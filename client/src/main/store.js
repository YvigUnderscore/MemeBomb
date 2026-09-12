// Persistance des réglages du client (JSON dans le dossier userData).
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  // Multi-channel : le client peut être appairé à plusieurs channels.
  // accounts = [{ url, deviceToken, channel:{slug,name}, wsUrl }]
  accounts: [],
  activeSlug: '',            // channel actif pour l'envoi (dernier choisi)
  overlay: {
    enabled: true,
    mode: 'anchor',          // 'anchor' (ancre + taille) | 'manual' (cadre libre)
    anchor: 'center',        // position par défaut du cadre 16/9
    sizePct: 42,             // largeur du cadre en % de l'écran
    manual: { xPct: 0.29, yPct: 0.29, wPct: 0.42 }, // cadre 16/9 libre (fractions d'écran)
    maxWidthPx: 0,           // taille max du meme en px (0 = illimité), utile en mode "expéditeur choisit"
    textBackground: true,    // fond (carte dégradée) derrière les memes 100% texte
    opacity: 0.95,
    allowSenderPosition: true, // l'expéditeur peut choisir position/taille
    displayIndex: 0,         // écran cible (multi-moniteurs)
    marginPct: 3,            // marge par rapport aux bords (mode ancre)
  },
  playback: {
    volume: 0.7,
    cooldownS: 10,
    muteAll: false,
    displayMode: 'queue',    // 'queue' (un à la fois) | 'concurrent' (plusieurs)
    maxConcurrent: 3,        // nb max de memes simultanés en mode concurrent
    maxImageDurationS: 8,
    maxGifDurationS: 10,
    maxVideoDurationS: 15,
    maxAudioDurationS: 15,
    celebrate: true,         // effets de seuil de réactions (confettis/son) reçus du serveur (#7)
  },
  tray: {
    doubleClickPage: 'settings', // 'settings' | 'editor' | 'none'
  },
  network: {
    maxDownloadMBps: 5,      // débit de téléchargement max (défaut 5 MB/s)
  },
  // Aucun raccourci global par défaut : une combinaison imposée risque de voler
  // une touche à un autre logiciel. L'utilisateur les associe lui-même dans les
  // réglages ; une valeur vide n'est jamais enregistrée (cf. registerShortcuts).
  shortcuts: {
    openEditor: '',
    toggleOverlay: '',
    toggleMute: '',
    doNotDisturb: '',
    // Réactions au dernier meme reçu (#6) et blocage de son expéditeur (#15).
    react1: '',
    react2: '',
    react3: '',
    react4: '',
    blockLast: '',
    replayLast: '',
  },
  // Emojis associés aux raccourcis react1..react4 (doivent être dans la liste serveur).
  reactionEmojis: ['😂', '🔥', '💀', '❤️'],
  fun: {
    soundEffects: true,
    entranceAnimations: true,
    doNotDisturb: false,
    dndUntil: 0,
    showSeenBy: true,        // afficher « Vu par » quand mes memes sont affichés (#1)
    floatingReactions: true, // réactions flottantes sur l'overlay (#3)
    notifySound: false,      // petit son à l'arrivée d'un meme (#34, opt-in)
  },
  guidelinesAcceptedAt: 0,
  launchAtStartup: false,
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else if (over[k] !== undefined) {
      out[k] = over[k];
    }
  }
  return out;
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'memedrop-config.json');
    this.data = this._load();
  }
  _load() {
    let data;
    try { data = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { data = structuredClone(DEFAULTS); }
    // Migration : ancien appairage unique (server) → liste de comptes.
    if (data.server && data.server.deviceToken && (!data.accounts || !data.accounts.length)) {
      data.accounts = [{ url: data.server.url, deviceToken: data.server.deviceToken, channel: data.server.channel, wsUrl: data.server.wsUrl }];
      data.activeSlug = data.server.channel?.slug || '';
    }
    delete data.server;
    if (!Array.isArray(data.accounts)) data.accounts = [];
    return data;
  }
  get() { return this.data; }
  set(patch) {
    this.data = deepMerge(this.data, patch);
    this._save();
    return this.data;
  }

  // --- Comptes de channels ---
  activeAccount() {
    const a = this.data.accounts;
    if (!a.length) return null;
    return a.find((x) => x.channel?.slug === this.data.activeSlug) || a[0];
  }
  setActive(slug) { this.data.activeSlug = slug; this._save(); return this.activeAccount(); }
  upsertAccount(acc) {
    const slug = acc.channel?.slug;
    const i = this.data.accounts.findIndex((x) => x.channel?.slug === slug);
    if (i >= 0) this.data.accounts[i] = acc; else this.data.accounts.push(acc);
    this.data.activeSlug = slug;
    this._save();
    return acc;
  }
  removeAccount(slug) {
    this.data.accounts = this.data.accounts.filter((x) => x.channel?.slug !== slug);
    if (this.data.activeSlug === slug) this.data.activeSlug = this.data.accounts[0]?.channel?.slug || '';
    this._save();
  }
  _save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
    catch (e) { console.error('Sauvegarde config échouée:', e.message); }
  }
  reset() { this.data = structuredClone(DEFAULTS); this._save(); return this.data; }
}

module.exports = { Store, DEFAULTS };
