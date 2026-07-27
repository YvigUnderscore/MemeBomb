// ============================================================
//  Connexion au serveur MemeDrop : appairage, config, WebSocket,
//  et téléchargement des médias à DÉBIT LIMITÉ (défaut 5 MB/s).
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { EventEmitter } = require('node:events');

const TMP_DIR = path.join(os.tmpdir(), 'memedrop-media');
fs.mkdirSync(TMP_DIR, { recursive: true });

function httpJson(method, urlStr, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = mod.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Device-Token': token } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch { json = {}; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error(json.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Délai dépassé')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Téléchargement avec plafond de débit (token-window par seconde).
function throttledDownload(urlStr, maxBytesPerSec, ext, onProgress) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const dest = path.join(TMP_DIR, `${crypto.randomBytes(10).toString('hex')}.${ext}`);
    const out = fs.createWriteStream(dest);
    let settled = false;
    // Échec unique + nettoyage du fichier partiel : évite qu'un média corrompu
    // reste sur le disque et soit « résolu » comme un succès.
    const fail = (err) => {
      if (settled) return; settled = true;
      try { out.destroy(); } catch { /* ignore */ }
      fs.rmSync(dest, { force: true });
      reject(err);
    };
    out.on('error', fail);
    const req = mod.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); fail(new Error(`HTTP ${res.statusCode}`)); return; }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let windowStart = Date.now();
      let windowBytes = 0;
      res.on('data', (chunk) => {
        out.write(chunk);
        received += chunk.length;
        if (onProgress && total > 0) onProgress(received, total);
        if (maxBytesPerSec > 0) {
          windowBytes += chunk.length;
          const elapsed = Date.now() - windowStart;
          const allowed = maxBytesPerSec * (elapsed / 1000);
          if (windowBytes > allowed) {
            res.pause();
            const waitMs = ((windowBytes - allowed) / maxBytesPerSec) * 1000;
            setTimeout(() => res.resume(), Math.max(0, Math.min(waitMs, 2000)));
          }
          if (elapsed >= 1000) { windowStart = Date.now(); windowBytes = 0; }
        }
      });
      res.on('error', fail);
      res.on('end', () => {
        // Connexion coupée en cours → fichier tronqué. On échoue explicitement
        // plutôt que de livrer un média illisible (« nom mais pas de contenu »).
        if (total > 0 && received < total) { fail(new Error(`Téléchargement incomplet (${received}/${total})`)); return; }
        out.end(() => { if (!settled) { settled = true; resolve(dest); } });
      });
    });
    // Un téléchargement qui « pend » ne doit pas bloquer le meme indéfiniment.
    req.setTimeout(30000, () => req.destroy(new Error('Délai de téléchargement dépassé')));
    req.on('error', fail);
  });
}

