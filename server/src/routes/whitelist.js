import { Router } from 'express';
import { z } from 'zod';
import { db, now, audit } from '../db.js';
import { panelAuth, requireChannelStaff } from '../auth.js';
import { asyncHandler, loadChannel } from './helpers.js';

// Monté sur /api/channels/:channelId/whitelist
const router = Router({ mergeParams: true });
router.use(panelAuth, loadChannel, requireChannelStaff);

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM whitelist WHERE channel_id = ? ORDER BY role DESC, discord_username')
    .all(req.channel.id));
});

// Comptes ayant lié leur Discord à l'app (connexion Discord) — pour les
// ajouter à la whitelist d'un clic, sans copier d'ID à la main.
router.get('/discord-users', (req, res) => {
  const rows = db.prepare("SELECT discord_id, discord_username, discord_avatar FROM users WHERE discord_id IS NOT NULL AND discord_id != ''").all();
  const inList = new Set(db.prepare('SELECT discord_id FROM whitelist WHERE channel_id = ?').all(req.channel.id).map((r) => r.discord_id));
  res.json(rows.map((r) => ({
    discordId: r.discord_id,
    username: r.discord_username || r.discord_id,
    avatarUrl: r.discord_avatar ? `https://cdn.discordapp.com/avatars/${r.discord_id}/${r.discord_avatar}.png?size=64` : null,
    alreadyListed: inList.has(r.discord_id),
  })));
});

router.post('/', asyncHandler((req, res) => {
  const b = z.object({
    discordId: z.string().regex(/^\d{5,25}$/, 'Invalid Discord ID'),
    discordUsername: z.string().max(80).optional().default(''),
    role: z.enum(['user', 'moderator']).default('user'),
    canSend: z.boolean().default(true),
    note: z.string().max(200).optional().default(''),
  }).parse(req.body);
  const exists = db.prepare('SELECT id FROM whitelist WHERE channel_id = ? AND discord_id = ?')
    .get(req.channel.id, b.discordId);
  if (exists) return res.status(409).json({ error: 'Already on the whitelist' });
  const info = db.prepare(`INSERT INTO whitelist
      (channel_id, discord_id, discord_username, role, can_send, note, added_by, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(req.channel.id, b.discordId, b.discordUsername, b.role, b.canSend ? 1 : 0, b.note, req.user.username, now());
  audit(req.user.username, 'whitelist.add', { channel: req.channel.slug, discordId: b.discordId });
  res.status(201).json(db.prepare('SELECT * FROM whitelist WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/:wid', asyncHandler((req, res) => {
  const b = z.object({
    discordUsername: z.string().max(80).optional(),
    role: z.enum(['user', 'moderator']).optional(),
    canSend: z.boolean().optional(),
    banned: z.boolean().optional(),
    note: z.string().max(200).optional(),
    features: z.record(z.boolean()).optional(),
  }).parse(req.body);
  const row = db.prepare('SELECT * FROM whitelist WHERE id = ? AND channel_id = ?').get(req.params.wid, req.channel.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE whitelist SET
      discord_username = COALESCE(?, discord_username),
      role = COALESCE(?, role),
      can_send = COALESCE(?, can_send),
      banned = COALESCE(?, banned),
      note = COALESCE(?, note),
      features = COALESCE(?, features)
      WHERE id = ?`)
    .run(b.discordUsername ?? null, b.role ?? null,
      b.canSend === undefined ? null : (b.canSend ? 1 : 0),
      b.banned === undefined ? null : (b.banned ? 1 : 0),
      b.note ?? null, b.features === undefined ? null : JSON.stringify(b.features), row.id);
  audit(req.user.username, 'whitelist.update', { channel: req.channel.slug, discordId: row.discord_id });
  res.json(db.prepare('SELECT * FROM whitelist WHERE id = ?').get(row.id));
}));

router.delete('/:wid', asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM whitelist WHERE id = ? AND channel_id = ?').get(req.params.wid, req.channel.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM whitelist WHERE id = ?').run(row.id);
  audit(req.user.username, 'whitelist.remove', { channel: req.channel.slug, discordId: row.discord_id });
  res.json({ ok: true });
}));

export default router;
