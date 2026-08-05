// ============================================================
//  Service central d'envoi de meme.
//  Utilisé par : bot Discord, éditeur desktop (via API), panel web.
//  Étapes : validation whitelist → modération texte → média → cibles → diffusion.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { db, now, getChannelSettings, audit } from './db.js';
import { config } from './config.js';
import { checkText } from './moderation.js';
import { processMedia, probeStoredMedia, storeComposedVideo, HttpError } from './media.js';
import { composeLayers } from './composer.js';
import { removeMediaFile, soundPathsOf } from './retention.js';
import { broadcast, onlineCount, onlineSince, pushPanel } from './wsHub.js';
import { assertFeature } from './features.js';
import { postMemeFeed } from './discordManager.js'; // cycle ESM ok (déclarations de fonctions)
import { logger } from './logger.js';

// Fenêtre glissante en mémoire pour le rate-limit par expéditeur.
const rateWindows = new Map(); // key: channelId:sender -> number[]

function checkRate(channelId, sender, perMinute) {
  if (!perMinute || perMinute <= 0) return true;
  const key = `${channelId}:${sender}`;
  const arr = (rateWindows.get(key) || []).filter((t) => now() - t < 60000);
  if (arr.length >= perMinute) { rateWindows.set(key, arr); return false; }
  arr.push(now());
  rateWindows.set(key, arr);
  return true;
}

/** Signe une URL média (capacité à durée limitée). */
export function signMediaUrl(relPath) {
  const token = jwt.sign({ f: relPath }, config.jwtSecret, { expiresIn: '2h' });
  return `${config.publicUrl}/media/${encodeURIComponent(relPath)}?t=${token}`;
}

export function verifyMediaToken(relPath, token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return p.f === relPath;
  } catch { return false; }
}

