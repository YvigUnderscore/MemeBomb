const api = window.memedrop;
let cfg = null;
const $ = (id) => document.getElementById(id);
const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

// Affiche un message d'erreur dans un conteneur. Le texte vient du serveur
// (champ `error` d'une réponse JSON) : il est posé via textContent, jamais
// interpolé dans du HTML — l'utilisateur peut s'appairer à une URL arbitraire,
// et un serveur hostile injecterait sinon du script dans cette fenêtre.
function showError(containerId, message) {
  const box = $(containerId);
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'muted small';
  div.textContent = message;
  box.replaceChildren(div);
}

// --- Onglets ---
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('section').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  document.querySelector(`section[data-panel="${b.dataset.tab}"]`).classList.add('active');
  if (b.dataset.tab === 'social') { loadSocial(); loadBlocks(); }
}));

// --- Blocages personnels (#15) ---
async function loadBlocks() {
  // Peuple le sélecteur avec les membres du channel (pour bloquer).
  try {
    const info = await api.getTargets();
    const pick = $('blockPick'); pick.replaceChildren();
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Choisir un membre…'; pick.appendChild(ph);
    (info?.members || []).forEach((m) => { const o = document.createElement('option'); o.value = JSON.stringify({ id: m.discordId, name: m.username }); o.textContent = m.username; pick.appendChild(o); });
  } catch { /* ignore */ }
  try {
    const blocks = await api.listBlocks();
    const list = $('blocksList'); list.replaceChildren();
    if (!blocks.length) { list.innerHTML = '<div class="muted small">Nobody blocked.</div>'; return; }
    blocks.forEach((b) => {
      const row = document.createElement('div'); row.className = 'sched-row';
      const info = document.createElement('div'); info.innerHTML = '<b></b><div class="muted small"></div>';
      info.querySelector('b').textContent = b.name || b.senderId;
      info.querySelector('.small').textContent = b.senderId;
      const del = document.createElement('button'); del.className = 'btn btn-ghost'; del.textContent = 'Unblock';
      del.onclick = async () => { await api.removeBlock(b.senderId); loadBlocks(); };
      row.append(info, del); list.appendChild(row);
    });
  } catch (e) { showError('blocksList', e.message); }
}
$('blockAdd').onclick = async () => {
  const v = $('blockPick').value; if (!v) return;
  try { const { id, name } = JSON.parse(v); await api.addBlock(id, name); loadBlocks(); } catch { /* ignore */ }
};

async function loadSocial() {
  try {
    const scheds = await api.listSchedules();
    const sl = $('schedList');
    sl.replaceChildren();
    if (!scheds.length) { sl.innerHTML = '<div class="muted small">No schedules.</div>'; }
    else scheds.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'sched-row';
      const when = s.triggerType === 'recurring'
        ? `every ${s.triggerDays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join('/')} at ${s.triggerTime}`
        : new Date(s.nextRun).toLocaleString('fr-FR');
      const info = document.createElement('div');
      info.innerHTML = `<b></b><div class="muted small"></div>`;
      info.querySelector('b').textContent = s.label || s.text || '(meme)';
      info.querySelector('.small').textContent = when;
      const del = document.createElement('button');
      del.className = 'btn btn-ghost'; del.textContent = '🗑';
      del.onclick = async () => { await api.deleteSchedule(s.id); loadSocial(); };
      div.append(info, del);
      sl.appendChild(div);
    });
  } catch (e) { showError('schedList', e.message); }

  try {
    const members = await api.membersSettings();
    const ml = $('membersList');
    ml.replaceChildren();
    if (!members.length) { ml.innerHTML = '<div class="muted small">Nobody has shared their settings yet.</div>'; }
    else members.forEach((m) => {
      const ov = m.settings?.overlay || {}; const pb = m.settings?.playback || {};
      const div = document.createElement('div');
      div.className = 'sched-row';
      div.style.gap = '12px';
      // Vignette de placement overlay (#32) : mini-écran 16/9 avec la boîte du membre.
      div.appendChild(overlayThumb(ov));
      const info = document.createElement('div');
      info.style.flex = '1';
      info.innerHTML = `<b></b><div class="muted small"></div>`;
      info.querySelector('b').textContent = m.name || m.discordId;
      info.querySelector('.small').textContent =
        `Position: ${ov.anchor || '—'} · Taille: ${ov.sizePct ?? '—'}% · Volume: ${Math.round((pb.volume ?? 0) * 100)}% · Cooldown: ${pb.cooldownS ?? '—'}s`;
      div.appendChild(info);
      ml.appendChild(div);
    });
  } catch (e) { showError('membersList', e.message); }
}

