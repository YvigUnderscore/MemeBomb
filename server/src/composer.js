// ============================================================
//  Composition multi-calques → une seule vidéo MP4.
//  L'éditeur envoie N fichiers (fond + calques vidéo/gif/image) et un
//  descripteur `comp` (position/taille/rotation/opacité par calque, en
//  fractions du canvas 1280x720), plus un overlay PNG (texte/images/dessin)
//  gravé par-dessus. ffmpeg assemble le tout ; le MP4 résultant repasse
//  ensuite par processMedia() comme n'importe quel upload (anti-injection).
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import ffmpeg from 'fluent-ffmpeg';
import { fileTypeFromBuffer } from 'file-type';
import { config } from './config.js';
import { HttpError, LOUDNORM_FILTER } from './media.js';
import { logger } from './logger.js';
import { runQueued } from './transcodeQueue.js';

const MAX_LAYERS = 6;
const W = 1280, H = 720, FPS = 30;
const THREADS = String(config.transcode.threads);

const num = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

// Volontairement HORS de la file des encodages : ces probes ont lieu avant
// l'encodage de la même composition, les mettre dans la même file ferait
// attendre un job derrière lui-même (interblocage). Ils coûtent quelques ms.
function ffprobeFile(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// ---- Homographie (déformation corner pin, cf. éditeur) -------------------
// Même méthode « adjugate » que l'éditeur : matrice 3x3 envoyant 4 points sur 4 points.
function adj3(m) {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}
function mul33(a, b) {
  const r = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
}
function mul3v(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
function basisToPoints(p1, p2, p3, p4) {
  const m = [p1[0], p2[0], p3[0], p1[1], p2[1], p3[1], 1, 1, 1];
  const v = mul3v(adj3(m), [p4[0], p4[1], 1]);
  return mul33(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}
function homography(src, dst) { // 4 points chacun, ordre tl,tr,br,bl
  const s = basisToPoints(src[0], src[1], src[2], src[3]);
  const d = basisToPoints(dst[0], dst[1], dst[2], dst[3]);
  const t = mul33(d, adj3(s));
  for (let i = 0; i < 9; i++) t[i] /= t[8];
  return t;
}
function projectPoint(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

// Valide le quad d'un calque (4 coins [x,y] en px canvas, rotation incluse).
function sanitizeQuad(q) {
  if (!Array.isArray(q) || q.length !== 4) return null;
  const out = [];
  for (const p of q) {
    if (!Array.isArray(p) || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) return null;
    out.push([num(p[0], -2 * W, 3 * W, 0), num(p[1], -2 * H, 3 * H, 0)]);
  }
  return out;
}

/**
 * Compose les calques en une seule vidéo.
 * Fond couleur → MP4 h264 (repasse ensuite par processMedia).
 * Fond « Aucun » → WebM VP9 AVEC TRANSPARENCE (alpha) : le destinataire voit
 * les calques flotter sur son écran, sans rectangle noir autour.
 * @param {Buffer[]} layerBuffers  fichiers dans l'ordre de comp.layers (z croissant)
 * @param {object} comp  { bg: '#rrggbb'|null, durationS, layers: [{full?, mute?, xPct,yPct,wPct,rot,opacity}] }
 * @param {Buffer|null} overlayBuffer  PNG transparent 1280x720 gravé au-dessus
 * @param {object} settings  réglages du channel (limites)
 * @returns {Promise<{buffer: Buffer, mime: string, transparent: boolean}>}
 */
export async function composeLayers(layerBuffers, comp, overlayBuffer, settings) {
  const descs = Array.isArray(comp?.layers) ? comp.layers.slice(0, MAX_LAYERS) : [];
  if (!layerBuffers?.length || layerBuffers.length !== descs.length) {
    throw new HttpError(400, 'Invalid composition (layers and descriptor mismatch).');
  }
  const maxBytes = (settings.maxUploadMb || 25) * 1048576;
  const total = layerBuffers.reduce((a, b) => a + b.length, 0);
  if (total > maxBytes) {
    throw new HttpError(413, `Files too large (max ${settings.maxUploadMb} MB total).`);
  }

  // Type réel de chaque calque (sniffé, jamais l'extension annoncée).
  const metas = [];
  for (let i = 0; i < layerBuffers.length; i++) {
    const ft = await fileTypeFromBuffer(layerBuffers[i]);
    const mime = ft?.mime || '';
    const kind = mime === 'image/gif' ? 'gif'
      : mime.startsWith('video/') ? 'video'
        : mime.startsWith('image/') ? 'image' : null;
    if (!kind) throw new HttpError(415, `Layer ${i + 1}: file type not allowed.`);
    metas.push({ kind, hasAudio: false, durationS: 0 });
  }

  // Fichiers temporaires d'entrée.
  const id = nanoid(12);
  const tmps = [];
  const cleanup = () => { for (const t of tmps) fs.rmSync(t, { force: true }); };
  try {
    for (let i = 0; i < layerBuffers.length; i++) {
      const p = path.join(config.tmpDir, `${id}_l${i}`);
      fs.writeFileSync(p, layerBuffers[i]);
      tmps.push(p);
    }
    let overlayPath = null;
    if (overlayBuffer?.length) {
      overlayPath = path.join(config.tmpDir, `${id}_ov.png`);
      fs.writeFileSync(overlayPath, overlayBuffer);
      tmps.push(overlayPath);
    }

    // Durées et pistes audio des vidéos.
    for (let i = 0; i < metas.length; i++) {
      if (metas[i].kind === 'image') continue;
      try {
        const info = await ffprobeFile(tmps[i]);
        metas[i].durationS = Number(info.format?.duration) || 0;
        // `mute` : calque coupé à la demande de l'éditeur (bouton 🔊/🔇). La
        // piste existe toujours dans le fichier, elle est simplement écartée
        // du mixage — comme le fait l'encodage navigateur de son côté.
        metas[i].hasAudio = metas[i].kind === 'video'
          && !descs[i]?.mute
          && (info.streams || []).some((s) => s.codec_type === 'audio');
        const vs = (info.streams || []).find((s) => s.width);
        metas[i].w = vs?.width || 0;
        metas[i].h = vs?.height || 0;
      } catch {
        throw new HttpError(422, `Layer ${i + 1}: unreadable media.`);
      }
    }

    const maxDur = settings.maxVideoDurationS || 15;
    const longest = Math.max(0, ...metas.map((m) => m.durationS));
    const D = num(comp.durationS, 0.5, maxDur, Math.min(maxDur, longest || 6)).toFixed(2);

    // Fond « Aucun » → sortie WebM VP9 avec canal alpha (transparence réelle).
    // Le besoin d'alpha est décidé par l'éditeur et transmis explicitement : la
    // déduction « pas de couleur de fond ⇒ alpha » rangeait tout fond MÉDIA avec
    // le fond « Aucun », et imposait un encodage VP9 alpha — de loin le plus
    // coûteux — à des scènes pourtant opaques. Repli sur l'ancienne règle quand
    // le champ est absent : un editor.js encore en cache (cf. CLAUDE.md) ou un
    // client tiers continuent de fonctionner à l'identique.
    const hasColorBg = /^#[0-9a-fA-F]{6}$/.test(comp?.bg || '');
    const transparent = typeof comp?.transparent === 'boolean' ? comp.transparent : !hasColorBg;
    const out = path.join(config.tmpDir, `${id}_out.${transparent ? 'webm' : 'mp4'}`);
    tmps.push(out);

    const cmd = ffmpeg();
    for (let i = 0; i < tmps.length; i++) {
      if (i >= layerBuffers.length) break;
      if (metas[i].kind === 'image') cmd.input(tmps[i]).inputOptions(['-loop', '1']);
      else if (metas[i].kind === 'gif') cmd.input(tmps[i]).inputOptions(['-ignore_loop', '0']);
      else cmd.input(tmps[i]);
    }
    if (overlayPath) cmd.input(overlayPath);

    const filters = [];
    // Scène opaque sans couleur choisie (fond média plein cadre) : base noire
    // OPAQUE, la même que celle posée par le canvas de l'éditeur.
    const bg = hasColorBg ? '0x' + comp.bg.slice(1) : (transparent ? '0x000000@0.0' : '0x000000');
    filters.push(`color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${D},format=rgba[base]`);

    let prev = 'base';
    descs.forEach((L, i) => {
      const meta = metas[i];
      const full = !!L.full;
      const rot = num(L.rot, -180, 180, 0) * Math.PI / 180;
      const op = num(L.opacity, 0.05, 1, 1);
      // Déformation (corner pin) : coins absolus en px canvas, rotation incluse
      // — jamais sur un calque plein cadre, et uniquement si les dimensions
      // source sont connues (vidéos/gifs, probés ci-dessus).
      const quad = (!full && meta.w > 0) ? sanitizeQuad(L.quad) : null;
      const chain = [];
      let x, y;
      if (quad) {
        // Le calque est mis à l'échelle puis posé en (0,0) dans un cadre aux
        // dimensions du canvas ; la perspective envoie ensuite son rectangle
        // sur le quad voulu (coordonnées absolues canvas).
        const lw = Math.max(16, Math.round(num(L.wPct, 0.03, 1, 0.4) * W / 2) * 2);
        const lh = Math.max(16, Math.round((lw * meta.h / meta.w) / 2) * 2);
        // Contenu CENTRÉ dans le cadre avec bordure transparente : le filtre
        // perspective échantillonne en « clamp » hors du cadre source — sans
        // marge transparente, les bords du contenu bavent hors du quad.
        const fw = Math.max(W, lw + 4), fh = Math.max(H, lh + 4);
        const bx = Math.round((fw - lw) / 2), by = Math.round((fh - lh) / 2);
        const Hm = homography(
          [[bx, by], [bx + lw, by], [bx + lw, by + lh], [bx, by + lh]],
          quad,
        );
        // Coins du CADRE complet projetés par la même homographie
        // (ordre du filtre perspective : tl, tr, bl, br).
        const c = [projectPoint(Hm, 0, 0), projectPoint(Hm, fw, 0), projectPoint(Hm, 0, fh), projectPoint(Hm, fw, fh)]
          .map((p) => p.map(Math.round));
        chain.push(`scale=${lw}:${lh}`, 'format=rgba', `pad=${fw}:${fh}:${bx}:${by}:color=0x00000000`);
        chain.push(`perspective=${c[0][0]}:${c[0][1]}:${c[1][0]}:${c[1][1]}:${c[2][0]}:${c[2][1]}:${c[3][0]}:${c[3][1]}:sense=destination`);
        x = '0'; y = '0';
      } else if (full) {
        chain.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`, 'format=rgba');
        x = '(W-w)/2'; y = '(H-h)/2';
      } else {
        chain.push(`scale=${Math.max(16, Math.round(num(L.wPct, 0.03, 2, 0.4) * W))}:-2`, 'format=rgba');
        if (Math.abs(rot) > 0.001) {
          const r = rot.toFixed(5);
          chain.push(`rotate=${r}:c=black@0:ow=rotw(${r}):oh=roth(${r})`);
        }
        x = `${Math.round(num(L.xPct, 0, 1, 0.5) * W)}-w/2`;
        y = `${Math.round(num(L.yPct, 0, 1, 0.5) * H)}-h/2`;
      }
      if (op < 0.995) chain.push(`colorchannelmixer=aa=${op.toFixed(3)}`);
      // Une vidéo plus courte que D reste figée sur sa dernière image.
      if (meta.kind === 'video') chain.push('tpad=stop_mode=clone:stop=-1');
      chain.push(`fps=${FPS}`);
      filters.push(`[${i}:v]${chain.join(',')}[l${i}]`);
      filters.push(`[${prev}][l${i}]overlay=x=${x}:y=${y}:eval=init[t${i}]`);
      prev = `t${i}`;
    });

    if (overlayPath) {
      filters.push(`[${layerBuffers.length}:v]format=rgba[ovl]`);
      filters.push(`[${prev}][ovl]overlay=0:0:eval=init[tov]`);
      prev = 'tov';
    }
    filters.push(`[${prev}]format=${transparent ? 'yuva420p' : 'yuv420p'}[vout]`);

    // Audio : mixe les pistes des calques vidéo (les gifs/images sont muets).
    // La sortie transparente ne repasse pas par processMedia → loudnorm ici.
    const norm = transparent ? `${LOUDNORM_FILTER},` : '';
    const audioIdx = metas.map((m, i) => (m.hasAudio ? i : -1)).filter((i) => i >= 0);
    let hasAudio = false;
    if (audioIdx.length === 1) {
      filters.push(`[${audioIdx[0]}:a]${norm}aresample=48000,apad[aout]`);
      hasAudio = true;
    } else if (audioIdx.length > 1) {
      filters.push(audioIdx.map((i) => `[${i}:a]`).join('')
        + `amix=inputs=${audioIdx.length}:duration=longest:normalize=0,${norm}aresample=48000,apad[aout]`);
      hasAudio = true;
    }

    const videoOpts = transparent
      // VP9 + yuva420p : seul codec avec alpha lisible par Chromium/Electron.
      ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32',
        '-deadline', 'realtime', '-cpu-used', '5', '-row-mt', '1', '-auto-alt-ref', '0']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    const audioOpts = hasAudio
      ? ['-map', '[aout]', ...(transparent ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '128k']), '-ac', '2']
      : ['-an'];

    // Budget CPU : `-threads` borne l'encodeur, mais ici c'est le graphe de
    // filtres qui pèse le plus (scale/perspective/overlay pour chaque calque)
    // et il a son propre pool — sans `-filter_threads` et
    // `-filter_complex_threads`, il reprend tous les cœurs de la machine.
    const cpuOpts = ['-threads', THREADS, '-filter_threads', THREADS, '-filter_complex_threads', THREADS];

    // L'encodage passe par la file : c'est le job le plus lourd du serveur,
    // deux compositions concurrentes saturaient les 4 cœurs.
    let waitMs = 0, runMs = 0;
    await runQueued(`composition ${layerBuffers.length} calque(s)`, () => new Promise((resolve, reject) => {
      cmd.complexFilter(filters)
        .outputOptions([
          '-map', '[vout]',
          ...audioOpts,
          ...videoOpts,
          ...cpuOpts,
          '-t', String(D),
          '-map_metadata', '-1',
        ])
        .format(transparent ? 'webm' : 'mp4')
        .on('error', (e) => reject(e))
        .on('end', () => resolve())
        .save(out);
    }), (m) => { waitMs = m.waitMs; runMs = m.runMs; });

    const buf = fs.readFileSync(out);
    logger.info(`Composition: ${layerBuffers.length} calque(s) → ${(buf.length / 1048576).toFixed(2)} Mo (${D}s, ${transparent ? 'webm alpha' : 'mp4'}) — attente file ${waitMs} ms, encodage ${runMs} ms`);
    return { buffer: buf, mime: transparent ? 'video/webm' : 'video/mp4', transparent };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    logger.error('Composition ffmpeg:', e.message);
    throw new HttpError(422, 'Video composition failed (invalid media?).');
  } finally {
    cleanup();
  }
}
