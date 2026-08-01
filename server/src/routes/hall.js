// ============================================================
//  Hall of Memes — API accessible à TOUS les comptes panel (staff ET
//  membres connectés via Discord). Un membre ne voit que les channels
//  où son compte Discord est whitelisté.
//  Semaine courante (live) + semaines archivées, relecture des médias,
//  commentaires et réactions.
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import { db, now, audit } from '../db.js';
import { panelAuth } from '../auth.js';
import { signMediaUrl } from '../memeService.js';
import { soundPathsOf } from '../retention.js';
import { weekStart, weekKey, topMemes } from '../hallArchive.js';
import { asyncHandler } from './helpers.js';

const router = Router();
router.use(panelAuth);

const HALL_EMOJI = ['😂', '❤️', '🔥', '💀', '👏', '😮', '👎', '🤡'];
const isStaff = (u) => u.role === 'admin' || u.role === 'moderator';
const parseJSON = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

/** Channels visibles par l'utilisateur courant. */
function accessibleChannels(user) {
  if (isStaff(user)) return db.prepare('SELECT id, slug, name FROM channels WHERE active = 1 ORDER BY id').all();
  if (!user.discord_id) return [];
  return db.prepare(`SELECT c.id, c.slug, c.name FROM channels c
      JOIN whitelist w ON w.channel_id = c.id
      WHERE c.active = 1 AND w.discord_id = ? AND w.banned = 0 ORDER BY c.id`).all(String(user.discord_id));
}
function requireChannelAccess(req, res, next) {
  const id = Number(req.params.channelId);
  const ok = accessibleChannels(req.user).some((c) => c.id === id);
  if (!ok) return res.status(403).json({ error: 'Channel not accessible.' });
  req.channelId = id;
  next();
}
// L'utilisateur peut-il voir ce meme ? (meme vivant OU archivé, dans un channel accessible)
function memeChannelId(memeId) {
  const m = db.prepare('SELECT channel_id FROM memes WHERE id = ?').get(memeId)
    || db.prepare('SELECT channel_id FROM hall_archive WHERE meme_id = ? LIMIT 1').get(memeId);
  return m?.channel_id ?? null;
}
function requireMemeAccess(req, res, next) {
  const cid = memeChannelId(req.params.memeId);
  if (cid == null || !accessibleChannels(req.user).some((c) => c.id === cid)) {
    return res.status(404).json({ error: 'Meme not found.' });
  }
  req.memeChannelId = cid;
  next();
}

function hallReactionCounts(memeId) {
  const rows = db.prepare('SELECT emoji, COUNT(*) c FROM hall_reactions WHERE meme_id = ? GROUP BY emoji').all(memeId);
  const out = {};
  for (const r of rows) out[r.emoji] = r.c;
  return out;
}
// Détail des réactions overlay (celles reçues à l'affichage du meme).
function overlayReactionDetail(memeId) {
  const out = {};
  for (const r of db.prepare('SELECT emoji, COUNT(*) c FROM meme_reactions WHERE meme_id = ? GROUP BY emoji').all(memeId)) out[r.emoji] = r.c;
  return out;
}
// Sons joués à l'apparition du meme — le Hall les rejoue, sinon un meme dont
// toute la blague est le son y est muet. Les memes vivants les portent dans
// leurs options ; les memes archivés en gardent une copie (cf. hallArchive.js).
function liveSoundUrls(memeId) {
  const m = db.prepare('SELECT options FROM memes WHERE id = ?').get(memeId);
  if (!m) return [];
  let options = {};
  try { options = JSON.parse(m.options || '{}'); } catch { return []; }
  return soundPathsOf(options).map(signMediaUrl);
}

