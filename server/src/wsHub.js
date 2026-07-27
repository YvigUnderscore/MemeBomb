// ============================================================
//  Hub WebSocket — pousse les memes vers les clients en temps réel,
//  et pousse les événements de modération vers le panel.
//
//  Deux points de terminaison :
//   • /ws        → clients desktop (auth par token d'appareil). Reçoivent les
//                  memes ; renvoient des accusés de réception (#2) et des
//                  réactions (#6).
//   • /ws-panel  → panel web (auth par cookie de session JWT). Reçoit en
//                  temps réel les événements (nouveau meme, en attente,
//                  bloqué, signalement, réaction, accusé) (#4).
// ============================================================

import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { authenticateDevice, verifySessionUser } from './auth.js';
import { config } from './config.js';
import { db, now } from './db.js';
import { logger } from './logger.js';

/** Map<channelId, Set<ws>> — connexions des appareils. */
const byChannel = new Map();
/** Set<ws> — connexions du panel. */
const panelConns = new Set();

// --- Blocages personnels (#15) : cache mémoire par channel -----------------
/** Map<channelId, Map<owner, Set<blockedId>>> */
const blockCache = new Map();
function loadChannelBlocks(channelId) {
  const map = new Map();
  const rows = db.prepare('SELECT owner, blocked_id FROM member_blocks WHERE channel_id = ?').all(channelId);
  for (const r of rows) {
    if (!map.has(r.owner)) map.set(r.owner, new Set());
    map.get(r.owner).add(String(r.blocked_id));
  }
  blockCache.set(channelId, map);
  return map;
}
function getChannelBlocks(channelId) {
  return blockCache.get(channelId) || loadChannelBlocks(channelId);
}
export function invalidateBlocks(channelId) { blockCache.delete(channelId); }

// --- Quota par destinataire (#10) : fenêtre glissante en mémoire ------------
const recvWindows = new Map(); // key: channelId:deviceId -> number[]
function underReceiveQuota(channelId, deviceId, perMinute) {
  if (!perMinute || perMinute <= 0) return true;
  const key = `${channelId}:${deviceId}`;
  const arr = (recvWindows.get(key) || []).filter((t) => now() - t < 60000);
  if (arr.length >= perMinute) { recvWindows.set(key, arr); return false; }
  arr.push(now());
  recvWindows.set(key, arr);
  return true;
}

const ownerKeyOf = (ws) => ws.discordId || `device:${ws.deviceId}`;

// --- Warmup expéditeur : depuis quand chaque membre est-il en ligne ? -------
// Sert à empêcher le « lance l'app, envoie un meme, ferme » : un meme n'est
// diffusé que si son expéditeur est connecté depuis senderWarmupS secondes.
/** Map<channelId, Map<ownerKey, ts première connexion de la session>> */
const onlineSinceMap = new Map();

/** Timestamp de début de la session en ligne d'un membre, ou null. */
export function onlineSince(channelId, ownerKey) {
  return onlineSinceMap.get(channelId)?.get(String(ownerKey)) ?? null;
}

// --- Présence : qui est là, et joignable ? ---------------------------------
// Le serveur ne connaît de lui-même que les sockets ouverts. « Ne pas déranger »
// et « overlay coupé » ne vivent que dans le client, qui les publie par un
// message `status` (à l'ouverture puis à chaque changement). Un client d'avant
// cette fonctionnalité n'en envoie jamais : il compte simplement comme joignable.
function applyStatus(ws, msg) {
  const until = Number(msg.dndUntil);
  ws.status = {
    dnd: !!msg.dnd,
    dndUntil: Number.isFinite(until) && until > 0 ? until : 0,
    overlay: msg.overlay !== false,
  };
}

// Une échéance dépassée ne compte plus : le client peut être resté silencieux
// depuis (veille, socket inactif), on n'attend pas sa prochaine publication.
function dndActive(st) {
  if (!st?.dnd) return false;
  return !st.dndUntil || now() < st.dndUntil;
}

/**
 * État de présence d'un channel, agrégé par propriétaire — un membre peut avoir
 * plusieurs appareils connectés. Il n'est injoignable que si TOUS le sont : un
 * seul écran disponible suffit à ce qu'il voie passer le meme.
 * @returns {Array<{ownerKey, discordId, status, dndUntil, devices, since}>}
 */