/** URL CDN de l'avatar Discord de l'expéditeur (null si pas un compte Discord). */
export function senderAvatarUrl(channelId, senderId) {
  const s = String(senderId || '');
  // Envoi depuis l'éditeur du panel : avatar Discord du COMPTE PANEL, si lié.
  if (s.startsWith('panel:')) {
    const u = db.prepare('SELECT discord_id, discord_avatar FROM users WHERE username = ?').get(s.slice(6));
    if (u?.discord_id && u?.discord_avatar) return `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.discord_avatar}.png?size=64`;
    return null; // pas de compte Discord lié → pastille initiale côté client
  }
  if (!/^\d{5,}$/.test(s)) return null; // pas un id Discord (appareil non lié)
  const w = db.prepare('SELECT discord_avatar FROM whitelist WHERE channel_id = ? AND discord_id = ?')
    .get(channelId, s);
  if (w?.discord_avatar) return `https://cdn.discordapp.com/avatars/${s}/${w.discord_avatar}.png?size=64`;
  // La whitelist ne connaît pas le hash, mais le compte panel du membre peut-être
  // (connexion Discord au panel) : même humain, même avatar.
  const u = db.prepare('SELECT discord_avatar FROM users WHERE discord_id = ?').get(s);
  if (u?.discord_avatar) return `https://cdn.discordapp.com/avatars/${s}/${u.discord_avatar}.png?size=64`;
  // Hash d'avatar inconnu (membre qui n'a jamais utilisé une commande du bot) :
  // avatar Discord PAR DÉFAUT, déterministe par id — l'overlay a toujours une image.
  try { return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(s) >> 22n) % 6n)}.png`; } catch { return null; }
}

const HEX_RX = /^#[0-9a-fA-F]{6}$/;
/** Style du pseudo choisi par l'expéditeur (profil) : couleur + glow. */
export function senderStyle(channelId, senderId) {
  const s = String(senderId || '');
  let w = null;
  if (s.startsWith('panel:')) {
    w = db.prepare('SELECT name_color, name_glow FROM users WHERE username = ?').get(s.slice(6));
  } else if (/^\d{5,}$/.test(s)) {
    w = db.prepare('SELECT name_color, name_glow FROM whitelist WHERE channel_id = ? AND discord_id = ?')
      .get(channelId, s);
  } else return {};
  return {
    senderColor: HEX_RX.test(w?.name_color || '') ? w.name_color : null,
    senderGlow: HEX_RX.test(w?.name_glow || '') ? w.name_glow : null,
  };
}

/** Republie le meme dans les salons feed Discord (fire-and-forget). */
function feedMeme(channel, { targets, groupNames, senderName, text, media }) {
  postMemeFeed(channel, {
    targets, groupNames: groupNames || [], senderName, text,
    mediaAbsPath: media?.relPath ? path.join(config.mediaDir, path.basename(media.relPath)) : null,
  }).catch(() => {});
}

// Sons attachés à un meme : plusieurs fichiers et/ou assets de bibliothèque,
// joués ensemble à l'apparition. Plafonné pour borner le transcodage et le
// nombre de fichiers que le destinataire doit télécharger.
export const MAX_SOUNDS = 4;

/**
 * Transcode / copie les sons d'un envoi. Accepte les formes multiples
 * (soundBuffers, soundAssets) comme les anciennes (soundBuffer, soundAsset).
 */
export async function prepareSounds(channel, p, settings) {
  const buffers = (p.soundBuffers || (p.soundBuffer ? [p.soundBuffer] : [])).filter((b) => b?.length);
  const assets = (p.soundAssets || (p.soundAsset ? [p.soundAsset] : [])).filter((a) => a?.relPath);
  if (!buffers.length && !assets.length) return [];
  assertFeature(channel, p.sender ?? p.owner, 'sounds', 'Sons personnalisés');

  const out = [];
  for (const buf of buffers.slice(0, MAX_SOUNDS)) {
    out.push(await processMedia(buf, { ...settings, allowedTypes: ['audio'] }));
  }
  for (const a of assets.slice(0, Math.max(0, MAX_SOUNDS - out.length))) {
    // Son de la bibliothèque (#13) : déjà transcodé, on le copie sans le re-traiter.
    const rel = copyMediaFile(a.relPath);
    if (rel) out.push({ relPath: rel, mime: a.mime || 'audio/mp4', durationMs: 0 });
  }
  return out;
}

/** Inscrit les sons dans les options (soundPath = 1er son, lu par les clients d'avant le multi-son). */
export function applySoundOptions(options, sounds) {
  if (!sounds?.length) return options;
  options.soundPaths = sounds.map((s) => s.relPath);
  options.soundPath = sounds[0].relPath;
  return options;
}

/** Bloc `sound`/`sounds` du payload WebSocket, à partir des chemins stockés. */
function soundPayload(paths, durations = []) {
  const list = paths.map((relPath, i) => ({ url: signMediaUrl(relPath), durationMs: durations[i] || 0 }));
  return { sound: list[0] || null, sounds: list };
}

/** Résout la liste de discord_id destinataires à partir de groupes + mentions. */
export function resolveTargets(channelId, { groupNames = [], mentions = [] }) {
  const ids = new Set(mentions.map(String).filter(Boolean));
  for (const g of groupNames) {
    const row = db.prepare('SELECT members FROM mention_groups WHERE channel_id = ? AND name = ?')
      .get(channelId, g);
    if (row) {
      try { JSON.parse(row.members).forEach((id) => ids.add(String(id))); } catch { /* ignore */ }
    }
  }
  // Filtre : on ne cible que des membres whitelistés non bannis.
  const out = [];
  for (const id of ids) {
    const w = db.prepare('SELECT banned FROM whitelist WHERE channel_id = ? AND discord_id = ?')
      .get(channelId, id);
    if (w && !w.banned) out.push(id);
  }
  return out;
}

/**
 * @param {object} p
 * @param {object} p.channel      ligne channel
 * @param {string} p.source       'discord' | 'editor' | 'panel'
 * @param {string} p.sender       discord_id ou identifiant panel
 * @param {string} p.senderName
 * @param {string} [p.text]
 * @param {Buffer} [p.mediaBuffer]
 * @param {object} [p.mediaAsset] média déjà transcodé (bibliothèque) : { relPath, mime, size, type }
 * @param {string[]} [p.groupNames]
 * @param {string[]} [p.mentions]
 * @param {object} [p.options]    position/taille/durée/volume/opacité...
 * @param {boolean} [p.isModerator] contourne certaines limites
 */
export async function createAndDispatchMeme(p) {
  const channel = p.channel;
  if (!channel || !channel.active) throw new HttpError(404, 'Channel not found or disabled.');
  const settings = getChannelSettings(channel);

  // 1. Whitelist / droit d'envoi (source Discord, ou éditeur lié à un compte Discord).
  if (p.source === 'discord' || (p.source === 'editor' && p.discordId)) {
    const w = db.prepare('SELECT * FROM whitelist WHERE channel_id = ? AND discord_id = ?')
      .get(channel.id, String(p.discordId || p.sender));
    if (p.source === 'discord' && !w) throw new HttpError(403, 'You are not on this channel\'s whitelist.');
    if (w) {
      // Un bannissement / retrait du droit d'envoi s'applique partout, pas seulement sur Discord.
      if (w.banned) throw new HttpError(403, 'You are banned from this channel.');
      if (!w.can_send) throw new HttpError(403, 'You are not allowed to send memes.');
      p.isModerator = p.isModerator || w.role === 'moderator';
    }
  }
  if (p.source === 'editor' && !settings.allowEditorSend) {
    throw new HttpError(403, 'Sending from the editor is disabled on this channel.');
  }

  // 2. Rate limit.
  if (!p.isModerator && !checkRate(channel.id, p.sender, settings.rateLimitPerMinute)) {
    throw new HttpError(429, 'Too many memes sent, try again in a moment.');
  }

  // 3. Modération du texte.
  const mod = checkText(p.text || '', {
    extraBanned: settings.bannedWords || [],
    maxLength: settings.maxTextLength || 280,
  });
  if (settings.moderationMode !== 'off' && !mod.allowed) {
    // Journalise un meme bloqué pour la modération.
    const blockedId = nanoid(12);
    db.prepare(`INSERT INTO memes (id, channel_id, sender, sender_name, source, type, text, targets, options, status, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(blockedId, channel.id, String(p.sender), p.senderName || '', p.source, p.text ? 'text' : 'image',
        p.text || '', '[]', '{}', 'blocked', now());
    audit(p.sender, 'meme.blocked', { channel: channel.slug, matches: mod.matches });
    pushPanel('meme.blocked', { channelId: channel.id, channel: channel.slug, sender: p.senderName || p.sender });
    throw new HttpError(422, mod.reason);
  }
  const text = mod.sanitized;

  // 4. Média (optionnel) + feature-flags.
  // Composition multi-calques (éditeur) : fond + vidéos/gifs transformés +
  // overlay statique → une seule vidéo. Fond couleur → MP4 (repasse par
  // processMedia) ; fond « Aucun » → WebM alpha stocké tel quel (le
  // ré-encodage h264 détruirait la transparence).
  let media = null;
  if (p.layerBuffers && p.layerBuffers.length) {
    assertFeature(channel, p.sender, 'video', 'Vidéos/GIF');
    const composed = await composeLayers(p.layerBuffers, p.comp || {}, p.overlayBuffer, settings);
    p.overlayBuffer = null; // gravé dans la vidéo composée
    if (composed.transparent) media = await storeComposedVideo(composed.buffer, composed.mime);
    else p.mediaBuffer = composed.buffer;
  }
  if (!media && p.mediaBuffer && p.mediaBuffer.length) {
    media = await processMedia(p.mediaBuffer, settings);
    if (media.type === 'video' || media.type === 'gif') assertFeature(channel, p.sender, 'video', 'Vidéos/GIF');
    if (media.type === 'audio') assertFeature(channel, p.sender, 'audio', 'Sons');
  } else if (!media && p.mediaAsset && p.mediaAsset.relPath) {
    // Meme de la bibliothèque : média déjà transcodé (donc déjà passé par
    // processMedia à l'enregistrement), on le copie sans le re-traiter.
    const rel = copyMediaFile(p.mediaAsset.relPath);
    if (!rel) throw new HttpError(404, 'The saved media no longer exists.');
    const type = p.mediaAsset.type || 'image';
    const probed = await probeStoredMedia(path.join(config.mediaDir, rel), p.mediaAsset.mime);
    media = {
      type, relPath: rel, mime: p.mediaAsset.mime, size: p.mediaAsset.size || 0, ...probed,
      loop: type === 'gif', muted: type === 'gif',
    };
    if (type === 'video' || type === 'gif') assertFeature(channel, p.sender, 'video', 'Vidéos/GIF');
    if (type === 'audio') assertFeature(channel, p.sender, 'audio', 'Sons');
  }
  // Overlay (éléments composés au-dessus d'une vidéo).
  let overlay = null;
  if (p.overlayBuffer && p.overlayBuffer.length) {
    overlay = await processMedia(p.overlayBuffer, { ...settings, allowedTypes: ['image'] });
  }
  // Sons additionnels joués à l'apparition (fichiers et/ou assets de la
  // bibliothèque), tous mixés ensemble chez le destinataire.
  const sounds = await prepareSounds(channel, p, settings);
  if (!media && !text) throw new HttpError(400, 'A meme needs at least media or text.');

  // 5. Cibles.
  const targets = resolveTargets(channel.id, {
    groupNames: p.groupNames || [],
    mentions: p.mentions || [],
  });

  // 6. Options d'affichage (bornées).
  const options = sanitizeOptions(p.options || {}, settings, media, sounds);
  if (overlay) options.overlayPath = overlay.relPath;
  applySoundOptions(options, sounds);
  // Mémorise les groupes ciblés (feed Discord des memes sortis de la file).
  if (p.groupNames?.length) options.__groups = p.groupNames.slice(0, 10).map(String);

  // 6bis. Revue manuelle : un envoi non-modérateur passé le filtre auto est
  // retenu (statut 'pending') en attente d'une validation depuis le panel,
  // au lieu d'être diffusé immédiatement.
  const needsReview = settings.moderationMode === 'review' && !p.isModerator;

  // 6ter. Warmup expéditeur : anti « lance l'app, envoie, ferme ». Le meme
  // n'est diffusé que si l'expéditeur est en ligne depuis senderWarmupS ;
  // sinon il est mis en file (statut 'queued') et part à la fin du warmup.
  // Modérateurs/admins et comptes panel (déjà staff) bypassent.
  const warmupS = Math.max(0, Number(settings.senderWarmupS ?? 0) || 0);
  let needsWarmup = false;
  if (!needsReview && warmupS > 0 && !p.isModerator && !String(p.sender).startsWith('panel:')) {
    const since = onlineSince(channel.id, String(p.sender));
    needsWarmup = !since || (now() - since) < warmupS * 1000;
  }

  // 7. Persistance.
  const id = nanoid(14);
  const status = needsReview ? 'pending' : needsWarmup ? 'queued' : 'sent';
  db.prepare(`INSERT INTO memes
      (id, channel_id, sender, sender_name, source, type, text, media_path, media_mime, media_size, targets, options, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, channel.id, String(p.sender), p.senderName || '', p.source,
      media ? media.type : 'text', text, media?.relPath || null, media?.mime || null,
      media?.size || null, JSON.stringify(targets), JSON.stringify(options), status, now());

  if (needsReview) {
    audit(p.sender, 'meme.pending', { id, channel: channel.slug });
    pushPanel('meme.pending', { channelId: channel.id, channel: channel.slug, sender: p.senderName || p.sender });
    return { id, pending: true, delivered: 0, online: onlineCount(channel.id), targets };
  }

  if (needsWarmup) {
    const since = onlineSince(channel.id, String(p.sender));
    const remainS = since ? Math.ceil((warmupS * 1000 - (now() - since)) / 1000) : null;
    audit(p.sender, 'meme.queued', { id, channel: channel.slug, remainS });
    pushPanel('meme.queued', { channelId: channel.id, channel: channel.slug, sender: p.senderName || p.sender });
    return { id, queued: true, warmupRemainS: remainS, delivered: 0, online: onlineCount(channel.id), targets };
  }

  // 8. Diffusion temps réel.
  const payload = {
    type: 'meme',
    meme: {
      id,
      channel: channel.slug,
      kind: media ? media.type : 'text',
      text,
      sender: p.senderName || p.sender,
      senderId: String(p.sender),
      senderAvatar: senderAvatarUrl(channel.id, p.sender),
      ...senderStyle(channel.id, p.sender),
      media: media ? {
        url: signMediaUrl(media.relPath),
        mime: media.mime,
        width: media.width,
        height: media.height,
        durationMs: media.durationMs,
        loop: !!media.loop,
        muted: !!media.muted,
      } : null,
      overlay: overlay ? { url: signMediaUrl(overlay.relPath) } : null,
      ...soundPayload(sounds.map((s) => s.relPath), sounds.map((s) => s.durationMs)),
      options,
      ts: now(),
    },
  };
  const delivered = broadcast(channel.id, payload, targets.length ? targets : null);
  // Feed Discord (#22) : memes publics → salon du channel ; groupes → salon du groupe.
  feedMeme(channel, { targets, groupNames: p.groupNames, senderName: payload.meme.sender, text, media });
  logger.info(`Meme ${id} (${payload.meme.kind}) → channel ${channel.slug} : ${delivered} client(s), cibles=${targets.length || 'tous'}`);
  audit(p.sender, 'meme.sent', { id, channel: channel.slug, kind: payload.meme.kind, delivered });
  pushPanel('meme.sent', { channelId: channel.id, channel: channel.slug, id, kind: payload.meme.kind, sender: p.senderName || p.sender, delivered });

  return { id, delivered, online: onlineCount(channel.id), targets, meme: payload.meme };
}

/**
 * Diffuse un meme déjà préparé (fichiers stockés) — utilisé par le scheduler,
 * sans re-transcodage. mediaInfo/overlayInfo = { relPath, ... }, soundInfos = [{ relPath, ... }].
 */
export function dispatchPrepared(channel, { sender, senderName, text, mediaInfo, overlayInfo, soundInfos, soundInfo, options, targets }) {
  const soundList = (soundInfos || (soundInfo ? [soundInfo] : [])).filter((s) => s?.relPath);
  const id = nanoid(14);
  const kind = mediaInfo ? mediaInfo.type : 'text';
  db.prepare(`INSERT INTO memes
      (id, channel_id, sender, sender_name, source, type, text, media_path, media_mime, media_size, targets, options, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, channel.id, String(sender), senderName || '', 'schedule', kind, text || '',
      mediaInfo?.relPath || null, mediaInfo?.mime || null, mediaInfo?.size || null,
      JSON.stringify(targets || []), JSON.stringify(options || {}), 'sent', now());
  const payload = {
    type: 'meme',
    meme: {
      id, channel: channel.slug, kind, text: text || '', sender: senderName || sender, senderId: String(sender),
      senderAvatar: senderAvatarUrl(channel.id, sender),
      ...senderStyle(channel.id, sender),
      media: mediaInfo ? {
        url: signMediaUrl(mediaInfo.relPath), mime: mediaInfo.mime, width: mediaInfo.width,
        height: mediaInfo.height, durationMs: mediaInfo.durationMs, loop: !!mediaInfo.loop, muted: !!mediaInfo.muted,
      } : null,
      overlay: overlayInfo ? { url: signMediaUrl(overlayInfo.relPath) } : null,
      ...soundPayload(soundList.map((s) => s.relPath), soundList.map((s) => s.durationMs)),
      options: options || {}, ts: now(),
    },
  };
  const delivered = broadcast(channel.id, payload, (targets && targets.length) ? targets : null);
  audit(sender, 'meme.scheduled.sent', { id, channel: channel.slug, delivered });
  return { id, delivered };
}

