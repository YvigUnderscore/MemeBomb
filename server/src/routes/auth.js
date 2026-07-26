import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, now, audit } from '../db.js';
import { config } from '../config.js';
import {
  verifyPassword, issueSession, panelAuth, requireAdmin, verifySessionUser, bumpUserEpoch,
  moderatedChannelIds,
} from '../auth.js';
import { closePanelSessions } from '../wsHub.js';
import {
  isOAuthEnabled, createState, verifyState, buildAuthorizeUrl, exchangeCode, fetchDiscordUser,
} from '../discordOAuth.js';
import { asyncHandler } from './helpers.js';

const router = Router();

const OAUTH_NONCE_COOKIE = 'md_oauth_state';
const secureCookie = config.publicUrl.startsWith('https');
function sessionCookieOpts() {
  return { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: 7 * 24 * 3600 * 1000 };
}

router.post('/login', asyncHandler((req, res) => {
  const { username, password } = z.object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(200),
  }).parse(req.body);
  const user = verifyPassword(username, password);
  if (!user) { audit(username, 'auth.login.fail', '', req.ip); return res.status(401).json({ error: 'Invalid credentials' }); }
  const token = issueSession(user);
  res.cookie('md_session', token, sessionCookieOpts());
  audit(username, 'auth.login.ok', '', req.ip);
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
}));

router.post('/logout', (req, res) => {
  res.clearCookie('md_session');
  res.json({ ok: true });
});

router.get('/me', panelAuth, (req, res) => {
  const u = db.prepare('SELECT discord_avatar, name_color, name_glow FROM users WHERE id = ?').get(req.user.id);
  const avatarUrl = (req.user.discord_id && u?.discord_avatar)
    ? `https://cdn.discordapp.com/avatars/${req.user.discord_id}/${u.discord_avatar}.png?size=128`
    : null;
  res.json({
    user: {
      id: req.user.id, username: req.user.username, role: req.user.role,
      discordId: req.user.discord_id || null,
      discordUsername: req.user.discord_username || null,
      discordAvatarUrl: avatarUrl,
      nameColor: u?.name_color || null,
      nameGlow: u?.name_glow || null,
      // Channels dont ce compte est modérateur via la whitelist. Le panel s'en
      // sert pour ouvrir les écrans de channel à un compte 'member'.
      moderatedChannels: moderatedChannelIds(req.user),
    },
    oauth: { discordEnabled: isOAuthEnabled() },
  });
});

// Style du pseudo affiché sur l'overlay quand on envoie un meme (couleur + glow).
router.post('/profile/style', panelAuth, asyncHandler((req, res) => {
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const b = z.object({
    nameColor: z.string().regex(HEX).nullable(),
    nameGlow: z.string().regex(HEX).nullable(),
  }).parse(req.body);
  db.prepare('UPDATE users SET name_color = ?, name_glow = ? WHERE id = ?')
    .run(b.nameColor, b.nameGlow, req.user.id);
  // Propage sur toutes les whitelist de ce compte Discord (lu par memeService).
  if (req.user.discord_id) {
    db.prepare('UPDATE whitelist SET name_color = ?, name_glow = ? WHERE discord_id = ?')
      .run(b.nameColor, b.nameGlow, String(req.user.discord_id));
  }
  audit(req.user.username, 'profile.style', b);
  res.json({ ok: true });
}));

router.post('/change-password', panelAuth, asyncHandler((req, res) => {
  const { current, next: nextPw } = z.object({
    current: z.string().min(1), next: z.string().min(8).max(200),
  }).parse(req.body);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current, u.password_hash)) return res.status(403).json({ error: 'Current password is incorrect' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(nextPw, 12), u.id);
  // Révoque les AUTRES sessions de ce compte : changer son mot de passe est le
  // réflexe de quelqu'un qui se sait compromis, et doit donc déconnecter un
  // éventuel cookie volé (il restait valide jusqu'à 7 jours).
  bumpUserEpoch(u.id);
  closePanelSessions(u.id);
  // …puis remet la session courante à jour, pour ne pas déconnecter l'auteur
  // du changement du navigateur qu'il est en train d'utiliser.
  res.cookie('md_session', issueSession(u), sessionCookieOpts());
  audit(req.user.username, 'auth.password.change', '', req.ip);
  res.json({ ok: true });
}));

