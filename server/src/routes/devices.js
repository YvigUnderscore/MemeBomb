import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, now, audit } from '../db.js';
import { panelAuth, requireChannelStaff } from '../auth.js';
import { invalidateBlocks } from '../wsHub.js';
import { asyncHandler, loadChannel } from './helpers.js';

// Monté sur /api/channels/:channelId/devices
const router = Router({ mergeParams: true });
router.use(panelAuth, loadChannel, requireChannelStaff);

// Code d'appairage lisible (évite 0/O, 1/I).
function makePairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

router.get('/', (req, res) => {
  res.json(db.prepare(`SELECT id, name, discord_id, last_seen, revoked, created_at
      FROM devices WHERE channel_id = ? ORDER BY created_at DESC`).all(req.channel.id));
});

router.post('/pair-code', asyncHandler((req, res) => {
  const b = z.object({
    label: z.string().max(60).optional().default(''),
    discordId: z.string().regex(/^\d{5,25}$/).optional().or(z.literal('')).default(''),
    ttlMinutes: z.number().min(1).max(1440).optional().default(30),
  }).parse(req.body);
  const code = makePairingCode();
  const expires = now() + b.ttlMinutes * 60000;
  db.prepare('INSERT INTO pairing_codes (code, channel_id, discord_id, label, expires_at, created_at) VALUES (?,?,?,?,?,?)')
    .run(code, req.channel.id, b.discordId || '', b.label, expires, now());
  audit(req.user.username, 'device.paircode', { channel: req.channel.slug, code });
  res.status(201).json({ code, expiresAt: expires, channel: req.channel.slug });
}));

router.patch('/:did', asyncHandler((req, res) => {
  const b = z.object({
    name: z.string().max(60).optional(),
    discordId: z.string().regex(/^\d{5,25}$/).optional().or(z.literal('')),
  }).parse(req.body);
  const dev = db.prepare('SELECT * FROM devices WHERE id = ? AND channel_id = ?').get(req.params.did, req.channel.id);
  if (!dev) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE devices SET name = COALESCE(?, name), discord_id = COALESCE(?, discord_id) WHERE id = ?')
    .run(b.name ?? null, b.discordId ?? null, dev.id);
  // Lier l'appareil change son propriétaire logique (device:<id> → discord_id) :
  // on migre ses possessions pour que sa bibliothèque, ses planifications et ses
  // blocages suivent la nouvelle identité au lieu de devenir orphelins.
  if (b.discordId !== undefined && b.discordId !== '' && !dev.owner && !dev.discord_id) {
    const from = `device:${dev.id}`;
    db.prepare('UPDATE assets SET owner = ? WHERE channel_id = ? AND owner = ?').run(b.discordId, req.channel.id, from);
    db.prepare('UPDATE schedules SET owner = ? WHERE channel_id = ? AND owner = ?').run(b.discordId, req.channel.id, from);
    // OR IGNORE : la PK (channel, owner, blocked) peut déjà exister sous la nouvelle identité.
    db.prepare('UPDATE OR IGNORE member_blocks SET owner = ? WHERE channel_id = ? AND owner = ?').run(b.discordId, req.channel.id, from);
    invalidateBlocks(req.channel.id);
  }
  audit(req.user.username, 'device.link', { channel: req.channel.slug, device: dev.id, discordId: b.discordId ?? null });
  res.json({ ok: true });
}));

router.delete('/:did', asyncHandler((req, res) => {
  const dev = db.prepare('SELECT * FROM devices WHERE id = ? AND channel_id = ?').get(req.params.did, req.channel.id);
  if (!dev) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(dev.id);
  audit(req.user.username, 'device.revoke', { channel: req.channel.slug, device: dev.id });
  res.json({ ok: true });
}));

export default router;
