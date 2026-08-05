// ============================================================
//  Routeur côté client desktop (device-facing).
//  Appairage, config+features, envoi (media/overlay/son), bibliothèque
//  d'assets (quota), réglages partagés, planification.
// ============================================================

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db, now, audit, getChannelSettings } from '../db.js';
import { config } from '../config.js';
import { deviceAuth } from '../auth.js';
import { hashToken, randomToken } from '../crypto.js';
import { getChannelGuidelines } from '../guidelines.js';
import { effectiveFeatures, assertFeature } from '../features.js';
import { processMedia, storeComposedVideo, HttpError } from '../media.js';
import { composeLayers } from '../composer.js';
import { createAndDispatchMeme, signMediaUrl, MAX_SOUNDS } from '../memeService.js';
import { createSchedule } from '../scheduler.js';
import { removeMediaFile, soundPathsOf } from '../retention.js';
import { pushPanel, invalidateBlocks, channelPresence } from '../wsHub.js';
import { searchMyInstants, trendingMyInstants, downloadMyInstants, TRENDING_REGIONS } from '../sounds.js';
import { giphyEnabled, searchGiphy, fetchRemoteMedia } from '../webmedia.js';
import { asyncHandler } from './helpers.js';

const router = Router();
// fieldSize : la scène d'un meme enregistré (calques + images en dataURL) part
// dans le champ texte `data` — la limite multer par défaut (1 Mo) la tronquerait.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 10, fieldSize: 12 * 1024 * 1024 },
});
const memeFields = upload.fields([
  { name: 'media', maxCount: 1 }, { name: 'overlay', maxCount: 1 },
  { name: 'sound', maxCount: MAX_SOUNDS },   // plusieurs sons joués à l'apparition
  { name: 'layers', maxCount: 6 }, // composition multi-calques (fond + vidéos/gifs)
]);
// Un meme enregistré est soit un rendu déjà aplati (`media`), soit — quand la
// scène est animée — les mêmes calques que pour un envoi, composés en vidéo.
const assetFields = upload.fields([
  { name: 'media', maxCount: 1 }, { name: 'overlay', maxCount: 1 }, { name: 'layers', maxCount: 6 },
]);

// Propriétaire logique : appareil virtuel (éditeur panel) → owner explicite ;
// sinon compte Discord lié, sinon l'appareil lui-même.
const ownerOf = (device) => device.owner || device.discord_id || `device:${device.id}`;
const parseJSON = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

// Référence le son déjà transcodé d'un asset de la bibliothèque (#13), si l'assetId
// appartient bien au device courant. On le copie tel quel (pas de re-transcodage),
// ce qui évite aussi la mauvaise détection d'un m4a audio comme "video/mp4".
function assetSoundInfo(device, assetId) {
  if (!assetId) return null;
  // Le son peut appartenir à l'appareil (bibliothèque perso) OU au channel
  // (soundboard partagé #4). Dans les deux cas il est déjà transcodé.
  const a = db.prepare("SELECT media_path, media_mime FROM assets WHERE id = ? AND channel_id = ? AND owner IN (?, 'channel') AND kind = 'sound'")
    .get(String(assetId), device.channel_id, ownerOf(device));
  if (!a || !a.media_path) return null;
  if (!fs.existsSync(path.join(config.mediaDir, path.basename(a.media_path)))) return null;
  return { relPath: a.media_path, mime: a.media_mime };
}

// Sons de bibliothèque joints à un envoi : `soundAssetIds` (JSON array) et/ou
// l'ancien champ unique `soundAssetId`. La source est soit un champ multipart
// (chaîne JSON), soit la définition d'un meme enregistré (tableau déjà parsé).
function assetSoundInfos(device, body) {
  const list = Array.isArray(body.soundAssetIds) ? body.soundAssetIds : parseJSON(body.soundAssetIds, []);
  const ids = [...list, ...(body.soundAssetId ? [body.soundAssetId] : [])];
  return [...new Set(ids.map(String))].slice(0, MAX_SOUNDS)
    .map((id) => assetSoundInfo(device, id)).filter(Boolean);
}