export function channelPresence(channelId) {
  const byOwner = new Map();
  for (const ws of byChannel.get(channelId) || []) {
    if (ws.readyState !== ws.OPEN) continue;
    const key = ownerKeyOf(ws);
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(ws);
  }
  return [...byOwner].map(([ownerKey, conns]) => {
    const dnd = conns.every((ws) => dndActive(ws.status));
    // Le DND du membre cesse à la première échéance de ses appareils ; une
    // échéance nulle (« jusqu'à réactivation ») n'en fixe aucune.
    const untils = conns.map((ws) => ws.status?.dndUntil || 0).filter((u) => u > 0);
    const overlayOff = conns.every((ws) => ws.status && ws.status.overlay === false);
    return {
      ownerKey,
      discordId: conns[0].discordId || '',
      status: dnd ? 'dnd' : overlayOff ? 'off' : 'online',
      dndUntil: dnd && untils.length ? Math.min(...untils) : 0,
      devices: conns.length,
      since: onlineSince(channelId, ownerKey) || 0,
    };
  });
}

function addConn(ws) {
  const set = byChannel.get(ws.channelId) || new Set();
  set.add(ws);
  byChannel.set(ws.channelId, set);
  const m = onlineSinceMap.get(ws.channelId) || new Map();
  if (!m.has(ownerKeyOf(ws))) m.set(ownerKeyOf(ws), now());
  onlineSinceMap.set(ws.channelId, m);
}
function removeConn(ws) {
  const set = byChannel.get(ws.channelId);
  if (set) { set.delete(ws); if (set.size === 0) byChannel.delete(ws.channelId); }
  // Plus aucun appareil de ce propriétaire connecté → sa session en ligne s'arrête.
  const owner = ownerKeyOf(ws);
  const remaining = [...(byChannel.get(ws.channelId) || [])].some((peer) => ownerKeyOf(peer) === owner);
  if (!remaining) onlineSinceMap.get(ws.channelId)?.delete(owner);
}

// --- Enregistrement des accusés / réactions --------------------------------
// Envoie un message à tous les appareils d'un channel dont le propriétaire
// correspond (ex. : les appareils de l'expéditeur d'un meme).
function sendToOwner(channelId, ownerKey, obj) {
  const set = byChannel.get(channelId);
  if (!set || !ownerKey) return;
  const data = JSON.stringify(obj);
  for (const peer of set) {
    if (peer.readyState !== peer.OPEN) continue;
    if (ownerKeyOf(peer) === String(ownerKey)) { try { peer.send(data); } catch { /* ignore */ } }
  }
}

function recordReceipt(ws, memeId, status, detail = '') {
  const m = db.prepare('SELECT channel_id, sender FROM memes WHERE id = ?').get(memeId);
  if (!m || m.channel_id !== ws.channelId) return;
  db.prepare(`INSERT INTO meme_receipts (meme_id, channel_id, device_id, discord_id, name, status, detail, created_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(meme_id, device_id) DO UPDATE SET status=excluded.status, detail=excluded.detail, created_at=excluded.created_at`)
    .run(memeId, ws.channelId, ws.deviceId, ws.discordId || '', ws.deviceName || '', String(status).slice(0, 20), String(detail).slice(0, 200), now());
  pushPanel('receipt', { memeId, channelId: ws.channelId, deviceId: ws.deviceId, status });
  // « Vu par » (#1) : quand un destinataire AFFICHE réellement le meme, on prévient
  // les appareils de l'expéditeur (pseudo du spectateur). On ne notifie pas pour
  // les non-affichages (skipped/dnd/throttled) et jamais l'expéditeur de lui-même.
  if (status === 'displayed' && String(m.sender) !== ownerKeyOf(ws)) {
    sendToOwner(ws.channelId, m.sender, {
      type: 'seen', memeId, by: ws.deviceName || '', at: now(),
    });
  }
}

const ALLOWED_EMOJI = ['😂', '❤️', '🔥', '💀', '👏', '😮', '👎', '🤡'];

