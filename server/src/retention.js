// Rétention et purge des memes (l'historique serveur est conservé X jours).
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';

export function getRetentionDays() {
  const row = db.prepare("SELECT value FROM global_settings WHERE key = 'retentionDays'").get();
  const n = parseInt(row?.value ?? '7', 10);
  return Number.isFinite(n) ? n : 7;
}

export function setRetentionDays(days) {
  const n = Math.max(0, Math.min(3650, parseInt(days, 10) || 0));
  db.prepare(`INSERT INTO global_settings (key, value) VALUES ('retentionDays', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(n));
  return n;
}

function rmMedia(mediaPath) {
  if (!mediaPath) return;
  try { fs.rmSync(path.join(config.mediaDir, path.basename(mediaPath)), { force: true }); } catch { /* ignore */ }
}

// Utilisé partout où un fichier média référencé (asset, schedule, meme rejeté...) doit être effacé.
export const removeMediaFile = rmMedia;

// Sons attachés à un meme. `soundPaths` (plusieurs sons) est la forme courante ;
// `soundPath` reste lu pour les memes enregistrés avant le multi-son.
export function soundPathsOf(options) {
  if (Array.isArray(options?.soundPaths)) return options.soundPaths.filter(Boolean);
  return options?.soundPath ? [options.soundPath] : [];
}

// Un meme peut référencer plusieurs fichiers : le média principal, et (dans `options`)
// un overlay composé et/ou des sons additionnels — tous doivent être nettoyés ensemble.
function removeMemeFiles(m) {
  rmMedia(m.media_path);
  try {
    const o = JSON.parse(m.options || '{}');
    if (o.overlayPath) rmMedia(o.overlayPath);
    for (const p of soundPathsOf(o)) rmMedia(p);
  } catch { /* ignore */ }
}

// Purge les memes plus vieux que la rétention (0 = conservation illimitée).
export function purgeOldMemes() {
  const days = getRetentionDays();
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  const rows = db.prepare('SELECT media_path, options FROM memes WHERE created_at < ?').all(cutoff);
  for (const m of rows) removeMemeFiles(m);
  const info = db.prepare('DELETE FROM memes WHERE created_at < ?').run(cutoff);
  if (info.changes) logger.info(`Rétention : ${info.changes} meme(s) purgé(s) (> ${days} j).`);
  return info.changes;
}

// Supprime tout l'historique (d'un channel, ou global si channelId absent).
export function deleteAllMemes(channelId = null) {
  const rows = channelId
    ? db.prepare('SELECT media_path, options FROM memes WHERE channel_id = ?').all(channelId)
    : db.prepare('SELECT media_path, options FROM memes').all();
  for (const m of rows) removeMemeFiles(m);
  if (channelId) db.prepare('DELETE FROM memes WHERE channel_id = ?').run(channelId);
  else db.prepare('DELETE FROM memes').run();
  return rows.length;
}

export function startRetentionJob() {
  purgeOldMemes();
  return setInterval(purgeOldMemes, 3600_000); // toutes les heures
}
