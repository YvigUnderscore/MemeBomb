// ============================================================
//  Intégration myinstants.com (#13) — recherche et import de sons.
//
//  Sécurité : seul le domaine myinstants.com est autorisé (anti-SSRF),
//  taille plafonnée, et le fichier importé est TOUJOURS re-transcodé par
//  le pipeline média (processMedia) avant stockage — comme tout upload.
// ============================================================

import { HttpError } from './media.js';
import { logger } from './logger.js';

const HOST_RX = /^(www\.)?myinstants\.com$/i;
// UA type navigateur : certains CDN refusent les UA exotiques.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Récupère une page myinstants (SSRF-guardé : URL construite ici, jamais reçue).
 *
 * Les redirections sont suivies À LA MAIN, jamais par fetch : chaque saut doit
 * rester en https sur myinstants.com, sinon on abandonne. `redirect: 'error'`
 * seul ne suffit pas ici — le site renvoie un 30x sur plusieurs de ses chemins
 * (préfixe de langue, index par pays) et la page devenait alors injoignable.
 */
async function fetchInstantsPage(url, what, hops = 2) {
  let current = url;
  for (let i = 0; i <= hops; i++) {
    let resp;
    try {
      resp = await fetch(current, {
        headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000), redirect: 'manual',
      });
    } catch (e) {
      throw new HttpError(502, `${what} unavailable (${e?.cause?.code || e.message || 'network'}).`);
    }
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location') || '';
      let next;
      try { next = new URL(loc, current); } catch { throw new HttpError(502, `${what} unavailable (bad redirect).`); }
      if (next.protocol !== 'https:' || !HOST_RX.test(next.hostname)) {
        throw new HttpError(502, `${what} unavailable (off-site redirect).`);
      }
      current = next.href;
      continue;
    }
    if (!resp.ok) throw new HttpError(502, `${what} unavailable (HTTP ${resp.status}).`);
    return resp.text();
  }
  throw new HttpError(502, `${what} unavailable (too many redirects).`);
}

/** Extrait les boutons « instant » d'une page myinstants → [{ title, url }]. */
function parseInstants(html, limit) {
  const rx = /<button class="small-button" onclick="play\('(\/media\/sounds\/[^']+\.mp3)'[^)]*\)"[^>]*title="([^"]+)"/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = rx.exec(html)) && out.length < limit) {
    const url = `https://www.myinstants.com${m[1]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    // Décode les entités HTML basiques et retire l'habillage du title
    // (« Jouer le son de X » / « Play X sound » selon la locale).
    const title = m[2]
      .replace(/^Jouer le son de\s+/i, '').replace(/^Play\s+/i, '').replace(/\s+sound$/i, '')
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').slice(0, 80);
    out.push({ title, url });
  }
  return out;
}

/** Recherche des sons sur myinstants et renvoie [{ title, url }]. */
export async function searchMyInstants(query, limit = 24) {
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return [];
  const html = await fetchInstantsPage(
    `https://www.myinstants.com/fr/search/?name=${encodeURIComponent(q)}`, 'Sound search',
  );
  return parseInstants(html, limit);
}

// Pages « tendances » de myinstants, par région. Liste FERMÉE : la région
// reçue du client sert uniquement de clé ici, jamais de morceau d'URL —
// aucun chemin arbitraire ne peut donc être fabriqué depuis l'extérieur.
// Plusieurs chemins par région : le site en a déplacé/redirigé quelques-uns,
// on prend le premier qui répond ET qui contient des sons.
export const TRENDING_REGIONS = {
  world: { label: 'Monde', paths: ['/fr/index/all/', '/fr/', '/en/'] },
  fr: { label: 'France', paths: ['/fr/index/fr/', '/en/index/fr/'] },
  us: { label: 'États-Unis', paths: ['/fr/index/us/', '/en/index/us/'] },
  gb: { label: 'Royaume-Uni', paths: ['/fr/index/gb/', '/en/index/gb/'] },
  es: { label: 'Espagne', paths: ['/fr/index/es/', '/en/index/es/'] },
  de: { label: 'Allemagne', paths: ['/fr/index/de/', '/en/index/de/'] },
  it: { label: 'Italie', paths: ['/fr/index/it/', '/en/index/it/'] },
  br: { label: 'Brésil', paths: ['/fr/index/br/', '/en/index/br/'] },
};

/**
 * Sons tendance d'une région → [{ title, url }] (même format que la recherche).
 * Ne LÈVE PAS quand myinstants est injoignable ou a changé de balisage : les
 * tendances sont un confort, une liste vide (et un log) vaut mieux qu'un 502
 * sur l'ouverture du popover Son.
 */
export async function trendingMyInstants(region = 'world', limit = 24) {
  const entry = TRENDING_REGIONS[String(region || '').toLowerCase()] || TRENDING_REGIONS.world;
  const reasons = [];
  for (const p of entry.paths) {
    try {
      const list = parseInstants(await fetchInstantsPage(`https://www.myinstants.com${p}`, 'Trending sounds'), limit);
      if (list.length) return list;
      reasons.push(`${p}: aucun son reconnu`);
    } catch (e) {
      reasons.push(`${p}: ${e.message}`);
    }
  }
  logger.warn(`Tendances myinstants (${region}) indisponibles — ${reasons.join(' | ')}`);
  return [];
}

/** Télécharge un mp3 myinstants (SSRF-guardé, taille plafonnée) → Buffer. */
export async function downloadMyInstants(rawUrl, maxBytes = 8 * 1024 * 1024) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new HttpError(400, 'Invalid sound URL.'); }
  if (u.protocol !== 'https:' || !HOST_RX.test(u.hostname)) {
    throw new HttpError(400, 'Only myinstants.com sounds are allowed.');
  }
  if (!/\.mp3$/i.test(u.pathname)) throw new HttpError(400, 'The sound must be an .mp3 file.');

  let resp;
  try {
    // redirect: 'error' → une redirection (potentiellement vers une IP interne) fait échouer
    // la requête au lieu d'être suivie : le contrôle d'hôte ci-dessus ne peut pas être contourné.
    resp = await fetch(u.href, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch { throw new HttpError(502, 'Could not download the sound.'); }
  if (!resp.ok) throw new HttpError(502, `Could not download the sound (HTTP ${resp.status}).`);

  const len = Number(resp.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new HttpError(413, 'Sound too large.');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) throw new HttpError(413, 'Sound too large.');
  if (buf.length === 0) throw new HttpError(502, 'Empty sound.');
  return buf;
}
