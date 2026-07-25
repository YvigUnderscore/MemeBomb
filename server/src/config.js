import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'tmp'), { recursive: true });

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// ---- Secrets : zéro-config par défaut -----------------------------------
// Un secret ABSENT est auto-généré au premier démarrage et persisté dans
// DATA_DIR/.secrets.json (survit aux redémarrages/upgrades du conteneur).
// Un secret FOURNI mais faible est refusé en production : un JWT_SECRET connu
// permettrait de forger une session admin, un ENCRYPTION_KEY connu de
// déchiffrer les tokens Discord stockés.
const SECRETS_FILE = path.join(DATA_DIR, '.secrets.json');
let persistedSecrets = {};
try { persistedSecrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { /* premier démarrage */ }

function autoSecret(name, bytes = 32) {
  if (process.env[name]) return process.env[name];
  if (persistedSecrets[name]) return persistedSecrets[name];
  const v = crypto.randomBytes(bytes).toString('hex');
  persistedSecrets[name] = v;
  try {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(persistedSecrets, null, 2), { mode: 0o600 });
    // eslint-disable-next-line no-console
    console.log(`[config] ${name} auto-generated and stored in ${SECRETS_FILE}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[config] Could not persist ${name} (${e.message}) — it will change on restart.`);
  }
  return v;
}

// TRUST_PROXY accepte les mêmes valeurs qu'Express : un nombre de sauts, `false`
// pour ne rien croire, ou une liste d'IP/CIDR/noms prédéfinis
// (`loopback`, `linklocal`, `uniquelocal`).
function parseTrustProxy(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return 'loopback, uniquelocal, linklocal';
  if (/^(false|off|0|none)$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

const WEAK_VALUES = new Set([
  'change_me_openssl_rand_hex_32', 'change_me_strong_password',
  'dev-insecure-secret-change-me', 'dev-insecure-encryption-key-change-me', 'admin', 'password',
]);
const secretProblems = [];
for (const [name, minLen] of [['JWT_SECRET', 32], ['ENCRYPTION_KEY', 16], ['ADMIN_PASSWORD', 8]]) {
  const v = process.env[name];
  if (v === undefined || v === '') continue; // absent → auto-généré, rien à valider
  if (WEAK_VALUES.has(v)) secretProblems.push(`${name} uses a default/weak value`);
  else if (v.length < minLen) secretProblems.push(`${name} is too short (min ${minLen} characters)`);
}
if (secretProblems.length) {
  const msg = `[SECURITY] Non-compliant secrets:\n  - ${secretProblems.join('\n  - ')}`;
  if (IS_PROD) {
    throw new Error(`${msg}\nSet strong values (openssl rand -hex 32) or simply REMOVE them to let MemeDrop auto-generate.`);
  }
  // eslint-disable-next-line no-console
  console.warn(`\x1b[33m${msg}\n  → Tolerated in development only.\x1b[0m`);
}

// Mot de passe admin : absent → généré (lisible) et loggé À LA CRÉATION du
// compte uniquement (voir ensureAdmin dans auth.js).
const generatedAdminPassword = !process.env.ADMIN_PASSWORD;
const adminPassword = process.env.ADMIN_PASSWORD
  || persistedSecrets.ADMIN_PASSWORD
  || autoSecret('ADMIN_PASSWORD', 9); // 18 caractères hex — lisible et fort

export const config = {
  env: NODE_ENV,
  port: parseInt(process.env.PORT || '8080', 10),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, ''),
  jwtSecret: autoSecret('JWT_SECRET'),
  encryptionKey: autoSecret('ENCRYPTION_KEY'),
  dataDir: DATA_DIR,
  mediaDir: path.join(DATA_DIR, 'media'),
  tmpDir: path.join(DATA_DIR, 'tmp'),
  dbPath: path.join(DATA_DIR, 'memedrop.sqlite'),
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: adminPassword,
    generated: generatedAdminPassword,
  },
  discord: {
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    // URI de redirection OAuth2 (doit être déclarée à l'identique dans le portail Discord).
    redirectUri: (process.env.DISCORD_REDIRECT_URI
      || `${(process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, '')}/api/auth/discord/callback`),
  },
  // Clé API Giphy (recherche de GIFs dans l'éditeur) — optionnelle, la
  // fonctionnalité est masquée si absente. https://developers.giphy.com/
  giphyKey: process.env.GIPHY_API_KEY || '',
  defaults: {
    maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '25', 10),
    maxVideoDurationS: parseInt(process.env.MAX_VIDEO_DURATION_S || '15', 10),
    maxAudioDurationS: parseInt(process.env.MAX_AUDIO_DURATION_S || '15', 10),
    maxTextLength: parseInt(process.env.MAX_TEXT_LENGTH || '280', 10),
  },
  // Budget CPU du transcodage. La machine hôte a 4 cœurs et l'API, le
  // WebSocket et le panel vivent dans le même process : un ffmpeg libre de
  // prendre tous les cœurs rend le serveur injoignable le temps d'un envoi.
  // `threads` borne chaque process ffmpeg (et le pool libvips de sharp),
  // `concurrency` borne le nombre d'encodages simultanés (transcodeQueue.js).
  // Défauts 2 × 1 = au plus 2 cœurs occupés, 2 restent pour servir.
  transcode: {
    threads: Math.max(1, parseInt(process.env.TRANSCODE_THREADS || '2', 10) || 2),
    concurrency: Math.max(1, parseInt(process.env.TRANSCODE_CONCURRENCY || '1', 10) || 1),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
  // Quels intermédiaires ont le droit de renseigner X-Forwarded-For.
  // Le rate limiting (dont celui du login) compte par IP cliente, et cette IP
  // est lue dans X-Forwarded-For : si l'on fait confiance à n'importe quel
  // appelant, il suffit d'inventer l'en-tête pour obtenir un quota neuf à
  // chaque tentative. Défaut : on ne fait confiance qu'aux intermédiaires
  // joignables en loopback ou en adressage privé (reverse proxy sur l'hôte ou
  // en conteneur) — une requête venue d'une IP publique ne peut donc pas
  // usurper l'en-tête. Mettre l'IP exacte du proxy pour durcir davantage,
  // ou `false` pour ne jamais faire confiance à X-Forwarded-For.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};
