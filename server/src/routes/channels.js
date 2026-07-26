import { Router } from 'express';
import { z } from 'zod';
import { db, now, audit, getChannelSettings, DEFAULT_CHANNEL_SETTINGS } from '../db.js';
import {
  panelAuth, requireAdmin, requireAnyChannelStaff, requireChannelStaff,
  isGlobalStaff, moderatedChannelIds, issueEditorToken,
} from '../auth.js';
import { encrypt } from '../crypto.js';
import { asyncHandler, loadChannel, slugify } from './helpers.js';
import { onlineCount } from '../wsHub.js';
import { restartChannelBot, stopChannelBot } from '../discordManager.js';

const router = Router();
router.use(panelAuth, requireAnyChannelStaff);

function publicChannel(c) {
  return {
    id: c.id, slug: c.slug, name: c.name, description: c.description,
    active: !!c.active, hasDiscord: !!c.discord_token,
    discordGuildId: c.discord_guild_id || '',
    settings: getChannelSettings(c),
    online: onlineCount(c.id),
    counts: {
      whitelist: db.prepare('SELECT COUNT(*) c FROM whitelist WHERE channel_id = ?').get(c.id).c,
      devices: db.prepare('SELECT COUNT(*) c FROM devices WHERE channel_id = ? AND revoked = 0').get(c.id).c,
      groups: db.prepare('SELECT COUNT(*) c FROM mention_groups WHERE channel_id = ?').get(c.id).c,
    },
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM channels ORDER BY id').all();
  // Un modérateur de channel ne voit que les channels qu'il modère.
  let visible = rows;
  if (!isGlobalStaff(req.user)) {
    const mine = new Set(moderatedChannelIds(req.user));
    visible = rows.filter((c) => mine.has(c.id));
  }
  res.json(visible.map(publicChannel));
});

router.get('/defaults', (req, res) => res.json(DEFAULT_CHANNEL_SETTINGS));

router.get('/:id', loadChannel, requireChannelStaff, (req, res) => res.json(publicChannel(req.channel)));

// Jeton éphémère pour l'éditeur web embarqué dans le panel (iframe /compose).
// Le modérateur/admin, déjà authentifié par cookie, obtient un token borné à CE channel
// que l'éditeur utilise ensuite comme un « appareil » sur /api/client/*.
router.post('/:id/editor-token', loadChannel, requireChannelStaff, asyncHandler((req, res) => {
  const token = issueEditorToken({ channelId: req.channel.id, username: req.user.username });
  res.json({ token, channel: { slug: req.channel.slug, name: req.channel.name } });
}));

router.post('/', requireAdmin, asyncHandler((req, res) => {
  const { name, description } = z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional().default(''),
  }).parse(req.body);
  let slug = slugify(name);
  let i = 1;
  while (db.prepare('SELECT 1 FROM channels WHERE slug = ?').get(slug)) slug = `${slugify(name)}-${++i}`;
  const info = db.prepare('INSERT INTO channels (slug, name, description, settings, created_at) VALUES (?,?,?,?,?)')
    .run(slug, name, description, JSON.stringify({}), now());
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid);
  audit(req.user.username, 'channel.create', slug);
  res.status(201).json(publicChannel(c));
}));

router.patch('/:id', requireAdmin, loadChannel, asyncHandler((req, res) => {
  const body = z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    active: z.boolean().optional(),
  }).parse(req.body);
  const c = req.channel;
  db.prepare('UPDATE channels SET name = COALESCE(?, name), description = COALESCE(?, description), active = COALESCE(?, active) WHERE id = ?')
    .run(body.name ?? null, body.description ?? null, body.active === undefined ? null : (body.active ? 1 : 0), c.id);
  audit(req.user.username, 'channel.update', c.slug);
  res.json(publicChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(c.id)));
}));

// Mise à jour des réglages (fusionnés). Ouvert à qui gère le channel : admin,
// modérateur panel, ou modérateur de CE channel. Ces réglages portent des
// contrôles de sécurité (mode de modération, mots bannis, quotas, débits) —
// promouvoir quelqu'un modérateur, c'est donc lui confier ces leviers.
router.put('/:id/settings', loadChannel, requireChannelStaff, asyncHandler((req, res) => {
  const schema = z.object({
    maxUploadMb: z.number().min(1).max(200),
    maxVideoDurationS: z.number().min(1).max(120),
    maxAudioDurationS: z.number().min(1).max(120),
    maxImageDurationS: z.number().min(1).max(60),
    maxGifDurationS: z.number().min(1).max(60),
    maxTextLength: z.number().min(1).max(1000),
    allowedTypes: z.array(z.enum(['image', 'gif', 'video', 'audio'])).min(1),
    defaultCooldownS: z.number().min(0).max(600),
    defaultVolume: z.number().min(0).max(1),
    defaultOpacity: z.number().min(0.1).max(1),
    moderationMode: z.enum(['off', 'filter', 'review']),
    bannedWords: z.array(z.string().max(80)).max(2000),
    requireGuidelinesAccept: z.boolean(),
    guidelines: z.string().max(20000),
    allowEditorSend: z.boolean(),
    rateLimitPerMinute: z.number().min(0).max(120),
    maxReceivesPerMinute: z.number().min(0).max(240),
    senderWarmupS: z.number().min(0).max(3600),
    maxAnimMs: z.number().min(100).max(5000),
    features: z.record(z.boolean()),
    storageQuotaMb: z.number().min(0).max(10000),
    maxSchedulesPerUser: z.number().min(0).max(1000),
    reactionMilestones: z.array(z.number().int().min(1).max(1000)).max(10),
    celebrateEffects: z.boolean(),
    sharedSoundboard: z.boolean(),
  }).partial().parse(req.body);
  const merged = { ...getChannelSettings(req.channel), ...schema };
  db.prepare('UPDATE channels SET settings = ? WHERE id = ?').run(JSON.stringify(merged), req.channel.id);
  audit(req.user.username, 'channel.settings', req.channel.slug);
  res.json(merged);
}));

// Configuration du bot Discord du channel (token chiffré). Le token n'est
// jamais renvoyé : un modérateur peut le remplacer, pas le lire.
router.put('/:id/discord', loadChannel, requireChannelStaff, asyncHandler(async (req, res) => {
  const { token, guildId, enabled } = z.object({
    token: z.string().max(120).optional(),
    guildId: z.string().max(40).optional(),
    enabled: z.boolean().optional(),
  }).parse(req.body);
  const c = req.channel;
  if (token !== undefined) {
    db.prepare('UPDATE channels SET discord_token = ? WHERE id = ?')
      .run(token ? encrypt(token) : null, c.id);
  }
  if (guildId !== undefined) db.prepare('UPDATE channels SET discord_guild_id = ? WHERE id = ?').run(guildId, c.id);
  audit(req.user.username, 'channel.discord', c.slug);
  const fresh = db.prepare('SELECT * FROM channels WHERE id = ?').get(c.id);
  if (enabled === false || !fresh.discord_token) await stopChannelBot(c.id);
  else await restartChannelBot(c.id);
  res.json(publicChannel(fresh));
}));

router.delete('/:id', requireAdmin, loadChannel, asyncHandler(async (req, res) => {
  await stopChannelBot(req.channel.id);
  db.prepare('DELETE FROM channels WHERE id = ?').run(req.channel.id);
  audit(req.user.username, 'channel.delete', req.channel.slug);
  res.json({ ok: true });
}));

export default router;
