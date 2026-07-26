// Tests des correctifs de sécurité de ce round : garde CSRF (Origin),
// portée des modérateurs de channel, état OAuth désactivé, et
// unité du module discordOAuth (state anti-CSRF).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { db, now } from '../src/db.js';
import { createState, verifyState, buildAuthorizeUrl, isOAuthEnabled } from '../src/discordOAuth.js';

const app = createApp();
const admin = request.agent(app);
let channelId;

beforeAll(async () => {
  ensureAdmin();
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'adminpass123' }).expect(200);
  const ch = await admin.post('/api/channels').send({ name: 'Sec Test' }).expect(201);
  channelId = ch.body.id;
});

describe('garde CSRF (vérification Origin)', () => {
  it('refuse une mutation avec une Origin cross-site', async () => {
    await request(app).post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ username: 'admin', password: 'adminpass123' })
      .expect(403);
  });

  it('refuse aussi via un Referer cross-site', async () => {
    await request(app).post('/api/auth/login')
      .set('Referer', 'https://evil.example/attaque.html')
      .send({ username: 'admin', password: 'adminpass123' })
      .expect(403);
  });

  it('autorise une mutation same-origin (Origin = Host)', async () => {
    // Origin correspondant au Host de la requête → passe le garde (puis 401 sur creds).
    await request(app).post('/api/auth/login')
      .set('Origin', 'http://127.0.0.1')
      .set('Host', '127.0.0.1')
      .send({ username: 'admin', password: 'mauvais' })
      .expect(401);
  });

  it('autorise une requête sans Origin (client non-navigateur)', async () => {
    await request(app).post('/api/auth/login')
      .send({ username: 'admin', password: 'mauvais' })
      .expect(401);
  });
});

describe('réglages de channel : réservés à qui gère le channel', () => {
  let mod;
  beforeAll(async () => {
    await admin.post('/api/auth/users').send({ username: 'modsec', password: 'modpass123', role: 'moderator' }).expect(201);
    mod = request.agent(app);
    await mod.post('/api/auth/login').send({ username: 'modsec', password: 'modpass123' }).expect(200);
  });

  it('un modérateur panel peut modifier les réglages', async () => {
    const r = await mod.put(`/api/channels/${channelId}/settings`).send({ moderationMode: 'off' }).expect(200);
    expect(r.body.moderationMode).toBe('off');
  });

  it('un admin le peut aussi', async () => {
    const r = await admin.put(`/api/channels/${channelId}/settings`).send({ moderationMode: 'filter' }).expect(200);
    expect(r.body.moderationMode).toBe('filter');
  });

  it('créer ou supprimer un channel reste réservé aux admins', async () => {
    await mod.post('/api/channels').send({ name: 'Interdit' }).expect(403);
    await mod.delete(`/api/channels/${channelId}`).expect(403);
  });
});

