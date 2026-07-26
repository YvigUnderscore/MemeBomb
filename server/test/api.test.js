import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { db } from '../src/db.js';

const app = createApp();
const admin = request.agent(app);

beforeAll(async () => {
  ensureAdmin();
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'adminpass123' }).expect(200);
});

describe('santé & auth', () => {
  it('répond sur /healthz', async () => {
    const r = await request(app).get('/healthz').expect(200);
    expect(r.body.ok).toBe(true);
  });

  it('refuse un mauvais mot de passe', async () => {
    await request(app).post('/api/auth/login').send({ username: 'admin', password: 'faux' }).expect(401);
  });

  it('expose /me pour la session admin', async () => {
    const r = await admin.get('/api/auth/me').expect(200);
    expect(r.body.user.role).toBe('admin');
  });

  it('refuse /me sans session', async () => {
    await request(app).get('/api/auth/me').expect(401);
  });
});

describe('permissions', () => {
  let modAgent;
  beforeAll(async () => {
    await admin.post('/api/auth/users').send({ username: 'mod1', password: 'modpass123', role: 'moderator' }).expect(201);
    modAgent = request.agent(app);
    await modAgent.post('/api/auth/login').send({ username: 'mod1', password: 'modpass123' }).expect(200);
  });

  it('un modérateur ne peut pas créer de channel', async () => {
    await modAgent.post('/api/channels').send({ name: 'Interdit' }).expect(403);
  });

  it('un modérateur ne peut pas lister les comptes', async () => {
    await modAgent.get('/api/auth/users').expect(403);
  });
});

describe('cycle channel → whitelist → device → envoi', () => {
  let channelId; let deviceToken;

  it('crée un channel (admin)', async () => {
    const r = await admin.post('/api/channels').send({ name: 'API Test' }).expect(201);
    channelId = r.body.id;
    expect(r.body.slug).toBeTruthy();
  });

  it('valide l\'ID Discord de la whitelist', async () => {
    await admin.post(`/api/channels/${channelId}/whitelist`).send({ discordId: 'abc' }).expect(400);
    await admin.post(`/api/channels/${channelId}/whitelist`).send({ discordId: '123456789012345' }).expect(201);
  });

  it('appaire un appareil et récupère sa config', async () => {
    const code = (await admin.post(`/api/channels/${channelId}/devices/pair-code`).send({}).expect(201)).body.code;
    const pair = await request(app).post('/api/client/pair').send({ code, deviceName: 'PC Test' }).expect(201);
    deviceToken = pair.body.deviceToken;
    expect(deviceToken).toBeTruthy();
    const cfg = await request(app).get('/api/client/config').set('X-Device-Token', deviceToken).expect(200);
    expect(cfg.body.channel.name).toBe('API Test');
  });

  it('refuse un token d\'appareil invalide', async () => {
    await request(app).get('/api/client/config').set('X-Device-Token', 'faux').expect(401);
  });

  it('envoie un meme texte depuis l\'éditeur', async () => {
    const r = await request(app).post('/api/client/meme').set('X-Device-Token', deviceToken)
      .field('text', 'Hello depuis le test').expect(201);
    expect(r.body.id).toBeTruthy();
  });

  it('conserve les sauts de ligne d\'un texte multiligne', async () => {
    const r = await request(app).post('/api/client/meme').set('X-Device-Token', deviceToken)
      .field('text', 'Première ligne\nSeconde ligne').expect(201);
    const stored = db.prepare('SELECT text FROM memes WHERE id = ?').get(r.body.id);
    expect(stored.text).toBe('Première ligne\nSeconde ligne');
  });

  it('filtre l\'historique par recherche texte', async () => {
    const r = await admin.get(`/api/channels/${channelId}/memes?q=Hello`).expect(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body[0].text).toMatch(/Hello/);
  });

  it('gère les blocages personnels', async () => {
    await request(app).post('/api/client/blocks').set('X-Device-Token', deviceToken)
      .send({ senderId: 'panel:admin', name: 'Admin' }).expect(201);
    const list = await request(app).get('/api/client/blocks').set('X-Device-Token', deviceToken).expect(200);
    expect(list.body.some((b) => b.senderId === 'panel:admin')).toBe(true);
    await request(app).delete('/api/client/blocks/panel:admin').set('X-Device-Token', deviceToken).expect(200);
  });
});

describe('sécurité (kill-switch)', () => {
  it('révoque tous les appareils', async () => {
    const r = await admin.post('/api/settings/security/revoke-devices').expect(200);
    expect(r.body).toHaveProperty('revoked');
  });
});