function clientConfigFor(channel, device) {
  const s = getChannelSettings(channel);
  return {
    channel: { slug: channel.slug, name: channel.name },
    device: { id: device.id, name: device.name, discordId: device.discord_id || '' },
    wsUrl: config.publicUrl.replace(/^http/, 'ws') + '/ws',
    guidelines: getChannelGuidelines(channel),
    features: effectiveFeatures(channel, ownerOf(device)),
    limits: { storageQuotaMb: s.storageQuotaMb, maxSchedulesPerUser: s.maxSchedulesPerUser },
    settings: {
      defaultCooldownS: s.defaultCooldownS, defaultVolume: s.defaultVolume, defaultOpacity: s.defaultOpacity,
      maxImageDurationS: s.maxImageDurationS, maxGifDurationS: s.maxGifDurationS,
      maxVideoDurationS: s.maxVideoDurationS, maxAudioDurationS: s.maxAudioDurationS,
      maxTextLength: s.maxTextLength, allowedTypes: s.allowedTypes, allowEditorSend: s.allowEditorSend,
      requireGuidelinesAccept: s.requireGuidelinesAccept, maxUploadMb: s.maxUploadMb,
      sharedSoundboard: s.sharedSoundboard !== false,
      maxAnimMs: s.maxAnimMs || 1500,
      giphyEnabled: giphyEnabled(),
    },
  };
}

function channelOf(req) {
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.device.channel_id);
  if (!c) throw new HttpError(404, 'Channel not found');
  return c;
}

// --- Appairage ----------------------------------------------------------
router.post('/pair', asyncHandler((req, res) => {
  const { code, deviceName } = z.object({
    code: z.string().min(4).max(20),
    deviceName: z.string().max(60).optional().default('Appareil'),
  }).parse(req.body);
  const pc = db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code.toUpperCase().trim());
  if (!pc || pc.used || pc.expires_at < now()) return res.status(400).json({ error: 'Invalid or expired code.' });
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND active = 1').get(pc.channel_id);
  if (!channel) return res.status(404).json({ error: 'Channel not found or disabled.' });

  const token = randomToken(32);
  const info = db.prepare(`INSERT INTO devices (channel_id, name, token_hash, discord_id, last_seen, created_at)
      VALUES (?,?,?,?,?,?)`).run(channel.id, deviceName, hashToken(token), pc.discord_id || '', now(), now());
  db.prepare('UPDATE pairing_codes SET used = 1 WHERE code = ?').run(pc.code);
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
  audit(deviceName, 'device.paired', { channel: channel.slug, device: device.id });
  res.status(201).json({ deviceToken: token, ...clientConfigFor(channel, device) });
}));

router.get('/config', deviceAuth, asyncHandler((req, res) => res.json(clientConfigFor(channelOf(req), req.device))));

router.get('/targets', deviceAuth, (req, res) => {
  const cid = req.device.channel_id;
  const groups = db.prepare('SELECT name, members FROM mention_groups WHERE channel_id = ? ORDER BY name').all(cid)
    .map((g) => ({ name: g.name, count: parseJSON(g.members, []).length }));
  const members = db.prepare('SELECT discord_id, discord_username FROM whitelist WHERE channel_id = ? AND banned = 0 ORDER BY discord_username').all(cid)
    .map((m) => ({ discordId: m.discord_id, username: m.discord_username || m.discord_id }));
  res.json({ groups, members });
});

