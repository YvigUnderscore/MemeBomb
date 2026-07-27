// ============================================================
//  MemeDrop client — processus principal.
// ============================================================
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage, shell, dialog,
} = require('electron');
const { Store, DEFAULTS } = require('./store.js');
const { Connection } = require('./connection.js');
const { OverlayManager } = require('./overlayManager.js');
const updater = require('./updater.js');

// Empêche plusieurs instances.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let store, connection, overlay, tray;
let settingsWin = null;

// Le logo est packagé DANS l'asar (src/**), contrairement à build/icon.png
// qui reste hors asar → indispensable pour que l'icône du tray s'affiche.
const ICON_PATH = path.join(__dirname, '..', 'shared', 'logo.png');
function icon() {
  try {
    const img = nativeImage.createFromPath(ICON_PATH);
    return img.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png')) : img;
  } catch { return nativeImage.createEmpty(); }
}

// ---- Fenêtres utilitaires (réglages / éditeur) -------------------------
function makeWindow(file, { width, height, title }) {
  const win = new BrowserWindow({
    width, height, title,
    minWidth: 720, minHeight: 560,
    backgroundColor: '#0b0a0c',
    autoHideMenuBar: true,
    icon: icon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, '..', file));
  return win;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = makeWindow('settings/settings.html', { width: 940, height: 760, title: 'MemeDrop — Settings' });
  settingsWin.on('closed', () => { settingsWin = null; });
}
// L'éditeur de meme vit désormais sur le site : on ouvre <url-serveur>/compose
// dans le navigateur du système. Le token d'appareil est passé dans le FRAGMENT
// (#dt=…) : jamais envoyé au serveur, lu puis effacé par la page → l'éditeur
// est appairé automatiquement, sans redemander de code à chaque ouverture.
function openWebEditor() {
  const a = connection.active();
  const base = (a?.url || '').replace(/\/+$/, '');
  if (!base) { openSettings(); return; } // pas encore appairé → guider vers les réglages
  const frag = a.deviceToken ? `#dt=${encodeURIComponent(a.deviceToken)}` : '';
  shell.openExternal(`${base}/compose${frag}`).catch(() => {});
}

// Publie un résumé (non sensible) des réglages pour que les potes le voient.
let publishTimer = null;
function publishMySettings() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    if (connection.status !== 'connected') return;
    const c = store.get();
    connection.publishSettings({
      overlay: { mode: c.overlay.mode, anchor: c.overlay.anchor, sizePct: c.overlay.sizePct, allowSenderPosition: c.overlay.allowSenderPosition, maxWidthPx: c.overlay.maxWidthPx, textBackground: c.overlay.textBackground },
      playback: { volume: c.playback.volume, cooldownS: c.playback.cooldownS, displayMode: c.playback.displayMode },
    }).catch(() => {});
  }, 1500);
}

// Ouvre le site web associé (le panel du channel actif) dans le navigateur.
function openWebsite() {
  const a = connection.active();
  const url = a?.url || '';
  if (url) shell.openExternal(url).catch(() => {});
}

// Page ouverte au double-clic sur l'icône du tray (configurable).
function openTrayPage() {
  const page = store.get().tray?.doubleClickPage || 'settings';
  if (page === 'editor') openWebEditor();
  else if (page === 'settings') openSettings();
}

// ---- Réception d'un meme ------------------------------------------------
// id du meme → chemin du fichier temporaire, supprimé après lecture.
const playedTemp = new Map();
// Métadonnées des memes reçus (id → {id, slug, senderId, sender}), pour résoudre
// la cible d'une réaction/d'un blocage. Bornée pour ne pas croître indéfiniment.
const memeMeta = new Map();
// Résolution de la cible d'une réaction (#3), SANS AMBIGUÏTÉ :
//  1. le meme actuellement en cours de lecture le plus récent (ordre d'affichage) ;
//  2. sinon le dernier meme terminé (le plus récent).
const playingOrder = [];   // ids des memes actuellement à l'écran, dans l'ordre d'affichage
let lastFinishedId = null; // dernier meme terminé (le plus récent)