// --- Gestion des comptes panel (admin) ----------------------------------
router.get('/users', panelAuth, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all());
});

router.post('/users', panelAuth, requireAdmin, asyncHandler((req, res) => {
  const { username, password, role } = z.object({
    username: z.string().min(1).max(64),
    password: z.string().min(8).max(200),
    role: z.enum(['admin', 'moderator']).default('moderator'),
  }).parse(req.body);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'This name already exists' });
  }
  const info = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)')
    .run(username, bcrypt.hashSync(password, 12), role, now());
  audit(req.user.username, 'user.create', username);
  res.status(201).json({ id: info.lastInsertRowid, username, role });
}));

router.delete('/users/:id', panelAuth, requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const count = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.role === 'admin' && count <= 1) return res.status(400).json({ error: 'At least one admin is required' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(req.user.username, 'user.delete', target.username);
  res.json({ ok: true });
}));

// ============================================================
//  Discord OAuth2 : connexion + liaison de compte
// ============================================================

// Le panel interroge cet endpoint pour savoir s'il doit afficher le bouton Discord.
router.get('/discord/status', (req, res) => res.json({ enabled: isOAuthEnabled() }));

function oauthNonceCookieOpts() {
  // Cookie de nonce OAuth : court, httpOnly. SameSite=Lax pour survivre au retour
  // top-level depuis discord.com (redirection GET).
  return { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: 10 * 60 * 1000, path: '/api/auth/discord' };
}

// Lit l'id du compte panel connecté à partir du cookie de session (ou null).
// Passe par verifySessionUser : une session révoquée ne doit pas pouvoir
// démarrer une liaison de compte Discord.
function currentUserId(req) {
  return verifySessionUser(req.cookies?.md_session)?.id ?? null;
}

// Démarre le flux : intent=login (par défaut) ou intent=link (requiert une session).
router.get('/discord/login', asyncHandler((req, res) => {
  if (!isOAuthEnabled()) return res.status(404).json({ error: 'Discord sign-in is not configured.' });
  const intent = req.query.intent === 'link' ? 'link' : 'login';

  let userId = null;
  if (intent === 'link') {
    // La liaison exige d'être déjà connecté.
    userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Connecte-toi d\'abord pour lier un compte Discord.' });
  }

  const { nonce, state } = createState({ intent, userId });
  res.cookie(OAUTH_NONCE_COOKIE, nonce, oauthNonceCookieOpts());
  res.redirect(buildAuthorizeUrl(state));
}));