/**
 * Ré-analyse le média déjà transcodé d'un meme stocké en base (largeur/hauteur/
 * durée ne sont pas persistées) — utilisé pour re-diffuser un meme existant
 * (validation d'une revue manuelle, ou renvoi depuis l'historique).
 */
async function hydrateStoredMedia(m) {
  const options = JSON.parse(m.options || '{}');
  let media = null;
  if (m.media_path) {
    const abs = path.join(config.mediaDir, path.basename(m.media_path));
    const probed = await probeStoredMedia(abs, m.media_mime);
    media = {
      relPath: m.media_path, mime: m.media_mime, ...probed,
      loop: m.type === 'gif', muted: m.type === 'gif',
    };
  }
  return { media, options };
}

function buildMemePayload(id, channel, m, media, options) {
  delete options.__groups; // interne (feed Discord), jamais exposé aux clients
  return {
    type: 'meme',
    meme: {
      id, channel: channel.slug, kind: m.type, text: m.text, sender: m.sender_name || m.sender, senderId: String(m.sender),
      senderAvatar: senderAvatarUrl(channel.id, m.sender),
      ...senderStyle(channel.id, m.sender),
      media: media ? {
        url: signMediaUrl(media.relPath), mime: media.mime, width: media.width, height: media.height,
        durationMs: media.durationMs, loop: media.loop, muted: media.muted,
      } : null,
      overlay: options.overlayPath ? { url: signMediaUrl(options.overlayPath) } : null,
      ...soundPayload(soundPathsOf(options)),
      options, ts: now(),
    },
  };
}

