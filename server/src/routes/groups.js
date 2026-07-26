import { Router } from 'express';
import { z } from 'zod';
import { db, now, audit } from '../db.js';
import { panelAuth, requireChannelStaff } from '../auth.js';
import { asyncHandler, loadChannel } from './helpers.js';

// Monté sur /api/channels/:channelId/groups
const router = Router({ mergeParams: true });
router.use(panelAuth, loadChannel, requireChannelStaff);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM mention_groups WHERE channel_id = ? ORDER BY name').all(req.channel.id);
  res.json(rows.map((r) => ({ ...r, members: JSON.parse(r.members || '[]'), features: JSON.parse(r.features || '{}') })));
});

const bodySchema = z.object({
  name: z.string().min(1).max(60),
  members: z.array(z.string().regex(/^\d{5,25}$/)).max(200),
  features: z.record(z.boolean()).optional().default({}),
});

router.post('/', asyncHandler((req, res) => {
  const b = bodySchema.parse(req.body);
  if (db.prepare('SELECT 1 FROM mention_groups WHERE channel_id = ? AND name = ?').get(req.channel.id, b.name)) {
    return res.status(409).json({ error: 'Un groupe porte déjà ce nom' });
  }
  const info = db.prepare('INSERT INTO mention_groups (channel_id, name, members, features, created_at) VALUES (?,?,?,?,?)')
    .run(req.channel.id, b.name, JSON.stringify([...new Set(b.members)]), JSON.stringify(b.features || {}), now());
  audit(req.user.username, 'group.create', { channel: req.channel.slug, name: b.name });
  const r = db.prepare('SELECT * FROM mention_groups WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...r, members: JSON.parse(r.members), features: JSON.parse(r.features || '{}') });
}));

router.put('/:gid', asyncHandler((req, res) => {
  const b = bodySchema.parse(req.body);
  const row = db.prepare('SELECT * FROM mention_groups WHERE id = ? AND channel_id = ?').get(req.params.gid, req.channel.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE mention_groups SET name = ?, members = ?, features = ? WHERE id = ?')
    .run(b.name, JSON.stringify([...new Set(b.members)]), JSON.stringify(b.features || {}), row.id);
  audit(req.user.username, 'group.update', { channel: req.channel.slug, name: b.name });
  const r = db.prepare('SELECT * FROM mention_groups WHERE id = ?').get(row.id);
  res.json({ ...r, members: JSON.parse(r.members), features: JSON.parse(r.features || '{}') });
}));

router.delete('/:gid', asyncHandler((req, res) => {
  const row = db.prepare('SELECT * FROM mention_groups WHERE id = ? AND channel_id = ?').get(req.params.gid, req.channel.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM mention_groups WHERE id = ?').run(row.id);
  audit(req.user.username, 'group.delete', { channel: req.channel.slug, name: row.name });
  res.json({ ok: true });
}));

export default router;
