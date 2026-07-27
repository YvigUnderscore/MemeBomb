// Présence des membres : le serveur ne connaît que les sockets ouverts, l'état
// « ne pas déranger » lui est publié par le client (message `status`).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ensureAdmin } from '../src/auth.js';
import { initWebSocket } from '../src/wsHub.js';

const app = createApp();
const admin = request.agent(app);
const MEMBER = '111222333444555666';
let server, port, channelId, memberToken, editorToken;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Appareil appairé, éventuellement lié à un compte Discord.
async function pairDevice(name, discordId = '') {
  const code = (await admin.post(`/api/channels/${channelId}/devices/pair-code`)
    .send(discordId ? { discordId } : {}).expect(201)).body.code;
  const pair = await request(app).post('/api/client/pair').send({ code, deviceName: name }).expect(201);
  return pair.body.deviceToken;
}

const presence = (token) => request(app).get('/api/client/presence').set('X-Device-Token', token).expect(200);
const memberOf = (body, id) => body.members.find((m) => m.discordId === id);

beforeAll(async () => {
  ensureAdmin();
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'adminpass123' }).expect(200);
  channelId = (await admin.post('/api/channels').send({ name: 'Presence Test' }).expect(201)).body.id;
  await admin.post(`/api/channels/${channelId}/whitelist`)
    .send({ discordId: MEMBER, discordUsername: 'marc' }).expect(201);
  memberToken = await pairDevice('Marc PC', MEMBER);
  editorToken = await pairDevice('Editeur');

  server = http.createServer(app);
  initWebSocket(server);
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});

afterAll(() => { try { server.close(); } catch { /* ignore */ } });

describe('présence des destinataires', () => {
  it('suit connexion, « ne pas déranger », échéance dépassée et déconnexion', async () => {
    // Personne de connecté : le membre whitelisté est hors ligne.
    const before = (await presence(editorToken)).body;
    expect(before.enabled).toBe(true);
    expect(memberOf(before, MEMBER).status).toBe('offline');
    expect(before.others).toBe(0);

    const ws = await connectWs(memberToken);
    await wait(120);
    // Un client qui ne publie rien reste joignable — les anciennes versions
    // n'envoient pas de `status`.
    expect(memberOf((await presence(editorToken)).body, MEMBER).status).toBe('online');

    ws.send(JSON.stringify({ type: 'status', dnd: true, dndUntil: Date.now() + 60000, overlay: true }));
    await wait(120);
    const dnd = memberOf((await presence(editorToken)).body, MEMBER);
    expect(dnd.status).toBe('dnd');
    expect(dnd.dndUntil).toBeGreaterThan(Date.now());

    // Overlay coupé : joignable, mais rien ne s'affichera.
    ws.send(JSON.stringify({ type: 'status', dnd: false, overlay: false }));
    await wait(120);
    expect(memberOf((await presence(editorToken)).body, MEMBER).status).toBe('off');

    // Échéance déjà passée : le DND ne compte plus, sans nouvelle publication.
    ws.send(JSON.stringify({ type: 'status', dnd: true, dndUntil: Date.now() - 1000 }));
    await wait(120);
    expect(memberOf((await presence(editorToken)).body, MEMBER).status).toBe('online');

    ws.close();
    await wait(150);
    expect(memberOf((await presence(editorToken)).body, MEMBER).status).toBe('offline');
  });

  it('compte à part les appareils sans membre associé', async () => {
    const ws = await connectWs(editorToken);
    await wait(120);
    const body = (await presence(editorToken)).body;
    expect(body.others).toBe(1);                       // l'appareil non lié, non ciblable
    expect(memberOf(body, MEMBER).status).toBe('offline');
    ws.close();
    await wait(150);
  });

  it('reste muette quand le flag « presence » est coupé pour le membre', async () => {
    const wl = (await admin.get(`/api/channels/${channelId}/whitelist`).expect(200)).body
      .find((w) => w.discord_id === MEMBER);
    await admin.patch(`/api/channels/${channelId}/whitelist/${wl.id}`)
      .send({ features: { presence: false } }).expect(200);
    const body = (await presence(memberToken)).body;
    expect(body.enabled).toBe(false);
    expect(body.members).toEqual([]);
    await admin.patch(`/api/channels/${channelId}/whitelist/${wl.id}`).send({ features: {} }).expect(200);
  });
});