/**
 * Diffuse les memes en file d'attente (warmup expéditeur) dont l'expéditeur
 * est désormais en ligne depuis assez longtemps. Appelé périodiquement.
 */
export async function dispatchQueuedMemes() {
  const rows = db.prepare("SELECT * FROM memes WHERE status = 'queued' ORDER BY created_at ASC LIMIT 50").all();
  for (const m of rows) {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND active = 1').get(m.channel_id);
    if (!channel) { db.prepare("UPDATE memes SET status = 'removed' WHERE id = ?").run(m.id); continue; }
    const settings = getChannelSettings(channel);
    const warmupS = Math.max(0, Number(settings.senderWarmupS ?? 0) || 0);
    // Prêt si l'expéditeur est en ligne depuis warmupS — OU si le meme attend
    // depuis warmupS (garantie de livraison : un expéditeur qui ferme l'app ou
    // dont le WS a coupé ne doit pas laisser son meme bloqué en file à jamais).
    const since = onlineSince(channel.id, String(m.sender));
    const senderReady = !!since && (now() - since) >= warmupS * 1000;
    const waitedFull = (now() - m.created_at) >= warmupS * 1000;
    if (warmupS > 0 && !senderReady && !waitedFull) continue; // pas encore prêt
    try {
      const { media, options } = await hydrateStoredMedia(m);
      const groupNames = options.__groups || [];
      delete options.__groups; // interne, jamais envoyé aux clients
      const targets = JSON.parse(m.targets || '[]');
      db.prepare("UPDATE memes SET status = 'sent' WHERE id = ?").run(m.id);
      const payload = buildMemePayload(m.id, channel, m, media, options);
      const delivered = broadcast(channel.id, payload, targets.length ? targets : null);
      feedMeme(channel, { targets, groupNames, senderName: m.sender_name || m.sender, text: m.text, media });
      logger.info(`Meme ${m.id} sorti de la file (warmup) → ${delivered} client(s)`);
      audit(m.sender, 'meme.dequeued', { id: m.id, channel: channel.slug, delivered });
      pushPanel('meme.sent', { channelId: channel.id, channel: channel.slug, id: m.id, kind: m.type, sender: m.sender_name || m.sender, delivered });
    } catch (e) {
      logger.error('File warmup:', e.message);
      db.prepare("UPDATE memes SET status = 'removed' WHERE id = ?").run(m.id);
    }
  }
}

