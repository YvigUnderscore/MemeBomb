// ============================================================
//  Construction de l'application Express (sans écoute réseau).
//  Isolée d'index.js pour être importable dans les tests (supertest).
// ============================================================
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { config } from './config.js';
import { errorMiddleware } from './routes/helpers.js';

import authRouter from './routes/auth.js';
import channelsRouter from './routes/channels.js';
import whitelistRouter from './routes/whitelist.js';
import groupsRouter from './routes/groups.js';
import devicesRouter from './routes/devices.js';
import memesRouter from './routes/memes.js';
import settingsRouter from './routes/settings.js';
import clientRouter from './routes/client.js';
import mediaRouter from './routes/media.js';
import hallRouter from './routes/hall.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// --- Protection CSRF (défense en profondeur) ----------------------------
// La session panel est un cookie SameSite=Lax : les navigateurs n'envoient donc
// déjà pas ce cookie sur une requête POST cross-site. On ajoute une vérification
// d'Origin/Referer : toute mutation dont l'entête Origin/Referer pointe vers un
// autre hôte est refusée. Les clients non-navigateur (client Electron, bot, CLI,
// tests) n'envoient pas d'Origin → autorisés (ils s'authentifient par token, pas cookie).
function allowedHosts(req) {
  const set = new Set();
  try { set.add(new URL(config.publicUrl).host); } catch { /* ignore */ }
  if (req.headers.host) set.add(req.headers.host);
  return set;
}
function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const source = req.headers.origin || req.headers.referer;
  if (!source) return next(); // client non-navigateur (token-based)
  let host;
  try { host = new URL(source).host; } catch { return res.status(403).json({ error: 'Invalid origin.' }); }
  if (!allowedHosts(req).has(host)) {
    return res.status(403).json({ error: 'Cross-origin request denied (CSRF).' });
  }
  next();
}

export function createApp() {
  const app = express();
  // Voir config.trustProxy : la valeur décide qui peut renseigner
  // X-Forwarded-For, donc l'IP sur laquelle porte le rate limiting.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // cdn.discordapp.com : avatars Discord ; *.giphy.com : vignettes GIF de l'éditeur (/compose).
        imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.discordapp.com', 'https://*.giphy.com'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        // 'self' (et non 'none') : le panel embarque l'éditeur web (/compose) en iframe
        // same-origin. Le framing cross-site reste interdit (anti-clickjacking).
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
      },
    },
    frameguard: { action: 'sameorigin' }, // X-Frame-Options: SAMEORIGIN (cohérent avec frameAncestors)
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // médias lus par le client Electron
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));

  // --- Rate limiting -----------------------------------------------------
  const apiLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 40, standardHeaders: true, legacyHeaders: false });
  const pairLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
  // Uploads : lourds en CPU (transcodage) et en mémoire (buffer). Plafond serré.
  const uploadLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
  // OAuth : évite l'abus des redirections/échanges de code.
  const oauthLimiter = rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false });

  app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

  // --- Médias (URL signée) ----------------------------------------------
  app.use('/media', mediaRouter);

  // --- API --------------------------------------------------------------
  app.use('/api', apiLimiter);
  app.use('/api', csrfGuard);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/discord', oauthLimiter);
  app.use('/api/client/pair', pairLimiter);
  // Endpoints qui reçoivent des fichiers (transcodage) : limiteur dédié.
  app.use(['/api/client/meme', '/api/client/schedules', '/api/client/assets', '/api/client/sounds/import', '/api/client/media/from-url'], uploadLimiter);

  app.use('/api/auth', authRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/channels/:channelId/whitelist', whitelistRouter);
  app.use('/api/channels/:channelId/groups', groupsRouter);
  app.use('/api/channels/:channelId/devices', devicesRouter);
  app.use('/api/channels/:channelId', memesRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/client', clientRouter);
  app.use('/api/hall', hallRouter);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Route not found' }));

  // --- Panel web (SPA) --------------------------------------------------
  // Interdit toute mise en cache, navigateur ET CDN intermédiaire. Cloudflare
  // n'honore `Cache-Control` que si « Origin Cache Control » est actif ; les
  // en-têtes ciblés (CDN-Cache-Control, puis le préfixé) sont, eux, toujours lus.
  const setNoStore = (res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  };

  // Version des fichiers de l'éditeur : date du plus récent d'entre eux, donc
  // stable tant que rien ne bouge et renouvelée à chaque déploiement.
  const ASSET_VERSION = (() => {
    const dir = path.join(PUBLIC_DIR, 'compose');
    try {
      const times = fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs);
      if (times.length) return String(Math.round(Math.max(...times)));
    } catch { /* éditeur non buildé : la route renvoie déjà un 404 explicite */ }
    return String(Date.now());
  })();

  if (fs.existsSync(PUBLIC_DIR)) {
    // Éditeur web (page autonome, hors SPA React) : /compose → compose/index.html.
    // `__V__` y est remplacé par la version des assets : les CSS/JS de l'éditeur
    // n'ont pas de hash dans leur nom, cette version est ce qui garantit qu'un
    // redéploiement invalide vraiment ce qui est en cache, chez le client comme
    // sur le CDN. La CSP interdisant l'inline, l'injection se fait ici — donc
    // avant express.static, qui servirait sinon le fichier brut.
    app.get(['/compose', '/compose/', '/compose/index.html'], (req, res) => {
      const f = path.join(PUBLIC_DIR, 'compose', 'index.html');
      if (!fs.existsSync(f)) return res.status(404).send('Web editor not built (server/public/compose/).');
      setNoStore(res);
      res.type('html').send(fs.readFileSync(f, 'utf8').replaceAll('__V__', ASSET_VERSION));
    });
    app.use(express.static(PUBLIC_DIR, {
      index: false,
      maxAge: '1h',
      // Fichiers de l'éditeur (/compose) : non versionnés (pas de hash dans le
      // nom) → no-store, sinon les navigateurs gardent l'ancien JS/CSS 1 h
      // après une mise à jour (editor.js est injecté dynamiquement : même un
      // rechargement forcé ne le rafraîchit pas). Les assets du panel, eux,
      // ont un hash dans le nom et restent cachés.
      // CDN-Cache-Control : un CDN devant l'origine (Cloudflare) met en cache
      // les .js/.css d'après leur EXTENSION et ignore le Cache-Control d'origine.
      // Sans ça, api.js peut être servi dans une version plus ancienne
      // qu'editor.js (lui cache-busté) → méthodes manquantes et sons ignorés.
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}compose${path.sep}`)) setNoStore(res);
      },
    }));
    app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  } else {
    app.get('*', (req, res) => res.status(200).send(
      '<h1>MemeDrop</h1><p>Le panel web n\'est pas encore buildé. Voir docs/CLIENT.md.</p>'));
  }

  app.use(errorMiddleware);
  return app;
}
