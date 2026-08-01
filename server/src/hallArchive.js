// ============================================================
//  Hall of Memes — archivage hebdomadaire du top 10.
//  Chaque semaine écoulée (lundi → dimanche), le top 10 des memes les plus
//  réagis de chaque channel est figé dans hall_archive. Les médias sont
//  COPIÉS sous un nouveau nom : l'archive survit à la rétention.
// ============================================================

import { db, now } from './db.js';
import { copyMediaFile } from './memeService.js';
import { soundPathsOf } from './retention.js';
import { logger } from './logger.js';

/** Lundi 00:00 (heure locale) de la semaine contenant `ts`. */
export function weekStart(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 0 = lundi
  d.setDate(d.getDate() - day);
  return d;
}
export function weekKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Top N memes d'un channel sur [from, to), classés au total des réactions
 * reçues à l'affichage (`cnt`) ET des votes déposés après coup depuis le Hall
 * (`hall_cnt`) — voter plus tard compte donc autant que réagir sur le moment.
 * PUBLICS uniquement (targets = '[]') : un meme envoyé en privé/à un groupe
 * n'apparaît jamais dans le Hall. Les memes à zéro sont écartés.
 */
export function topMemes(channelId, from, to, limit = 10) {
  return db.prepare(`
    SELECT * FROM (
      SELECT m.*,
        (SELECT COUNT(*) FROM meme_reactions r WHERE r.meme_id = m.id) AS cnt,
        (SELECT COUNT(*) FROM hall_reactions h WHERE h.meme_id = m.id) AS hall_cnt
      FROM memes m
      WHERE m.channel_id = ? AND m.status = 'sent' AND m.targets = '[]'
        AND m.created_at >= ? AND m.created_at < ?
    )
    WHERE cnt + hall_cnt > 0
    ORDER BY cnt + hall_cnt DESC, created_at ASC
    LIMIT ?`).all(channelId, from, to, limit);
}

function reactionDetail(memeId) {
  const rows = db.prepare('SELECT emoji, COUNT(*) c FROM meme_reactions WHERE meme_id = ? GROUP BY emoji').all(memeId);
  const out = {};
  for (const r of rows) out[r.emoji] = r.c;
  return out;
}

/** Archive une semaine donnée pour un channel (no-op si déjà archivée ou vide). */
function archiveWeek(channel, monday) {
  const key = weekKey(monday);
  const exists = db.prepare('SELECT 1 FROM hall_archive WHERE channel_id = ? AND week = ? LIMIT 1').get(channel.id, key);
  if (exists) return 0;
  const from = monday.getTime();
  const to = from + 7 * 86400000;
  const top = topMemes(channel.id, from, to, 10);
  if (!top.length) return 0;
  const ins = db.prepare(`INSERT INTO hall_archive
      (channel_id, week, rank, meme_id, sender, sender_name, type, text, media_path, media_mime, sound_paths, reactions, reaction_detail, meme_created_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  top.forEach((m, i) => {
    // Copie du média ET des sons joués à l'apparition : les fichiers d'origine
    // disparaîtront avec la rétention, et un meme rejoué muet n'est pas le meme.
    const mediaCopy = m.media_path ? copyMediaFile(m.media_path) : null;
    let options = {};
    try { options = JSON.parse(m.options || '{}'); } catch { /* ignore */ }
    const soundCopies = soundPathsOf(options).map(copyMediaFile).filter(Boolean);
    // `reactions` reste le total des seules réactions d'affichage : les votes du
    // Hall sont recomptés en direct à la lecture, un vote tardif compte donc
    // encore après l'archivage (et n'est jamais compté deux fois).
    ins.run(channel.id, key, i + 1, m.id, m.sender, m.sender_name, m.type, m.text,
      mediaCopy, m.media_mime, JSON.stringify(soundCopies), m.cnt,
      JSON.stringify(reactionDetail(m.id)), m.created_at, now());
    n++;
  });
  logger.info(`Hall : semaine ${key} archivée pour "${channel.slug}" (${n} meme(s)).`);
  return n;
}

/**
 * Archive les semaines écoulées non encore archivées (jusqu'à 4 en arrière,
 * pour rattraper un serveur resté éteint). Appelé au démarrage puis chaque heure.
 */
export function runHallArchive() {
  const channels = db.prepare('SELECT * FROM channels WHERE active = 1').all();
  const current = weekStart();
  for (const c of channels) {
    for (let back = 1; back <= 4; back++) {
      const monday = new Date(current.getTime() - back * 7 * 86400000);
      try { archiveWeek(c, monday); } catch (e) { logger.error('Archive hall:', e.message); }
    }
  }
}

export function startHallArchiveJob() {
  runHallArchive();
  return setInterval(runHallArchive, 3600_000);
}