function decorate(userId, item) {
  const hallReactions = hallReactionCounts(item.memeId);
  const votes = Object.values(hallReactions).reduce((a, b) => a + b, 0);
  return {
    ...item,
    // Ce qui classe un meme : ses réactions à l'affichage PLUS les votes
    // déposés depuis le Hall, y compris longtemps après l'envoi.
    votes,
    score: (item.reactions || 0) + votes,
    comments: db.prepare('SELECT COUNT(*) c FROM meme_comments WHERE meme_id = ?').get(item.memeId).c,
    hallReactions,
    myReactions: db.prepare('SELECT emoji FROM hall_reactions WHERE meme_id = ? AND user_id = ?').all(item.memeId, userId).map((r) => r.emoji),
  };
}

// --- Channels visibles ----------------------------------------------------
router.get('/channels', (req, res) => res.json(accessibleChannels(req.user)));

// --- Semaines disponibles (archives + courante) ---------------------------
router.get('/:channelId/weeks', requireChannelAccess, (req, res) => {
  const weeks = db.prepare('SELECT DISTINCT week FROM hall_archive WHERE channel_id = ? ORDER BY week DESC')
    .all(req.channelId).map((r) => r.week);
  res.json({ current: weekKey(weekStart()), weeks });
});

// --- Top de la semaine (courante = live, sinon archive) -------------------
router.get('/:channelId/top', requireChannelAccess, asyncHandler((req, res) => {
  const week = String(req.query.week || 'current');
  const currentKey = weekKey(weekStart());

  if (week === 'current' || week === currentKey) {
    const from = weekStart().getTime();
    const rows = topMemes(req.channelId, from, from + 7 * 86400000, 10);
    return res.json({
      week: currentKey, live: true,
      memes: rows.map((m, i) => decorate(req.user.id, {
        memeId: m.id, rank: i + 1, type: m.type, text: m.text,
        sender: m.sender, senderName: m.sender_name,
        reactions: m.cnt,
        reactionDetail: overlayReactionDetail(m.id),
        mediaUrl: m.media_path ? signMediaUrl(m.media_path) : null,
        mediaMime: m.media_mime,
        soundUrls: liveSoundUrls(m.id),
        createdAt: m.created_at,
      })),
    });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return res.status(400).json({ error: 'Invalid week.' });
  const rows = db.prepare('SELECT * FROM hall_archive WHERE channel_id = ? AND week = ? ORDER BY rank ASC')
    .all(req.channelId, week);
  // Le classement d'une semaine passée n'est pas figé : les votes déposés
  // depuis (dans le Hall) s'ajoutent au total et peuvent réordonner ses dix
  // memes. Le lot archivé, lui, ne change pas — les memes hors top 10 ont
  // disparu avec la rétention, ils ne peuvent plus y entrer.
  const memes = rows.map((m) => decorate(req.user.id, {
    memeId: m.meme_id, rank: m.rank, type: m.type, text: m.text,
    sender: m.sender, senderName: m.sender_name,
    reactions: m.reactions,
    reactionDetail: JSON.parse(m.reaction_detail || '{}'),
    mediaUrl: m.media_path ? signMediaUrl(m.media_path) : null,
    mediaMime: m.media_mime,
    soundUrls: parseJSON(m.sound_paths, []).map(signMediaUrl),
    createdAt: m.meme_created_at,
  }));
  memes.sort((a, b) => b.score - a.score || a.rank - b.rank);
  memes.forEach((m, i) => { m.rank = i + 1; });
  res.json({ week, live: false, memes });
}));

// --- Tous les memes PUBLICS d'un channel (pas seulement le top), paginé ----
// Comme le Hall, uniquement les memes globaux (targets = '[]'), jamais privés.
// Ordre antéchronologique (récents d'abord). Le top 10 hebdo reste archivé à part.
router.get('/:channelId/all', requireChannelAccess, asyncHandler((req, res) => {
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 30));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  // limit+1 pour savoir s'il reste une page suivante sans second COUNT.
  const rows = db.prepare(`
    SELECT m.*, (SELECT COUNT(*) FROM meme_reactions r WHERE r.meme_id = m.id) AS cnt
    FROM memes m
    WHERE m.channel_id = ? AND m.status = 'sent' AND m.targets = '[]'
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?`).all(req.channelId, limit + 1, offset);
  const hasMore = rows.length > limit;
  res.json({
    all: true, offset, limit, hasMore,
    memes: rows.slice(0, limit).map((m) => decorate(req.user.id, {
      memeId: m.id, rank: null, type: m.type, text: m.text,
      sender: m.sender, senderName: m.sender_name,
      reactions: m.cnt,
      reactionDetail: overlayReactionDetail(m.id),
      mediaUrl: m.media_path ? signMediaUrl(m.media_path) : null,
      mediaMime: m.media_mime,
      soundUrls: liveSoundUrls(m.id),
      createdAt: m.created_at,
    })),
  });
}));

