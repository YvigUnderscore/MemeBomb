// ============================================================
//  File d'attente des encodages ffmpeg (sémaphore maison, zéro dépendance).
//
//  La machine a 4 cœurs et le même process sert l'API REST, le hub WebSocket
//  et le panel. Un ffmpeg lancé sans bride prend TOUS les cœurs : deux envois
//  simultanés suffisaient à rendre le serveur injoignable le temps des
//  encodages. On sérialise donc les encodages (TRANSCODE_CONCURRENCY, 1 par
//  défaut) ; combiné au `-threads` posé sur chaque sortie ffmpeg, il reste en
//  permanence des cœurs libres pour répondre aux requêtes.
//
//  RÉSERVÉ AUX ENCODAGES : ne JAMAIS y faire passer un ffprobe. handleVideo
//  (media.js) et composeLayers (composer.js) probent leurs entrées AVANT
//  d'encoder — un probe mis en file derrière l'encodage qui l'attend figerait
//  la file pour de bon. Les appels réels sont séquentiels (composeLayers rend
//  son jeton avant que processMedia ne demande le sien), aucun job de la file
//  n'en attend donc un autre de façon imbriquée.
// ============================================================

import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Crée une file indépendante (utile aux tests : la file globale ci-dessous
 * suit la config du process et n'est pas reconfigurable à chaud).
 * @param {number} concurrency  nombre d'encodages simultanés (min. 1)
 */
export function createTranscodeQueue(concurrency = 1) {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  let running = 0;
  const waiting = [];

  function release() {
    running--;
    const next = waiting.shift();
    if (next) next();
  }

  function run(label, fn, report) {
    return new Promise((resolve, reject) => {
      const queuedAt = Date.now();
      const begin = () => {
        running++;
        const startedAt = Date.now();
        const done = (failed) => {
          const m = { label, waitMs: startedAt - queuedAt, runMs: Date.now() - startedAt };
          // Jeton rendu AVANT de propager le résultat, et aussi bien sur rejet
          // que sur succès : un job qui échoue sans libérer sa place fige la
          // file définitivement (plus aucun encodage ne passe jusqu'au restart).
          release();
          // Un job échoué n'atteindra pas la ligne de log de son appelant :
          // dans ce cas la file loggue elle-même, la mesure reste visible.
          if (report && !failed) report(m);
          else logger.info(`Transcode ${m.label}: attente ${m.waitMs} ms, exécution ${m.runMs} ms${failed ? ' (échec)' : ''}`);
        };
        // Promise.resolve().then(fn) : fn peut lever de façon SYNCHRONE, on
        // veut quand même passer par le chemin d'échec — donc par release().
        Promise.resolve().then(fn).then(
          (v) => { done(false); resolve(v); },
          (e) => { done(true); reject(e); },
        );
      };
      if (running < limit) begin();
      else waiting.push(begin);
    });
  }

  return {
    run,
    get running() { return running; },
    get pending() { return waiting.length; },
  };
}

const queue = createTranscodeQueue(config.transcode.concurrency);

/**
 * Exécute un encodage dans la file globale.
 * @param {string} label  libellé du job (apparaît dans les mesures)
 * @param {() => Promise<any>} fn  l'encodage lui-même
 * @param {(m: {label: string, waitMs: number, runMs: number}) => void} [report]
 *   remplace le log de la file : composer.js agrège les mesures dans SA ligne
 *   de fin de composition plutôt que d'en émettre une seconde.
 */
export function runQueued(label, fn, report) {
  return queue.run(label, fn, report);
}