/** Valide un meme en attente de revue manuelle : diffusion différée. */
export async function approveMeme(channel, memeId, moderator) {
  const m = db.prepare('SELECT * FROM memes WHERE id = ? AND channel_id = ?').get(memeId, channel.id);
  if (!m) throw new HttpError(404, 'Meme not found.');
  if (m.status !== 'pending') throw new HttpError(409, 'This meme is not pending review.');

  const { media, options } = await hydrateStoredMedia(m);
  const targets = JSON.parse(m.targets || '[]');
  db.prepare("UPDATE memes SET status = 'sent' WHERE id = ?").run(m.id);

  const payload = buildMemePayload(m.id, channel, m, media, options);
  const delivered = broadcast(channel.id, payload, targets.length ? targets : null);
  audit(moderator || 'moderator', 'meme.approve', { id: m.id, channel: channel.slug, delivered });
  return { id: m.id, delivered };
}

// Copie un fichier média existant sous un nouveau nom (null si absent/illisible).
export function copyMediaFile(relPath) {
  if (!relPath) return null;
  const dest = `${nanoid(16)}${path.extname(relPath)}`;
  try {
    fs.copyFileSync(path.join(config.mediaDir, path.basename(relPath)), path.join(config.mediaDir, dest));
    return dest;
  } catch { return null; }
}