function rememberMeme(meme) {
  memeMeta.set(meme.id, { id: meme.id, slug: meme._slug, senderId: meme.senderId, sender: meme.sender });
  // Purge : ne garde que les 40 dernières entrées.
  if (memeMeta.size > 40) { const k = memeMeta.keys().next().value; memeMeta.delete(k); }
}

// Le meme cible d'une réaction : en cours de lecture (le plus récent) sinon dernier terminé.
function targetMeme() {
  for (let i = playingOrder.length - 1; i >= 0; i--) {
    const meta = memeMeta.get(playingOrder[i]);
    if (meta) return meta;
  }
  if (lastFinishedId && memeMeta.has(lastFinishedId)) return memeMeta.get(lastFinishedId);
  return null;
}

// Overlay : le meme est réellement affiché → on l'ajoute à l'ordre de lecture.
function onMemeDisplayed(memeId) {
  if (!memeId || memeId === 'test') return;
  if (!playingOrder.includes(memeId)) playingOrder.push(memeId);
}
// Overlay : le meme est terminé → il quitte l'écran et devient le « dernier terminé ».
function onMemeFinished(memeId) {
  const i = playingOrder.indexOf(memeId);
  if (i >= 0) playingOrder.splice(i, 1);
  if (memeId && memeId !== 'test' && memeMeta.has(memeId)) lastFinishedId = memeId;
  cleanupPlayedMeme(memeId);
}

// Dernier meme reçu complet (pour « Rejouer » #36) — re-téléchargé à la demande.
let lastIncoming = null;

async function handleIncomingMeme(meme) {
  const cfg = store.get();
  rememberMeme(meme);
  if (meme.id !== 'test') lastIncoming = meme;
  // Accusé de réception (#2) : on rapporte pourquoi on n'affiche pas, le cas échéant.
  if (!cfg.overlay.enabled) { connection.sendAck(meme._slug, meme.id, 'skipped', 'overlay désactivé'); return; }
  if (cfg.fun.doNotDisturb && (!cfg.fun.dndUntil || Date.now() < cfg.fun.dndUntil)) { connection.sendAck(meme._slug, meme.id, 'dnd'); return; }

  try {
    const temps = [];
    let local = null;
    if (meme.media && meme.media.url) {
      // Échec de téléchargement isolé : on affiche quand même le meme (carte
      // d'erreur média côté overlay) au lieu de tout laisser disparaître.
      try { local = await connection.downloadMedia(meme); if (local) temps.push(local); }
      catch (e) { console.error('Média du meme non téléchargé:', e.message); }
    }
    // Son à l'apparition + overlay : téléchargés localement eux aussi — la CSP
    // stricte de l'overlay bloque toute URL distante (c'était la cause des
    // sons « qui n'arrivent pas » chez le destinataire).
    // Un meme peut porter plusieurs sons (`sounds`) ; `sound` reste lu pour les
    // memes émis par un serveur d'avant le multi-son.
    const soundUrls = (meme.sounds && meme.sounds.length ? meme.sounds : (meme.sound ? [meme.sound] : []))
      .map((s) => s && s.url).filter(Boolean);
    const localSounds = [];
    for (const url of soundUrls) {
      try { const p = await connection.downloadAux(url, 'm4a'); localSounds.push(p); temps.push(p); }
      catch (e) { console.error('Son du meme non téléchargé:', e.message); }
    }
    let localOverlay = null;
    if (meme.overlay && meme.overlay.url) {
      try { localOverlay = await connection.downloadAux(meme.overlay.url, 'webp'); temps.push(localOverlay); }
      catch (e) { console.error('Overlay du meme non téléchargé:', e.message); }
    }
    if (temps.length) playedTemp.set(meme.id, temps);
    // pathToFileURL produit une URL file:// correcte (file:///C:/... sous Windows),
    // contrairement à une concaténation manuelle qui prendrait « C: » pour un hôte.
    overlay.sendMeme({
      ...meme,
      localPath: local ? pathToFileURL(local).href : null,
      localSoundPath: localSounds[0] ? pathToFileURL(localSounds[0]).href : null,
      localSoundPaths: localSounds.map((p) => pathToFileURL(p).href),
      localOverlayPath: localOverlay ? pathToFileURL(localOverlay).href : null,
    });
  } catch (e) {
    console.error('Meme non affiché:', e.message);
    connection.sendAck(meme._slug, meme.id, 'error', e.message);
  }
}

