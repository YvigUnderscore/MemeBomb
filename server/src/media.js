// ============================================================
//  Pipeline média — validation et re-transcodage.
//
//  Garantie anti-injection : AUCUN octet reçu n'est servi tel quel.
//  Chaque média est décodé puis ré-encodé (sharp pour les images,
//  ffmpeg pour gif/vidéo/audio). Un éventuel payload caché dans les
//  métadonnées ou une structure de fichier malformée ne survit pas au
//  ré-encodage. On valide d'abord le type réel par magic-bytes, on
//  refuse tout ce qui n'est pas une image/vidéo/audio d'une liste blanche.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { logger } from './logger.js';
import { runQueued } from './transcodeQueue.js';

// Budget CPU commun à ffmpeg et à sharp (voir config.transcode).
const THREADS = String(config.transcode.threads);
// sharp ouvre par défaut un thread libvips par cœur : sans ce plafond, il
// reprendrait d'une main les cœurs que `-threads` et la file concèdent de
// l'autre, et une rafale d'images suffirait à saturer la machine.
sharp.concurrency(config.transcode.threads);

// --- Résolution des binaires ffmpeg/ffprobe -----------------------------
async function resolveBinaries() {
  let ffmpegPath = null;
  let ffprobePath = null;
  try { ffmpegPath = (await import('ffmpeg-static')).default; } catch { /* system */ }
  try { ffprobePath = (await import('ffprobe-static')).default?.path; } catch { /* system */ }
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
  if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
  logger.info('ffmpeg:', ffmpegPath || 'système (PATH)', '| ffprobe:', ffprobePath || 'système (PATH)');
}
resolveBinaries();

// --- Types autorisés (magic-bytes → catégorie) --------------------------
const ALLOWED = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'gif',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/mp4': 'audio',
};

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// Normalisation de sonie EBU R128 : quel que soit le fichier source (screamer,
// son sur-compressé…), le volume perçu est ramené à une cible fixe et le pic
// réel est plafonné. Appliquée à TOUT audio entrant (sons, vidéos, compositions).
export const LOUDNORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11';

// NB : le builder doit terminer par .output(...) et JAMAIS .save(...) —
// .save() démarre déjà le process, et le .run() d'ici lancerait un second
// ffmpeg écrivant le même fichier en parallèle (corruption aléatoire).
// Tout encodage passe par la file (transcodeQueue.js) : sans elle, deux
// envois simultanés lancent deux ffmpeg qui se disputent les 4 cœurs et
// l'API cesse de répondre. Les ffprobe, eux, restent hors file (rapides, et
// handleVideo probe AVANT d'encoder → interblocage garanti sinon).
function runFfmpeg(label, build) {
  return runQueued(label, () => new Promise((resolve, reject) => {
    const cmd = build(ffmpeg());
    cmd.on('end', resolve).on('error', reject).run();
  }));
}

/**
 * Valide et transcode un média.
 * @param {Buffer} buffer  contenu brut reçu
 * @param {object} settings  réglages du channel (limites)
 * @returns {Promise<{type,relPath,absPath,mime,size,durationMs,width,height}>}
 */
export async function processMedia(buffer, settings) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'Empty file.');
  }
  const maxBytes = (settings.maxUploadMb || 25) * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new HttpError(413, `File too large (max ${settings.maxUploadMb} MB).`);
  }

  const ft = await fileTypeFromBuffer(buffer);
  if (!ft || !ALLOWED[ft.mime]) {
    throw new HttpError(415, `File type not allowed${ft ? ` (${ft.mime})` : ''}.`);
  }
  const category = ALLOWED[ft.mime];
  if (!(settings.allowedTypes || []).includes(category)) {
    throw new HttpError(415, `The "${category}" type is disabled on this channel.`);
  }

  const id = nanoid(16);
  const tmpIn = path.join(config.tmpDir, `${id}.in`);
  fs.writeFileSync(tmpIn, buffer);

  try {
    let result;
    if (category === 'image') result = await handleImage(id);
    else if (category === 'gif') result = await handleGif(id, settings);
    else if (category === 'video') result = await handleVideo(id, settings);
    else if (category === 'audio') result = await handleAudio(id, settings);
    else throw new HttpError(415, 'Unsupported type.');
    return result;
  } finally {
    fs.rmSync(tmpIn, { force: true });
  }
}

