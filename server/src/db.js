import Database from 'better-sqlite3';
import { config } from './config.js';
import { logger } from './logger.js';

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---- Schéma -------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'moderator', -- 'admin' | 'moderator'
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT DEFAULT '',
  active           INTEGER NOT NULL DEFAULT 1,
  settings         TEXT NOT NULL DEFAULT '{}',      -- JSON: limites, cooldowns, modération...
  discord_token    TEXT,                             -- chiffré (AES-GCM)
  discord_guild_id TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS whitelist (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  discord_id       TEXT NOT NULL,
  discord_username TEXT DEFAULT '',
  role             TEXT NOT NULL DEFAULT 'user',    -- 'user' | 'moderator'
  can_send         INTEGER NOT NULL DEFAULT 1,
  banned           INTEGER NOT NULL DEFAULT 0,
  note             TEXT DEFAULT '',
  added_by         TEXT DEFAULT '',
  created_at       INTEGER NOT NULL,
  UNIQUE(channel_id, discord_id)
);

CREATE TABLE IF NOT EXISTS mention_groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  members      TEXT NOT NULL DEFAULT '[]',          -- JSON array de discord_id
  created_at   INTEGER NOT NULL,
  UNIQUE(channel_id, name)
);

CREATE TABLE IF NOT EXISTS devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'Appareil',
  token_hash   TEXT NOT NULL,
  discord_id   TEXT DEFAULT '',                     -- lien optionnel vers un membre whitelist
  last_seen    INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code         TEXT PRIMARY KEY,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  discord_id   TEXT DEFAULT '',
  label        TEXT DEFAULT '',
  expires_at   INTEGER NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memes (
  id           TEXT PRIMARY KEY,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender       TEXT DEFAULT '',                     -- discord_id ou 'panel'
  sender_name  TEXT DEFAULT '',
  source       TEXT DEFAULT 'discord',              -- 'discord' | 'editor' | 'panel'
  type         TEXT NOT NULL,                        -- image|gif|video|audio
  text         TEXT DEFAULT '',
  media_path   TEXT,                                 -- chemin relatif dans media/
  media_mime   TEXT,
  media_size   INTEGER,
  targets      TEXT NOT NULL DEFAULT '[]',          -- JSON array discord_id destinataires
  options      TEXT NOT NULL DEFAULT '{}',          -- JSON: position, taille, durée, volume...
  status       TEXT NOT NULL DEFAULT 'sent',        -- sent|blocked|removed
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  meme_id      TEXT REFERENCES memes(id) ON DELETE CASCADE,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  reporter     TEXT DEFAULT '',
  reason       TEXT DEFAULT '',
  resolved     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor        TEXT DEFAULT '',
  action       TEXT NOT NULL,
  detail       TEXT DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS global_settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL
);

-- Bibliothèque : sons et memes réutilisables, par utilisateur (stockage + quota).
CREATE TABLE IF NOT EXISTS assets (
  id           TEXT PRIMARY KEY,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  owner        TEXT NOT NULL,                 -- discord_id ou 'device:<id>'
  owner_name   TEXT DEFAULT '',
  kind         TEXT NOT NULL,                 -- 'sound' | 'meme'
  name         TEXT DEFAULT '',
  media_path   TEXT, media_mime TEXT, media_size INTEGER DEFAULT 0,
  data         TEXT NOT NULL DEFAULT '{}',    -- JSON (définition du meme, etc.)
  created_at   INTEGER NOT NULL
);

-- Planification de memes (rejoués plus tard).
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  owner         TEXT NOT NULL,
  owner_name    TEXT DEFAULT '',
  label         TEXT DEFAULT '',
  text          TEXT DEFAULT '',
  media_path    TEXT, media_mime TEXT,
  sound_path    TEXT,
  options       TEXT NOT NULL DEFAULT '{}',
  targets       TEXT NOT NULL DEFAULT '[]',
  trigger_type  TEXT NOT NULL,                -- 'at' | 'recurring'
  trigger_at    INTEGER,                       -- 'at' : timestamp
  trigger_days  TEXT DEFAULT '[]',            -- 'recurring' : [0-6]
  trigger_time  TEXT DEFAULT '',              -- 'recurring' : 'HH:MM'
  next_run      INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- Réglages partagés des membres (pour voir les préférences des autres).
CREATE TABLE IF NOT EXISTS member_settings (
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  discord_id   TEXT NOT NULL,
  name         TEXT DEFAULT '',
  settings     TEXT NOT NULL DEFAULT '{}',
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (channel_id, discord_id)
);