// Réagir au meme cible via un raccourci global (#3/#6) : en cours de lecture, sinon dernier terminé.
function reactToLast(emoji) {
  const t = targetMeme();
  if (!t || !emoji) return;
  connection.sendReaction(t.slug, t.id, emoji);
  if (store.get().fun?.floatingReactions !== false) overlay.floatReaction(emoji); // réaction flottante immédiate sur mon overlay (#3)
}

// Rejouer localement le dernier meme reçu (#36) — re-téléchargé, non renvoyé aux autres.
function replayLast() {
  if (!lastIncoming) { overlay.reactionToast('No meme to replay'); return; }
  handleIncomingMeme({ ...lastIncoming });
}

// Active le mode Ne pas déranger pour une durée donnée (0 = jusqu'à réactivation) (#21).
function setDnd(minutes) {
  const until = minutes > 0 ? Date.now() + minutes * 60000 : 0;
  store.set({ fun: { doNotDisturb: true, dndUntil: until } });
  updateTray();
}

// Bloquer l'expéditeur du meme cible (#15).
async function blockLastSender() {
  const t = targetMeme();
  if (!t || !t.senderId) return;
  try {
    await connection.addBlock(t.senderId, t.sender || '');
    overlay.reactionToast(`🚫 ${t.sender || 'Sender'} blocked`);
  } catch (e) { console.error('Blocage:', e.message); }
}

// Supprime les fichiers locaux du meme une fois joué (le serveur garde l'historique).
function cleanupPlayedMeme(memeId) {
  const p = playedTemp.get(memeId);
  if (p) { (Array.isArray(p) ? p : [p]).forEach((f) => connection.cleanupTemp(f)); playedTemp.delete(memeId); }
}

// ---- Raccourcis globaux -------------------------------------------------
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const s = store.get().shortcuts;
  const safe = (accel, fn) => { if (accel) try { globalShortcut.register(accel, fn); } catch {} };
  safe(s.openEditor, () => openWebEditor());
  safe(s.toggleOverlay, () => {
    const enabled = !store.get().overlay.enabled;
    store.set({ overlay: { enabled } });
    overlay.pushSettings();
    updateTray();
  });
  safe(s.toggleMute, () => {
    const muteAll = !store.get().playback.muteAll;
    store.set({ playback: { muteAll } });
    overlay.pushSettings();
    updateTray();
  });
  safe(s.doNotDisturb, () => {
    const dnd = !store.get().fun.doNotDisturb;
    store.set({ fun: { doNotDisturb: dnd, dndUntil: 0 } });
    updateTray();
  });
  // Réactions (#6) + blocage (#15) au dernier meme reçu.
  const emojis = store.get().reactionEmojis || ['😂', '🔥', '💀', '❤️'];
  safe(s.react1, () => reactToLast(emojis[0]));
  safe(s.react2, () => reactToLast(emojis[1]));
  safe(s.react3, () => reactToLast(emojis[2]));
  safe(s.react4, () => reactToLast(emojis[3]));
  safe(s.blockLast, () => blockLastSender());
  safe(s.replayLast, () => replayLast());
}

// Publie la disponibilité du poste (« ne pas déranger », overlay coupé) : c'est
// la seule source d'où le serveur la tient, et l'éditeur s'en sert pour montrer
// qui est joignable. Branché sur updateTray() — tout changement de DND ou
// d'overlay rafraîchit le tray — et sans effet si l'état n'a pas bougé.
function publishAvailability() {
  const c = store.get();
  connection.publishStatus({
    dnd: !!c.fun.doNotDisturb,
    dndUntil: c.fun.dndUntil || 0,
    overlay: c.overlay.enabled !== false,
  });
}

