import { describe, it, expect } from 'vitest';
import { createTranscodeQueue } from '../src/transcodeQueue.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('file d\'attente des encodages', () => {
  it('ne fait jamais tourner deux jobs en même temps à concurrence 1', async () => {
    const q = createTranscodeQueue(1);
    let live = 0, maxLive = 0;
    const job = async () => {
      live++;
      maxLive = Math.max(maxLive, live);
      await wait(20);
      live--;
    };
    await Promise.all([q.run('a', job), q.run('b', job), q.run('c', job)]);
    expect(maxLive).toBe(1);
    expect(q.running).toBe(0);
    expect(q.pending).toBe(0);
  });

  it('respecte l\'ordre d\'arrivée', async () => {
    const q = createTranscodeQueue(1);
    const order = [];
    await Promise.all(['a', 'b', 'c'].map((n) => q.run(n, async () => {
      await wait(5);
      order.push(n);
    })));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('libère le jeton quand un job échoue (sinon la file se fige)', async () => {
    const q = createTranscodeQueue(1);
    let ran = false;
    const failing = q.run('ko', async () => { await wait(10); throw new Error('ffmpeg boom'); });
    const following = q.run('ok', async () => { ran = true; return 42; });
    await expect(failing).rejects.toThrow('ffmpeg boom');
    await expect(following).resolves.toBe(42);
    expect(ran).toBe(true);
    expect(q.running).toBe(0);
  });

  it('libère aussi le jeton sur une erreur SYNCHRONE du job', async () => {
    const q = createTranscodeQueue(1);
    await expect(q.run('ko-sync', () => { throw new Error('build failed'); })).rejects.toThrow('build failed');
    await expect(q.run('ok', async () => 'suivant')).resolves.toBe('suivant');
    expect(q.running).toBe(0);
  });

  it('laisse passer N jobs de front quand la concurrence le permet', async () => {
    const q = createTranscodeQueue(2);
    let live = 0, maxLive = 0;
    const job = async () => {
      live++;
      maxLive = Math.max(maxLive, live);
      await wait(20);
      live--;
    };
    await Promise.all([q.run('a', job), q.run('b', job), q.run('c', job), q.run('d', job)]);
    expect(maxLive).toBe(2);
  });

  it('remonte le temps d\'attente et le temps d\'exécution', async () => {
    const q = createTranscodeQueue(1);
    const seen = [];
    const report = (m) => seen.push(m);
    await Promise.all([
      q.run('premier', () => wait(30), report),
      q.run('second', () => wait(5), report),
    ]);
    expect(seen.map((m) => m.label)).toEqual(['premier', 'second']);
    // Le premier démarre tout de suite ; le second a attendu derrière lui.
    expect(seen[0].waitMs).toBeLessThan(20);
    expect(seen[0].runMs).toBeGreaterThanOrEqual(25);
    expect(seen[1].waitMs).toBeGreaterThanOrEqual(25);
  });
});