// Un appareil ne peut réagir qu'à un meme qu'il a réellement reçu : soit il en a
// déjà accusé réception (affiché), soit il faisait partie des destinataires
// (ciblage explicite ou diffusion à tout le channel). Rend la cible non ambiguë
// et empêche de réagir à un memeId arbitraire (#3).
function deviceReceivedMeme(ws, meme) {
  const r = db.prepare('SELECT 1 FROM meme_receipts WHERE meme_id = ? AND device_id = ?').get(meme.id, ws.deviceId);
  if (r) return true;
  let targets = [];
  try { targets = JSON.parse(meme.targets || '[]').map(String); } catch { /* ignore */ }
  if (targets.length === 0) return true;                       // diffusé à tout le channel
  return !!(ws.discordId && targets.includes(String(ws.discordId)));
}

function handleReaction(ws, memeId, emoji) {
  if (!ALLOWED_EMOJI.includes(emoji)) return;
  const m = db.prepare('SELECT id, channel_id, sender, targets FROM memes WHERE id = ?').get(memeId);
  if (!m || m.channel_id !== ws.channelId) return;
  if (!deviceReceivedMeme(ws, m)) return;                      // cible invalide → ignore

  // Toggle : la même réaction du même appareil s'annule.
  const existing = db.prepare('SELECT 1 FROM meme_reactions WHERE meme_id = ? AND device_id = ? AND emoji = ?')
    .get(memeId, ws.deviceId, emoji);
  const before = totalReactions(memeId);
  if (existing) {
    db.prepare('DELETE FROM meme_reactions WHERE meme_id = ? AND device_id = ? AND emoji = ?').run(memeId, ws.deviceId, emoji);
  } else {
    db.prepare(`INSERT INTO meme_reactions (meme_id, channel_id, device_id, discord_id, name, emoji, created_at)
        VALUES (?,?,?,?,?,?,?)`)
      .run(memeId, ws.channelId, ws.deviceId, ws.discordId || '', ws.deviceName || '', emoji, now());
  }
  const counts = reactionCounts(memeId);
  const after = Object.values(counts).reduce((a, b) => a + b, 0);
  // Notifie l'expéditeur (ses appareils) que son meme a reçu une réaction.
  sendToOwner(ws.channelId, m.sender, { type: 'reaction', memeId, emoji, from: ws.deviceName || '', by: ownerKeyOf(ws), counts });
  pushPanel('reaction', { memeId, channelId: ws.channelId, emoji, counts });

  // Effets de seuil (#7) : uniquement à la hausse (ajout d'une réaction).
  if (after > before) maybeCelebrate(ws.channelId, m, after);
}

function totalReactions(memeId) {
  return db.prepare('SELECT COUNT(*) c FROM meme_reactions WHERE meme_id = ?').get(memeId).c;
}

// --- Effets de seuil de réactions (#7) --------------------------------------
// Mémoire du plus haut palier déjà fêté par meme (évite les doublons de confettis).
const milestoneFired = new Map(); // memeId -> highest threshold fired

function channelMilestoneConfig(channelId) {
  const c = db.prepare('SELECT settings FROM channels WHERE id = ?').get(channelId);
  let s = {};
  try { s = JSON.parse(c?.settings || '{}'); } catch { s = {}; }
  const enabled = s.celebrateEffects !== false;
  let thresholds = Array.isArray(s.reactionMilestones) ? s.reactionMilestones : [5, 10, 25];
  thresholds = thresholds.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  return { enabled, thresholds };
}

function maybeCelebrate(channelId, meme, total) {
  const { enabled, thresholds } = channelMilestoneConfig(channelId);
  if (!enabled || thresholds.length === 0) return;
  // Plus haut palier atteint par le total courant.
  let reached = 0;
  for (const t of thresholds) { if (total >= t) reached = t; }
  if (reached === 0) return;
  const prev = milestoneFired.get(meme.id) || 0;
  if (reached <= prev) return;                                 // déjà fêté ce palier
  milestoneFired.set(meme.id, reached);
  broadcastToChannel(channelId, {
    type: 'milestone', memeId: meme.id, threshold: reached, total,
    sender: db.prepare('SELECT sender_name FROM memes WHERE id = ?').get(meme.id)?.sender_name || '',
  });
  pushPanel('milestone', { channelId, memeId: meme.id, threshold: reached, total });
}