// ---- Tray ---------------------------------------------------------------
function updateTray() {
  if (!tray) return;
  publishAvailability();
  const cfg = store.get();
  const status = connection.status;
  const statusLabel = {
    connected: '🟢 Connected', connecting: '🟡 Connecting...', reconnecting: '🟡 Reconnecting...',
    disconnected: '⚪ Disconnected', unpaired: '🔴 Not paired',
  }[status] || status;

  const active = connection.active();
  const channelsSub = cfg.accounts.length > 1 ? [{
    label: 'Active channel', submenu: cfg.accounts.map((a) => ({
      label: a.channel?.name || a.channel?.slug, type: 'radio',
      checked: a.channel?.slug === (active?.channel?.slug),
      click: () => { store.setActive(a.channel.slug); updateTray(); },
    })),
  }] : [];

  const emojis = cfg.reactionEmojis || ['😂', '🔥', '💀', '❤️'];
  const dndActive = cfg.fun.doNotDisturb && (!cfg.fun.dndUntil || Date.now() < cfg.fun.dndUntil);
  const dndLabel = dndActive && cfg.fun.dndUntil ? `Do not disturb (until ${new Date(cfg.fun.dndUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : 'Do not disturb';

  // Item de mise à jour : visible seulement si une version plus récente existe.
  const upd = updater.getLastResult();
  const updateItem = upd.updateAvailable ? [
    { label: `⬇️  Update available — v${upd.latest}`, click: () => updater.openDownload() },
    { type: 'separator' },
  ] : [];

  const menu = Menu.buildFromTemplate([
    { label: `MemeDrop — ${statusLabel}`, enabled: false },
    { label: active ? `Channel: ${active.channel?.name}` : 'No channel', enabled: false },
    ...channelsSub,
    { type: 'separator' },
    ...updateItem,
    { label: 'Replay last meme', accelerator: cfg.shortcuts.replayLast, enabled: !!lastIncoming, click: () => replayLast() },
    { label: 'React to last meme', submenu: emojis.map((e, i) => ({ label: e, accelerator: cfg.shortcuts[`react${i + 1}`], click: () => reactToLast(e) })) },
    { type: 'separator' },
    { label: 'Meme editor (web)…', accelerator: cfg.shortcuts.openEditor, click: openWebEditor },
    { label: 'Settings…', click: openSettings },
    { label: 'Open website', click: openWebsite },
    { label: 'Check for updates…', click: () => manualUpdateCheck() },
    { type: 'separator' },
    { label: 'Overlay enabled', type: 'checkbox', checked: cfg.overlay.enabled, click: () => { store.set({ overlay: { enabled: !cfg.overlay.enabled } }); overlay.pushSettings(); updateTray(); } },
    { label: 'Mute everything', type: 'checkbox', checked: cfg.playback.muteAll, click: () => { store.set({ playback: { muteAll: !cfg.playback.muteAll } }); overlay.pushSettings(); updateTray(); } },
    {
      label: dndLabel, submenu: [
        { label: 'Enable for 30 min', click: () => setDnd(30) },
        { label: 'Enable for 1 hour', click: () => setDnd(60) },
        { label: 'Until turned off', click: () => setDnd(0) },
        { type: 'separator' },
        { label: 'Disable', enabled: dndActive, click: () => { store.set({ fun: { doNotDisturb: false, dndUntil: 0 } }); updateTray(); } },
      ],
    },
    { type: 'separator' },
    { label: 'Test placement', click: () => sendTestMeme() },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setToolTip(`MemeDrop — ${statusLabel}`);
  tray.setContextMenu(menu);
}

// Vérification manuelle (menu tray) : donne toujours un retour, y compris
// « à jour » ou en cas d'échec réseau — contrairement au check silencieux.
function manualUpdateCheck() {
  updater.checkForUpdates({ notify: false }).then((r) => {
    updateTray();
    if (r.error) {
      dialog.showMessageBox({ type: 'warning', title: 'MemeDrop', message: 'Update check failed', detail: r.error });
    } else if (r.updateAvailable) {
      dialog.showMessageBox({
        type: 'info', title: 'MemeDrop', message: `Version ${r.latest} is available`,
        detail: `You have ${r.current}. Download the new version?`, buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
      }).then((res) => { if (res.response === 0) updater.openDownload(); });
    } else {
      dialog.showMessageBox({ type: 'info', title: 'MemeDrop', message: 'You are up to date', detail: `Version ${r.current}` });
    }
  });
}

function sendTestMeme() {
  overlay.sendMeme({
    id: 'test', kind: 'text', text: 'MemeDrop — placement test 🎬', sender: 'you',
    media: null, localPath: null,
    options: { anchor: store.get().overlay.anchor, scale: store.get().overlay.sizePct / 100, durationS: 4, opacity: store.get().overlay.opacity, animation: 'bounce', textPos: 'center', textColor: '#ffffff', volume: 0 },
  });
}

// ---- IPC ----------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('config:get', () => store.get());
  ipcMain.handle('config:set', (_e, patch) => {
    const next = store.set(patch || {});
    overlay.pushSettings();
    if (patch?.shortcuts) registerShortcuts();
    if (patch?.overlay?.displayIndex !== undefined) overlay.relocate();
    if (patch?.launchAtStartup !== undefined) applyAutoLaunch(next.launchAtStartup);
    updateTray();
    publishMySettings();
    return next;
  });
  ipcMain.handle('config:reset', () => { const c = store.reset(); registerShortcuts(); overlay.pushSettings(); updateTray(); return c; });
  ipcMain.handle('config:defaults', () => DEFAULTS);
  ipcMain.handle('config:resetShortcuts', () => { const c = store.set({ shortcuts: structuredClone(DEFAULTS.shortcuts) }); registerShortcuts(); updateTray(); return c; });
  ipcMain.handle('displays:get', () => screen.getAllDisplays().map((d, i) => ({
    index: i, label: `Display ${i + 1} — ${d.size.width}×${d.size.height}`, primary: d.id === screen.getPrimaryDisplay().id,
  })));

  ipcMain.handle('conn:pair', async (_e, { serverUrl, code, deviceName }) => {
    const res = await connection.pair(serverUrl, code, deviceName);
    updateTray();
    return res;
  });
  ipcMain.handle('conn:unpair', (_e, slug) => { connection.unpair(slug || connection.active()?.channel?.slug); updateTray(); return true; });
  ipcMain.handle('channels:list', () => ({ accounts: store.get().accounts.map((a) => ({ slug: a.channel?.slug, name: a.channel?.name, url: a.url })), activeSlug: connection.active()?.channel?.slug || '' }));
  ipcMain.handle('channels:setActive', (_e, slug) => { store.setActive(slug); updateTray(); return connection.active()?.channel?.slug || ''; });
  ipcMain.handle('website:open', () => openWebsite());
  ipcMain.handle('conn:reconnect', () => { connection.connect(); return connection.status; });
  ipcMain.handle('conn:status', () => connection.status);
  ipcMain.handle('conn:serverConfig', () => connection.fetchConfig());

  // L'éditeur (composition/envoi) est passé sur le site : plus de pickFile/fileDataUrl/
  // send/schedule côté client. `editor:targets` reste utilisé par les Réglages.
  ipcMain.handle('editor:targets', async () => {
    try {
      const [cfg, targets] = await Promise.all([connection.fetchConfig(), connection.fetchTargets()]);
      return { channel: cfg.channel, settings: cfg.settings, features: cfg.features, limits: cfg.limits, groups: targets.groups, members: targets.members };
    } catch (e) { return { error: e.message }; }
  });
  // Bibliothèque / soundboard / stockage : gérés dans l'éditeur web désormais.
  // On garde la lecture/suppression des planifications et les réglages partagés
  // (utilisés par la fenêtre Réglages).
  ipcMain.handle('schedules:list', () => connection.listSchedules());
  ipcMain.handle('schedules:delete', (_e, id) => connection.deleteSchedule(id));
  ipcMain.handle('settings:members', () => connection.membersSettings());

  ipcMain.handle('overlay:report', async (_e, { memeId, reason }) => {
    const { url, deviceToken } = store.get().server;
    if (!url) return false;
    try {
      await fetch(`${url}/api/client/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Token': deviceToken },
        body: JSON.stringify({ memeId, reason }),
      });
      return true;
    } catch { return false; }
  });
  ipcMain.on('overlay:finished', (_e, memeId) => onMemeFinished(memeId));
  // Accusé de réception « affiché » émis par l'overlay quand il montre réellement le meme (#2).
  // Sert aussi à savoir quel meme est en cours de lecture (résolution de cible de réaction #3).
  ipcMain.on('overlay:displayed', (_e, { memeId, slug }) => { if (memeId) { connection.sendAck(slug, memeId, 'displayed'); onMemeDisplayed(memeId); } });

  // Blocages personnels (#15).
  ipcMain.handle('blocks:list', () => connection.listBlocks().catch(() => []));
  ipcMain.handle('blocks:add', (_e, { senderId, name }) => connection.addBlock(senderId, name));
  ipcMain.handle('blocks:remove', (_e, senderId) => connection.removeBlock(senderId));

  ipcMain.handle('app:version', () => ({ app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('win:settings', () => openSettings());
  ipcMain.handle('win:editor', () => openWebEditor()); // ouvre l'éditeur web
  ipcMain.handle('debug:testMeme', () => sendTestMeme());

  ipcMain.handle('guidelines:get', async () => {
    try { const cfg = await connection.fetchConfig(); return { text: cfg.guidelines, requireAccept: cfg.settings.requireGuidelinesAccept, acceptedAt: store.get().guidelinesAcceptedAt }; }
    catch { return { text: '', requireAccept: false, acceptedAt: store.get().guidelinesAcceptedAt }; }
  });
  ipcMain.handle('guidelines:accept', () => { store.set({ guidelinesAcceptedAt: Date.now() }); return true; });
}

function applyAutoLaunch(enabled) {
  try { app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] }); } catch {}
}

