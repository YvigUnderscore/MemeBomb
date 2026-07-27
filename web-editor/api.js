// ============================================================
//  Adaptateur navigateur de l'éditeur web.
//  Expose window.memedrop (même surface que le preload Electron) mais
//  implémenté via fetch() vers /api/client/*, puis charge editor.js.
//
//  Deux modes d'authentification :
//   • panel  : ?channel=<slug> présent → demande un token éditeur (cookie de
//              session panel, même origine) puis l'utilise comme un appareil.
//   • membre : token d'appareil dans localStorage, obtenu via un écran
//              d'appairage (POST /api/client/pair).
// ============================================================
(function () {
  const params = new URLSearchParams(location.search);
  const PANEL_CHANNEL = params.get('channel');
  const PANEL_MODE = !!PANEL_CHANNEL;
  const TOKEN_KEY = 'md_web_token';
  let TOKEN = null;
  let configCache = null;
  const $ = (id) => document.getElementById(id);

  async function api(method, path, { json, form, raw } = {}) {
    const headers = {};
    if (TOKEN) headers['X-Device-Token'] = TOKEN;
    const opts = { method, headers };
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    if (form) opts.body = form;
    const res = await fetch(path, opts);
    if (raw) {
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
        throw new Error(msg);
      }
      return res;
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || ('Error ' + res.status));
    return data;
  }

  function dataURLtoBlob(dataUrl) {
    const [meta, b64] = String(dataUrl).split(',');
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  // Payload éditeur → FormData (mêmes champs que POST /api/client/meme).
  function memeForm(p) {
    const fd = new FormData();
    fd.append('text', p.text || '');
    fd.append('options', JSON.stringify(p.options || {}));
    fd.append('groups', JSON.stringify(p.groups || []));
    fd.append('mentions', JSON.stringify(p.mentions || []));
    if (p.media) {
      if (p.media.file) fd.append('media', p.media.file, p.media.filename || 'media');
      else if (p.media.dataUrl) fd.append('media', dataURLtoBlob(p.media.dataUrl), p.media.filename || 'meme.png');
    }
    if (p.overlay && p.overlay.dataUrl) fd.append('overlay', dataURLtoBlob(p.overlay.dataUrl), p.overlay.filename || 'overlay.png');
    // Composition multi-calques : fichiers dans l'ordre de comp.layers (z croissant).
    if (p.layers) p.layers.forEach((l) => fd.append('layers', l.file, l.filename || 'layer'));
    if (p.comp) fd.append('comp', JSON.stringify(p.comp));
    // Sons joués à l'apparition : plusieurs fichiers (champ `sound` répété)
    // et/ou plusieurs assets de la bibliothèque (`soundAssetIds`).
    const assetIds = [];
    for (const s of p.sounds || (p.sound ? [p.sound] : [])) {
      if (!s) continue;
      if (s.assetId) assetIds.push(s.assetId);
      else if (s.file) fd.append('sound', s.file, s.filename || 'sound');
      else if (s.dataUrl) fd.append('sound', dataURLtoBlob(s.dataUrl), s.filename || 'sound');
    }
    if (assetIds.length) fd.append('soundAssetIds', JSON.stringify(assetIds));
    return fd;
  }

  // Asset de bibliothèque (son ou meme) → FormData : rendu + définition JSON.
  // Un meme animé arrive sous forme de calques (+ comp/overlay), comme un envoi :
  // le serveur les compose en vidéo et stocke ce rendu.
  function assetForm(p) {
    const fd = new FormData();
    fd.append('kind', p.kind || 'sound');
    fd.append('name', p.name || '');
    fd.append('data', JSON.stringify(p.data || {}));
    if (p.media && p.media.dataUrl) fd.append('media', dataURLtoBlob(p.media.dataUrl), p.media.filename || 'meme.png');
    else if (p.media && p.media.file) fd.append('media', p.media.file, p.media.filename || 'media');
    if (p.layers) p.layers.forEach((l) => fd.append('layers', l.file, l.filename || 'layer'));
    if (p.comp) fd.append('comp', JSON.stringify(p.comp));
    if (p.overlay && p.overlay.dataUrl) fd.append('overlay', dataURLtoBlob(p.overlay.dataUrl), p.overlay.filename || 'overlay.png');
    return fd;
  }

  async function getConfig() {
    if (!configCache) configCache = await api('GET', '/api/client/config');
    return configCache;
  }

  // Sélecteur de fichier natif (remplace le dialog Electron). Renvoie un File ou null.
  function pickFile() {
    return new Promise((resolve) => {
      const inp = $('hiddenFile');
      inp.value = '';
      inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
      inp.click();
    });
  }

  window.memedrop = {
    pickFile,
    fileDataUrl: (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }),
    listChannels: async () => { const c = await getConfig(); return { accounts: [{ slug: c.channel.slug, name: c.channel.name }], activeSlug: c.channel.slug }; },
    setActiveChannel: async () => (await getConfig()).channel.slug,
    getTargets: async () => {
      try {
        const [c, t] = await Promise.all([getConfig(), api('GET', '/api/client/targets')]);
        return { channel: c.channel, settings: c.settings, features: c.features, limits: c.limits, groups: t.groups, members: t.members };
      } catch (e) { return { error: e.message }; }
    },
    // Présence des membres (en ligne / ne pas déranger) — interrogée en boucle.
    getPresence: () => api('GET', '/api/client/presence'),
    getStorage: () => api('GET', '/api/client/storage'),
    getGuidelines: async () => { const c = await getConfig(); return { text: c.guidelines, requireAccept: c.settings.requireGuidelinesAccept, acceptedAt: localStorage.getItem('md_gl_accepted') }; },
    acceptGuidelines: async () => { localStorage.setItem('md_gl_accepted', String(Date.now())); return true; },
    listAssets: (kind) => api('GET', '/api/client/assets' + (kind ? '?kind=' + encodeURIComponent(kind) : '')),
    // Détail d'un asset, scène comprise (la liste ne la transporte pas).
    getAsset: (id) => api('GET', '/api/client/assets/' + encodeURIComponent(id)),
    addAsset: (p) => api('POST', '/api/client/assets', { form: assetForm(p) }),
    // Ré-enregistre un meme existant (retouché) au lieu d'en créer un doublon.
    replaceAsset: (id, p) => api('PUT', '/api/client/assets/' + encodeURIComponent(id), { form: assetForm(p) }),
    // Renvoie un meme de la bibliothèque sans repasser par l'éditeur.
    sendAsset: (id, p) => api('POST', '/api/client/assets/' + encodeURIComponent(id) + '/send', { json: p || {} }),
    deleteAsset: (id) => api('DELETE', '/api/client/assets/' + encodeURIComponent(id)),
    updateAsset: (id, patch) => api('PATCH', '/api/client/assets/' + encodeURIComponent(id), { json: patch }),
    searchSounds: (q) => api('GET', '/api/client/sounds/search?q=' + encodeURIComponent(q || '')).catch((e) => ({ error: e.message })),
    importSound: (url, name) => api('POST', '/api/client/sounds/import', { json: { url, name } }),
    previewSound: async (url) => {
      try { const res = await api('GET', '/api/client/sounds/preview?url=' + encodeURIComponent(url), { raw: true }); return URL.createObjectURL(await res.blob()); }
      catch (e) { return { error: e.message }; }
    },
    listSharedSounds: () => api('GET', '/api/client/soundboard'),
    // Recherche Giphy (dégradée si GIPHY_API_KEY absent côté serveur).
    searchGifs: (q) => api('GET', '/api/client/gifs/search?q=' + encodeURIComponent(q || '')).catch((e) => ({ error: e.message })),
    // Import d'un média par URL : le serveur télécharge (anti-SSRF) et renvoie le binaire.
    mediaFromUrl: async (url) => {
      const res = await api('POST', '/api/client/media/from-url', { json: { url }, raw: true });
      return res.blob();
    },
    sendMeme: (p) => api('POST', '/api/client/meme', { form: memeForm(p) }),
    scheduleMeme: (p) => { const fd = memeForm(p); fd.append('label', p.label || ''); fd.append('trigger', JSON.stringify(p.trigger || {})); return api('POST', '/api/client/schedules', { form: fd }); },
  };

  // --- Boot ---------------------------------------------------------------
  // Cache-busting : editor.js est injecté dynamiquement, un rechargement forcé
  // ne le rafraîchit pas. On reprend la version de NOTRE propre URL (posée par
  // le serveur dans index.html) : les deux fichiers restent ainsi d'une seule
  // et même génération, jamais un api.js périmé avec un editor.js à jour.
  const VERSION = (() => {
    try { return new URL(document.currentScript.src).searchParams.get('v') || ''; }
    catch { return ''; }
  })() || String(Date.now());
  function loadEditor() { const s = document.createElement('script'); s.src = 'editor.js?v=' + encodeURIComponent(VERSION); document.body.appendChild(s); }

  async function bootPanel() {
    try {
      const r = await fetch('/api/channels/' + encodeURIComponent(PANEL_CHANNEL) + '/editor-token', { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) throw new Error('unauthorized');
      TOKEN = (await r.json()).token;
      const wrap = $('chanSelectWrap'); if (wrap) wrap.style.display = 'none'; // channel fixe
      loadEditor();
    } catch {
      document.body.innerHTML = '<div style="font-family:system-ui;color:#eee;display:grid;place-items:center;height:100vh;text-align:center">Panel session expired.<br>Reload the panel page.</div>';
    }
  }

  function showPairGate(msg) {
    const gate = $('pairGate'); gate.classList.remove('hidden');
    if (msg) $('pairErr').textContent = msg;
    $('pairBtn').onclick = async () => {
      const code = ($('pairCode').value || '').trim();
      const deviceName = ($('pairName').value || 'Browser').trim();
      if (!code) { $('pairErr').textContent = 'Enter a code.'; return; }
      $('pairBtn').disabled = true; $('pairErr').textContent = '';
      try {
        const res = await fetch('/api/client/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Invalid code.');
        TOKEN = data.deviceToken; localStorage.setItem(TOKEN_KEY, TOKEN);
        gate.classList.add('hidden'); loadEditor();
      } catch (e) { $('pairErr').textContent = e.message; $('pairBtn').disabled = false; }
    };
  }

  // Le client desktop ouvre /compose#dt=<token appareil> : le fragment ne
  // transite jamais vers le serveur ; on le stocke puis on nettoie l'URL.
  // → l'éditeur est appairé d'office, sans redemander de code.
  function tokenFromFragment() {
    const m = /[#&]dt=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search);
    try { return decodeURIComponent(m[1]); } catch { return null; }
  }

  async function bootMember() {
    const fromClient = tokenFromFragment();
    if (fromClient) { TOKEN = fromClient; localStorage.setItem(TOKEN_KEY, TOKEN); }
    else TOKEN = localStorage.getItem(TOKEN_KEY);
    if (!TOKEN) return showPairGate();
    try { await getConfig(); loadEditor(); }
    catch { TOKEN = null; localStorage.removeItem(TOKEN_KEY); configCache = null; showPairGate('Device disconnected — pair it again.'); }
  }

  if (PANEL_MODE) bootPanel(); else bootMember();
})();