// Présence des destinataires : qui est connecté, qui est en « ne pas déranger ».
// L'éditeur est une page web sans WebSocket : il interroge cette route
// périodiquement plutôt que d'ouvrir un socket rien que pour ça.
router.get('/presence', deviceAuth, asyncHandler((req, res) => {
  const channel = channelOf(req);
  const flags = effectiveFeatures(channel, ownerOf(req.device));
  if (flags.presence === false) return res.json({ enabled: false, members: [], others: 0 });

  const live = new Map(channelPresence(channel.id).map((p) => [p.ownerKey, p]));
  const members = db.prepare('SELECT discord_id, discord_username FROM whitelist WHERE channel_id = ? AND banned = 0 ORDER BY discord_username')
    .all(channel.id)
    .map((m) => {
      const p = live.get(String(m.discord_id));
      live.delete(String(m.discord_id));
      return {
        discordId: m.discord_id, username: m.discord_username || m.discord_id,
        status: p ? p.status : 'offline',
        dndUntil: p?.dndUntil || 0, devices: p?.devices || 0, since: p?.since || 0,
      };
    });
  // Appareils connectés sans membre whitelisté (appareil anonyme) : non ciblables
  // mais bien destinataires d'une diffusion à tout le channel — comptés à part.
  res.json({ enabled: true, members, others: live.size });
}));

// --- Envoi (media + overlay + son) --------------------------------------
router.post('/meme', deviceAuth, memeFields, asyncHandler(async (req, res) => {
  const channel = channelOf(req);
  const f = req.files || {};
  const result = await createAndDispatchMeme({
    channel, source: 'editor', sender: ownerOf(req.device), senderName: req.device.name,
    discordId: req.device.discord_id || '',
    text: req.body.text || '',
    mediaBuffer: f.media?.[0]?.buffer || null,
    overlayBuffer: f.overlay?.[0]?.buffer || null,
    soundBuffers: (f.sound || []).map((x) => x.buffer),
    layerBuffers: (f.layers || []).map((x) => x.buffer),
    comp: parseJSON(req.body.comp, null),
    soundAssets: assetSoundInfos(req.device, req.body),
    groupNames: parseJSON(req.body.groups, []).map(String),
    mentions: parseJSON(req.body.mentions, []).map(String),
    options: parseJSON(req.body.options, {}),
  });
  res.status(201).json(result);
}));

router.post('/report', deviceAuth, asyncHandler((req, res) => {
  const { memeId, reason } = z.object({
    memeId: z.string().max(40).optional().default(''), reason: z.string().max(500).optional().default(''),
  }).parse(req.body);
  db.prepare('INSERT INTO reports (meme_id, channel_id, reporter, reason, created_at) VALUES (?,?,?,?,?)')
    .run(memeId || null, req.device.channel_id, req.device.name, reason, now());
  pushPanel('report.new', { channelId: req.device.channel_id, reporter: req.device.name, reason });
  res.status(201).json({ ok: true });
}));

// --- Blocages personnels (#15) : masquer les memes d'un expéditeur ------
router.get('/blocks', deviceAuth, (req, res) => {
  const rows = db.prepare('SELECT blocked_id, blocked_name, created_at FROM member_blocks WHERE channel_id = ? AND owner = ? ORDER BY created_at DESC')
    .all(req.device.channel_id, ownerOf(req.device));
  res.json(rows.map((r) => ({ senderId: r.blocked_id, name: r.blocked_name, createdAt: r.created_at })));
});

router.post('/blocks', deviceAuth, asyncHandler((req, res) => {
  const { senderId, name } = z.object({
    senderId: z.string().min(1).max(80), name: z.string().max(80).optional().default(''),
  }).parse(req.body);
  db.prepare(`INSERT INTO member_blocks (channel_id, owner, blocked_id, blocked_name, created_at)
      VALUES (?,?,?,?,?) ON CONFLICT(channel_id, owner, blocked_id) DO UPDATE SET blocked_name = excluded.blocked_name`)
    .run(req.device.channel_id, ownerOf(req.device), senderId, name, now());
  invalidateBlocks(req.device.channel_id);
  res.status(201).json({ ok: true });
}));