async function handleImage(id) {
  const tmpIn = path.join(config.tmpDir, `${id}.in`);
  const rel = `${id}.webp`;
  const abs = path.join(config.mediaDir, rel);
  // sharp décode puis ré-encode : métadonnées retirées, dimensions bornées.
  const meta = await sharp(tmpIn, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(abs);
  return {
    type: 'image', relPath: rel, absPath: abs, mime: 'image/webp',
    size: meta.size, durationMs: 0, width: meta.width, height: meta.height,
  };
}

async function handleGif(id, settings) {
  const tmpIn = path.join(config.tmpDir, `${id}.in`);
  const rel = `${id}.mp4`;
  const abs = path.join(config.mediaDir, rel);
  const maxDur = settings.maxGifDurationS || 10;
  // Un GIF animé est converti en MP4 muet en boucle : plus léger, ré-encodé,
  // et affiché en boucle par le client comme un GIF.
  try {
    await runFfmpeg('gif→mp4', (c) => c.input(tmpIn)
      .noAudio()
      .duration(maxDur)
      .videoCodec('libx264')
      .outputOptions([
        '-threads', THREADS,
        '-preset', 'veryfast',
        '-profile:v', 'main',
        '-level', '4.0',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-vf', 'scale=trunc(min(iw\\,1280)/2)*2:trunc(min(ih\\,1280)/2)*2:flags=lanczos',
        '-map_metadata', '-1',
        '-an',
      ])
      .format('mp4')
      .output(abs));
  } catch (e) {
    fs.rmSync(abs, { force: true });
    throw new HttpError(422, 'This GIF is invalid or could not be converted.');
  }
  const info = await safeProbe(abs);
  return {
    type: 'gif', relPath: rel, absPath: abs, mime: 'video/mp4',
    size: fs.statSync(abs).size, durationMs: Math.round((info.duration || 0) * 1000),
    width: info.width, height: info.height, loop: true, muted: true,
  };
}

async function handleVideo(id, settings) {
  const tmpIn = path.join(config.tmpDir, `${id}.in`);
  const probe = await ffprobe(tmpIn);
  const hasAudio = (probe.streams || []).some((s) => s.codec_type === 'audio');
  const rel = `${id}.mp4`;
  const abs = path.join(config.mediaDir, rel);
  // Sortie h264 "main" 8-bit 4:2:0, faststart : lisible par Chromium/Electron
  // quel que soit l'encodage source (HEVC, VP9, 10-bit, ProRes...).
  try {
    await runFfmpeg('video→mp4', (c) => {
      let cmd = c.input(tmpIn)
        .duration(settings.maxVideoDurationS || 15)
        .videoCodec('libx264')
        .outputOptions([
          '-threads', THREADS,
          '-preset', 'veryfast',
          '-profile:v', 'main',
          '-level', '4.0',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-vf', 'scale=trunc(min(iw\\,1280)/2)*2:trunc(min(ih\\,720)/2)*2',
          '-map_metadata', '-1',
          '-max_muxing_queue_size', '1024',
        ]);
      if (hasAudio) {
        cmd = cmd.audioCodec('aac').audioBitrate('128k')
          .audioFilters(LOUDNORM_FILTER)
          .outputOptions(['-ac', '2', '-ar', '48000']);
      } else {
        cmd = cmd.noAudio();
      }
      return cmd.format('mp4').output(abs);
    });
  } catch (e) {
    fs.rmSync(abs, { force: true });
    throw new HttpError(422, 'This video is invalid or could not be converted.');
  }
  const info = await safeProbe(abs);
  return {
    type: 'video', relPath: rel, absPath: abs, mime: 'video/mp4',
    size: fs.statSync(abs).size, durationMs: Math.round((info.duration || 0) * 1000),
    width: info.width, height: info.height,
  };
}

async function handleAudio(id, settings) {
  const tmpIn = path.join(config.tmpDir, `${id}.in`);
  const rel = `${id}.m4a`;
  const abs = path.join(config.mediaDir, rel);
  try {
    await runFfmpeg('audio→m4a', (c) => c.input(tmpIn)
      .noVideo()
      .duration(settings.maxAudioDurationS || 15)
      .audioCodec('aac')
      .audioBitrate('160k')
      .audioFilters(LOUDNORM_FILTER)
      .outputOptions(['-threads', THREADS, '-ar', '48000', '-map_metadata', '-1', '-movflags', '+faststart'])
      .format('mp4')
      .output(abs));
  } catch (e) {
    fs.rmSync(abs, { force: true });
    throw new HttpError(422, 'This audio file is invalid or could not be converted.');
  }
  const info = await safeProbe(abs);
  return {
    type: 'audio', relPath: rel, absPath: abs, mime: 'audio/mp4',
    size: fs.statSync(abs).size, durationMs: Math.round((info.duration || 0) * 1000),
    width: 0, height: 0,
  };
}

async function safeProbe(file) {
  try {
    const p = await ffprobe(file);
    const v = (p.streams || []).find((s) => s.width) || {};
    return { duration: p.format?.duration || 0, width: v.width || 0, height: v.height || 0 };
  } catch {
    return { duration: 0, width: 0, height: 0 };
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Stocke tel quel une vidéo produite par NOTRE composer (composer.js).
 * Pas de re-transcodage : le fichier sort déjà de notre ffmpeg (mêmes garanties
 * que processMedia) et un ré-encodage h264 détruirait le canal alpha du WebM.
 */
export async function storeComposedVideo(buffer, mime = 'video/webm') {
  const id = nanoid(16);
  const rel = `${id}.${mime === 'video/webm' ? 'webm' : 'mp4'}`;
  const abs = path.join(config.mediaDir, rel);
  fs.writeFileSync(abs, buffer);
  const info = await safeProbe(abs);
  return {
    type: 'video', relPath: rel, absPath: abs, mime,
    size: buffer.length, durationMs: Math.round((info.duration || 0) * 1000),
    width: info.width, height: info.height,
  };
}

/**
 * Ré-analyse un média déjà transcodé et stocké sur disque (utilisé pour
 * reconstituer largeur/hauteur/durée lors de l'approbation différée d'un
 * meme mis en revue manuelle : ces infos ne sont pas persistées en base).
 */
export async function probeStoredMedia(absPath, mime) {
  if (mime === 'image/webp') {
    try {
      const meta = await sharp(absPath).metadata();
      return { width: meta.width || 0, height: meta.height || 0, durationMs: 0 };
    } catch { return { width: 0, height: 0, durationMs: 0 }; }
  }
  const info = await safeProbe(absPath);
  return { width: info.width, height: info.height, durationMs: Math.round((info.duration || 0) * 1000) };
}
