import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db, now, audit, getChannelSettings } from '../db.js';
import { config } from '../config.js';
import { panelAuth, requireStaff } from '../auth.js';
import { createAndDispatchMeme, signMediaUrl, approveMeme, rejectMeme, resendMeme } from '../memeService.js';
import { processMedia } from '../media.js';
import { deleteAllMemes, removeMediaFile, soundPathsOf } from '../retention.js';
import { asyncHandler, loadChannel } from './helpers.js';

// Monté sur /api/channels/:channelId/
const router = Router({ mergeParams: true });
router.use(panelAuth, requireStaff);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
const ALLOWED_EMOJI = ['😂', '❤️', '🔥', '💀', '👏', '😮', '👎', '🤡'];

// Envoi d'un meme depuis le panel (modérateur/admin).
router.post('/meme', loadChannel, upload.single('media'), asyncHandler(async (req, res) => {
  const parseJSON = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  const result = await createAndDispatchMeme({
    channel: req.channel,
    source: 'panel',
    sender: `panel:${req.user.username}`,
    senderName: req.user.username,
    text: req.body.text || '',
    mediaBuffer: req.file?.buffer || null,
    groupNames: parseJSON(req.body.groups, []),
    mentions: parseJSON(req.body.mentions, []),
    options: parseJSON(req.body.options, {}),
    isModerator: true,
  });
  res.status(201).json(result);
}));

// Historique — avec filtres avancés (#12) et receipts/réactions (#2/#6).
router.get('/memes', loadChannel, asyncHandler((req, res) => {
  const { limit, offset, status, type, sender, q, from, to } = z.object({
    limit: z.coerce.number().min(1).max(100).default(30),
    offset: z.coerce.number().min(0).default(0),
    status: z.enum(['sent', 'blocked', 'removed', 'pending', 'all']).default('all'),
    type: z.enum(['image', 'gif', 'video', 'audio', 'text', 'all']).default('all'),
    sender: z.string().max(80).optional().default(''),
    q: z.string().max(120).optional().default(''),
    from: z.coerce.number().optional(),
    to: z.coerce.number().optional(),
  }).parse(req.query);

  const cond = ['channel_id = @cid'];
  const params = { cid: req.channel.id, limit, offset };
  if (status !== 'all') { cond.push('status = @status'); params.status = status; }
  if (type !== 'all') { cond.push('type = @type'); params.type = type; }
  if (sender) { cond.push('(sender = @sender OR sender_name LIKE @senderLike)'); params.sender = sender; params.senderLike = `%${sender}%`; }
  if (q) { cond.push('text LIKE @q'); params.q = `%${q}%`; }
  if (Number.isFinite(from)) { cond.push('created_at >= @from'); params.from = from; }
  if (Number.isFinite(to)) { cond.push('created_at <= @to'); params.to = to; }

  const rows = db.prepare(`SELECT * FROM memes WHERE ${cond.join(' AND ')}
      ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all(params);

  // Receipts + réactions agrégés pour les memes retournés (une requête chacun).
  const ids = rows.map((m) => m.id);
  const receipts = {}; const reactions = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT meme_id, status, COUNT(*) c FROM meme_receipts WHERE meme_id IN (${ph}) GROUP BY meme_id, status`).all(...ids)) {
      (receipts[r.meme_id] ||= {})[r.status] = r.c;
    }
    for (const r of db.prepare(`SELECT meme_id, emoji, COUNT(*) c FROM meme_reactions WHERE meme_id IN (${ph}) GROUP BY meme_id, emoji`).all(...ids)) {
      (reactions[r.meme_id] ||= {})[r.emoji] = r.c;
    }
  }

  res.json(rows.map((m) => ({
    ...m,
    targets: JSON.parse(m.targets || '[]'),
    options: JSON.parse(m.options || '{}'),
    mediaUrl: m.media_path ? signMediaUrl(m.media_path) : null,
    receipts: receipts[m.id] || {},
    reactions: reactions[m.id] || {},
  })));
}));