router.delete('/blocks/:senderId', deviceAuth, (req, res) => {
  db.prepare('DELETE FROM member_blocks WHERE channel_id = ? AND owner = ? AND blocked_id = ?')
    .run(req.device.channel_id, ownerOf(req.device), req.params.senderId);
  invalidateBlocks(req.device.channel_id);
  res.json({ ok: true });
});

// --- GIFs Giphy + import d'un média par URL ------------------------------
router.get('/gifs/search', deviceAuth, asyncHandler(async (req, res) => {
  const q = z.object({ q: z.string().max(100).optional().default('') }).parse(req.query).q;
  if (!giphyEnabled()) return res.json({ enabled: false, results: [] });
  res.json({ enabled: true, results: q ? await searchGiphy(q) : [] });
}));

// Coller un lien d'image/GIF/vidéo dans l'éditeur : le serveur le télécharge
// (anti-SSRF, cf. webmedia.js) et renvoie le binaire — le contenu repassera
// par processMedia à l'envoi, comme n'importe quel fichier local.
router.post('/media/from-url', deviceAuth, asyncHandler(async (req, res) => {
  const { url } = z.object({ url: z.string().url().max(600) }).parse(req.body);
  const s = getChannelSettings(channelOf(req));
  const { buffer, mime } = await fetchRemoteMedia(url, (s.maxUploadMb || 25) * 1048576);
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(buffer);
}));

// --- Soundboard myinstants (#13) : recherche + import -------------------
router.get('/sounds/search', deviceAuth, asyncHandler(async (req, res) => {
  const q = z.object({ q: z.string().max(80).optional().default('') }).parse(req.query).q;
  res.json(await searchMyInstants(q));
}));

// Parcourir la soundboard sans rien chercher : les sons tendance du moment,
// par région (idée d'Epi — trouver des sons quand on n'a pas d'idée).
router.get('/sounds/trending', deviceAuth, asyncHandler(async (req, res) => {
  const region = z.object({ region: z.string().max(10).optional().default('world') }).parse(req.query).region;
  const { results, reason } = await trendingMyInstants(region);
  res.json({
    regions: Object.entries(TRENDING_REGIONS).map(([id, r]) => ({ id, label: r.label })),
    results,
    // Raison de l'échec plutôt qu'une liste vide muette (le popover l'affiche).
    reason: reason || undefined,
  });
}));

// Aperçu d'un son myinstants (proxy SSRF-guardé) — remplace l'IPC Electron `sounds:preview`
// pour l'éditeur web (le navigateur ne peut pas charger le mp3 cross-origin sous CSP).
router.get('/sounds/preview', deviceAuth, asyncHandler(async (req, res) => {
  const url = z.object({ url: z.string().url() }).parse(req.query).url;
  const buffer = await downloadMyInstants(url);           // valide l'hôte + plafonne la taille
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.send(buffer);
}));

