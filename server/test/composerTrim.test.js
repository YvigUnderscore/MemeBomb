// Découpe des vidéos (✂ de l'éditeur) : contrat éditeur ↔ composer.
//
// L'éditeur ne mémorise qu'un intervalle `{ s, e }` (secondes) sur le calque ;
// c'est ffmpeg qui coupe, et seul l'extrait gardé compte dans la durée de la
// scène. Un intervalle hors des clous est borné à la durée réelle du fichier.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import ffmpeg from 'fluent-ffmpeg';
import { composeLayers } from '../src/composer.js';

const SETTINGS = { maxUploadMb: 25, maxVideoDurationS: 15 };
const SRC_S = 3; // durée de la vidéo de test
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trim-'));
let clip;
let out = 0;

const probe = (file) => new Promise((resolve, reject) => {
  ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
});

// Vidéo de test générée par ffmpeg (rien n'est versionné). Sans ffmpeg
// utilisable, les cas sont sautés plutôt que rouges.
beforeAll(async () => {
  const file = path.join(dir, 'in.mp4');
  try {
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=15:duration=${SRC_S}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file,
      ]);
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    });
    clip = fs.readFileSync(file);
  } catch {
    clip = null;
  }
}, 60_000);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// Durée de la composition, la scène adoptant celle du calque le plus long
// (comp.durationS volontairement absent).
async function composedDuration(layer) {
  const res = await composeLayers([clip], {
    bg: '#101014', transparent: false, layers: [layer],
  }, null, SETTINGS);
  const file = path.join(dir, `out-${out++}.mp4`);
  fs.writeFileSync(file, res.buffer);
  return Number((await probe(file)).format?.duration) || 0;
}

const LAYER = { xPct: 0.5, yPct: 0.5, wPct: 0.5 };

describe('composer — découpe des calques vidéo', () => {
  it('garde la vidéo entière sans découpe', async (ctx) => {
    if (!clip) ctx.skip();
    expect(await composedDuration(LAYER)).toBeCloseTo(SRC_S, 0);
  }, 90_000);

  it('ne garde que l\'extrait demandé', async (ctx) => {
    if (!clip) ctx.skip();
    expect(await composedDuration({ ...LAYER, trim: { s: 1, e: 2 } })).toBeCloseTo(1, 0);
  }, 90_000);

  it('borne un intervalle qui dépasse la fin du fichier', async (ctx) => {
    if (!clip) ctx.skip();
    // e au-delà de la durée réelle → coupé à la fin du fichier (2 s gardées).
    expect(await composedDuration({ ...LAYER, trim: { s: 1, e: 99 } })).toBeCloseTo(SRC_S - 1, 0);
  }, 90_000);
});