class Connection extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.sockets = new Map();       // slug -> { ws, pingTimer, reconnectTimer, open }
    this.status = 'disconnected';
    this.config = null;
    // Dernier état de disponibilité publié ({ dnd, dndUntil, overlay }) : renvoyé
    // à chaque (re)connexion, sinon le serveur croirait le poste joignable.
    this.deviceStatus = null;
  }

  active() { return this.store.activeAccount(); }

  _refreshStatus() {
    const accounts = this.store.get().accounts;
    if (!accounts.length) { this._set('unpaired'); return; }
    const anyOpen = [...this.sockets.values()].some((s) => s.open);
    const anyConnecting = [...this.sockets.values()].some((s) => s.ws && !s.open);
    this._set(anyOpen ? 'connected' : anyConnecting ? 'connecting' : 'reconnecting');
  }
  _set(s) { if (this.status !== s) { this.status = s; this.emit('status', s); } }

  async pair(serverUrl, code, deviceName) {
    const base = serverUrl.replace(/\/+$/, '');
    const res = await httpJson('POST', `${base}/api/client/pair`, { body: { code, deviceName } });
    const acc = { url: base, deviceToken: res.deviceToken, channel: res.channel, wsUrl: res.wsUrl };
    this.store.upsertAccount(acc);
    this.config = res;
    this._applyServerDefaults(res);
    this._connectAccount(acc);
    return res;
  }

  async fetchConfig() {
    const a = this.active(); if (!a) throw new Error('Non appairé');
    const res = await httpJson('GET', `${a.url}/api/client/config`, { token: a.deviceToken });
    this.config = res;
    return res;
  }
  async fetchTargets() {
    const a = this.active(); if (!a) throw new Error('Non appairé');
    return httpJson('GET', `${a.url}/api/client/targets`, { token: a.deviceToken });
  }

  _applyServerDefaults(cfg) {
    const s = cfg.settings || {};
    this.store.set({ playback: {
      cooldownS: s.defaultCooldownS ?? this.store.get().playback.cooldownS,
      volume: s.defaultVolume ?? this.store.get().playback.volume,
      maxImageDurationS: s.maxImageDurationS, maxGifDurationS: s.maxGifDurationS,
      maxVideoDurationS: s.maxVideoDurationS, maxAudioDurationS: s.maxAudioDurationS,
    }, overlay: { opacity: s.defaultOpacity ?? this.store.get().overlay.opacity } });
  }

  // Connecte les WS de TOUS les channels appairés (réception multi-channel).
  connect() {
    const accounts = this.store.get().accounts;
    if (!accounts.length) { this._set('unpaired'); return; }
    // Ferme les sockets orphelins.
    for (const slug of [...this.sockets.keys()]) {
      if (!accounts.find((a) => a.channel?.slug === slug)) this._closeAccount(slug);
    }
    for (const a of accounts) this._connectAccount(a);
    this._refreshStatus();
  }

  _connectAccount(a) {
    const slug = a.channel?.slug;
    if (!slug || !a.wsUrl || !a.deviceToken) return;
    this._closeAccount(slug);
    const entry = { ws: null, pingTimer: null, reconnectTimer: null, connectTimer: null, open: false, lastActivity: Date.now() };
    this.sockets.set(slug, entry);
    try { entry.ws = new WebSocket(`${a.wsUrl}?token=${encodeURIComponent(a.deviceToken)}`); }
    catch { entry.reconnectTimer = setTimeout(() => this._connectAccount(a), 4000); return; }

    // Garde-fou de connexion : si l'ouverture n'aboutit pas (réseau qui « pend »),
    // on coupe pour forcer une reconnexion au lieu de rester bloqué en « connecting ».
    entry.connectTimer = setTimeout(() => { if (!entry.open) { try { entry.ws.terminate(); } catch {} } }, 15000);

    const bump = () => { entry.lastActivity = Date.now(); };

    entry.ws.on('open', () => {
      entry.open = true;
      clearTimeout(entry.connectTimer);
      bump();
      if (this.deviceStatus) { try { entry.ws.send(JSON.stringify({ type: 'status', ...this.deviceStatus })); } catch {} }
      // Battement de cœur applicatif : ping régulier + détection de socket
      // « mort silencieux » (demi-ouvert : aucun close TCP, ex. wifi qui change
      // ou reprise de veille). Sans aucune activité depuis 70 s malgré les pings,
      // on coupe pour reconnecter — corrige « l'app ne reçoit plus, faut reboot ».
      entry.pingTimer = setInterval(() => {
        if (Date.now() - entry.lastActivity > 70000) { try { entry.ws.terminate(); } catch {} return; }
        try { entry.ws.send(JSON.stringify({ type: 'ping' })); } catch {}
      }, 25000);
      this._refreshStatus();
    });
    // Toute activité serveur rafraîchit la vivacité : messages applicatifs ET
    // pings/pongs protocolaires (le serveur envoie un ping WS toutes les 30 s).
    entry.ws.on('ping', bump);
    entry.ws.on('pong', bump);
    entry.ws.on('message', (raw) => {
      bump();
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'meme') this.emit('meme', { ...m.meme, _slug: slug });
      else if (m.type === 'reaction') this.emit('reaction', m);     // mon meme a reçu une réaction
      else if (m.type === 'seen') this.emit('seen', { ...m, _slug: slug });        // « Vu par » (#1)
      else if (m.type === 'milestone') this.emit('milestone', { ...m, _slug: slug }); // seuil de réactions (#7)
      // 'pong' applicatif : rien de plus à faire, la vivacité est déjà rafraîchie.
    });
    entry.ws.on('close', () => { entry.open = false; clearTimeout(entry.connectTimer); clearInterval(entry.pingTimer); if (this.sockets.get(slug) === entry) { entry.reconnectTimer = setTimeout(() => this._connectAccount(a), 4000); } this._refreshStatus(); });
    entry.ws.on('error', () => {});
  }

  _closeAccount(slug) {
    const e = this.sockets.get(slug);
    if (!e) return;
    clearInterval(e.pingTimer); clearTimeout(e.reconnectTimer); clearTimeout(e.connectTimer);
    if (e.ws) { try { e.ws.removeAllListeners(); e.ws.close(); } catch {} }
    this.sockets.delete(slug);
  }

  disconnect() {
    for (const slug of [...this.sockets.keys()]) this._closeAccount(slug);
    this._set('disconnected');
  }

  unpair(slug) { this._closeAccount(slug); this.store.removeAccount(slug); this._refreshStatus(); }

  // Envoie un message sur le socket d'un channel précis (accusé / réaction).
  _sendWs(slug, obj) {
    const e = slug ? this.sockets.get(slug) : null;
    const entry = e || [...this.sockets.values()].find((x) => x.open);
    if (entry && entry.ws && entry.open) { try { entry.ws.send(JSON.stringify(obj)); return true; } catch { return false; } }
    return false;
  }
  sendAck(slug, memeId, status, detail = '') { return this._sendWs(slug, { type: 'ack', memeId, status, detail }); }
  sendReaction(slug, memeId, emoji) { return this._sendWs(slug, { type: 'reaction', memeId, emoji }); }

  // Disponibilité (« ne pas déranger », overlay coupé) : publiée sur TOUS les
  // channels appairés — la présence est calculée par channel, côté serveur.
  // Appelée à chaque rafraîchissement du tray : on ne réémet que sur changement
  // réel (la reconnexion, elle, repart de `deviceStatus`).
  publishStatus(status) {
    const payload = JSON.stringify({ type: 'status', ...status });
    if (payload === this._statusPayload) return;
    this._statusPayload = payload;
    this.deviceStatus = status;
    for (const e of this.sockets.values()) {
      if (e.open && e.ws) { try { e.ws.send(payload); } catch { /* la reconnexion renverra l'état */ } }
    }
  }

  // Blocages personnels (#15).
  listBlocks() { return this._authed('GET', '/api/client/blocks'); }
  addBlock(senderId, name) { return this._authed('POST', '/api/client/blocks', { senderId, name }); }
  removeBlock(senderId) { return this._authed('DELETE', `/api/client/blocks/${encodeURIComponent(senderId)}`); }

  // Soundboard myinstants (#13).
  searchSounds(q) { return this._authed('GET', `/api/client/sounds/search?q=${encodeURIComponent(q || '')}`); }
  importSound(url, name) { return this._authed('POST', '/api/client/sounds/import', { url, name }); }

  // Soundboard partagé du channel (#4) + métadonnées d'assets (#9).
  listSharedSounds() { return this._authed('GET', '/api/client/soundboard'); }
  updateAsset(id, patch) { return this._authed('PATCH', `/api/client/assets/${id}`, patch); }

  async downloadMedia(meme) {
    const extByMime = { 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'video/webm': 'webm' };
    const ext = extByMime[meme.media.mime] || 'bin';
    const maxBps = Math.max(0, (this.store.get().network.maxDownloadMBps || 0)) * 1024 * 1024;
    // Progression (#13) : émise seulement pour les fichiers non triviaux (> 400 Ko).
    let announced = false;
    const onProgress = (received, total) => {
      if (total < 400 * 1024) return;
      announced = true;
      this.emit('download', { id: meme.id, pct: Math.min(100, Math.round((received / total) * 100)), done: received >= total });
    };
    const p = await throttledDownload(meme.media.url, maxBps, ext, onProgress);
    if (announced) this.emit('download', { id: meme.id, pct: 100, done: true });
    return p;
  }

  // Téléchargement local d'un fichier annexe (son à l'apparition, overlay) :
  // la CSP stricte de l'overlay n'autorise que file:, jamais les URLs distantes.
  downloadAux(url, ext) {
    const maxBps = Math.max(0, (this.store.get().network.maxDownloadMBps || 0)) * 1024 * 1024;
    return throttledDownload(url, maxBps, ext, null);
  }

  // --- Multipart générique (sans dépendance) ----------------------------
  _resolveFile(f) {
    if (!f) return null;
    if (f.buffer) return { buffer: f.buffer, mime: f.mime || 'application/octet-stream', filename: f.filename || 'file' };
    if (f.path) return { buffer: fs.readFileSync(f.path), mime: f.mime || 'application/octet-stream', filename: f.filename || path.basename(f.path) };
    if (f.dataUrl) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(f.dataUrl);
      if (m) return { buffer: Buffer.from(m[2], 'base64'), mime: m[1], filename: f.filename || 'baked.png' };
    }
    return null;
  }

  _postMultipart(urlPath, fields, files) {
    const a = this.active();
    if (!a) return Promise.reject(new Error('Non appairé'));
    const { url, deviceToken } = a;
    const boundary = '----MemeDrop' + crypto.randomBytes(12).toString('hex');
    const parts = [];
    for (const [k, v] of Object.entries(fields || {})) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    for (const f of files || []) {
      const rf = this._resolveFile(f); if (!rf) continue;
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${rf.filename}"\r\nContent-Type: ${rf.mime}\r\n\r\n`));
      parts.push(rf.buffer);
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(parts);
    return new Promise((resolve, reject) => {
      const u = new URL(`${url}${urlPath}`);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length, 'X-Device-Token': deviceToken },
      }, (res) => {
        let data = ''; res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json; try { json = JSON.parse(data); } catch { json = {}; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(json.error || `HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.write(bodyBuf); req.end();
    });
  }

  _authed(method, urlPath, body) {
    const a = this.active();
    if (!a) return Promise.reject(new Error('Non appairé'));
    return httpJson(method, `${a.url}${urlPath}`, { token: a.deviceToken, body });
  }

  _files({ media, overlay, sound }) {
    const files = [];
    if (media) files.push({ name: 'media', ...media });
    if (overlay) files.push({ name: 'overlay', ...overlay });
    if (sound) files.push({ name: 'sound', ...sound });
    return files;
  }

  // Champs communs ; un son de la bibliothèque (#13) est référencé par assetId
  // (pas de ré-upload : le serveur réutilise le fichier déjà stocké).
  _commonFields(p) {
    const f = {
      text: p.text || '', options: JSON.stringify(p.options || {}),
      groups: JSON.stringify(p.groups || []), mentions: JSON.stringify(p.mentions || []),
    };
    if (p.sound && p.sound.assetId) f.soundAssetId = p.sound.assetId;
    return f;
  }
  // N'envoie le son en fichier que s'il vient d'un fichier local (pas d'assetId).
  _memeFiles(p) { return this._files({ ...p, sound: p.sound && p.sound.assetId ? null : p.sound }); }

  sendComposite(p) {
    return this._postMultipart('/api/client/meme', this._commonFields(p), this._memeFiles(p));
  }

  scheduleComposite(p) {
    return this._postMultipart('/api/client/schedules',
      { ...this._commonFields(p), label: p.label || '', trigger: JSON.stringify(p.trigger || {}) },
      this._memeFiles(p));
  }

  // Bibliothèque, planifications, réglages partagés.
  addAsset(p) { return this._postMultipart('/api/client/assets', { kind: p.kind || 'sound', name: p.name || '', data: JSON.stringify(p.data || {}) }, p.media ? [{ name: 'media', ...p.media }] : []); }
  listAssets(kind) { return this._authed('GET', `/api/client/assets${kind ? `?kind=${kind}` : ''}`); }
  deleteAsset(id) { return this._authed('DELETE', `/api/client/assets/${id}`); }
  getStorage() { return this._authed('GET', '/api/client/storage'); }
  listSchedules() { return this._authed('GET', '/api/client/schedules'); }
  deleteSchedule(id) { return this._authed('DELETE', `/api/client/schedules/${id}`); }
  publishSettings(settings) { return this._authed('POST', '/api/client/my-settings', { settings }); }
  membersSettings() { return this._authed('GET', '/api/client/members-settings'); }

  cleanupTemp(filePath) { try { fs.rmSync(filePath, { force: true }); } catch {} }
}

module.exports = { Connection, TMP_DIR };