router.post('/sounds/import', deviceAuth, asyncHandler(async (req, res) => {
  const { url, name } = z.object({ url: z.string().url(), name: z.string().max(80).optional().default('') }).parse(req.body);
  const channel = channelOf(req);
  const s = getChannelSettings(channel);
  const owner = ownerOf(req.device);
  const buffer = await downloadMyInstants(url);
  const media = await processMedia(buffer, { ...s, allowedTypes: ['audio'] });
  if ((usedBytes(channel.id, owner) + (media.size || 0)) > s.storageQuotaMb * 1048576) {
    removeMediaFile(media.relPath);
    throw new HttpError(413, `Storage quota exceeded (${s.storageQuotaMb} MB).`);
  }
  const id = nanoid(14);
  db.prepare(`INSERT INTO assets (id, channel_id, owner, owner_name, kind, name, media_path, media_mime, media_size, data, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, channel.id, owner, req.device.name, 'sound', (name || 'Son myinstants').slice(0, 80),
      media.relPath, media.mime, media.size || 0, JSON.stringify({ source: 'myinstants', url }), now());
  res.status(201).json({ id, sizeMb: +((media.size || 0) / 1048576).toFixed(2) });
}));

// --- Bibliothèque (sons / memes) + quota --------------------------------
// La scène d'un meme (calques, images en dataURL) est stockée dans `data` :
// elle pèse autant qu'un fichier et compte donc dans le quota, sous peine
// d'offrir un stockage illimité hors comptabilité.
const MAX_ASSET_DATA_BYTES = 8 * 1048576;

const dataBytes = (json) => Buffer.byteLength(String(json || ''), 'utf8');

// media_size garde la taille du fichier transcodé ; le JSON `data` est pesé à
// la volée (CAST en BLOB : LENGTH() compte des caractères, pas des octets).
function usedBytes(channelId, owner) {
  return db.prepare('SELECT COALESCE(SUM(media_size + LENGTH(CAST(data AS BLOB))),0) s FROM assets WHERE channel_id = ? AND owner = ?')
    .get(channelId, owner).s;
}

// Média déjà transcodé d'un meme enregistré, si le fichier existe encore.
function assetMediaInfo(row) {
  if (!row.media_path) return null;
  if (!fs.existsSync(path.join(config.mediaDir, path.basename(row.media_path)))) return null;
  const data = parseJSON(row.data, {});
  return { relPath: row.media_path, mime: row.media_mime, size: row.media_size || 0, type: data.mediaType || 'image' };
}

// Vue publique d'un asset. La scène (potentiellement lourde) n'est envoyée
// que sur demande explicite (GET /assets/:id), jamais dans la liste.
function assetView(a, { withScene = false } = {}) {
  const data = parseJSON(a.data, {});
  const { scene, ...rest } = data;
  return {
    id: a.id, kind: a.kind, name: a.name,
    sizeMb: +(((a.media_size || 0) + dataBytes(a.data)) / 1048576).toFixed(2),
    url: a.media_path ? signMediaUrl(a.media_path) : null, mime: a.media_mime,
    data: withScene ? data : { ...rest, hasScene: !!scene },
    createdAt: a.created_at,
  };
}

function ownedAsset(req, id, kind = null) {
  return db.prepare(`SELECT * FROM assets WHERE id = ? AND channel_id = ? AND owner = ?${kind ? ' AND kind = ?' : ''}`)
    .get(...[id, req.device.channel_id, ownerOf(req.device), ...(kind ? [kind] : [])]);
}

// Transcode le média reçu et écrit l'asset (création ou remplacement), en
// vérifiant le quota du propriétaire sur l'empreinte totale.
async function writeAsset(req, { replace = null } = {}) {
  const channel = channelOf(req);
  const s = getChannelSettings(channel);
  const owner = ownerOf(req.device);
  const kind = ['sound', 'meme'].includes(req.body.kind) ? req.body.kind : (replace?.kind || 'sound');

  const incoming = parseJSON(req.body.data, {});
  // Un remplacement conserve les métadonnées de rangement (favori, catégorie).
  const previous = replace ? parseJSON(replace.data, {}) : {};
  const data = { ...incoming };
  for (const k of ['favorite', 'category', 'mediaType']) {
    if (previous[k] !== undefined && data[k] === undefined) data[k] = previous[k];
  }
  const json = JSON.stringify(data);
  if (dataBytes(json) > MAX_ASSET_DATA_BYTES) {
    throw new HttpError(413, `Meme too heavy to be saved (max ${Math.round(MAX_ASSET_DATA_BYTES / 1048576)} MB).`);
  }

  const f = req.files || {};
  const layerBuffers = (f.layers || []).map((x) => x.buffer);
  let media = null;
  if (kind === 'meme' && layerBuffers.length) {
    // Meme ANIMÉ : mêmes calques que pour un envoi, composés en une vidéo une
    // fois pour toutes. On stocke le rendu vidéo — d'où un vrai MP4/WebM au
    // téléchargement, et un renvoi direct sans re-transcodage.
    assertFeature(channel, owner, 'video', 'Vidéos/GIF');
    const composed = await composeLayers(layerBuffers, parseJSON(req.body.comp, {}), f.overlay?.[0]?.buffer || null, s);
    // Fond « Aucun » → WebM alpha stocké tel quel (un ré-encodage h264 détruirait
    // la transparence) ; fond couleur → MP4, qui repasse par le pipeline normal.
    media = composed.transparent
      ? await storeComposedVideo(composed.buffer, composed.mime)
      : await processMedia(composed.buffer, { ...s, allowedTypes: ['video'] });
    data.mediaType = media.type || 'video';
  } else if (f.media?.[0]?.buffer) {
    const allowed = kind === 'sound' ? ['audio'] : ['image', 'gif', 'video', 'audio'];
    media = await processMedia(f.media[0].buffer, { ...s, allowedTypes: allowed });
    // Depuis que l'éditeur compose lui-même les scènes à fond couleur, un meme
    // ANIMÉ arrive ici comme un média ordinaire au lieu d'emprunter la branche
    // calques ci-dessus — laquelle portait seule l'assertion. Sans ce contrôle,
    // composer côté client suffirait à contourner le feature-flag. Même règle
    // que createAndDispatchMeme (memeService.js).
    const featureOf = { video: ['video', 'Vidéos/GIF'], gif: ['video', 'Vidéos/GIF'], audio: ['audio', 'Sons'] }[media.type];
    if (featureOf) {
      try {
        assertFeature(channel, owner, featureOf[0], featureOf[1]);
      } catch (e) {
        removeMediaFile(media.relPath); // le rendu transcodé ne sera jamais référencé
        throw e;
      }
    }
    data.mediaType = media.type;
  }
  const finalJson = JSON.stringify(data);
  // Empreinte de l'asset après écriture, l'ancienne version étant libérée.
  const keptMediaSize = media ? media.size || 0 : (replace?.media_size || 0);
  const freed = replace ? (replace.media_size || 0) + dataBytes(replace.data) : 0;
  if ((usedBytes(channel.id, owner) - freed + keptMediaSize + dataBytes(finalJson)) > s.storageQuotaMb * 1048576) {
    if (media) removeMediaFile(media.relPath);
    throw new HttpError(413, `Storage quota exceeded (${s.storageQuotaMb} MB).`);
  }

  const name = (req.body.name || replace?.name || 'Sans nom').slice(0, 80);
  if (replace) {
    if (media) removeMediaFile(replace.media_path); // l'ancien rendu n'est plus référencé
    db.prepare('UPDATE assets SET name = ?, media_path = ?, media_mime = ?, media_size = ?, data = ? WHERE id = ?')
      .run(name, media?.relPath || replace.media_path, media?.mime || replace.media_mime, keptMediaSize,
        finalJson, replace.id);
    return { id: replace.id };
  }
  const id = nanoid(14);
  db.prepare(`INSERT INTO assets (id, channel_id, owner, owner_name, kind, name, media_path, media_mime, media_size, data, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, channel.id, owner, req.device.name, kind, name,
      media?.relPath || null, media?.mime || null, keptMediaSize, finalJson, now());
  return { id };
}

router.get('/storage', deviceAuth, (req, res) => {
  const s = getChannelSettings(channelOf(req));
  res.json({ usedMb: +(usedBytes(req.device.channel_id, ownerOf(req.device)) / 1048576).toFixed(2), quotaMb: s.storageQuotaMb });
});

router.get('/assets', deviceAuth, (req, res) => {
  const kind = ['sound', 'meme'].includes(req.query.kind) ? req.query.kind : null;
  const rows = db.prepare(`SELECT * FROM assets WHERE channel_id = @cid AND owner = @owner ${kind ? 'AND kind = @kind' : ''} ORDER BY created_at DESC`)
    .all({ cid: req.device.channel_id, owner: ownerOf(req.device), kind });
  res.json(rows.map((a) => assetView(a)));
});

// Détail d'un asset, scène comprise : appelé quand on rouvre un meme enregistré
// dans l'éditeur (la liste, elle, reste légère).
router.get('/assets/:id', deviceAuth, (req, res) => {
  const row = ownedAsset(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(assetView(row, { withScene: true }));
});

router.post('/assets', deviceAuth, assetFields, asyncHandler(async (req, res) => {
  res.status(201).json(await writeAsset(req));
}));

// Remplace le contenu d'un asset (meme retouché puis ré-enregistré sous le même
// nom d'entrée) : nouveau rendu + nouvelle scène, favori/catégorie conservés.
router.put('/assets/:id', deviceAuth, assetFields, asyncHandler(async (req, res) => {
  const row = ownedAsset(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(await writeAsset(req, { replace: row }));
}));

// Envoi direct d'un meme de la bibliothèque : le rendu est déjà transcodé, on
// le rejoue tel quel — mais via createAndDispatchMeme, donc whitelist,
// rate-limit, modération, warmup et feature-flags s'appliquent comme un envoi normal.
router.post('/assets/:id/send', deviceAuth, asyncHandler(async (req, res) => {
  const channel = channelOf(req);
  const row = ownedAsset(req, req.params.id, 'meme');
  if (!row) return res.status(404).json({ error: 'Not found' });
  const body = z.object({
    groups: z.array(z.string().max(60)).max(30).optional().default([]),
    mentions: z.array(z.string().max(40)).max(50).optional().default([]),
  }).parse(req.body || {});
  const data = parseJSON(row.data, {});
  const media = assetMediaInfo(row);
  if (!media && !data.text) throw new HttpError(410, 'This saved meme no longer has any content.');
  const result = await createAndDispatchMeme({
    channel, source: 'editor', sender: ownerOf(req.device), senderName: req.device.name,
    discordId: req.device.discord_id || '',
    text: data.text || '',
    mediaAsset: media,
    soundAssets: assetSoundInfos(req.device, data),
    groupNames: body.groups.map(String),
    mentions: body.mentions.map(String),
    options: data.options || {},
  });
  res.status(201).json(result);
}));

// Métadonnées d'un asset (#9) : favori / catégorie / renommage.
router.patch('/assets/:id', deviceAuth, asyncHandler((req, res) => {
  const row = ownedAsset(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const body = z.object({
    name: z.string().min(1).max(80).optional(),
    favorite: z.boolean().optional(),
    category: z.string().max(40).optional(),
  }).parse(req.body || {});
  let data = parseJSON(row.data, {});
  if (body.favorite !== undefined) data.favorite = body.favorite;
  if (body.category !== undefined) data.category = body.category;
  const name = body.name !== undefined ? body.name : row.name;
  db.prepare('UPDATE assets SET name = ?, data = ? WHERE id = ?').run(name, JSON.stringify(data), row.id);
  res.json({ ok: true });
}));

router.delete('/assets/:id', deviceAuth, (req, res) => {
  const row = ownedAsset(req, req.params.id);
  if (row) {
    removeMediaFile(row.media_path);
    db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
  }
  res.json({ ok: true });
});

// --- Soundboard partagé du channel (#4) : lecture seule côté client -------
router.get('/soundboard', deviceAuth, asyncHandler((req, res) => {
  const channel = channelOf(req);
  const s = getChannelSettings(channel);
  if (s.sharedSoundboard === false) return res.json([]);
  const rows = db.prepare("SELECT * FROM assets WHERE channel_id = ? AND owner = 'channel' AND kind = 'sound' ORDER BY created_at DESC")
    .all(channel.id);
  res.json(rows.map((a) => ({
    id: a.id, name: a.name, sizeMb: +((a.media_size || 0) / 1048576).toFixed(2),
    url: a.media_path ? signMediaUrl(a.media_path) : null, mime: a.media_mime,
    data: parseJSON(a.data, {}), createdAt: a.created_at, shared: true,
  })));
}));

// --- Réglages partagés (voir les préférences des autres) ----------------
router.post('/my-settings', deviceAuth, asyncHandler((req, res) => {
  const did = req.device.discord_id;
  if (!did) return res.json({ ok: false, reason: 'device non lié à un compte Discord' });
  const settings = JSON.stringify(parseJSON(JSON.stringify(req.body?.settings || {}), {}));
  db.prepare(`INSERT INTO member_settings (channel_id, discord_id, name, settings, updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(channel_id, discord_id) DO UPDATE SET name=excluded.name, settings=excluded.settings, updated_at=excluded.updated_at`)
    .run(req.device.channel_id, did, req.device.name, settings, now());
  res.json({ ok: true });
}));

router.get('/members-settings', deviceAuth, asyncHandler((req, res) => {
  const channel = channelOf(req);
  const flags = effectiveFeatures(channel, ownerOf(req.device));
  if (flags.shareSettings === false) return res.json([]);
  const rows = db.prepare('SELECT discord_id, name, settings, updated_at FROM member_settings WHERE channel_id = ? ORDER BY updated_at DESC')
    .all(channel.id);
  res.json(rows.map((r) => ({ discordId: r.discord_id, name: r.name, settings: parseJSON(r.settings, {}), updatedAt: r.updated_at })));
}));

// --- Planification ------------------------------------------------------
router.get('/schedules', deviceAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM schedules WHERE channel_id = ? AND owner = ? ORDER BY created_at DESC')
    .all(req.device.channel_id, ownerOf(req.device));
  res.json(rows.map((r) => ({
    id: r.id, label: r.label, text: r.text, triggerType: r.trigger_type, triggerAt: r.trigger_at,
    triggerDays: parseJSON(r.trigger_days, []), triggerTime: r.trigger_time, nextRun: r.next_run,
    active: !!r.active, hasMedia: !!r.media_path, targets: parseJSON(r.targets, []),
  })));
});

router.post('/schedules', deviceAuth, memeFields, asyncHandler(async (req, res) => {
  const channel = channelOf(req);
  const f = req.files || {};
  const result = await createSchedule({
    channel, device: req.device, owner: ownerOf(req.device),
    label: req.body.label || '',
    text: req.body.text || '',
    mediaBuffer: f.media?.[0]?.buffer || null,
    overlayBuffer: f.overlay?.[0]?.buffer || null,
    soundBuffers: (f.sound || []).map((x) => x.buffer),
    layerBuffers: (f.layers || []).map((x) => x.buffer),
    comp: parseJSON(req.body.comp, null),
    soundAssets: assetSoundInfos(req.device, req.body),
    options: parseJSON(req.body.options, {}),
    groupNames: parseJSON(req.body.groups, []).map(String),
    mentions: parseJSON(req.body.mentions, []).map(String),
    trigger: parseJSON(req.body.trigger, {}),
  });
  res.status(201).json(result);
}));

router.delete('/schedules/:id', deviceAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ? AND channel_id = ? AND owner = ?')
    .get(req.params.id, req.device.channel_id, ownerOf(req.device));
  if (row) {
    // Le média a déjà été transcodé et écrit sur disque à la création (options.__prepared) :
    // s'il n'a jamais été diffusé, il n'est référencé par aucun meme et doit être nettoyé ici.
    removeMediaFile(row.media_path);
    const options = parseJSON(row.options, {});
    for (const p of soundPathsOf(options)) removeMediaFile(p);
    removeMediaFile(row.sound_path);   // schedules d'avant le multi-son
    if (options.overlayPath) removeMediaFile(options.overlayPath);
    db.prepare('DELETE FROM schedules WHERE id = ?').run(row.id);
  }
  res.json({ ok: true });
});

export default router;
