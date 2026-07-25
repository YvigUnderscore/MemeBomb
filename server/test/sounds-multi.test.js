// Plusieurs sons par meme : joints à l'envoi, copiés (jamais partagés avec
// l'asset d'origine), diffusés dans le payload et nettoyés au retrait.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { createApp } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { db, now } from '../src/db.js';
import { config } from '../src/config.js';

const app = createApp();
const admin = request.agent(app);

let channelId; let deviceToken; let soundIds = [];

// Sons déjà « transcodés » (l'API les copie sans les retraiter → pas de ffmpeg ici).
function makeSoundAsset(owner, name) {
  const id = nanoid(14);
  const rel = `${id}.m4a`;
  fs.writeFileSync(path.join(config.mediaDir, rel), Buffer.from('fake-audio'));
  db.prepare(`INSERT INTO assets (id, channel_id, owner, owner_name, kind, name, media_path, media_mime, media_size, data, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, channelId, owner, 'PC Sons', 'sound', name, rel, 'audio/mp4', 10, '{}', now());
  return id;
}

beforeAll(async () => {
  ensureAdmin();
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'adminpass123' }).expect(200);
  channelId = (await admin.post('/api/channels').send({ name: 'Multi Sound' }).expect(201)).body.id;
  const code = (await admin.post(`/api/channels/${channelId}/devices/pair-code`).send({}).expect(201)).body.code;
  deviceToken = (await request(app).post('/api/client/pair').send({ code, deviceName: 'PC Sons' }).expect(201)).body.deviceToken;
  const deviceId = db.prepare('SELECT id FROM devices WHERE channel_id = ? ORDER BY id DESC').get(channelId).id;
  soundIds = ['Air horn', 'Bruh', 'Vine boom'].map((n) => makeSoundAsset(`device:${deviceId}`, n));
});

const optionsOf = (memeId) => JSON.parse(db.prepare('SELECT options FROM memes WHERE id = ?').get(memeId).options);

describe('plusieurs sons par meme', () => {
  it('attache plusieurs sons de la bibliothèque à un envoi', async () => {
    const r = await request(app).post('/api/client/meme').set('X-Device-Token', deviceToken)
      .field('text', 'Trois sons')
      .field('soundAssetIds', JSON.stringify(soundIds))
      .expect(201);

    const options = optionsOf(r.body.id);
    expect(options.soundPaths).toHaveLength(3);
    // soundPath (1er son) reste renseigné pour les clients d'avant le multi-son.
    expect(options.soundPath).toBe(options.soundPaths[0]);
    // Chaque son est une COPIE : supprimer l'asset ne casse pas le meme envoyé.
    const originals = soundIds.map((id) => db.prepare('SELECT media_path FROM assets WHERE id = ?').get(id).media_path);
    for (const p of options.soundPaths) {
      expect(originals).not.toContain(p);
      expect(fs.existsSync(path.join(config.mediaDir, p))).toBe(true);
    }
    // Payload diffusé aux clients : liste complète + premier son en compat.
    expect(r.body.meme.sounds).toHaveLength(3);
    expect(r.body.meme.sound.url).toBe(r.body.meme.sounds[0].url);
  });

  it('accepte encore le champ unique soundAssetId', async () => {
    const r = await request(app).post('/api/client/meme').set('X-Device-Token', deviceToken)
      .field('text', 'Un seul son')
      .field('soundAssetId', soundIds[0])
      .expect(201);
    const options = optionsOf(r.body.id);
    expect(options.soundPaths).toHaveLength(1);
    expect(r.body.meme.sounds).toHaveLength(1);
  });

  it('plafonne le nombre de sons', async () => {
    const many = [...soundIds, makeSoundAsset(`device:${db.prepare('SELECT id FROM devices WHERE channel_id = ? ORDER BY id DESC').get(channelId).id}`, 'S4'),
      makeSoundAsset(`device:${db.prepare('SELECT id FROM devices WHERE channel_id = ? ORDER BY id DESC').get(channelId).id}`, 'S5')];
    const r = await request(app).post('/api/client/meme').set('X-Device-Token', deviceToken)
      .field('text', 'Trop de sons')
      .field('soundAssetIds', JSON.stringify(many))
      .expect(201);
    expect(optionsOf(r.body.id).soundPaths).toHaveLength(4);
  });

  it('ignore un son qui ne m\'appartient pas', async () => {
    const foreign = makeSoundAsset('device:999999', 'Pas à moi');
    const r = await request(app).post('/api/client/meme').set('X-Device-Token', deviceToken)
      .field('text', 'Son étranger')
      .field('soundAssetIds', JSON.stringify([foreign]))
      .expect(201);
    expect(optionsOf(r.body.id).soundPaths).toBeUndefined();
  });

  it('renvoie un meme multi-sons depuis le panel sans partager ses fichiers', async () => {
    const first = await request(app).post('/api/client/meme').set('X-Device-Token', deviceToken)
      .field('text', 'À renvoyer')
      .field('soundAssetIds', JSON.stringify(soundIds.slice(0, 2)))
      .expect(201);
    const original = optionsOf(first.body.id).soundPaths;

    const r = await admin.post(`/api/channels/${channelId}/memes/${first.body.id}/resend`).expect(201);
    const copies = optionsOf(r.body.id).soundPaths;
    expect(copies).toHaveLength(2);
    for (const [i, p] of copies.entries()) {
      expect(p).not.toBe(original[i]);                                   // copie, pas référence
      expect(fs.existsSync(path.join(config.mediaDir, p))).toBe(true);
      expect(fs.existsSync(path.join(config.mediaDir, original[i]))).toBe(true); // original intact
    }
  });

  it('supprime tous les sons quand le meme est retiré', async () => {
    const r = await request(app).post('/api/client/meme').set('X-Device-Token', deviceToken)
      .field('text', 'À retirer')
      .field('soundAssetIds', JSON.stringify(soundIds.slice(0, 2)))
      .expect(201);
    const paths = optionsOf(r.body.id).soundPaths;
    expect(paths).toHaveLength(2);

    await admin.delete(`/api/channels/${channelId}/memes/${r.body.id}`).expect(200);
    for (const p of paths) expect(fs.existsSync(path.join(config.mediaDir, p))).toBe(false);
    // Les sons de la bibliothèque, eux, sont intacts.
    for (const id of soundIds.slice(0, 2)) {
      const a = db.prepare('SELECT media_path FROM assets WHERE id = ?').get(id);
      expect(fs.existsSync(path.join(config.mediaDir, a.media_path))).toBe(true);
    }
  });
});