// Détail des accusés de réception d'un meme (#2).
router.get('/memes/:memeId/receipts', loadChannel, asyncHandler((req, res) => {
  const m = db.prepare('SELECT id FROM memes WHERE id = ? AND channel_id = ?').get(req.params.memeId, req.channel.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const receipts = db.prepare('SELECT device_id, name, status, detail, created_at FROM meme_receipts WHERE meme_id = ? ORDER BY created_at').all(m.id);
  const reactions = db.prepare('SELECT device_id, name, emoji, created_at FROM meme_reactions WHERE meme_id = ? ORDER BY created_at').all(m.id);
  res.json({ receipts, reactions });
}));

// Classement / statistiques par membre (#14).
router.get('/leaderboard', loadChannel, asyncHandler((req, res) => {
  const { days } = z.object({ days: z.coerce.number().min(0).max(365).default(30) }).parse(req.query);
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  const cid = req.channel.id;

  const topSenders = db.prepare(`SELECT sender, MAX(sender_name) name, COUNT(*) c FROM memes
      WHERE channel_id = ? AND status = 'sent' AND created_at >= ? GROUP BY sender ORDER BY c DESC LIMIT 20`).all(cid, since);
  const topReceivers = db.prepare(`SELECT discord_id, MAX(name) name, COUNT(*) c FROM meme_receipts
      WHERE channel_id = ? AND status = 'displayed' AND created_at >= ? GROUP BY device_id ORDER BY c DESC LIMIT 20`).all(cid, since);
  const topReacted = db.prepare(`SELECT m.id, m.text, m.type, m.sender_name, COUNT(*) c FROM meme_reactions r
      JOIN memes m ON m.id = r.meme_id
      WHERE r.channel_id = ? AND r.created_at >= ? GROUP BY r.meme_id ORDER BY c DESC LIMIT 10`).all(cid, since);
  const byType = db.prepare(`SELECT type, COUNT(*) c FROM memes
      WHERE channel_id = ? AND status = 'sent' AND created_at >= ? GROUP BY type ORDER BY c DESC`).all(cid, since);
  const totals = {
    sent: db.prepare("SELECT COUNT(*) c FROM memes WHERE channel_id = ? AND status = 'sent' AND created_at >= ?").get(cid, since).c,
    reactions: db.prepare('SELECT COUNT(*) c FROM meme_reactions WHERE channel_id = ? AND created_at >= ?').get(cid, since).c,
    displays: db.prepare("SELECT COUNT(*) c FROM meme_receipts WHERE channel_id = ? AND status = 'displayed' AND created_at >= ?").get(cid, since).c,
  };
  res.json({ days, topSenders, topReceivers, topReacted, byType, totals });
}));

// Validation / rejet d'un meme en attente de revue manuelle (moderationMode = 'review').
router.post('/memes/:memeId/approve', loadChannel, asyncHandler(async (req, res) => {
  const r = await approveMeme(req.channel, req.params.memeId, req.user.username);
  res.json(r);
}));

router.post('/memes/:memeId/reject', loadChannel, asyncHandler((req, res) => {
  const r = rejectMeme(req.channel, req.params.memeId, req.user.username);
  res.json(r);
}));

// Renvoie un meme déjà envoyé sans re-upload (réutilise le média déjà transcodé).
router.post('/memes/:memeId/resend', loadChannel, asyncHandler(async (req, res) => {
  const r = await resendMeme(req.channel, req.params.memeId, `panel:${req.user.username}`, req.user.username);
  res.status(201).json(r);
}));

// Retrait d'un meme (modération) : supprime le fichier média.
router.delete('/memes/:memeId', loadChannel, asyncHandler((req, res) => {
  const m = db.prepare('SELECT * FROM memes WHERE id = ? AND channel_id = ?').get(req.params.memeId, req.channel.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  removeMediaFile(m.media_path);
  const options = JSON.parse(m.options || '{}');
  if (options.overlayPath) removeMediaFile(options.overlayPath);
  for (const p of soundPathsOf(options)) removeMediaFile(p);
  db.prepare("UPDATE memes SET status = 'removed', media_path = NULL WHERE id = ?").run(m.id);
  audit(req.user.username, 'meme.remove', { channel: req.channel.slug, meme: m.id });
  res.json({ ok: true });
}));

// --- Hall of Memes : memes les plus marquants (les plus réagis) ----------
// Filtrable par période (days) et par type de réaction (emoji).
router.get('/hall', loadChannel, asyncHandler((req, res) => {
  const { days, emoji, limit } = z.object({
    days: z.coerce.number().min(0).max(3650).default(30),
    emoji: z.string().max(8).optional().default(''),
    limit: z.coerce.number().min(1).max(50).default(12),
  }).parse(req.query);
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  const cid = req.channel.id;
  const byEmoji = emoji && ALLOWED_EMOJI.includes(emoji);

  // Compte les réactions (filtrées éventuellement par emoji) et classe les memes.
  const rows = db.prepare(`
    SELECT m.id, m.type, m.text, m.sender, m.sender_name, m.media_path, m.media_mime, m.created_at, m.options,
           COUNT(*) c
    FROM meme_reactions r JOIN memes m ON m.id = r.meme_id
    WHERE r.channel_id = @cid AND r.created_at >= @since AND m.status = 'sent'
      ${byEmoji ? 'AND r.emoji = @emoji' : ''}
    GROUP BY r.meme_id
    ORDER BY c DESC, m.created_at DESC
    LIMIT @limit
  `).all({ cid, since, emoji, limit });

  const ids = rows.map((m) => m.id);
  const breakdown = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT meme_id, emoji, COUNT(*) c FROM meme_reactions WHERE meme_id IN (${ph}) GROUP BY meme_id, emoji`).all(...ids)) {
      (breakdown[r.meme_id] ||= {})[r.emoji] = r.c;
    }
  }
  res.json({
    days, emoji: byEmoji ? emoji : '',
    memes: rows.map((m) => ({
      id: m.id, type: m.type, text: m.text, sender: m.sender, senderName: m.sender_name,
      createdAt: m.created_at, count: m.c,
      mediaUrl: m.media_path ? signMediaUrl(m.media_path) : null,
      reactions: breakdown[m.id] || {},
    })),
  });
}));

// --- Profil de membre (#10) : galerie, stats, réactions reçues, appareils, blocages.
router.get('/members/:memberId/profile', loadChannel, asyncHandler((req, res) => {
  const cid = req.channel.id;
  const memberId = String(req.params.memberId);
  // Un membre est identifié par son discord_id ; on retrouve aussi ses envois via
  // sender (qui vaut discord_id quand l'appareil est lié à un compte Discord).
  const wl = db.prepare('SELECT discord_id, discord_username, role, can_send, banned, note, created_at FROM whitelist WHERE channel_id = ? AND discord_id = ?')
    .get(cid, memberId);

  const memes = db.prepare(`SELECT * FROM memes WHERE channel_id = ? AND sender = ? AND status = 'sent'
      ORDER BY created_at DESC LIMIT 60`).all(cid, memberId);
  const gallery = memes.map((m) => ({
    id: m.id, type: m.type, text: m.text, createdAt: m.created_at,
    mediaUrl: m.media_path ? signMediaUrl(m.media_path) : null,
  }));

  const stats = {
    sent: db.prepare("SELECT COUNT(*) c FROM memes WHERE channel_id = ? AND sender = ? AND status = 'sent'").get(cid, memberId).c,
    blocked: db.prepare("SELECT COUNT(*) c FROM memes WHERE channel_id = ? AND sender = ? AND status = 'blocked'").get(cid, memberId).c,
    // Réactions reçues : réactions sur les memes envoyés par ce membre.
    reactionsReceived: db.prepare(`SELECT COUNT(*) c FROM meme_reactions r JOIN memes m ON m.id = r.meme_id
        WHERE m.channel_id = ? AND m.sender = ?`).get(cid, memberId).c,
    // Affichages confirmés de ses memes chez les destinataires.
    displays: db.prepare(`SELECT COUNT(*) c FROM meme_receipts rc JOIN memes m ON m.id = rc.meme_id
        WHERE m.channel_id = ? AND m.sender = ? AND rc.status = 'displayed'`).get(cid, memberId).c,
    // Réactions envoyées par ce membre (via ses appareils liés).
    reactionsGiven: db.prepare('SELECT COUNT(*) c FROM meme_reactions WHERE channel_id = ? AND discord_id = ?').get(cid, memberId).c,
  };

  // Répartition des emojis reçus.
  const reactionsBreakdown = {};
  for (const r of db.prepare(`SELECT r.emoji, COUNT(*) c FROM meme_reactions r JOIN memes m ON m.id = r.meme_id
      WHERE m.channel_id = ? AND m.sender = ? GROUP BY r.emoji ORDER BY c DESC`).all(cid, memberId)) {
    reactionsBreakdown[r.emoji] = r.c;
  }

  const devices = db.prepare('SELECT id, name, last_seen, revoked, created_at FROM devices WHERE channel_id = ? AND discord_id = ? ORDER BY created_at DESC')
    .all(cid, memberId);

  // Blocages posés par ce membre (via un de ses appareils ou son discord_id).
  const deviceOwners = devices.map((d) => `device:${d.id}`);
  const owners = [memberId, ...deviceOwners];
  const ph = owners.map(() => '?').join(',');
  const blocks = db.prepare(`SELECT DISTINCT blocked_id, blocked_name, created_at FROM member_blocks
      WHERE channel_id = ? AND owner IN (${ph}) ORDER BY created_at DESC`).all(cid, ...owners);

  res.json({
    member: wl || { discord_id: memberId, discord_username: '', role: 'user', can_send: 1, banned: 0 },
    stats, reactionsBreakdown, gallery,
    devices: devices.map((d) => ({ id: d.id, name: d.name, lastSeen: d.last_seen, revoked: !!d.revoked, createdAt: d.created_at })),
    blocks: blocks.map((b) => ({ senderId: b.blocked_id, name: b.blocked_name, createdAt: b.created_at })),
  });
}));

// --- Soundboard partagé du channel (#4) : curé par les modérateurs -------
// Stocké dans assets avec owner = 'channel'. data = { category, sharedBy }.
const SHARED_OWNER = 'channel';
router.get('/soundboard', loadChannel, asyncHandler((req, res) => {
  const rows = db.prepare("SELECT * FROM assets WHERE channel_id = ? AND owner = ? AND kind = 'sound' ORDER BY created_at DESC")
    .all(req.channel.id, SHARED_OWNER);
  const parse = (v) => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
  res.json(rows.map((a) => ({
    id: a.id, name: a.name, sizeMb: +((a.media_size || 0) / 1048576).toFixed(2),
    url: a.media_path ? signMediaUrl(a.media_path) : null, mime: a.media_mime,
    data: parse(a.data), createdAt: a.created_at,
  })));
}));

router.post('/soundboard', loadChannel, upload.single('media'), asyncHandler(async (req, res) => {
  const s = getChannelSettings(req.channel);
  if (!req.file?.buffer) return res.status(400).json({ error: 'Fichier audio requis.' });
  const media = await processMedia(req.file.buffer, { ...s, allowedTypes: ['audio'] });
  const id = nanoid(14);
  const data = { category: (req.body.category || '').toString().slice(0, 40), sharedBy: req.user.username };
  db.prepare(`INSERT INTO assets (id, channel_id, owner, owner_name, kind, name, media_path, media_mime, media_size, data, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.channel.id, SHARED_OWNER, req.user.username, 'sound', (req.body.name || 'Son partagé').toString().slice(0, 80),
      media.relPath, media.mime, media.size || 0, JSON.stringify(data), now());
  audit(req.user.username, 'soundboard.add', { channel: req.channel.slug, id });
  res.status(201).json({ id });
}));

router.patch('/soundboard/:id', loadChannel, asyncHandler((req, res) => {
  const row = db.prepare("SELECT * FROM assets WHERE id = ? AND channel_id = ? AND owner = ? AND kind = 'sound'")
    .get(req.params.id, req.channel.id, SHARED_OWNER);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const body = z.object({ name: z.string().max(80).optional(), category: z.string().max(40).optional() }).parse(req.body);
  let data = {}; try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  if (body.category !== undefined) data.category = body.category;
  const name = body.name !== undefined ? body.name : row.name;
  db.prepare('UPDATE assets SET name = ?, data = ? WHERE id = ?').run(name, JSON.stringify(data), row.id);
  res.json({ ok: true });
}));

router.delete('/soundboard/:id', loadChannel, asyncHandler((req, res) => {
  const row = db.prepare("SELECT * FROM assets WHERE id = ? AND channel_id = ? AND owner = ? AND kind = 'sound'")
    .get(req.params.id, req.channel.id, SHARED_OWNER);
  if (row) { removeMediaFile(row.media_path); db.prepare('DELETE FROM assets WHERE id = ?').run(row.id); audit(req.user.username, 'soundboard.remove', { channel: req.channel.slug, id: row.id }); }
  res.json({ ok: true });
}));

// Supprime TOUT l'historique du channel (médias inclus).
router.post('/purge', loadChannel, asyncHandler((req, res) => {
  const n = deleteAllMemes(req.channel.id);
  audit(req.user.username, 'memes.purge.channel', { channel: req.channel.slug, deleted: n });
  res.json({ deleted: n });
}));

export default router;
