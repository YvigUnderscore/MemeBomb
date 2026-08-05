// Durée d'affichage : plafond par type de média, relevé quand le meme porte
// des sons. Une image accompagnée d'un son de 12 s était ramenée au plafond des
// images (8 s) et le son se faisait couper à l'écran.
import { describe, it, expect } from 'vitest';
import { sanitizeOptions } from '../src/memeService.js';

const SETTINGS = { maxImageDurationS: 8, maxGifDurationS: 10, maxVideoDurationS: 15, maxAudioDurationS: 15 };
const SOUND = [{ relPath: 'a.m4a' }];

describe('sanitizeOptions — durée', () => {
  it('borne une image à son plafond quand le meme n\'a pas de son', () => {
    expect(sanitizeOptions({ durationS: 12 }, SETTINGS, { type: 'image' }).durationS).toBe(8);
  });

  it('relève le plafond au plafond des sons quand le meme en porte un', () => {
    expect(sanitizeOptions({ durationS: 12 }, SETTINGS, { type: 'image' }, SOUND).durationS).toBe(12);
  });

  it('ne dépasse jamais le plafond des sons', () => {
    expect(sanitizeOptions({ durationS: 99 }, SETTINGS, { type: 'image' }, SOUND).durationS).toBe(15);
  });

  it('laisse raccourcir un meme en dessous de la durée de son média', () => {
    const o = sanitizeOptions({ durationS: 3 }, SETTINGS, { type: 'video', durationMs: 12000 });
    expect(o.durationS).toBe(3);
  });
});