// Diffuse un événement brut à TOUS les appareils connectés d'un channel.
export function broadcastToChannel(channelId, obj) {
  const set = byChannel.get(channelId);
  if (!set || set.size === 0) return 0;
  const data = JSON.stringify(obj);
  let n = 0;
  for (const ws of set) {
    if (ws.readyState !== ws.OPEN) continue;
    try { ws.send(data); n++; } catch { /* ignore */ }
  }
  return n;
}

export function reactionCounts(memeId) {
  const rows = db.prepare('SELECT emoji, COUNT(*) c FROM meme_reactions WHERE meme_id = ? GROUP BY emoji').all(memeId);
  const out = {};
  for (const r of rows) out[r.emoji] = r.c;
  return out;
}

// --- Panel push (#4) --------------------------------------------------------
export function pushPanel(type, data) {
  if (panelConns.size === 0) return;
  const payload = JSON.stringify({ type, ...data, ts: now() });
  for (const ws of panelConns) {
    if (ws.userRole === 'member') continue; // les membres ne reçoivent pas les événements de modération
    if (ws.readyState === ws.OPEN) { try { ws.send(payload); } catch { /* ignore */ } }
  }
}

// Anti-CSWSH : le handshake panel est refusé si l'Origin est cross-site.
// Un client non-navigateur (sans Origin) est autorisé — il ne peut pas voler le cookie d'un tiers.
function sameOriginWs(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost;
  try { originHost = new URL(origin).host; } catch { return false; }
  const allowed = new Set();
  try { allowed.add(new URL(config.publicUrl).host); } catch { /* ignore */ }
  if (req.headers.host) allowed.add(req.headers.host);
  return allowed.has(originHost);
}

function verifyPanelCookie(req) {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)md_session=([^;]+)/.exec(cookie);
  if (!m) return null;
  // Même contrôle que l'API REST, révocation comprise : sans cela un cookie
  // révoqué (logout-all, changement de mot de passe) restait recevable ici et
  // continuait de recevoir les événements de modération en temps réel.
  return verifySessionUser(decodeURIComponent(m[1]));
}

/**
 * Ferme les connexions panel d'un compte (ou toutes si userId est null).
 * Le handshake n'authentifie qu'à l'ouverture : sans cette coupure, une session
 * révoquée garderait son flux d'événements jusqu'à déconnexion réseau.
 */
export function closePanelSessions(userId = null) {
  let n = 0;
  for (const ws of [...panelConns]) {
    if (userId != null && ws.userId !== userId) continue;
    try { ws.close(4001, 'session revoked'); } catch { /* ignore */ }
    panelConns.delete(ws);
    n++;
  }
  return n;
}

