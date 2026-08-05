// Son des vidéos importées : contrat éditeur ↔ composer.
//
// Une vidéo posée en calque garde sa piste audio dans la composition ; le
// bouton 🔇 de l'éditeur envoie `mute: true` sur le calque, et cette piste est
// alors écartée du mixage (le fichier source, lui, n'est pas retouché).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import ffmpeg from 'fluent-ffmpeg';
import { composeLayers } from '../src/composer.js';

const SETTINGS = { maxUploadMb: 25, maxVideoDurationS: 15 };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mute-'));
let videoWithAudio;

const probe = (file) => new Promise((resolve, reject) => {
  ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
});

// Vidéo de test : 1 s d'image + 1 s de sinus, générée par ffmpeg lui-même
// (aucun binaire n'est versionné). Appel direct : fluent-ffmpeg refuse les
// entrées lavfi, absentes de sa liste de démuxeurs de fichiers. Sans ffmpeg
// utilisable, les deux cas sont sautés plutôt que rouges.
beforeAll(async () => {
  const out = path.join(dir, 'in.mp4');
  try {
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', out,
      ]);
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    });
    videoWithAudio = fs.readFileSync(out);
  } catch {
    videoWithAudio = null;
  }
}, 60_000);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function composedStreams(layer) {
  const res = await composeLayers([videoWithAudio], {
    bg: '#101014', transparent: false, durationS: 1, layers: [layer],
  }, null, SETTINGS);
  const file = path.join(dir, `out-${Math.round(res.buffer.length)}.mp4`);
  fs.writeFileSync(file, res.buffer);
  const info = await probe(file);
  return (info.streams || []).map((s) => s.codec_type);
}

describe('composer — son des calques vidéo', () => {
  it('conserve la piste audio d\'un calque vidéo par défaut', async (ctx) => {
    if (!videoWithAudio) ctx.skip();
    expect(await composedStreams({ xPct: 0.5, yPct: 0.5, wPct: 0.5 })).toContain('audio');
  }, 90_000);

  it('écarte la piste d\'un calque marqué mute', async (ctx) => {
    if (!videoWithAudio) ctx.skip();
    expect(await composedStreams({ xPct: 0.5, yPct: 0.5, wPct: 0.5, mute: true })).not.toContain('audio');
  }, 90_000);
});
