// Contrat éditeur ↔ serveur sur la transparence.
//
// Le serveur déduisait le besoin d'alpha de l'absence de couleur de fond, ce qui
// rangeait tout fond MÉDIA avec le fond « Aucun » et imposait un encodage VP9
// alpha — de loin le plus coûteux — à des scènes pourtant opaques. L'éditeur
// annonce désormais ce besoin explicitement (comp.transparent). Ces tests figent
// les trois cas, dont le repli indispensable pour un editor.js encore en cache.
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { composeLayers } from '../src/composer.js';

const SETTINGS = { maxUploadMb: 25, maxVideoDurationS: 15 };
const COMP = { durationS: 0.5, layers: [{ full: true }] };

const layer = () => sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 20, g: 120, b: 200 } } })
  .png().toBuffer();

const compose = async (comp) => composeLayers([await layer()], { ...COMP, ...comp }, null, SETTINGS);

describe('composer — décision de transparence', () => {
  it('sort un MP4 quand l\'éditeur annonce une scène opaque sans couleur de fond', async () => {
    const out = await compose({ bg: null, transparent: false });
    expect(out.transparent).toBe(false);
    expect(out.mime).toBe('video/mp4');
  }, 60_000);

  it('sort un WebM alpha quand l\'éditeur annonce une scène transparente', async () => {
    const out = await compose({ bg: null, transparent: true });
    expect(out.transparent).toBe(true);
    expect(out.mime).toBe('video/webm');
  }, 60_000);

  it('retombe sur l\'ancienne règle quand le champ est absent', async () => {
    const alpha = await compose({ bg: null });
    expect(alpha.transparent).toBe(true);
    const opaque = await compose({ bg: '#101014' });
    expect(opaque.transparent).toBe(false);
    expect(opaque.mime).toBe('video/mp4');
  }, 90_000);
});