// --- Commentaires ---------------------------------------------------------
router.get('/memes/:memeId/comments', requireMemeAccess, (req, res) => {
  const rows = db.prepare('SELECT id, user_id, username, text, created_at FROM meme_comments WHERE meme_id = ? ORDER BY created_at ASC LIMIT 300')
    .all(req.params.memeId);
  res.json(rows.map((r) => ({ id: r.id, userId: r.user_id, username: r.username, text: r.text, createdAt: r.created_at, mine: r.user_id === req.user.id })));
});

router.post('/memes/:memeId/comments', requireMemeAccess, asyncHandler((req, res) => {
  const { text } = z.object({ text: z.string().trim().min(1).max(500) }).parse(req.body);
  const name = req.user.discord_username || req.user.username;
  const info = db.prepare('INSERT INTO meme_comments (meme_id, channel_id, user_id, username, text, created_at) VALUES (?,?,?,?,?,?)')
    .run(req.params.memeId, req.memeChannelId, req.user.id, name, text, now());
  audit(req.user.username, 'hall.comment', { memeId: req.params.memeId });
  res.status(201).json({ id: info.lastInsertRowid, username: name, text, createdAt: now(), mine: true });
}));

// Supprimer un commentaire : son auteur, ou le staff.
router.delete('/comments/:id', asyncHandler((req, res) => {
  const c = db.prepare('SELECT * FROM meme_comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Introuvable.' });
  if (c.user_id !== req.user.id && !isStaff(req.user)) return res.status(403).json({ error: 'Forbidden.' });
  db.prepare('DELETE FROM meme_comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
}));

// --- Votes du Hall (toggle) -----------------------------------------------
// Voter après coup, sur un meme d'aujourd'hui comme sur une semaine archivée :
// le vote compte dans le total qui classe le top 10 (cf. topMemes).

// Réactions d'affichage d'un meme : comptées sur le meme vivant, ou reprises du
// snapshot d'archive quand la rétention l'a purgé.
function baseReactions(memeId) {
  const live = db.prepare('SELECT COUNT(*) c FROM meme_reactions WHERE meme_id = ?').get(memeId).c;
  if (live) return live;
  return db.prepare('SELECT reactions FROM hall_archive WHERE meme_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(memeId)?.reactions || 0;
}

router.post('/memes/:memeId/react', requireMemeAccess, asyncHandler((req, res) => {
  const { emoji } = z.object({ emoji: z.string() }).parse(req.body);
  if (!HALL_EMOJI.includes(emoji)) return res.status(400).json({ error: 'Emoji not allowed.' });
  const existing = db.prepare('SELECT 1 FROM hall_reactions WHERE meme_id = ? AND user_id = ? AND emoji = ?')
    .get(req.params.memeId, req.user.id, emoji);
  if (existing) {
    db.prepare('DELETE FROM hall_reactions WHERE meme_id = ? AND user_id = ? AND emoji = ?')
      .run(req.params.memeId, req.user.id, emoji);
  } else {
    db.prepare('INSERT INTO hall_reactions (meme_id, channel_id, user_id, emoji, created_at) VALUES (?,?,?,?,?)')
      .run(req.params.memeId, req.memeChannelId, req.user.id, emoji, now());
  }
  const counts = hallReactionCounts(req.params.memeId);
  const votes = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({ counts, mine: !existing, votes, score: baseReactions(req.params.memeId) + votes });
}));

export default router;