// Un membre promu modérateur dans la whitelist d'un channel gère CE channel
// depuis le panel — et rien d'autre : ni les autres channels, ni les écrans
// globaux (comptes, réglages serveur).
describe('modérateur de channel (promu dans la whitelist)', () => {
  const DISCORD_ID = '987654321098765';
  let chanMod; let otherId;

  beforeAll(async () => {
    const other = await admin.post('/api/channels').send({ name: 'Sec Autre' }).expect(201);
    otherId = other.body.id;
    // Compte 'member' lié à ce Discord. Mot de passe réel (au lieu du '!' posé
    // par le flux OAuth) pour pouvoir ouvrir une session dans le test.
    db.prepare('INSERT INTO users (username, password_hash, role, discord_id, created_at) VALUES (?,?,?,?,?)')
      .run('chanmod', bcrypt.hashSync('chanmodpass123', 4), 'member', DISCORD_ID, now());
    await admin.post(`/api/channels/${channelId}/whitelist`)
      .send({ discordId: DISCORD_ID, role: 'moderator' }).expect(201);
    chanMod = request.agent(app);
    await chanMod.post('/api/auth/login').send({ username: 'chanmod', password: 'chanmodpass123' }).expect(200);
  });

  it('annonce ses channels modérés dans /auth/me (contrat du panel)', async () => {
    const r = await chanMod.get('/api/auth/me').expect(200);
    expect(r.body.user.role).toBe('member');
    expect(r.body.user.moderatedChannels).toEqual([channelId]);
  });

  it('ne liste que les channels qu\'il modère', async () => {
    const r = await chanMod.get('/api/channels').expect(200);
    expect(r.body.map((c) => c.id)).toEqual([channelId]);
  });

  it('gère son channel : whitelist, groupes, appareils, soundboard, historique', async () => {
    await chanMod.get(`/api/channels/${channelId}`).expect(200);
    await chanMod.get(`/api/channels/${channelId}/whitelist`).expect(200);
    await chanMod.get(`/api/channels/${channelId}/groups`).expect(200);
    await chanMod.get(`/api/channels/${channelId}/devices`).expect(200);
    await chanMod.get(`/api/channels/${channelId}/soundboard`).expect(200);
    await chanMod.get(`/api/channels/${channelId}/memes`).expect(200);
  });

  it('modifie les réglages et la config Discord de son channel', async () => {
    const r = await chanMod.put(`/api/channels/${channelId}/settings`).send({ maxTextLength: 123 }).expect(200);
    expect(r.body.maxTextLength).toBe(123);
    await chanMod.put(`/api/channels/${channelId}/discord`).send({ guildId: '123456789012345' }).expect(200);
  });

  it('est refusé sur un channel qu\'il ne modère pas', async () => {
    await chanMod.get(`/api/channels/${otherId}`).expect(403);
    await chanMod.get(`/api/channels/${otherId}/whitelist`).expect(403);
    await chanMod.put(`/api/channels/${otherId}/settings`).send({ maxTextLength: 50 }).expect(403);
  });

  it('n\'atteint ni les écrans globaux ni la création de channel', async () => {
    await chanMod.get('/api/auth/users').expect(403);
    await chanMod.get('/api/settings/stats').expect(403);
    await chanMod.post('/api/channels').send({ name: 'Interdit' }).expect(403);
    await chanMod.delete(`/api/channels/${channelId}`).expect(403);
  });

  it('perd l\'accès dès qu\'il est rétrogradé', async () => {
    const wl = await admin.get(`/api/channels/${channelId}/whitelist`).expect(200);
    const row = wl.body.find((w) => w.discord_id === DISCORD_ID);
    await admin.patch(`/api/channels/${channelId}/whitelist/${row.id}`).send({ role: 'user' }).expect(200);
    await chanMod.get(`/api/channels/${channelId}`).expect(403);
    await chanMod.get('/api/channels').expect(403);
  });
});

describe('OAuth Discord désactivé (env de test sans client)', () => {
  it('status renvoie enabled:false', async () => {
    const r = await request(app).get('/api/auth/discord/status').expect(200);
    expect(r.body.enabled).toBe(false);
    expect(isOAuthEnabled()).toBe(false);
  });
  it('login renvoie 404 quand non configuré', async () => {
    await request(app).get('/api/auth/discord/login').expect(404);
  });
  it('callback renvoie 404 quand non configuré', async () => {
    await request(app).get('/api/auth/discord/callback?code=x&state=y').expect(404);
  });
});

describe('module discordOAuth : state anti-CSRF', () => {
  it('valide un state signé avec le bon nonce', () => {
    const { nonce, state } = createState({ intent: 'login' });
    const parsed = verifyState(state, nonce);
    expect(parsed).toEqual({ intent: 'login', userId: null });
  });
  it('rejette un state avec un mauvais nonce', () => {
    const { state } = createState({ intent: 'link', userId: 7 });
    expect(verifyState(state, 'mauvais_nonce')).toBeNull();
  });
  it('rejette un state absent ou falsifié', () => {
    expect(verifyState('', 'x')).toBeNull();
    expect(verifyState('pas.un.jwt', 'x')).toBeNull();
  });
  it('construit une URL d\'autorisation avec les bons paramètres', () => {
    const url = buildAuthorizeUrl('STATE123');
    expect(url).toContain('response_type=code');
    expect(url).toContain('scope=identify');
    expect(url).toContain('state=STATE123');
  });
});
