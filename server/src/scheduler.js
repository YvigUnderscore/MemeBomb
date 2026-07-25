// Planification de memes : création + job de diffusion des schedules dus.
import { nanoid } from 'nanoid';
import { db, now, audit, getChannelSettings } from './db.js';
import { processMedia, storeComposedVideo, HttpError } from './media.js';
import { composeLayers } from './composer.js';
import { assertFeature } from './features.js';
import { resolveTargets, sanitizeOptions, dispatchPrepared, dispatchQueuedMemes, prepareSounds, applySoundOptions } from './memeService.js';
import { logger } from './logger.js';

const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };

// Prochaine occurrence pour un déclencheur récurrent (jours 0=dimanche, "HH:MM").
export function computeNextRecurring(days, time, from = Date.now()) {
  if (!Array.isArray(days) || days.length === 0) return null;
  const [hh, mm] = String(time || '12:00').split(':').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() > from && days.includes(d.getDay())) return d.getTime();
  }
  return null;
}

function computeNextRun(trigger) {
  if (trigger.type === 'recurring') return computeNextRecurring(trigger.days, trigger.time);
  // 'at' : timestamp absolu, ou délai (in X ms) depuis maintenant.
  if (Number.isFinite(+trigger.at)) return +trigger.at;
  if (Number.isFinite(+trigger.delayMs)) return now() + Math.max(0, +trigger.delayMs);
  return null;
}

export async function createSchedule(p) {
  const { channel, owner } = p;
  const s = getChannelSettings(channel);
  assertFeature(channel, owner, 'schedule', 'Planification');

  const activeCount = db.prepare('SELECT COUNT(*) c FROM schedules WHERE channel_id = ? AND owner = ? AND active = 1')
    .get(channel.id, owner).c;
  if (activeCount >= (s.maxSchedulesPerUser || 10)) {
    throw new HttpError(429, `Limit of ${s.maxSchedulesPerUser} schedules reached.`);
  }

  let media = null; let overlay = null;
  // Composition multi-calques (voir memeService) : préparée dès la création.
  if (p.layerBuffers?.length) {
    assertFeature(channel, owner, 'video', 'Vidéos/GIF');
    const composed = await composeLayers(p.layerBuffers, p.comp || {}, p.overlayBuffer, s);
    p.overlayBuffer = null;
    if (composed.transparent) media = await storeComposedVideo(composed.buffer, composed.mime);
    else p.mediaBuffer = composed.buffer;
  }
  if (!media && p.mediaBuffer?.length) {
    media = await processMedia(p.mediaBuffer, s);
    // Même raison qu'à l'enregistrement en bibliothèque : une scène animée
    // composée par l'éditeur n'emprunte plus la branche calques ci-dessus, qui
    // portait seule l'assertion. Contrôle identique à createAndDispatchMeme.
    if (media.type === 'video' || media.type === 'gif') assertFeature(channel, owner, 'video', 'Vidéos/GIF');
    if (media.type === 'audio') assertFeature(channel, owner, 'audio', 'Sons');
  }
  if (p.overlayBuffer?.length) overlay = await processMedia(p.overlayBuffer, { ...s, allowedTypes: ['image'] });
  const sounds = await prepareSounds(channel, p, s);
  if (!media && !p.text) throw new HttpError(400, 'A schedule needs at least media or text.');

  const targets = resolveTargets(channel.id, { groupNames: p.groupNames || [], mentions: p.mentions || [] });
  const options = sanitizeOptions(p.options || {}, s, media);
  if (overlay) options.overlayPath = overlay.relPath;
  applySoundOptions(options, sounds);
  options.__prepared = { media, overlay, sounds };

  const trigger = p.trigger || {};
  const type = trigger.type === 'recurring' ? 'recurring' : 'at';
  const nextRun = computeNextRun(trigger);
  if (!nextRun) throw new HttpError(400, 'Invalid trigger.');

  const id = nanoid(14);
  db.prepare(`INSERT INTO schedules
      (id, channel_id, owner, owner_name, label, text, media_path, media_mime, sound_path, options, targets,
       trigger_type, trigger_at, trigger_days, trigger_time, next_run, active, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    .run(id, channel.id, owner, p.device?.name || '', (p.label || '').slice(0, 80), p.text || '',
      media?.relPath || null, media?.mime || null, sounds[0]?.relPath || null,
      JSON.stringify(options), JSON.stringify(targets),
      type, type === 'at' ? nextRun : null, JSON.stringify(trigger.days || []), trigger.time || '',
      nextRun, now());
  audit(owner, 'schedule.create', { channel: channel.slug, id, type, nextRun });
  return { id, nextRun };
}

function runDue() {
  const due = db.prepare('SELECT * FROM schedules WHERE active = 1 AND next_run IS NOT NULL AND next_run <= ?').all(now());
  for (const sch of due) {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND active = 1').get(sch.channel_id);
    if (!channel) { db.prepare('UPDATE schedules SET active = 0 WHERE id = ?').run(sch.id); continue; }
    try {
      const options = parse(sch.options, {});
      const prepared = options.__prepared || {};
      delete options.__prepared;
      dispatchPrepared(channel, {
        sender: sch.owner, senderName: sch.owner_name,
        text: sch.text, mediaInfo: prepared.media, overlayInfo: prepared.overlay,
        soundInfos: prepared.sounds || (prepared.sound ? [prepared.sound] : []),
        options, targets: parse(sch.targets, []),
      });
    } catch (e) { logger.error('Schedule dispatch:', e.message); }

    if (sch.trigger_type === 'recurring') {
      const next = computeNextRecurring(parse(sch.trigger_days, []), sch.trigger_time, now() + 60000);
      if (next) db.prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(next, sch.id);
      else db.prepare('UPDATE schedules SET active = 0 WHERE id = ?').run(sch.id);
    } else {
      db.prepare('UPDATE schedules SET active = 0, next_run = NULL WHERE id = ?').run(sch.id);
    }
  }
}

export function startSchedulerJob() {
  // File warmup (#11) : vérification fréquente pour diffuser dès que l'expéditeur est prêt.
  setInterval(() => { dispatchQueuedMemes().catch((e) => logger.error('File warmup:', e.message)); }, 10000);
  return setInterval(runDue, 20000); // toutes les 20 s
}