export function initWebSocket(server) {
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const panelWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  // Routage manuel de l'upgrade selon le chemin.
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* ignore */ }
    if (pathname === '/ws') {
      // Appareils : auth par token opaque (pas de cookie) → non exploitable en CSWSH.
      deviceWss.handleUpgrade(req, socket, head, (ws) => deviceWss.emit('connection', ws, req));
    } else if (pathname === '/ws-panel') {
      // Panel : auth par cookie de session → vulnérable au WebSocket hijacking cross-site.
      // On refuse tout handshake dont l'Origin (envoyé par les navigateurs) est cross-site.
      if (!sameOriginWs(req)) { socket.destroy(); return; }
      panelWss.handleUpgrade(req, socket, head, (ws) => panelWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  // --- Appareils --------------------------------------------------------
  deviceWss.on('connection', (ws, req) => {
    let token = '';
    try {
      const u = new URL(req.url, 'http://localhost');
      token = u.searchParams.get('token') || '';
    } catch { /* ignore */ }
    if (!token && req.headers['x-device-token']) token = String(req.headers['x-device-token']);

    const device = authenticateDevice(token);
    if (!device) {
      ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' }));
      ws.close(4001, 'unauthorized');
      return;
    }

    ws.deviceId = device.id;
    ws.deviceName = device.name || '';
    ws.channelId = device.channel_id;
    ws.discordId = device.discord_id || '';
    ws.isAlive = true;
    addConn(ws);
    logger.debug(`WS connecté device#${device.id} channel#${device.channel_id}`);
    ws.send(JSON.stringify({ type: 'hello', deviceId: device.id, channelId: device.channel_id }));

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString().slice(0, 8192)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); return; }
      if (msg.type === 'ack' && msg.memeId) {
        recordReceipt(ws, String(msg.memeId), String(msg.status || 'displayed'), msg.detail);
        return;
      }
      if (msg.type === 'reaction' && msg.memeId && msg.emoji) {
        handleReaction(ws, String(msg.memeId), String(msg.emoji));
        return;
      }
      if (msg.type === 'status') { applyStatus(ws, msg); return; }
    });
    ws.on('close', () => removeConn(ws));
    ws.on('error', () => removeConn(ws));
  });

  // --- Panel ------------------------------------------------------------
  panelWss.on('connection', (ws, req) => {
    const user = verifyPanelCookie(req);
    if (!user) { ws.close(4001, 'unauthorized'); return; }
    ws.isAlive = true;
    ws.userId = user.id;
    ws.userRole = user.role;
    panelConns.add(ws);
    ws.send(JSON.stringify({ type: 'hello', user }));
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString().slice(0, 2048)); } catch { return; }
      if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
    });
    ws.on('close', () => panelConns.delete(ws));
    ws.on('error', () => panelConns.delete(ws));
  });

  // Heartbeat : ferme les connexions mortes (appareils + panel).
  const interval = setInterval(() => {
    for (const set of byChannel.values()) {
      for (const ws of set) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }
    for (const ws of panelConns) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  deviceWss.on('close', () => clearInterval(interval));

  return { deviceWss, panelWss };
}

/**
 * Diffuse un événement (meme) à un channel.
 * Applique les blocages personnels (#15) et le quota par destinataire (#10).
 * @param {number} channelId
 * @param {object} payload      doit contenir payload.meme.{id, senderId}
 * @param {string[]|null} targets  liste de discord_id ; null/[] = tout le channel
 * @returns {number} nombre de clients réellement touchés
 */
export function broadcast(channelId, payload, targets = null) {
  const set = byChannel.get(channelId);
  if (!set || set.size === 0) return 0;
  const data = JSON.stringify(payload);
  const targeted = Array.isArray(targets) && targets.length > 0;
  const targetSet = targeted ? new Set(targets.map(String)) : null;

  const meme = payload.meme || {};
  const senderId = meme.senderId != null ? String(meme.senderId) : '';
  const memeId = meme.id;
  const perMinute = receiveQuotaFor(channelId);
  const blocks = getChannelBlocks(channelId);

  let n = 0;
  for (const ws of set) {
    if (ws.readyState !== ws.OPEN) continue;
    if (targeted && !(ws.discordId && targetSet.has(String(ws.discordId)))) continue;
    // Blocage personnel : ce destinataire a masqué cet expéditeur.
    if (senderId) {
      const owner = ownerKeyOf(ws);
      const blockedSet = blocks.get(owner);
      if (blockedSet && blockedSet.has(senderId)) continue;
    }
    // Quota anti-spam par destinataire.
    if (!underReceiveQuota(channelId, ws.deviceId, perMinute)) {
      if (memeId) { try { recordReceipt(ws, memeId, 'throttled', 'quota destinataire'); } catch { /* ignore */ } }
      continue;
    }
    try { ws.send(data); n++; } catch { /* ignore */ }
  }
  return n;
}

// Lit le quota de réception configuré pour un channel (settings JSON).
function receiveQuotaFor(channelId) {
  const c = db.prepare('SELECT settings FROM channels WHERE id = ?').get(channelId);
  if (!c) return 0;
  try {
    const s = JSON.parse(c.settings || '{}');
    return Number.isFinite(+s.maxReceivesPerMinute) ? +s.maxReceivesPerMinute : 20;
  } catch { return 20; }
}

export function channelStats() {
  const out = {};
  for (const [cid, set] of byChannel) out[cid] = set.size;
  return out;
}

export function onlineCount(channelId) {
  return byChannel.get(channelId)?.size || 0;
}