/** Renvoie un meme déjà envoyé, sans re-upload (ré-encodage) : copie le(s) fichier(s) déjà transcodé(s). */
export async function resendMeme(channel, memeId, moderatorSender, moderatorName) {
  const m = db.prepare('SELECT * FROM memes WHERE id = ? AND channel_id = ?').get(memeId, channel.id);
  if (!m) throw new HttpError(404, 'Meme not found.');
  if (m.status !== 'sent') throw new HttpError(409, 'Only an already-sent meme can be re-sent.');
  if (!m.media_path && !m.text) throw new HttpError(400, 'Nothing to re-send.');

  // Copie physique de chaque fichier référencé : un meme doit rester propriétaire
  // exclusif de son média, sinon supprimer l'original ou le renvoi casserait l'autre.
  let mediaPath = null;
  if (m.media_path) {
    mediaPath = copyMediaFile(m.media_path);
    if (!mediaPath) throw new HttpError(404, 'The original media no longer exists, this meme cannot be re-sent.');
  }
  const options = JSON.parse(m.options || '{}');
  if (options.overlayPath) options.overlayPath = copyMediaFile(options.overlayPath);
  const copiedSounds = soundPathsOf(options).map((p) => copyMediaFile(p)).filter(Boolean);
  delete options.soundPath; delete options.soundPaths;
  applySoundOptions(options, copiedSounds.map((relPath) => ({ relPath })));

  const row = { ...m, media_path: mediaPath, options: JSON.stringify(options) };
  const { media } = await hydrateStoredMedia(row);
  const targets = JSON.parse(m.targets || '[]');
  const id = nanoid(14);
  db.prepare(`INSERT INTO memes
      (id, channel_id, sender, sender_name, source, type, text, media_path, media_mime, media_size, targets, options, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, channel.id, String(moderatorSender), moderatorName || '', 'panel', m.type, m.text,
      mediaPath, m.media_mime, m.media_size, JSON.stringify(targets), JSON.stringify(options), 'sent', now());

  const payload = buildMemePayload(id, channel, row, media, options);
  const delivered = broadcast(channel.id, payload, targets.length ? targets : null);
  audit(moderatorSender, 'meme.resend', { channel: channel.slug, from: m.id, id, delivered });
  return { id, delivered, online: onlineCount(channel.id) };
}

/** Rejette un meme en attente de revue manuelle : supprime son média, ne diffuse jamais. */
export function rejectMeme(channel, memeId, moderator) {
  const m = db.prepare('SELECT * FROM memes WHERE id = ? AND channel_id = ?').get(memeId, channel.id);
  if (!m) throw new HttpError(404, 'Meme not found.');
  if (m.status !== 'pending') throw new HttpError(409, 'This meme is not pending review.');

  const options = JSON.parse(m.options || '{}');
  removeMediaFile(m.media_path);
  if (options.overlayPath) removeMediaFile(options.overlayPath);
  for (const p of soundPathsOf(options)) removeMediaFile(p);

  db.prepare("UPDATE memes SET status = 'removed', media_path = NULL WHERE id = ?").run(m.id);
  audit(moderator || 'moderator', 'meme.reject', { id: m.id, channel: channel.slug });
  return { ok: true };
}

const clamp = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

/** Borne les options d'affichage envoyées par le client/bot (jamais de confiance aveugle). */
export function sanitizeOptions(o, settings, media, sounds = []) {
  const kind = media ? media.type : 'text';
  let maxDur = {
    image: settings.maxImageDurationS || 8,
    gif: settings.maxGifDurationS || 10,
    video: settings.maxVideoDurationS || 15,
    audio: settings.maxAudioDurationS || 15,
    text: settings.maxImageDurationS || 8,
  }[kind];
  // Un meme qui porte des sons dure au moins ce que dure un son : sans ça une
  // image accompagnée d'un son de 12 s était ramenée au plafond des images
  // (8 s) et le son se faisait couper. Le plafond des sons reste le maximum.
  if (sounds?.length) maxDur = Math.max(maxDur, settings.maxAudioDurationS || 15);
  return {
    // Emplacement/anchor sur l'écran du destinataire (le client borne aussi).
    anchor: ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']
      .includes(o.anchor) ? o.anchor : 'center',
    scale: clamp(o.scale, 0.1, 1, 0.5),                 // fraction de l'écran
    durationS: clamp(o.durationS, 0.5, maxDur, Math.min(maxDur, media?.durationMs ? media.durationMs / 1000 : 5)),
    volume: clamp(o.volume, 0, 1, settings.defaultVolume ?? 0.7),
    opacity: clamp(o.opacity, 0.1, 1, settings.defaultOpacity ?? 0.95),
    textPos: ['top', 'bottom', 'center'].includes(o.textPos) ? o.textPos : 'bottom',
    textColor: /^#[0-9a-fA-F]{6}$/.test(o.textColor || '') ? o.textColor : '#ffffff',
    animation: ['none', 'fade', 'slide', 'bounce', 'shake'].includes(o.animation) ? o.animation : 'fade',
    // Durées des animations d'entrée/sortie (ms), plafonnées par le channel.
    animInMs: clamp(o.animInMs, 80, settings.maxAnimMs || 1500, 350),
    animOutMs: clamp(o.animOutMs, 80, settings.maxAnimMs || 1500, 350),
    // Image déjà composée dans l'éditeur : le texte est intégré au média,
    // on ne le ré-affiche pas en surimpression côté client.
    bakedText: !!o.bakedText,
    // Cadre libre 16/9 défini par l'expéditeur (page de placement avant envoi).
    box: (o.box && Number.isFinite(+o.box.wPct)) ? {
      xPct: clamp(o.box.xPct, 0, 1, 0.29),
      yPct: clamp(o.box.yPct, 0, 1, 0.29),
      wPct: clamp(o.box.wPct, 0.02, 1, 0.42),
    } : null,
  };
}