// --- Statut connexion ---
function renderStatus(s) {
  const map = { connected: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', disconnected: 'Disconnected', unpaired: 'Not paired' };
  const box = $('status');
  box.className = 'status ' + s;
  $('statusText').textContent = map[s] || s;
}
api.onStatus(renderStatus);

// --- Chargement ---
async function load() {
  cfg = await api.getConfig();
  const displays = await api.getDisplays();
  renderStatus(await api.getStatus());

  // Connexion (multi-channel)
  await renderChannels();
  $('deviceName').value = '';

  // Overlay
  $('ov_enabled').checked = cfg.overlay.enabled;
  $('ov_allowSender').checked = cfg.overlay.allowSenderPosition;
  $('ov_textbg').checked = cfg.overlay.textBackground !== false;
  window._displays = displays;
  const sel = $('ov_display'); sel.replaceChildren();
  displays.forEach((d) => { const o = document.createElement('option'); o.value = d.index; o.textContent = d.label + (d.primary ? ' (principal)' : ''); sel.appendChild(o); });
  sel.value = cfg.overlay.displayIndex || 0;
  buildAnchorGrid();
  setMode(cfg.overlay.mode || 'anchor');
  bindRange('ov_size', 'ov_sizeVal', cfg.overlay.sizePct, (v) => setCfg({ overlay: { sizePct: v } }));
  bindRange('ov_opacity', 'ov_opacityVal', Math.round(cfg.overlay.opacity * 100), (v) => setCfg({ overlay: { opacity: v / 100 } }));
  bindRange('ov_margin', 'ov_marginVal', cfg.overlay.marginPct, (v) => setCfg({ overlay: { marginPct: v } }));
  bindRange('ov_maxpx', 'ov_maxpxVal', cfg.overlay.maxWidthPx || 0, (v) => setCfg({ overlay: { maxWidthPx: v } }));
  $('ov_maxpxVal').textContent = (cfg.overlay.maxWidthPx || 0) === 0 ? 'unlimited' : `${cfg.overlay.maxWidthPx} px`;
  $('ov_maxpx').addEventListener('input', (e) => { const v = +e.target.value; $('ov_maxpxVal').textContent = v === 0 ? 'unlimited' : `${v} px`; });
  initPlaceBox();

  // Lecture
  bindRange('pb_vol', 'pb_volVal', Math.round(cfg.playback.volume * 100), (v) => setCfg({ playback: { volume: v / 100 } }));
  $('pb_mute').checked = cfg.playback.muteAll;
  setPlayMode(cfg.playback.displayMode || 'queue');
  bindRange('pb_cd', 'pb_cdVal', cfg.playback.cooldownS, (v) => setCfg({ playback: { cooldownS: v } }));
  bindRange('pb_conc', 'pb_concVal', cfg.playback.maxConcurrent ?? 3, (v) => setCfg({ playback: { maxConcurrent: v } }));
  bindNum('pb_img', cfg.playback.maxImageDurationS, (v) => setCfg({ playback: { maxImageDurationS: v } }));
  bindNum('pb_gif', cfg.playback.maxGifDurationS, (v) => setCfg({ playback: { maxGifDurationS: v } }));
  bindNum('pb_vid', cfg.playback.maxVideoDurationS, (v) => setCfg({ playback: { maxVideoDurationS: v } }));
  bindNum('pb_aud', cfg.playback.maxAudioDurationS, (v) => setCfg({ playback: { maxAudioDurationS: v } }));

  // Réseau
  bindRange('net_rate', 'net_val', cfg.network.maxDownloadMBps, (v) => setCfg({ network: { maxDownloadMBps: v } }), 1);

  // Raccourcis
  bindShortcut('sc_editor', 'openEditor');
  bindShortcut('sc_overlay', 'toggleOverlay');
  bindShortcut('sc_mute', 'toggleMute');
  bindShortcut('sc_dnd', 'doNotDisturb');
  bindShortcut('sc_react1', 'react1');
  bindShortcut('sc_react2', 'react2');
  bindShortcut('sc_react3', 'react3');
  bindShortcut('sc_react4', 'react4');
  bindShortcut('sc_blockLast', 'blockLast');
  bindShortcut('sc_replayLast', 'replayLast');
  // Affiche les emojis configurés à côté des raccourcis + construit les sélecteurs (#31).
  const em = cfg.reactionEmojis || ['😂', '🔥', '💀', '❤️'];
  ['re1', 're2', 're3', 're4'].forEach((id, i) => { if ($(id)) $(id).textContent = em[i]; });
  buildReactionPickers();

  // Options
  $('opt_dblclick').value = cfg.tray?.doubleClickPage || 'settings';
  $('fun_anim').checked = cfg.fun.entranceAnimations;
  $('fun_float').checked = cfg.fun.floatingReactions !== false;
  $('fun_seen').checked = cfg.fun.showSeenBy !== false;
  $('fun_celebrate').checked = cfg.playback.celebrate !== false;
  $('fun_notify').checked = !!cfg.fun.notifySound;
  $('fun_dnd').checked = cfg.fun.doNotDisturb;
  $('opt_startup').checked = cfg.launchAtStartup;
}

// --- Mode de placement overlay (ancre / manuel) ---
function setMode(mode) {
  document.querySelectorAll('#ov_mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('modeAnchor').classList.toggle('hidden', mode !== 'anchor');
  $('modeManual').classList.toggle('hidden', mode !== 'manual');
}
document.querySelectorAll('#ov_mode button').forEach((b) => b.addEventListener('click', () => {
  setMode(b.dataset.mode); setCfg({ overlay: { mode: b.dataset.mode } }); cfg.overlay.mode = b.dataset.mode;
  if (b.dataset.mode === 'manual') initPlaceBox();
}));

// --- Mode de lecture (file / simultané) ---
function setPlayMode(mode) {
  document.querySelectorAll('#pb_mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('cdLabel').style.opacity = mode === 'queue' ? '1' : '.4';
  $('pb_cd').style.opacity = mode === 'queue' ? '1' : '.4';
  $('concLabel').style.opacity = mode === 'concurrent' ? '1' : '.4';
  $('pb_conc').style.opacity = mode === 'concurrent' ? '1' : '.4';
}
document.querySelectorAll('#pb_mode button').forEach((b) => b.addEventListener('click', () => {
  setPlayMode(b.dataset.mode); setCfg({ playback: { displayMode: b.dataset.mode } });
}));

// --- Éditeur de cadre 16/9 (mode manuel) ---
function initPlaceBox() {
  const disp = (window._displays || []).find((d) => d.index === (cfg.overlay.displayIndex || 0)) || { size: { width: 16, height: 9 } };
  const ratio = (disp.size?.width || 16) / (disp.size?.height || 9);
  const preview = $('screenPreview');
  preview.style.aspectRatio = String(ratio);
  const box = $('placeBox');
  const man = cfg.overlay.manual || { xPct: 0.29, yPct: 0.29, wPct: 0.42 };

  const render = () => {
    const pw = preview.clientWidth, ph = preview.clientHeight;
    if (!pw) { requestAnimationFrame(render); return; }
    const wPx = man.wPct * pw;
    const hPx = wPx * 9 / 16;
    box.style.width = `${wPx}px`;
    box.style.height = `${hPx}px`;
    box.style.left = `${man.xPct * pw}px`;
    box.style.top = `${man.yPct * ph}px`;
  };
  render();

  const save = () => { setCfg({ overlay: { manual: { ...man } } }); cfg.overlay.manual = { ...man }; };

  // Déplacement
  let drag = null;
  box.onpointerdown = (e) => {
    if (e.target.id === 'placeHandle') return;
    const pw = preview.clientWidth, ph = preview.clientHeight;
    drag = { sx: e.clientX, sy: e.clientY, x0: man.xPct * pw, y0: man.yPct * ph, pw, ph };
    box.setPointerCapture(e.pointerId); e.preventDefault();
  };
  box.onpointermove = (e) => {
    if (!drag) return;
    const wPx = man.wPct * drag.pw, hPx = wPx * 9 / 16;
    let x = drag.x0 + (e.clientX - drag.sx), y = drag.y0 + (e.clientY - drag.sy);
    x = Math.max(0, Math.min(drag.pw - wPx, x)); y = Math.max(0, Math.min(drag.ph - hPx, y));
    man.xPct = x / drag.pw; man.yPct = y / drag.ph; render();
  };
  box.onpointerup = () => { if (drag) { drag = null; save(); } };

  // Redimensionnement (verrouillé 16/9, pas de min)
  const handle = $('placeHandle');
  let rez = null;
  handle.onpointerdown = (e) => {
    const pw = preview.clientWidth;
    rez = { sx: e.clientX, w0: man.wPct * pw, pw, ph: preview.clientHeight };
    handle.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault();
  };
  handle.onpointermove = (e) => {
    if (!rez) return;
    let wPx = rez.w0 + (e.clientX - rez.sx);
    wPx = Math.max(6, Math.min(rez.pw - man.xPct * rez.pw, wPx));
    const hPx = wPx * 9 / 16;
    if (man.yPct * rez.ph + hPx > rez.ph) wPx = (rez.ph - man.yPct * rez.ph) * 16 / 9;
    man.wPct = wPx / rez.pw; render();
  };
  handle.onpointerup = () => { if (rez) { rez = null; save(); } };
}

// Mini-écran 16/9 illustrant le placement overlay d'un membre (#32).
function overlayThumb(ov) {
  const wrap = document.createElement('div'); wrap.className = 'ov-thumb';
  const box = document.createElement('div'); box.className = 'ov-thumb-box';
  const anchor = ov.anchor || 'center';
  const size = clampNum(ov.mode === 'manual' && ov.manual ? (ov.manual.wPct * 100) : (ov.sizePct ?? 42), 8, 100);
  const wPct = size, hPct = size; // cadre 16/9 dans un écran 16/9 → même fraction
  let left, top;
  if (ov.mode === 'manual' && ov.manual) { left = (ov.manual.xPct ?? 0.29) * 100; top = (ov.manual.yPct ?? 0.29) * 100; }
  else {
    left = anchor.includes('left') ? 4 : anchor.includes('right') ? 96 - wPct : (100 - wPct) / 2;
    top = anchor.includes('top') ? 4 : anchor.includes('bottom') ? 96 - hPct : (100 - hPct) / 2;
  }
  box.style.width = wPct + '%'; box.style.aspectRatio = '16/9';
  box.style.left = left + '%'; box.style.top = top + '%';
  box.style.opacity = String(clampNum(ov.opacity ?? 0.95, 0.2, 1));
  wrap.appendChild(box);
  return wrap;
}
const clampNum = (v, a, b) => Math.min(b, Math.max(a, Number.isFinite(+v) ? +v : a));

function setCfg(patch) { api.setConfig(patch).then((c) => { cfg = c; }); }

function bindRange(id, valId, initial, onChange, decimals = 0) {
  const el = $(id); el.value = initial;
  const label = $(valId); label.textContent = Number(initial).toFixed(decimals);
  el.oninput = () => { label.textContent = Number(el.value).toFixed(decimals); };
  el.onchange = () => onChange(Number(el.value));
}
function bindNum(id, initial, onChange) {
  const el = $(id); el.value = initial;
  el.onchange = () => onChange(Number(el.value));
}

function buildAnchorGrid() {
  const grid = $('anchorGrid'); grid.replaceChildren();
  ANCHORS.forEach((a) => {
    const b = document.createElement('button');
    b.title = a;
    if (cfg.overlay.anchor === a) b.classList.add('active');
    b.onclick = () => { setCfg({ overlay: { anchor: a } }); cfg.overlay.anchor = a; buildAnchorGrid(); };
    grid.appendChild(b);
  });
}

// Capture d'un raccourci clavier.
function bindShortcut(id, key) {
  const el = $(id);
  el.value = cfg.shortcuts[key] || '';
  el.placeholder = 'None';
  el.onkeydown = (e) => {
    e.preventDefault();
    // Retirer le raccourci : aucune touche n'est associée par défaut, on doit
    // pouvoir revenir à cet état sans passer par le bouton global.
    if (['Backspace', 'Delete', 'Escape'].includes(e.key)) {
      el.value = '';
      setCfg({ shortcuts: { [key]: '' } });
      return;
    }
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    const k = e.key.toUpperCase();
    if (!['CONTROL', 'ALT', 'SHIFT', 'META'].includes(k)) parts.push(k.length === 1 ? k : e.key);
    if (parts.length >= 2 && !['CONTROL', 'ALT', 'SHIFT', 'META'].includes(k)) {
      const accel = parts.join('+');
      el.value = accel;
      setCfg({ shortcuts: { [key]: accel } });
    }
  };
}

// --- Actions ---
$('ov_enabled').onchange = (e) => setCfg({ overlay: { enabled: e.target.checked } });
$('ov_allowSender').onchange = (e) => setCfg({ overlay: { allowSenderPosition: e.target.checked } });
$('ov_textbg').onchange = (e) => setCfg({ overlay: { textBackground: e.target.checked } });
$('ov_display').onchange = (e) => { setCfg({ overlay: { displayIndex: Number(e.target.value) } }); cfg.overlay.displayIndex = Number(e.target.value); initPlaceBox(); };
$('scResetBtn').onclick = async () => {
  cfg = await api.resetShortcuts();
  ['sc_editor:openEditor', 'sc_overlay:toggleOverlay', 'sc_mute:toggleMute', 'sc_dnd:doNotDisturb',
    'sc_react1:react1', 'sc_react2:react2', 'sc_react3:react3', 'sc_react4:react4', 'sc_blockLast:blockLast', 'sc_replayLast:replayLast']
    .forEach((p) => { const [id, key] = p.split(':'); bindShortcut(id, key); });
};

// --- Sélecteur d'emojis de réaction (#31) -------------------------------
const ALLOWED_REACTIONS = ['😂', '❤️', '🔥', '💀', '👏', '😮', '👎', '🤡'];
let reactPickSlot = -1;
function buildReactionPickers() {
  const em = (cfg.reactionEmojis || ['😂', '🔥', '💀', '❤️']).slice(0, 4);
  const wrap = $('reactionPickers'); wrap.replaceChildren();
  em.forEach((e, i) => {
    const b = document.createElement('button'); b.className = 'btn btn-ghost react-slot'; b.textContent = e; b.title = `Emoji ${i + 1}`;
    b.onclick = (ev) => { ev.stopPropagation(); openReactPop(i); };
    wrap.appendChild(b);
  });
  // Grille de choix.
  const pop = $('reactPop'); pop.replaceChildren();
  ALLOWED_REACTIONS.forEach((e) => {
    const b = document.createElement('button'); b.textContent = e;
    b.onclick = () => {
      if (reactPickSlot < 0) return;
      const next = (cfg.reactionEmojis || ['😂', '🔥', '💀', '❤️']).slice(0, 4);
      next[reactPickSlot] = e;
      setCfg({ reactionEmojis: next }); cfg.reactionEmojis = next;
      pop.classList.add('hidden'); buildReactionPickers();
      ['re1', 're2', 're3', 're4'].forEach((id, i) => { if ($(id)) $(id).textContent = next[i]; });
    };
    pop.appendChild(b);
  });
}
function openReactPop(slot) { reactPickSlot = slot; $('reactPop').classList.remove('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('#reactPop') && !e.target.closest('.react-slot')) $('reactPop').classList.add('hidden'); });
$('opt_dblclick').onchange = (e) => setCfg({ tray: { doubleClickPage: e.target.value } });
$('pb_mute').onchange = (e) => setCfg({ playback: { muteAll: e.target.checked } });
$('fun_anim').onchange = (e) => setCfg({ fun: { entranceAnimations: e.target.checked } });
$('fun_float').onchange = (e) => setCfg({ fun: { floatingReactions: e.target.checked } });
$('fun_seen').onchange = (e) => setCfg({ fun: { showSeenBy: e.target.checked } });
$('fun_celebrate').onchange = (e) => setCfg({ playback: { celebrate: e.target.checked } });
$('fun_notify').onchange = (e) => setCfg({ fun: { notifySound: e.target.checked } });
$('fun_dnd').onchange = (e) => setCfg({ fun: { doNotDisturb: e.target.checked, dndUntil: 0 } });
$('opt_startup').onchange = (e) => setCfg({ launchAtStartup: e.target.checked });
$('testBtn').onclick = () => api.testMeme();
$('openEditorBtn').onclick = () => api.openEditor();
$('resetBtn').onclick = async () => { if (confirm('Reset all settings?')) { await api.resetConfig(); load(); } };

async function renderChannels() {
  const { accounts, activeSlug } = await api.listChannels();
  const list = $('channelsList'); list.replaceChildren();
  // Onboarding première utilisation (#4) : visible tant qu'aucun channel n'est appairé.
  $('onboarding').classList.toggle('hidden', accounts.length > 0);
  if (!accounts.length) { list.innerHTML = '<div class="muted small">No channel paired yet.</div>'; return; }
  accounts.forEach((a) => {
    const row = document.createElement('div'); row.className = 'sched-row';
    const left = document.createElement('label'); left.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;flex:1';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'chan'; radio.checked = a.slug === activeSlug;
    radio.onchange = async () => { await api.setActiveChannel(a.slug); };
    const info = document.createElement('div'); info.innerHTML = '<b></b><div class="muted small"></div>';
    info.querySelector('b').textContent = a.name || a.slug;
    info.querySelector('.small').textContent = a.url;
    left.append(radio, info);
    const del = document.createElement('button'); del.className = 'btn btn-ghost'; del.textContent = '🗑';
    del.onclick = async () => { if (confirm(`Désappairer "${a.name}" ?`)) { await api.unpair(a.slug); renderChannels(); } };
    row.append(left, del);
    list.appendChild(row);
  });
}
$('siteBtn').onclick = () => api.openWebsite();

// --- À propos (#49) ------------------------------------------------------
(async function initAbout() {
  try { const v = await api.getVersion(); $('aboutVersion').textContent = v.app || '—'; $('aboutElectron').textContent = v.electron || '—'; } catch { /* ignore */ }
})();
$('siteBtn2').onclick = () => api.openWebsite();
$('aboutReconnect').onclick = async () => { const s = await api.reconnect(); $('aboutStatus').textContent = `Status: ${s}`; };

$('pairBtn').onclick = async () => {
  $('pairErr').textContent = '';
  const url = $('serverUrl').value.trim();
  const code = $('pairCode').value.trim().toUpperCase();
  const name = $('deviceName').value.trim() || 'Mon PC';
  if (!url || !code) { $('pairErr').textContent = 'URL et code requis.'; return; }
  $('pairBtn').disabled = true; $('pairBtn').textContent = 'Appairage…';
  try { await api.pair(url, code, name); $('pairCode').value = ''; await load(); }
  catch (e) { $('pairErr').textContent = e.message; }
  finally { $('pairBtn').disabled = false; $('pairBtn').textContent = 'Appairer'; }
};

// Guidelines
$('guidelinesBtn').onclick = async () => {
  const g = await api.getGuidelines();
  $('guidelinesText').textContent = g.text || 'No guidelines available (connect first).';
  $('guidelinesModal').classList.remove('hidden');
};
$('glClose').onclick = () => $('guidelinesModal').classList.add('hidden');
$('glAccept').onclick = async () => { await api.acceptGuidelines(); $('guidelinesModal').classList.add('hidden'); };

load();
