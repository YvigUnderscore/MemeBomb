// Hall of Memes : top hebdo live, archives, commentaires, réactions,
// et accès membre (scopé sur sa whitelist).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { createApp } from '../src/app.js';
import { ensureAdmin, issueSession } from '../src/auth.js';
import { config } from '../src/config.js';
import { db, now } from '../src/db.js';
import { runHallArchive, weekStart, weekKey } from '../src/hallArchive.js';

const app = createApp();
const admin = request.agent(app);
let channelId;
let memeId;
let memberToken; // JWT Bearer d'un compte 'member'

function insertMeme(cid, { id = nanoid(14), text = 'lol', createdAt = now(), reactions = 0, soundPaths = [] } = {}) {
  db.prepare(`INSERT INTO memes (id, channel_id, sender, sender_name, source, type, text, targets, options, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, cid, '111111111111111', 'Testeur', 'editor', 'text', text, '[]',
      JSON.stringify(soundPaths.length ? { soundPaths } : {}), 'sent', createdAt);
  for (let i = 0; i < reactions; i++) {
    db.prepare(`INSERT INTO meme_reactions (meme_id, channel_id, device_id, discord_id, name, emoji, created_at)
        VALUES (?,?,?,?,?,?,?)`).run(id, cid, 1000 + i, '', `dev${i}`, '😂', now());
  }
  return id;
}

beforeAll(async () => {
  ensureAdmin();
  await admin.post('/api/auth/login').send({ username: 'admin', password: 'adminpass123' }).expect(200);
  channelId = (await admin.post('/api/channels').send({ name: 'Hall Test' }).expect(201)).body.id;

  // Meme de la semaine courante avec 3 réactions.
  memeId = insertMeme(channelId, { text: 'top de la semaine', reactions: 3 });
  // Meme de la semaine DERNIÈRE avec 5 réactions (sera archivé).
  const lastWeek = weekStart().getTime() - 3 * 86400000 - 7 * 86400000 + 86400000;
  insertMeme(channelId, { text: 'star de la semaine passée', createdAt: lastWeek, reactions: 5 });

  // Compte membre whitelisté sur ce channel.
  db.prepare(`INSERT INTO whitelist (channel_id, discord_id, discord_username, role, can_send, created_at)
      VALUES (?,?,?,?,1,?)`).run(channelId, '222222222222222', 'Membre', 'user', now());
  const info = db.prepare(`INSERT INTO users (username, password_hash, role, discord_id, discord_username, created_at)
      VALUES (?,?,?,?,?,?)`).run('membre-hall', '!', 'member', '222222222222222', 'Membre', now());
  memberToken = issueSession({ id: info.lastInsertRowid, username: 'membre-hall', role: 'member' });
});

describe('hall of memes', () => {
  it('liste le top live de la semaine courante', async () => {
    const r = await admin.get(`/api/hall/${channelId}/top?week=current`).expect(200);
    expect(r.body.live).toBe(true);
    expect(r.body.memes.some((m) => m.memeId === memeId && m.reactions === 3)).toBe(true);
  });

  it('archive la semaine écoulée (top 10 figé)', async () => {
    runHallArchive();
    const weeks = (await admin.get(`/api/hall/${channelId}/weeks`).expect(200)).body.weeks;
    expect(weeks.length).toBeGreaterThan(0);
    const r = await admin.get(`/api/hall/${channelId}/top?week=${weeks[0]}`).expect(200);
    expect(r.body.live).toBe(false);
    expect(r.body.memes[0].text).toBe('star de la semaine passée');
    expect(r.body.memes[0].reactions).toBe(5);
  });

  it('un membre voit le hall de ses channels, un intrus non', async () => {
    const list = (await request(app).get('/api/hall/channels').set('Authorization', `Bearer ${memberToken}`).expect(200)).body;
    expect(list.some((c) => c.id === channelId)).toBe(true);
    // Un membre d'aucun channel : accès refusé.
    const info = db.prepare(`INSERT INTO users (username, password_hash, role, discord_id, created_at)
        VALUES (?,?,?,?,?)`).run('intrus', '!', 'member', '999999999999999', now());
    const intrus = issueSession({ id: info.lastInsertRowid, username: 'intrus', role: 'member' });
    await request(app).get(`/api/hall/${channelId}/top`).set('Authorization', `Bearer ${intrus}`).expect(403);
  });

  it('commente et réagit (toggle) sur un meme du hall', async () => {
    const c = await request(app).post(`/api/hall/memes/${memeId}/comments`)
      .set('Authorization', `Bearer ${memberToken}`).send({ text: 'GG 😂' }).expect(201);
    expect(c.body.username).toBe('Membre');
    const list = (await admin.get(`/api/hall/memes/${memeId}/comments`).expect(200)).body;
    expect(list.some((x) => x.text === 'GG 😂')).toBe(true);

    const r1 = await request(app).post(`/api/hall/memes/${memeId}/react`)
      .set('Authorization', `Bearer ${memberToken}`).send({ emoji: '🔥' }).expect(200);
    expect(r1.body.counts['🔥']).toBe(1);
    const r2 = await request(app).post(`/api/hall/memes/${memeId}/react`)
      .set('Authorization', `Bearer ${memberToken}`).send({ emoji: '🔥' }).expect(200);
    expect(r2.body.counts['🔥']).toBeUndefined(); // toggle → retiré
  });

  it('refuse un emoji hors liste et les comptes member sur les routes staff', async () => {
    await request(app).post(`/api/hall/memes/${memeId}/react`)
      .set('Authorization', `Bearer ${memberToken}`).send({ emoji: '🍆' }).expect(400);
    await request(app).get('/api/channels').set('Authorization', `Bearer ${memberToken}`).expect(403);
    await request(app).get('/api/settings/stats').set('Authorization', `Bearer ${memberToken}`).expect(403);
  });
});

// --- Vote après coup : compte dans le classement, semaine courante ET archives.
describe('votes du hall dans le classement', () => {
  const vote = (id, emoji) => admin.post(`/api/hall/memes/${id}/react`).send({ emoji }).expect(200);

  it('fait entrer un meme sans réaction dans le top live, et le classe', async () => {
    const cid = (await admin.post('/api/channels').send({ name: 'Vote live' }).expect(201)).body.id;
    const chouchou = insertMeme(cid, { text: 'personne ne l a vu passer' }); // 0 réaction d'affichage
    const populaire = insertMeme(cid, { text: 'vu en direct', reactions: 2 });

    // Sans vote, un meme à zéro n'est pas dans le top.
    let top = (await admin.get(`/api/hall/${cid}/top?week=current`).expect(200)).body;
    expect(top.memes.map((m) => m.memeId)).toEqual([populaire]);

    // Trois votes après coup le font passer devant.
    for (const e of ['😂', '🔥', '💀']) await vote(chouchou, e);
    top = (await admin.get(`/api/hall/${cid}/top?week=current`).expect(200)).body;
    expect(top.memes.map((m) => m.memeId)).toEqual([chouchou, populaire]);
    const first = top.memes[0];
    expect(first.rank).toBe(1);
    expect(first.reactions).toBe(0);   // aucune réaction à l'affichage
    expect(first.votes).toBe(3);
    expect(first.score).toBe(3);       // c'est le score qui classe
  });

  it('réordonne une semaine archivée quand un vote tombe après l archivage', async () => {
    const cid = (await admin.post('/api/channels').send({ name: 'Vote archive' }).expect(201)).body.id;
    const lastWeek = weekStart().getTime() - 6 * 86400000;
    const premier = insertMeme(cid, { text: 'gagnant du moment', createdAt: lastWeek, reactions: 4 });
    const second = insertMeme(cid, { text: 'revanche tardive', createdAt: lastWeek, reactions: 2 });
    runHallArchive();

    const week = (await admin.get(`/api/hall/${cid}/weeks`).expect(200)).body.weeks[0];
    let archive = (await admin.get(`/api/hall/${cid}/top?week=${week}`).expect(200)).body;
    expect(archive.memes.map((m) => m.memeId)).toEqual([premier, second]);

    // Trois votes tardifs : 2 + 3 dépasse 4.
    for (const e of ['😂', '🔥', '💀']) await vote(second, e);
    archive = (await admin.get(`/api/hall/${cid}/top?week=${week}`).expect(200)).body;
    expect(archive.memes.map((m) => m.memeId)).toEqual([second, premier]);
    expect(archive.memes[0].rank).toBe(1);
    expect(archive.memes[0].reactions).toBe(2);  // le snapshot d'affichage ne bouge pas
    expect(archive.memes[0].score).toBe(5);      // 2 + 3 votes, sans double comptage
  });
});

// --- Sons joués à l'apparition : rejouables depuis le Hall, archives comprises.
describe('sons du hall', () => {
  it('expose les sons du meme et en garde une copie à l archivage', async () => {
    const cid = (await admin.post('/api/channels').send({ name: 'Sons hall' }).expect(201)).body.id;
    const rel = `${nanoid(10)}.m4a`;
    fs.writeFileSync(path.join(config.mediaDir, rel), 'faux son');
    const lastWeek = weekStart().getTime() - 6 * 86400000;
    const id = insertMeme(cid, { text: 'toute la blague est le son', createdAt: lastWeek, reactions: 1, soundPaths: [rel] });

    runHallArchive();
    const week = (await admin.get(`/api/hall/${cid}/weeks`).expect(200)).body.weeks[0];
    const archived = (await admin.get(`/api/hall/${cid}/top?week=${week}`).expect(200)).body.memes[0];
    expect(archived.memeId).toBe(id);
    expect(archived.soundUrls).toHaveLength(1);

    // Copie physique : l'archive survit à la purge du fichier d'origine.
    const copy = JSON.parse(db.prepare('SELECT sound_paths FROM hall_archive WHERE meme_id = ?').get(id).sound_paths);
    expect(copy).toHaveLength(1);
    expect(copy[0]).not.toBe(rel);
    expect(fs.existsSync(path.join(config.mediaDir, copy[0]))).toBe(true);
  });
});
