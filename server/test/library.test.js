// Bibliothèque de memes enregistrés (par utilisateur) : enregistrement d'une
// scène réutilisable, réouverture, renvoi direct, remplacement, suppression.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { createApp } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';

const app = createApp();
const admin = request.agent(app);

// PNG 1x1 valide : sharp le transcode en webp (aucun ffmpeg nécessaire).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const scene = {
  els: [{ id: 'a1', type: 'text', text: 'HELLO', xPct: 0.5, yPct: 0.5, fontFrac: 0.09, rot: 0, opacity: 1, color: '#ffffff', outline: true, z: 0 }],
  strokes: [],
  base: { mode: 'color', color: '#112233', media: null },
  sound: null,
  options: { durationS: 6, animation: 'fade', volume: 0.7 },
  placeBox: { xPct: 0.25, yPct: 0.25, wPct: 0.5 },
};

let channelId; let channelSlug; let deviceToken; let otherToken; let owner;

async function pairDevice(name) {
  const code = (await admin.post(`/api/channels/${channelId}/devices/pair-code`).send({}).expect(201)).body.code;
  const r = await request(app).post('/api/client/pair').send({ code, deviceName: name }).expect(201);
  return r.body.deviceToken;
}

beforeAll(async () => {
  ensureAdmin();
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'adminpass123' }).expect(200);
  const c = await admin.post('/api/channels').send({ name: 'Library Test' }).expect(201);
  channelId = c.body.id;
  channelSlug = c.body.slug;
  deviceToken = await pairDevice('PC Library');
  otherToken = await pairDevice('PC Voisin');
  const deviceId = db.prepare('SELECT id FROM devices WHERE channel_id = ? AND name = ?').get(channelId, 'PC Library').id;
  owner = `device:${deviceId}`;
});