// Petite page HTML de retour (le panel est une SPA) : affiche le résultat et renvoie vers /.
function oauthResult(res, { ok, message, to = '/' }) {
  res.clearCookie(OAUTH_NONCE_COOKIE, { path: '/api/auth/discord' });
  const safe = String(message || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const target = to.startsWith('/') ? to : '/';
  res.status(ok ? 200 : 400).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>MemeDrop</title>` +
    `<body style="font-family:system-ui;background:#0b0a0c;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center;max-width:32rem;padding:2rem">` +
    `<h1 style="font-size:1.4rem">${ok ? '✅' : '⛔'} ${safe}</h1>` +
    `<p><a style="color:#a78bfa" href="${target}">Retour au panel</a></p>` +
    `<script>setTimeout(function(){location.replace(${JSON.stringify(target)})},1800)</script>` +
    `</div></body>`);
}

router.get('/discord/callback', asyncHandler(async (req, res) => {
  if (!isOAuthEnabled()) return res.status(404).json({ error: 'Discord sign-in is not configured.' });

  const { code, state, error } = req.query;
  if (error) return oauthResult(res, { ok: false, message: 'Discord sign-in cancelled.' });
  if (!code || !state) return oauthResult(res, { ok: false, message: 'Invalid OAuth request.' });

  const parsed = verifyState(String(state), req.cookies?.[OAUTH_NONCE_COOKIE]);
  if (!parsed) return oauthResult(res, { ok: false, message: 'Anti-CSRF check failed. Try again.' });

  let profile;
  try {
    const tok = await exchangeCode(String(code));
    profile = await fetchDiscordUser(tok.access_token);
  } catch {
    return oauthResult(res, { ok: false, message: 'Could not verify your Discord account.' });
  }

  if (parsed.intent === 'link') {
    // Revérifie la session : la liaison doit s'appliquer au compte réellement connecté.
    const sessionUserId = currentUserId(req);
    if (!sessionUserId || sessionUserId !== parsed.userId) {
      return oauthResult(res, { ok: false, message: 'Session expired — sign in again then link your account.', to: '/account' });
    }
    // Ce compte Discord est-il déjà lié ailleurs ?
    const taken = db.prepare('SELECT id FROM users WHERE discord_id = ? AND id != ?').get(profile.id, sessionUserId);
    if (taken) return oauthResult(res, { ok: false, message: 'This Discord account is already linked to another MemeDrop account.', to: '/account' });

    db.prepare('UPDATE users SET discord_id = ?, discord_username = ?, discord_avatar = ? WHERE id = ?')
      .run(profile.id, profile.username, profile.avatar, sessionUserId);
    audit(String(sessionUserId), 'auth.discord.link', { discordId: profile.id });
    return oauthResult(res, { ok: true, message: `Discord account linked (${profile.username}).`, to: '/account' });
  }

  // intent = login : compte panel lié, OU membre whitelist (compte 'member'
  // auto-créé — il n'a accès qu'à sa page Profil).
  let user = db.prepare('SELECT id, username, role FROM users WHERE discord_id = ?').get(profile.id);
  if (!user) {
    const w = db.prepare('SELECT * FROM whitelist WHERE discord_id = ? AND banned = 0').get(profile.id);
    if (!w) {
      audit('discord', 'auth.discord.login.unlinked', { discordId: profile.id });
      return oauthResult(res, { ok: false, message: 'No MemeDrop account is linked to this Discord, and you are not whitelisted on any channel.' });
    }
    // Nom unique : le pseudo Discord, suffixé si déjà pris par un compte panel.
    let username = profile.username.slice(0, 60) || `membre_${profile.id.slice(-6)}`;
    let i = 1;
    while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username = `${profile.username.slice(0, 56)}-${++i}`;
    const info = db.prepare(`INSERT INTO users (username, password_hash, role, discord_id, discord_username, discord_avatar, created_at)
        VALUES (?,?,?,?,?,?,?)`)
      // '!' : hash bcrypt invalide → connexion par mot de passe impossible (Discord uniquement).
      .run(username, '!', 'member', profile.id, profile.username, profile.avatar || null, now());
    user = { id: info.lastInsertRowid, username, role: 'member' };
    audit(username, 'auth.discord.member.create', { discordId: profile.id });
  }
  // Rafraîchit pseudo/avatar Discord (compte panel + whitelist de tous les channels),
  // et propage le style de pseudo (couleur/glow) choisi dans le profil.
  db.prepare('UPDATE users SET discord_username = ?, discord_avatar = ? WHERE id = ?')
    .run(profile.username, profile.avatar || null, user.id);
  const style = db.prepare('SELECT name_color, name_glow FROM users WHERE id = ?').get(user.id);
  db.prepare('UPDATE whitelist SET discord_username = ?, discord_avatar = ?, name_color = ?, name_glow = ? WHERE discord_id = ?')
    .run(profile.username, profile.avatar || null, style?.name_color || null, style?.name_glow || null, profile.id);
  const jwtToken = issueSession(user);
  res.cookie('md_session', jwtToken, sessionCookieOpts());
  audit(user.username, 'auth.discord.login.ok');
  // Un membre atterrit sur son profil — sauf s'il modère un channel : sa page
  // d'accueil est alors la liste de ses channels.
  let to = '/';
  if (user.role === 'member') {
    to = moderatedChannelIds({ discord_id: profile.id }).length > 0 ? '/channels' : '/profile';
  }
  return oauthResult(res, { ok: true, message: `Welcome ${profile.username}!`, to });
}));

// Délier son compte Discord (depuis les réglages du profil).
router.post('/discord/unlink', panelAuth, asyncHandler((req, res) => {
  // Un compte 'member' n'existe QUE via Discord : le délier le verrouillerait.
  if (req.user.role === 'member') {
    return res.status(400).json({ error: 'Your account exists through Discord, it cannot be unlinked.' });
  }
  db.prepare('UPDATE users SET discord_id = NULL, discord_username = NULL, discord_avatar = NULL WHERE id = ?')
    .run(req.user.id);
  audit(req.user.username, 'auth.discord.unlink');
  res.json({ ok: true });
}));

export default router;