// ---- Cycle de vie -------------------------------------------------------
app.whenReady().then(() => {
  store = new Store();
  connection = new Connection(store);
  overlay = new OverlayManager(store);
  overlay.create();

  connection.on('meme', handleIncomingMeme);
  // Mon meme a reçu une réaction (#6) → réaction flottante + toast sur mon overlay.
  connection.on('reaction', (evt) => {
    const total = Object.values(evt.counts || {}).reduce((a, b) => a + b, 0);
    if (store.get().fun?.floatingReactions !== false) overlay.floatReaction(evt.emoji);
    overlay.reactionToast(`${evt.from || 'Someone'} reacted ${evt.emoji}${total > 1 ? ` (${total})` : ''}`);
  });
  // « Vu par » (#1) : un destinataire a réellement affiché mon meme.
  connection.on('seen', (evt) => { if (store.get().fun?.showSeenBy !== false) overlay.seenBy(evt.by || 'Someone'); });
  // Seuil de réactions franchi (#7) → confettis + son sur tous les écrans du channel.
  connection.on('milestone', (evt) => {
    if (store.get().playback?.celebrate === false) return;
    overlay.milestone({ threshold: evt.threshold, total: evt.total, sender: evt.sender || '' });
  });
  // Progression de téléchargement d'un média entrant (#13).
  connection.on('download', (d) => { if (store.get().overlay.enabled) overlay.downloadProgress(d); });
  connection.on('status', () => {
    updateTray();
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('conn:statusChanged', connection.status));
    if (connection.status === 'connected') publishMySettings();
  });

  tray = new Tray(icon().resize({ width: 16, height: 16 }));
  tray.on('double-click', () => openTrayPage());
  updateTray();

  registerIpc();
  registerShortcuts();
  applyAutoLaunch(store.get().launchAtStartup);

  // Connexion auto si déjà appairé.
  if (store.get().accounts.length) connection.connect();
  else openSettings();

  // Mise à jour : vérification différée au démarrage (notifie si dispo), puis
  // toutes les 6 h. Le résultat rafraîchit le menu tray (item « Update available »).
  setTimeout(() => updater.checkForUpdates().then(() => updateTray()), 8000);
  setInterval(() => updater.checkForUpdates().then(() => updateTray()), 6 * 60 * 60 * 1000);

  app.on('second-instance', () => openSettings());
});

app.on('window-all-closed', (e) => { e.preventDefault(); }); // reste en tray
app.on('before-quit', () => { app.isQuitting = true; globalShortcut.unregisterAll(); connection?.disconnect(); });