describe('bibliothèque de memes', () => {
  let memeId;

  it('enregistre un meme (rendu + scène)', async () => {
    const r = await request(app).post('/api/client/assets').set('X-Device-Token', deviceToken)
      .field('kind', 'meme')
      .field('name', 'Mon premier meme')
      .field('data', JSON.stringify({ text: 'HELLO', options: { durationS: 6 }, scene }))
      .attach('media', PNG_1x1, 'meme.png')
      .expect(201);
    memeId = r.body.id;
    expect(memeId).toBeTruthy();
  });

  it('compte la scène JSON dans le quota (pas seulement le média)', async () => {
    const usedMb = async () => (await request(app).get('/api/client/storage').set('X-Device-Token', deviceToken).expect(200)).body.usedMb;
    const before = await usedMb();
    // Scène volumineuse SANS média : sans comptabilisation du JSON, le quota
    // ne bougerait pas et la bibliothèque offrirait un stockage illimité.
    const r = await request(app).post('/api/client/assets').set('X-Device-Token', deviceToken)
      .field('kind', 'meme').field('name', 'Scène lourde')
      .field('data', JSON.stringify({ scene: { ...scene, blob: 'x'.repeat(1048576) } }))
      .expect(201);
    expect(await usedMb()).toBeGreaterThanOrEqual(before + 1);
    await request(app).delete(`/api/client/assets/${r.body.id}`).set('X-Device-Token', deviceToken).expect(200);
    expect(await usedMb()).toBeCloseTo(before, 1); // libéré à la suppression
  });

  it('liste les memes sans transporter la scène', async () => {
    const r = await request(app).get('/api/client/assets?kind=meme').set('X-Device-Token', deviceToken).expect(200);
    const a = r.body.find((x) => x.id === memeId);
    expect(a.name).toBe('Mon premier meme');
    expect(a.url).toMatch(/\/media\//);
    expect(a.data.scene).toBeUndefined();
    expect(a.data.hasScene).toBe(true);
  });

  it('renvoie la scène complète sur le détail', async () => {
    const r = await request(app).get(`/api/client/assets/${memeId}`).set('X-Device-Token', deviceToken).expect(200);
    expect(r.body.data.scene.els[0].text).toBe('HELLO');
    expect(r.body.data.scene.base.color).toBe('#112233');
    expect(r.body.data.mediaType).toBe('image');
  });

  it('envoie le meme enregistré sans le ré-uploader', async () => {
    const r = await request(app).post(`/api/client/assets/${memeId}/send`).set('X-Device-Token', deviceToken)
      .send({ groups: [], mentions: [] }).expect(201);
    expect(r.body.id).toBeTruthy();

    const meme = db.prepare('SELECT * FROM memes WHERE id = ?').get(r.body.id);
    expect(meme.type).toBe('image');
    expect(meme.text).toBe('HELLO');
    // Le média est une COPIE : supprimer le meme ne doit pas casser l'asset.
    const asset = db.prepare('SELECT media_path FROM assets WHERE id = ?').get(memeId);
    expect(meme.media_path).not.toBe(asset.media_path);
  });

  it('rejoue les sons attachés au meme enregistré', async () => {
    // Sons déjà transcodés (copiés tels quels par l'API → pas de ffmpeg ici).
    const soundIds = ['Air horn', 'Bruh'].map((name) => {
      const sid = nanoid(14);
      const rel = `${sid}.m4a`;
      fs.writeFileSync(path.join(config.mediaDir, rel), Buffer.from('fake-audio'));
      db.prepare(`INSERT INTO assets (id, channel_id, owner, owner_name, kind, name, media_path, media_mime, media_size, data, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(sid, channelId, owner, 'PC Library', 'sound', name, rel, 'audio/mp4', 10, '{}', Date.now());
      return sid;
    });
    const r = await request(app).post('/api/client/assets').set('X-Device-Token', deviceToken)
      .field('kind', 'meme').field('name', 'Meme sonore')
      // soundAssetIds arrive ici en tableau (définition du meme), pas en chaîne JSON.
      .field('data', JSON.stringify({ text: 'BOOM', scene, soundAssetIds: soundIds }))
      .attach('media', PNG_1x1, 'meme.png')
      .expect(201);

    const sent = await request(app).post(`/api/client/assets/${r.body.id}/send`).set('X-Device-Token', deviceToken)
      .send({}).expect(201);
    const options = JSON.parse(db.prepare('SELECT options FROM memes WHERE id = ?').get(sent.body.id).options);
    expect(options.soundPaths).toHaveLength(2);
    expect(sent.body.meme.sounds).toHaveLength(2);
  });

  it('remplace le contenu d\'un meme existant (retouche)', async () => {
    const before = db.prepare('SELECT media_path FROM assets WHERE id = ?').get(memeId).media_path;
    const updated = { ...scene, els: [{ ...scene.els[0], text: 'RETOUCHÉ' }] };
    await request(app).put(`/api/client/assets/${memeId}`).set('X-Device-Token', deviceToken)
      .field('kind', 'meme')
      .field('name', 'Mon meme retouché')
      .field('data', JSON.stringify({ text: 'RETOUCHÉ', options: { durationS: 6 }, scene: updated }))
      .attach('media', PNG_1x1, 'meme.png')
      .expect(200);

    const r = await request(app).get(`/api/client/assets/${memeId}`).set('X-Device-Token', deviceToken).expect(200);
    expect(r.body.name).toBe('Mon meme retouché');
    expect(r.body.data.scene.els[0].text).toBe('RETOUCHÉ');
    // Un seul asset : la retouche remplace au lieu de créer un doublon.
    const list = await request(app).get('/api/client/assets?kind=meme').set('X-Device-Token', deviceToken).expect(200);
    expect(list.body.filter((x) => x.id === memeId)).toHaveLength(1);
    expect(db.prepare('SELECT media_path FROM assets WHERE id = ?').get(memeId).media_path).not.toBe(before);
  });

  it('conserve le favori et la catégorie lors d\'un remplacement', async () => {
    await request(app).patch(`/api/client/assets/${memeId}`).set('X-Device-Token', deviceToken)
      .send({ favorite: true, category: 'Best-of' }).expect(200);
    await request(app).put(`/api/client/assets/${memeId}`).set('X-Device-Token', deviceToken)
      .field('kind', 'meme').field('name', 'Mon meme retouché')
      .field('data', JSON.stringify({ text: 'RETOUCHÉ', scene }))
      .expect(200);
    const r = await request(app).get(`/api/client/assets/${memeId}`).set('X-Device-Token', deviceToken).expect(200);
    expect(r.body.data.favorite).toBe(true);
    expect(r.body.data.category).toBe('Best-of');
    expect(r.body.data.mediaType).toBe('image'); // média conservé
  });

  it('isole les bibliothèques entre propriétaires', async () => {
    const list = await request(app).get('/api/client/assets?kind=meme').set('X-Device-Token', otherToken).expect(200);
    expect(list.body.find((x) => x.id === memeId)).toBeUndefined();
    await request(app).get(`/api/client/assets/${memeId}`).set('X-Device-Token', otherToken).expect(404);
    await request(app).post(`/api/client/assets/${memeId}/send`).set('X-Device-Token', otherToken).send({}).expect(404);
    await request(app).put(`/api/client/assets/${memeId}`).set('X-Device-Token', otherToken)
      .field('kind', 'meme').field('data', '{}').expect(404);
  });

  it('refuse une scène au-delà du plafond', async () => {
    const huge = JSON.stringify({ scene: { blob: 'x'.repeat(9 * 1048576) } });
    await request(app).post('/api/client/assets').set('X-Device-Token', deviceToken)
      .field('kind', 'meme').field('name', 'Trop lourd').field('data', huge)
      .expect(413);
  });

  it('refuse d\'enregistrer au-delà du quota de stockage', async () => {
    const ch = db.prepare('SELECT settings FROM channels WHERE id = ?').get(channelId);
    const settings = JSON.parse(ch.settings || '{}');
    db.prepare('UPDATE channels SET settings = ? WHERE id = ?')
      .run(JSON.stringify({ ...settings, storageQuotaMb: 0 }), channelId);
    await request(app).post('/api/client/assets').set('X-Device-Token', deviceToken)
      .field('kind', 'meme').field('name', 'Hors quota').field('data', JSON.stringify({ scene }))
      .attach('media', PNG_1x1, 'meme.png')
      .expect(413);
    db.prepare('UPDATE channels SET settings = ? WHERE id = ?').run(ch.settings, channelId);
  });

  it('supprime un meme de la bibliothèque', async () => {
    await request(app).delete(`/api/client/assets/${memeId}`).set('X-Device-Token', deviceToken).expect(200);
    const list = await request(app).get('/api/client/assets?kind=meme').set('X-Device-Token', deviceToken).expect(200);
    expect(list.body.find((x) => x.id === memeId)).toBeUndefined();
    await request(app).post(`/api/client/assets/${memeId}/send`).set('X-Device-Token', deviceToken).send({}).expect(404);
    expect(channelSlug).toBeTruthy();
  });
});