-- Accusés de réception (#2) : un appareil confirme ce qu'il a fait d'un meme.
CREATE TABLE IF NOT EXISTS meme_receipts (
  meme_id      TEXT NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  device_id    INTEGER NOT NULL,
  discord_id   TEXT DEFAULT '',
  name         TEXT DEFAULT '',
  status       TEXT NOT NULL,               -- 'displayed' | 'skipped' | 'dnd' | 'error' | 'throttled'
  detail       TEXT DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (meme_id, device_id)
);

-- Réactions (#6) : un destinataire réagit à un meme reçu.
CREATE TABLE IF NOT EXISTS meme_reactions (
  meme_id      TEXT NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  device_id    INTEGER NOT NULL,
  discord_id   TEXT DEFAULT '',
  name         TEXT DEFAULT '',
  emoji        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (meme_id, device_id, emoji)
);

-- Blocages personnels (#15) : un membre/appareil masque les memes d'un expéditeur.
CREATE TABLE IF NOT EXISTS member_blocks (
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  owner        TEXT NOT NULL,               -- discord_id ou 'device:<id>' (celui qui bloque)
  blocked_id   TEXT NOT NULL,               -- senderId bloqué
  blocked_name TEXT DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (channel_id, owner, blocked_id)
);

-- Hall of Memes : archive hebdomadaire du top 10 (survit à la rétention —
-- les médias sont COPIÉS sous un nom propre à l'archive).
CREATE TABLE IF NOT EXISTS hall_archive (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  week            TEXT NOT NULL,               -- lundi de la semaine, 'YYYY-MM-DD'
  rank            INTEGER NOT NULL,            -- 1..10
  meme_id         TEXT NOT NULL,               -- id d'origine (clé des commentaires/réactions)
  sender          TEXT DEFAULT '',
  sender_name     TEXT DEFAULT '',
  type            TEXT NOT NULL,
  text            TEXT DEFAULT '',
  media_path      TEXT, media_mime TEXT,
  reactions       INTEGER DEFAULT 0,           -- total de réactions au moment du snapshot
  reaction_detail TEXT DEFAULT '{}',           -- JSON {emoji: n}
  meme_created_at INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE(channel_id, week, rank)
);

-- Commentaires sur les memes du Hall (comptes panel : staff ET membres).
CREATE TABLE IF NOT EXISTS meme_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  meme_id      TEXT NOT NULL,                  -- pas de FK : peut référencer une archive
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      INTEGER,
  username     TEXT DEFAULT '',
  text         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Réactions du Hall (comptes panel — distinctes des réactions overlay des appareils).
CREATE TABLE IF NOT EXISTS hall_reactions (
  meme_id      TEXT NOT NULL,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL,
  emoji        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (meme_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_hall_archive ON hall_archive(channel_id, week);
CREATE INDEX IF NOT EXISTS idx_comments_meme ON meme_comments(meme_id);
CREATE INDEX IF NOT EXISTS idx_hall_reactions_meme ON hall_reactions(meme_id);
CREATE INDEX IF NOT EXISTS idx_memes_channel ON memes(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_whitelist_channel ON whitelist(channel_id);
CREATE INDEX IF NOT EXISTS idx_devices_channel ON devices(channel_id);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(channel_id, owner);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(active, next_run);
CREATE INDEX IF NOT EXISTS idx_receipts_meme ON meme_receipts(meme_id);
CREATE INDEX IF NOT EXISTS idx_reactions_meme ON meme_reactions(meme_id);
CREATE INDEX IF NOT EXISTS idx_blocks_owner ON member_blocks(channel_id, owner);
`);

// Migration douce : colonne de feature-flags sur whitelist et mention_groups.
for (const [table, col] of [['whitelist', 'features'], ['mention_groups', 'features']]) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT DEFAULT '{}'`).run(); } catch { /* déjà présent */ }
}

// Migration douce : liaison d'un compte panel à un compte Discord (OAuth2).
for (const col of ['discord_id TEXT', 'discord_username TEXT', 'discord_avatar TEXT']) {
  try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch { /* déjà présent */ }
}
// Migration douce : avatar Discord des membres whitelist (affiché sur les memes).
try { db.prepare('ALTER TABLE whitelist ADD COLUMN discord_avatar TEXT').run(); } catch { /* déjà présent */ }
// Migration douce : salons Discord « feed » — les memes publics d'un channel
// (ou d'un groupe) y sont republiés par le bot (/feed).
try { db.prepare('ALTER TABLE channels ADD COLUMN discord_feed_channel_id TEXT').run(); } catch { /* déjà présent */ }
try { db.prepare('ALTER TABLE mention_groups ADD COLUMN discord_feed_channel_id TEXT').run(); } catch { /* déjà présent */ }
// Migration douce : personnalisation du pseudo affiché sur l'overlay (couleur + glow).
for (const col of ['name_color TEXT', 'name_glow TEXT']) {
  try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch { /* déjà présent */ }
}
for (const col of ['name_color TEXT', 'name_glow TEXT']) {
  try { db.prepare(`ALTER TABLE whitelist ADD COLUMN ${col}`).run(); } catch { /* déjà présent */ }
}
// Un compte Discord ne peut être lié qu'à un seul compte panel (empêche l'usurpation).
try { db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord ON users(discord_id) WHERE discord_id IS NOT NULL').run(); } catch { /* ignore */ }
// Migration douce : époque de session PAR COMPTE. Incrémentée au changement de
// mot de passe pour révoquer les sessions de ce seul compte (un cookie volé ne
// survit plus au changement de mot de passe). Complète sessionEpoch, qui reste
// l'interrupteur global « déconnecter tout le monde ».
try { db.prepare('ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0').run(); } catch { /* déjà présent */ }
// Migration douce : IP source des événements d'audit — sans elle, une campagne
// de brute-force est invisible et non attribuable a posteriori.
try { db.prepare("ALTER TABLE audit_log ADD COLUMN ip TEXT DEFAULT ''").run(); } catch { /* déjà présent */ }
// Migration douce : sons joués à l'apparition, copiés dans l'archive du Hall.
// Sans eux, un meme archivé est muet dès que la rétention a purgé ses fichiers.
try { db.prepare("ALTER TABLE hall_archive ADD COLUMN sound_paths TEXT DEFAULT '[]'").run(); } catch { /* déjà présent */ }

export function now() {
  return Date.now();
}

export function audit(actor, action, detail = '', ip = '') {
  db.prepare('INSERT INTO audit_log (actor, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(String(actor || ''), String(action), typeof detail === 'string' ? detail : JSON.stringify(detail),
      String(ip || '').slice(0, 45), now());
}

// Réglages par défaut d'un channel (fusionnés avec settings JSON stockés).
export const DEFAULT_CHANNEL_SETTINGS = {
  // Limites média
  maxUploadMb: config.defaults.maxUploadMb,
  maxVideoDurationS: config.defaults.maxVideoDurationS,
  maxAudioDurationS: config.defaults.maxAudioDurationS,
  maxImageDurationS: 8,
  maxGifDurationS: 10,
  maxTextLength: config.defaults.maxTextLength,
  allowedTypes: ['image', 'gif', 'video', 'audio'],
  // Débit / lecture côté client (défauts poussés aux clients)
  defaultCooldownS: 10,
  defaultVolume: 0.7,
  defaultOpacity: 0.95,
  // Modération
  moderationMode: 'filter',            // 'off' | 'filter' | 'review'
  bannedWords: [],                     // mots/regex additionnels
  requireGuidelinesAccept: true,
  guidelines: '',                      // override des guidelines pour ce channel (vide = global)
  // Divers
  allowEditorSend: true,               // autoriser l'envoi depuis l'éditeur bureau
  rateLimitPerMinute: 6,               // memes/minute/expéditeur
  maxReceivesPerMinute: 20,            // memes/minute/destinataire (anti-spam ciblé, 0 = illimité)
  // Warmup expéditeur (#11) : durée de connexion minimale avant que ses envois
  // partent (anti « lance l'app, envoie, ferme »). 0 = désactivé (défaut : les
  // memes doivent partir immédiatement, sans « cooldown » après l'ouverture).
  senderWarmupS: 0,
  // Durée max (ms) des animations d'entrée/sortie choisies par l'expéditeur.
  maxAnimMs: 1500,
  // Feature-flags par défaut du channel (surchargés par groupe/membre)
  features: {
    video: true, audio: true, sounds: true, schedule: true,
    multiElement: true, chooseBig: true, choosePosition: true, shareSettings: true,
    presence: true,
  },
  // Stockage & abus
  storageQuotaMb: 50,                  // quota bibliothèque par utilisateur
  maxSchedulesPerUser: 10,             // schedules actifs max par utilisateur
  // Réactions : paliers déclenchant un effet (confettis/son) sur tout le channel (#7).
  reactionMilestones: [5, 10, 25],
  celebrateEffects: true,              // active les effets de seuil de réactions
  // Soundboard partagé du channel (#4) : les modérateurs curent des sons pour tous.
  sharedSoundboard: true,
};

export const FEATURE_KEYS = ['video', 'audio', 'sounds', 'schedule', 'multiElement', 'chooseBig', 'choosePosition', 'shareSettings', 'presence'];

export function getChannelSettings(channel) {
  let stored = {};
  try { stored = JSON.parse(channel.settings || '{}'); } catch { stored = {}; }
  return { ...DEFAULT_CHANNEL_SETTINGS, ...stored };
}

logger.info('Base de données initialisée:', config.dbPath);
