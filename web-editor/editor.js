// ============================================================
//  Éditeur de meme v2 — scène 16/9 WYSIWYG, multi-calques
//  (texte / emoji / image / dessin), déplacer/redimensionner/pivoter,
//  fond image/vidéo/gif/son, son à l'apparition, placement avant envoi,
//  planification, enregistrement en bibliothèque.
// ============================================================
const api = window.memedrop;
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, Number.isFinite(+v) ? +v : a));
const EMOJIS = ['😂', '💀', '🔥', '👀', '🤡', '😭', '🥲', '😎', '👍', '🙏', '💯', '🚀', '❤️', '🎉', '🤔', '😳', '🗿', '🤨', '👑', '⭐', '✅', '❌', '🥶', '🤯', '🫡', '😏', '🙄', '😤', '🍑', '💥'];
const DAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];

const stage = $('stage');
const drawCanvas = $('drawCanvas');
const dctx = drawCanvas.getContext('2d');

let els = [];             // calques (texte / image / vidéo / gif)
let selId = null;
let base = { mode: 'none', color: '#111114', media: null, img: null };
// Sons joués à l'apparition du meme (tous ensemble) : fichier local
// { file, name, mime } ou son de la bibliothèque { assetId, name, url }.
let sounds = [];
const MAX_SOUNDS = 4;     // doit rester ≤ MAX_SOUNDS côté serveur
let strokes = [];         // dessin : [{color,sizeFrac,points:[{x,y}fractions]}]
let drawMode = false;
let features = {};
let storageInfo = null;   // { usedMb, quotaMb } (compteur)
// Fichiers des calques vidéo/gif + fond : hors historique (un File n'est pas
// sérialisable), la Map survit aux undo/redo → les vidéos sont restaurées.
const mediaFiles = new Map(); // el.id -> { file, url }
let placeBox = { xPct: 0.25, yPct: 0.25, wPct: 0.5 }; // emplacement chez le destinataire
const options = { anchor: 'center', scale: 0.5, durationS: 6, animation: 'fade', volume: 0.7, animInMs: 350, animOutMs: 350 };
const selGroups = new Set();
const selMembers = new Set();

// ---- Init ---------------------------------------------------------------
(async function init() {
  initMiniPlace();
  buildEmojiPop();
  buildDays();
  bindOptions();
  resizeDrawCanvas();
  drawCanvas.style.pointerEvents = 'none';   // FIX : sinon le canvas bloque le clic sur les éléments
  window.addEventListener('resize', () => { resizeDrawCanvas(); renderElements(); renderMiniBox(); });

  await loadChannels();
  await loadTargets();
  startPresenceLoop();
  refreshStorage();
  pushHistory();

  const g = await api.getGuidelines();
  if (g.requireAccept && !g.acceptedAt) { $('glText').textContent = g.text || ''; $('glGate').classList.remove('hidden'); }
})();

// Sélecteur de channel (multi-channel, dernier choisi = défaut).
async function loadChannels() {
  try {
    const { accounts, activeSlug } = await api.listChannels();
    const sel = $('channelSelect'); sel.replaceChildren();
    if (!accounts.length) { const o = document.createElement('option'); o.textContent = 'Not paired'; sel.appendChild(o); return; }
    accounts.forEach((a) => { const o = document.createElement('option'); o.value = a.slug; o.textContent = a.name || a.slug; if (a.slug === activeSlug) o.selected = true; sel.appendChild(o); });
    sel.onchange = async () => { await api.setActiveChannel(sel.value); await loadTargets(); refreshStorage(); };
  } catch { /* ignore */ }
}

async function loadTargets() {
  const info = await api.getTargets();
  if (info && !info.error) {
    features = info.features || {};
    buildTargets(info.groups || [], info.members || []);
    applyFeatures();
    window._maxUploadMb = info.settings?.maxUploadMb || 25;
    window._quotaMb = info.limits?.storageQuotaMb || 0;
    // Limites serveur : durée des animations et durée max vidéo.
    window._maxAnimMs = info.settings?.maxAnimMs || 1500;
    window._maxVideoS = info.settings?.maxVideoDurationS || 15;
    window._giphy = info.settings?.giphyEnabled === true;
    $('optAnimIn').max = window._maxAnimMs;
    $('optAnimOut').max = window._maxAnimMs;
    $('optDur').max = Math.max(30, window._maxVideoS);
    $('sendErr').textContent = '';
    refreshPresence();
  } else {
    $('sendErr').textContent = info?.error ? `Connection: ${info.error}` : 'Not paired — open the Settings.';
  }
}

async function refreshStorage() {
  try { storageInfo = await api.getStorage(); } catch { /* ignore */ }
  updateWeight();
}

// ---- Compteur de poids en temps réel ------------------------------------
// Poids du meme en cours (calques vidéo + fond + son + images) vs limite d'envoi.
function payloadWeightMb() {
  let bytes = 0;
  for (const el of els) {
    if (el.hidden) continue;
    if (el.type === 'video') bytes += mediaFiles.get(el.id)?.file?.size || 0;
    else if (el.type === 'image' && el.src) bytes += Math.round((el.src.length || 0) * 0.75); // dataUrl → binaire
  }
  if (base.mode === 'media' && base.media?.file) bytes += base.media.file.size;
  for (const s of sounds) if (s.file) bytes += s.file.size;
  return bytes / 1048576;
}
function updateWeight() {
  updateDurationUI();
  const mb = payloadWeightMb();
  const max = window._maxUploadMb || 25;
  const el = $('storageCounter');
  const stock = storageInfo ? ` · 💾 ${storageInfo.usedMb}/${storageInfo.quotaMb} MB` : '';
  el.textContent = `📦 ${mb.toFixed(1)} / ${max} MB${stock}`;
  el.classList.toggle('warn', mb > max
    || (storageInfo && storageInfo.quotaMb > 0 && storageInfo.usedMb / storageInfo.quotaMb > 0.85));
}

$('glAgree').onchange = (e) => { $('glContinue').disabled = !e.target.checked; };
$('glContinue').onclick = async () => { await api.acceptGuidelines(); $('glGate').classList.add('hidden'); };

function applyFeatures() {
  if (features.sounds === false) $('soundCard').classList.add('hidden');
  if (features.schedule === false) $('scheduleBtn').classList.add('hidden');
  if (features.choosePosition === false) $('placeWrap').classList.add('hidden');
  if (features.multiElement === false) { $('tbImage').classList.add('hidden'); $('tbDraw').classList.add('hidden'); }
}

// ---- Calques : modèle + rendu ------------------------------------------
function addText(text, isEmoji) {
  const el = { id: rid(), type: 'text', text, xPct: 0.5, yPct: 0.5, fontFrac: isEmoji ? 0.14 : 0.09, rot: 0, opacity: 1, color: '#ffffff', outline: !isEmoji, z: els.length };
  els.push(el); select(el.id); renderElements(); commit();
}
// Bouton « Média » : ouvre le sélecteur puis délègue à addDroppedFile, qui
// route selon le type — image → calque, vidéo/gif/son → fond média (« en bas »).
async function addMedia() {
  const f = await api.pickFile(); if (!f) return;
  addDroppedFile(f);
}
const rid = () => Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const cur = () => els.find((e) => e.id === selId);

function stagePx() { const r = stage.getBoundingClientRect(); return { W: r.width, H: r.height, left: r.left, top: r.top }; }

// ---- Déformation (corner pin) : homographie -----------------------------
// el.quad = { tl:[dx,dy], tr:.., br:.., bl:.. } — décalages de chaque coin en
// fractions de la taille de l'élément (repère local non tourné). null = aucun.
const QUAD_KEYS = ['tl', 'tr', 'br', 'bl'];
function hasQuad(el) {
  const q = el.quad;
  return !!q && QUAD_KEYS.some((k) => q[k] && (Math.abs(q[k][0]) > 0.001 || Math.abs(q[k][1]) > 0.001));
}
// Coins du contenu (0,0..w,h) après déformation, en px locaux (origine haut-gauche).
function quadCorners(el, w, h) {
  const base = { tl: [0, 0], tr: [w, 0], br: [w, h], bl: [0, h] };
  return QUAD_KEYS.map((k) => {
    const q = (el.quad && el.quad[k]) || [0, 0];
    return [base[k][0] + q[0] * w, base[k][1] + q[1] * h];
  });
}
// Résolution d'une projection 2D générale (adjugate method) : renvoie la
// matrice 3x3 (ligne par ligne) envoyant les 4 points src sur les 4 points dst.
function adj3(m) {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}
function mul33(a, b) {
  const r = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
}
function mul3v(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
function basisToPoints(p1, p2, p3, p4) {
  const m = [p1[0], p2[0], p3[0], p1[1], p2[1], p3[1], 1, 1, 1];
  const v = mul3v(adj3(m), [p4[0], p4[1], 1]);
  return mul33(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}
function homography(srcPts, dstPts) { // 4 points chacun (ordre tl,tr,br,bl)
  const s = basisToPoints(srcPts[0], srcPts[1], srcPts[2], srcPts[3]);
  const d = basisToPoints(dstPts[0], dstPts[1], dstPts[2], dstPts[3]);
  const t = mul33(d, adj3(s));
  for (let i = 0; i < 9; i++) t[i] /= t[8];
  return t;
}
// Matrice CSS matrix3d envoyant le rect (0,0..w,h) sur les coins déformés.
function cssMatrix3d(el, w, h) {
  const t = homography([[0, 0], [w, 0], [w, h], [0, h]], quadCorners(el, w, h));
  const m = [t[0], t[3], 0, t[6], t[1], t[4], 0, t[7], 0, 0, 1, 0, t[2], t[5], 0, t[8]];
  return `matrix3d(${m.join(',')})`;
}
// Applique (ou retire) la déformation sur le contenu d'un nœud + place les pins.
// La taille de référence est TOUJOURS celle du nœud (le span du texte a une
// hauteur de boîte de ligne différente → les pins seraient décalés).
function applyQuadToNode(node, el) {
  const content = node.firstChild;
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  if (hasQuad(el) && w && h) {
    content.style.transformOrigin = '0 0';
    content.style.transform = cssMatrix3d(el, w, h);
  } else {
    content.style.transform = '';
  }
  // Pins aux coins (déformés) du contenu.
  const corners = quadCorners(el, w, h);
  node.querySelectorAll('.pin').forEach((pin, i) => {
    pin.style.left = `${corners[i][0]}px`;
    pin.style.top = `${corners[i][1]}px`;
  });
}

// ---- Édition inline du texte (double-clic) ------------------------------
function startInlineEdit(el, node) {
  if (el.type !== 'text') return;
  const span = node.querySelector('span');
  if (!span || el._editing) return;
  el._editing = true;
  try { span.contentEditable = 'plaintext-only'; } catch { span.contentEditable = 'true'; }
  node.classList.add('editing');
  span.focus();
  const range = document.createRange(); range.selectNodeContents(span);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const finish = (cancel) => {
    span.removeEventListener('blur', onBlur); span.removeEventListener('keydown', onKey);
    span.contentEditable = 'false';
    node.classList.remove('editing');
    el._editing = false;
    if (!cancel) { el.text = span.textContent || ' '; select(el.id); renderElements(); commit(); }
    else renderElements();
  };
  const onBlur = () => finish(false);
  const onKey = (ev) => {
    ev.stopPropagation();
    // Maj+Entrée : saut de ligne (comportement natif du contenteditable).
    // Entrée seule : on valide, comme avant.
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); span.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); span.textContent = el.text; finish(true); }
  };
  span.addEventListener('blur', onBlur);
  span.addEventListener('keydown', onKey);
}

// Cache de nœuds DOM par calque : indispensable pour les vidéos (recréer le
// <video> à chaque frame de drag le ferait redémarrer/clignoter).
const nodeCache = new Map(); // el.id -> node
function buildNode(el) {
  const node = document.createElement('div');
  node.dataset.id = el.id;
  node.className = 'el ' + el.type;
  if (el.type === 'text') {
    node.appendChild(document.createElement('span'));
    node.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const c = els.find((x) => x.id === el.id);
      if (c) startInlineEdit(c, node);
    });
  } else if (el.type === 'video' && el.kind !== 'gif') {
    const v = document.createElement('video');
    v.src = mediaFiles.get(el.id)?.url || '';
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    // La vignette de la scène boucle sur l'extrait gardé : la découpe se voit
    // sans avoir à ouvrir l'aperçu.
    v.addEventListener('timeupdate', () => {
      const c = els.find((x) => x.id === el.id);
      const cut = c && trimRange(c, v.duration || 0);
      if (cut && (v.currentTime >= cut.e || v.currentTime < cut.s - 0.05)) {
        try { v.currentTime = cut.s; } catch { /* ignore */ }
      }
    });
    node.appendChild(v);
    v.play?.().catch(() => {});
  } else { // image ou gif (un gif s'anime nativement dans <img>)
    const img = document.createElement('img');
    img.src = el.type === 'video' ? (mediaFiles.get(el.id)?.url || '') : el.src;
    node.appendChild(img);
  }
  const live = (fn) => (e) => { const c = els.find((x) => x.id === el.id); if (c) fn(e, c); };
  node.addEventListener('pointerdown', live((e, c) => { if (!c._editing) onDown(e, c, 'move'); }));
  // Corner pins : 4 coins. Drag = redimensionner ; mode Déformer (bouton
  // toolbar) OU Ctrl/Alt+drag = déformation perspective (corner pin).
  QUAD_KEYS.forEach((k) => {
    const pin = document.createElement('div');
    pin.className = `pin pin-${k}`;
    pin.title = 'Drag: resize · Ctrl+drag or Distort mode: corner pin';
    pin.addEventListener('pointerdown', live((e, c) => onDown(e, c, (distortMode || e.ctrlKey || e.altKey) ? 'distort' : 'resize', k)));
    node.appendChild(pin);
  });
  const hl = document.createElement('div'); hl.className = 'handle-line';
  const ht = document.createElement('div'); ht.className = 'handle-rot';
  ht.addEventListener('pointerdown', live((e, c) => onDown(e, c, 'rotate')));
  node.append(hl, ht);
  return node;
}
function renderElements() {
  const box = $('elements');
  const { W, H } = stagePx();
  // Normalise les z en 0..n-1 (évite la dérive des min-1/max+1 successifs).
  [...els].sort((a, b) => a.z - b.z).forEach((e, i) => { e.z = i; });
  const seen = new Set();
  for (const el of els) {
    seen.add(el.id);
    let node = nodeCache.get(el.id);
    if (!node) { node = buildNode(el); nodeCache.set(el.id, node); box.appendChild(node); }
    node.classList.toggle('selected', el.id === selId);
    node.classList.toggle('hidden', !!el.hidden);
    node.classList.toggle('outline', el.type === 'text' && !!el.outline);
    node.style.left = (el.xPct * W) + 'px';
    node.style.top = (el.yPct * H) + 'px';
    node.style.transform = `translate(-50%,-50%) rotate(${el.rot}deg)`;
    node.style.opacity = String(el.opacity);
    node.style.zIndex = String(1 + el.z);
    if (el.type === 'text') {
      node.style.fontSize = (el.fontFrac * W) + 'px';
      node.style.color = el.color;
      if (!el._editing) node.firstChild.textContent = el.text || ' ';
    } else {
      node.style.width = (el.wPct * W) + 'px';
    }
    applyQuadToNode(node, el);
  }
  for (const [id, node] of nodeCache) {
    if (!seen.has(id)) { node.remove(); nodeCache.delete(id); warpScratch.delete(id); }
  }
  renderLayers();
}

// ---- Panneau Calques (type Photoshop) ----------------------------------
// Réordonnancement UNIQUEMENT par glisser-déposer (plus de boutons ↑/↓).
let dragLayerId = null;
function reorderLayer(movedId, targetId) {
  if (movedId === targetId) return;
  const ordered = [...els].sort((a, b) => b.z - a.z).map((e) => e.id); // du dessus vers le dessous
  const from = ordered.indexOf(movedId), to = ordered.indexOf(targetId);
  if (from < 0 || to < 0) return;
  ordered.splice(from, 1);
  ordered.splice(to, 0, movedId);
  const n = ordered.length;
  ordered.forEach((id, i) => { const e = els.find((x) => x.id === id); if (e) e.z = n - 1 - i; });
  renderElements(); commit();
}
function renderLayers() {
  const list = $('layersList'); list.replaceChildren();
  if (!els.length) { list.innerHTML = '<div class="layers-empty">No layers. Add text, an emoji or an image.</div>'; return; }
  for (const el of [...els].sort((a, b) => b.z - a.z)) { // du dessus vers le dessous
    const row = document.createElement('div');
    row.className = 'layer' + (el.id === selId ? ' sel' : '');
    row.draggable = true;
    const icon = el.type === 'image' ? '🖼️'
      : el.type === 'video' ? (el.kind === 'gif' ? '🎞️' : '🎬')
        : (el.text || '').length <= 2 ? '😀' : 'T';
    const name = el.type === 'image' ? 'Image'
      : el.type === 'video' ? (el.name || (el.kind === 'gif' ? 'GIF' : 'Video'))
        : (el.text || 'Text');
    row.innerHTML = '<span class="lgrip" title="Drag to reorder">⋮⋮</span><span class="licon"></span><span class="lname"></span>';
    row.querySelector('.licon').textContent = icon;
    row.querySelector('.lname').textContent = name;
    row.onclick = () => { select(el.id); renderElements(); };
    row.addEventListener('dragstart', (e) => {
      dragLayerId = el.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', el.id); } catch { /* ignore */ }
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      dragLayerId = null;
      row.classList.remove('dragging');
      list.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (dragLayerId) reorderLayer(dragLayerId, el.id);
    });
    // Son du calque vidéo : conservé par défaut, coupé sur demande. Le réglage
    // suit la vidéo jusqu'à l'envoi (composition navigateur ET serveur).
    if (el.type === 'video' && el.kind !== 'gif') {
      const cut = document.createElement('button');
      cut.textContent = '✂';
      cut.title = el.trim ? `Cut: ${fmtT(el.trim.s)} → ${fmtT(el.trim.e)} — click to adjust` : 'Cut this video';
      if (el.trim) cut.style.color = 'var(--accent)';
      cut.onclick = (e) => { e.stopPropagation(); trimVideoLayer(el); };
      row.appendChild(cut);
      const snd = document.createElement('button');
      snd.textContent = el.muted ? '🔇' : '🔊';
      snd.title = el.muted ? 'Sound off — click to keep the video sound' : 'Sound on — click to mute this video';
      snd.onclick = (e) => { e.stopPropagation(); el.muted = !el.muted; renderElements(); commit(); };
      row.appendChild(snd);
    }
    const vis = document.createElement('button'); vis.textContent = el.hidden ? '🚫' : '👁'; vis.title = 'Show/hide';
    vis.onclick = (e) => { e.stopPropagation(); el.hidden = !el.hidden; renderElements(); commit(); };
    const del = document.createElement('button'); del.textContent = '🗑'; del.className = 'danger'; del.onclick = (e) => { e.stopPropagation(); els = els.filter((x) => x.id !== el.id); if (selId === el.id) { selId = null; $('elCard').classList.add('hidden'); } renderElements(); commit(); };
    row.append(vis, del);
    list.appendChild(row);
  }
}

function select(id) {
  selId = id;
  const el = cur();
  $('elCard').classList.toggle('hidden', !el);
  if (!el) return;
  $('elText').classList.toggle('hidden', el.type !== 'text');
  if (el.type === 'text') { $('elTextInput').value = el.text; $('elColor').value = el.color; $('elOutline').checked = el.outline; }
  $('elOpacity').value = Math.round(el.opacity * 100); $('elOpacityVal').textContent = Math.round(el.opacity * 100);
  $('elRot').value = Math.round(el.rot); $('elRotVal').textContent = Math.round(el.rot);
}
stage.addEventListener('pointerdown', (e) => { if (e.target === stage || e.target.id === 'stageBg' || e.target.id === 'elements') { selId = null; $('elCard').classList.add('hidden'); renderElements(); } });

// Drag / resize / rotate / distort (corner pin)
let drag = null;
function onDown(e, el, mode, corner) {
  if (drawMode) return;
  e.stopPropagation(); select(el.id); renderElements();
  const { W, H, left, top } = stagePx();
  const px = e.clientX - left, py = e.clientY - top;
  const cx = el.xPct * W, cy = el.yPct * H;
  if (mode === 'move') drag = { mode, el, offX: px - cx, offY: py - cy, W, H };
  else if (mode === 'resize') drag = { mode, el, cx, cy, startDist: Math.hypot(px - cx, py - cy) || 1, startVal: el.type === 'text' ? el.fontFrac : el.wPct };
  else if (mode === 'distort') {
    // Taille du contenu en px scène (repère local non tourné) — celle du nœud,
    // cohérente avec applyQuadToNode.
    const node = nodeCache.get(el.id);
    const w = node?.offsetWidth || 1;
    const h = node?.offsetHeight || 1;
    const q = (el.quad && el.quad[corner]) || [0, 0];
    drag = { mode, el, corner, sx: px, sy: py, w, h, q0: [q[0], q[1]], rot: (el.rot || 0) * Math.PI / 180 };
  } else drag = { mode, el, cx, cy, startRot: el.rot, startAng: Math.atan2(py - cy, px - cx) };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
// Points de magnétisme (fractions) : bords, tiers et centre (#20).
const SNAP_PTS = [0, 1 / 3, 0.5, 2 / 3, 1];
const SNAP_TOL = 0.012;
function snapAxis(v, showGuide) {
  for (const p of SNAP_PTS) { if (Math.abs(v - p) < SNAP_TOL) { showGuide(p); return p; } }
  return v;
}
function onMove(e) {
  if (!drag) return;
  const { W, H, left, top } = stagePx();
  const px = e.clientX - left, py = e.clientY - top; const el = drag.el;
  if (drag.mode === 'move') {
    let nx = clamp((px - drag.offX) / W, 0, 1);
    let ny = clamp((py - drag.offY) / H, 0, 1);
    let gx = null, gy = null;
    if (!e.shiftKey) { // Shift désactive le magnétisme.
      nx = snapAxis(nx, (p) => { gx = p; });
      ny = snapAxis(ny, (p) => { gy = p; });
    }
    el.xPct = nx; el.yPct = ny;
    showGuides(gx, gy, W, H);
  }
  else if (drag.mode === 'resize') {
    const f = (Math.hypot(px - drag.cx, py - drag.cy) || 1) / drag.startDist;
    if (el.type === 'text') el.fontFrac = clamp(drag.startVal * f, 0.02, 1);
    else el.wPct = clamp(drag.startVal * f, 0.03, 2);
  } else if (drag.mode === 'distort') {
    // Delta pointeur ramené dans le repère local (rotation inverse), puis
    // exprimé en fractions de la taille du contenu.
    const dx = px - drag.sx, dy = py - drag.sy;
    const cos = Math.cos(-drag.rot), sin = Math.sin(-drag.rot);
    const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
    if (!el.quad) el.quad = { tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] };
    el.quad[drag.corner] = [
      clamp(drag.q0[0] + lx / drag.w, -1.5, 1.5),
      clamp(drag.q0[1] + ly / drag.h, -1.5, 1.5),
    ];
  } else { el.rot = drag.startRot + (Math.atan2(py - drag.cy, px - drag.cx) - drag.startAng) * 180 / Math.PI; }
  select(el.id); renderElements();
}
function onUp() { const had = drag; drag = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); hideGuides(); if (had) commit(); }

// ---- Guides de magnétisme (lignes visuelles) ---------------------------
let guideV = null, guideH = null;
function ensureGuides() {
  if (!guideV) { guideV = document.createElement('div'); guideV.className = 'snap-guide v'; stage.appendChild(guideV); }
  if (!guideH) { guideH = document.createElement('div'); guideH.className = 'snap-guide h'; stage.appendChild(guideH); }
}
function showGuides(gx, gy, W, H) {
  ensureGuides();
  if (gx != null) { guideV.style.left = (gx * W) + 'px'; guideV.style.display = 'block'; } else guideV.style.display = 'none';
  if (gy != null) { guideH.style.top = (gy * H) + 'px'; guideH.style.display = 'block'; } else guideH.style.display = 'none';
}
function hideGuides() { if (guideV) guideV.style.display = 'none'; if (guideH) guideH.style.display = 'none'; }

// ---- Historique (undo / redo) ------------------------------------------
let history = []; let hIndex = -1;
function serializeEls() { return els.map((e) => { const c = { ...e }; delete c._img; delete c._editing; return c; }); }
// Un File n'est pas sérialisable : on ne garde que les métadonnées (+ dataUrl image)
// dans l'historique. Un fond vidéo/audio n'est donc pas restauré par undo/« dernier »
// (l'image et la couleur le sont) — l'utilisateur le re-choisit si besoin.
function serializableMedia(m) {
  if (!m) return null;
  return { name: m.name, kind: m.kind, mime: m.mime, dataUrl: m.dataUrl || null, trim: m.trim || null, durMs: m.durMs || 0 };
}
// Un File n'est pas sérialisable : d'un son fichier on ne garde que son nom
// (l'entrée reste visible mais devra être re-choisie après un rechargement).
function serializableSounds(list) {
  return (list || []).map((s) => (s.assetId
    ? { assetId: s.assetId, name: s.name, url: s.url || null, trim: s.trim || null, durMs: s.durMs || 0 }
    : { name: s.name, mime: s.mime, trim: s.trim || null, durMs: s.durMs || 0 }));
}
// La couleur de fond vit dans l'input (updateBg/bake la lisent là) : on la
// capture ici, sinon undo — et un meme rechargé depuis la bibliothèque —
// repartirait sur la couleur par défaut.
function snapshot() {
  return JSON.stringify({ els: serializeEls(), strokes, base: { mode: base.mode, color: $('bgColor').value, media: serializableMedia(base.media) }, sounds: serializableSounds(sounds), options, placeBox });
}
function pushHistory() {
  const snap = snapshot();
  if (history[hIndex] === snap) return;
  history = history.slice(0, hIndex + 1); history.push(snap); hIndex = history.length - 1;
  if (history.length > 80) { history.shift(); hIndex--; }
  updateUndoButtons();
}
// updateDurationUI : toute modification de la scène peut changer le média le
// plus long (ajout/suppression/masquage d'un média, découpe ✂) — la durée du
// meme le suit sans qu'on ait à y penser à chaque appel.
const commit = () => { pushHistory(); refreshStorageMaybe(); updateWeight(); updateDurationUI(); };
let _storageT = null;
function refreshStorageMaybe() { clearTimeout(_storageT); _storageT = setTimeout(refreshStorage, 500); }
function restore(snap) {
  const s = JSON.parse(snap);
  els = s.els.map((e) => ({ ...e }));
  // Les fichiers des calques vidéo vivent dans mediaFiles (hors historique) :
  // on ne restaure un calque vidéo que si son fichier est encore disponible.
  els = els.filter((e) => e.type !== 'video' || mediaFiles.has(e.id));
  els.filter((e) => e.type === 'image' && e.src).forEach((e) => { const im = new Image(); im.onload = () => renderElements(); im.src = e.src; e._img = im; });
  strokes = s.strokes || [];
  base.mode = s.base.mode; base.color = s.base.color; base.media = s.base.media; base.img = null;
  if (s.base.color) $('bgColor').value = s.base.color;
  if (base.media && base.media.kind === 'image' && base.media.dataUrl) { const im = new Image(); im.onload = () => updateBg(); im.src = base.media.dataUrl; base.img = im; }
  // `sound` (objet unique) : scènes enregistrées avant le multi-son.
  sounds = (s.sounds || (s.sound ? [s.sound] : [])).map((x) => ({ ...x }));
  placeBox = s.placeBox || { xPct: 0.25, yPct: 0.25, wPct: 0.5 };
  Object.assign(options, s.options || {});
  selId = null; $('elCard').classList.add('hidden');
  setBgMode(base.mode); renderElements(); renderStrokes(); renderMiniBox(); renderSounds();
  updateUndoButtons(); updateWeight(); updateDurationUI();
}
function undo() { if (hIndex > 0) { hIndex--; restore(history[hIndex]); } }
function redo() { if (hIndex < history.length - 1) { hIndex++; restore(history[hIndex]); } }
function updateUndoButtons() { $('tbUndo').disabled = hIndex <= 0; $('tbRedo').disabled = hIndex >= history.length - 1; }
$('tbUndo').onclick = undo; $('tbRedo').onclick = redo;

// ---- Copier / coller ---------------------------------------------------
let clipboard = null;
function copyEl() { const el = cur(); if (el) { clipboard = { ...el }; delete clipboard._img; } }
function pasteEl() {
  if (!clipboard) return;
  if (clipboard.type === 'video' && !mediaFiles.has(clipboard.id)) return; // fichier source disparu
  const e = { ...clipboard, id: rid(), xPct: clamp(clipboard.xPct + 0.04, 0, 1), yPct: clamp(clipboard.yPct + 0.04, 0, 1), z: (els.length ? Math.max(...els.map((x) => x.z)) : 0) + 1 };
  if (e.type === 'image' && e.src) { const im = new Image(); im.onload = () => renderElements(); im.src = e.src; e._img = im; }
  if (e.type === 'video') mediaFiles.set(e.id, mediaFiles.get(clipboard.id)); // même File partagé
  els.push(e); select(e.id); renderElements(); commit();
}

// ---- Raccourcis clavier ------------------------------------------------
window.addEventListener('keydown', (e) => {
  const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
    || document.activeElement.isContentEditable; // édition inline d'un texte
  if (document.activeElement.isContentEditable) return; // ne pas voler les touches pendant l'édition
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'y') || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (k === 'c' && !inField) { e.preventDefault(); copyEl(); }
    else if (k === 'v' && !inField) { e.preventDefault(); pasteEl(); }
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selId && !inField) { e.preventDefault(); $('elDelete').click(); }
});

// ---- Menu contextuel (clic droit) --------------------------------------
const ctxMenu = $('ctxMenu');
$('stage').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const node = e.target.closest('.el');
  const el = node ? els.find((x) => x.id === node.dataset.id) : null;
  showCtx(e.clientX, e.clientY, el);
});
// Popovers de la toolbar : Fond / Son / GIFs (un seul ouvert à la fois).
const TOOL_POPS = { tbBg: 'bgPop', tbSound: 'soundPop', tbGif: 'gifPop' };
function closeToolPops(except) {
  Object.values(TOOL_POPS).forEach((id) => { if (id !== except) $(id).classList.add('hidden'); });
}
Object.entries(TOOL_POPS).forEach(([btn, pop]) => {
  $(btn).onclick = () => {
    closeToolPops(pop);
    $(pop).classList.toggle('hidden');
    if (pop === 'soundPop' && !$(pop).classList.contains('hidden')) onSoundPopOpen();
  };
});
// Première ouverture du popover Son : charge les tendances (appel réseau
// sortant, donc jamais au démarrage de l'éditeur).
function onSoundPopOpen() { if (!sbTrendLoaded) loadTrending(); }

document.addEventListener('click', (e) => {
  ctxMenu.classList.add('hidden');
  // Ferme les popups si on clique en dehors de leur bouton et de leur contenu.
  if (!e.target.closest('#emojiPop') && e.target.id !== 'tbEmoji') $('emojiPop').classList.add('hidden');
  if (!e.target.closest('#templatePop') && e.target.id !== 'tbTemplate') $('templatePop').classList.add('hidden');
  for (const [btn, pop] of Object.entries(TOOL_POPS)) {
    if (!e.target.closest(`#${pop}`) && !e.target.closest(`#${btn}`)) $(pop).classList.add('hidden');
  }
});
document.addEventListener('scroll', () => ctxMenu.classList.add('hidden'), true);
function showCtx(x, y, el) {
  ctxMenu.replaceChildren();
  const item = (label, fn, danger) => { const b = document.createElement('button'); b.textContent = label; if (danger) b.className = 'danger'; b.onclick = () => { ctxMenu.classList.add('hidden'); fn(); }; ctxMenu.appendChild(b); };
  const hr = () => ctxMenu.appendChild(document.createElement('hr'));
  if (el) {
    select(el.id); renderElements();
    item('📋 Copy', () => copyEl());
    item('📄 Duplicate', () => { copyEl(); pasteEl(); });
    item(el.hidden ? '👁 Show' : '🚫 Hide', () => { el.hidden = !el.hidden; renderElements(); commit(); });
    if (el.type === 'text') item('✏️ Edit text', () => { const n = nodeCache.get(el.id); if (n) startInlineEdit(el, n); });
    if (hasQuad(el)) item('↩️ Reset distortion', () => { el.quad = null; renderElements(); commit(); });
    hr();
    item('🗑 Delete', () => { els = els.filter((x) => x.id !== el.id); selId = null; $('elCard').classList.add('hidden'); renderElements(); commit(); }, true);
  } else {
    item('＋ Text', () => addText('TEXT', false));
    item('😀 Emoji', () => $('emojiPop').classList.toggle('hidden'));
    if (clipboard) item('📋 Paste', () => pasteEl());
  }
  ctxMenu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 10) + 'px';
  ctxMenu.classList.remove('hidden');
}

// Panneau élément
$('elTextInput').oninput = (e) => { const el = cur(); if (el) { el.text = e.target.value; renderElements(); } };
$('elColor').oninput = (e) => { const el = cur(); if (el) { el.color = e.target.value; renderElements(); } };
$('elOutline').onchange = (e) => { const el = cur(); if (el) { el.outline = e.target.checked; renderElements(); } };
$('elOpacity').oninput = (e) => { const el = cur(); if (el) { el.opacity = +e.target.value / 100; $('elOpacityVal').textContent = e.target.value; renderElements(); } };
$('elRot').oninput = (e) => { const el = cur(); if (el) { el.rot = +e.target.value; $('elRotVal').textContent = e.target.value; renderElements(); } };
['elTextInput', 'elColor', 'elOpacity', 'elRot', 'elOutline'].forEach((id) => $(id).addEventListener('change', commit));
$('elDelete').onclick = () => { els = els.filter((x) => x.id !== selId); selId = null; $('elCard').classList.add('hidden'); renderElements(); commit(); };

// ---- Toolbar ------------------------------------------------------------
// Mode Déformer : quand actif, glisser un pin de coin déforme (corner pin)
// au lieu de redimensionner. Ctrl/Alt+glisser marche aussi sans le mode.
let distortMode = false;
$('tbDistort').onclick = () => {
  distortMode = !distortMode;
  $('tbDistort').classList.toggle('active', distortMode);
};
$('tbText').onclick = () => addText('TEXT', false);
$('tbImage').onclick = addMedia;
$('tbEmoji').onclick = () => $('emojiPop').classList.toggle('hidden');
function buildEmojiPop() {
  const p = $('emojiPop'); p.replaceChildren();
  EMOJIS.forEach((em) => { const b = document.createElement('button'); b.textContent = em; b.onclick = () => { addText(em, true); p.classList.add('hidden'); }; p.appendChild(b); });
}

// ---- Texte à une position donnée (utilisé par les modèles #12) ----------
function addTextAt(text, o = {}) {
  const el = { id: rid(), type: 'text', text, xPct: o.xPct ?? 0.5, yPct: o.yPct ?? 0.5, fontFrac: o.fontFrac ?? 0.09, rot: 0, opacity: 1, color: o.color ?? '#ffffff', outline: o.outline !== false, z: els.length };
  els.push(el);
  return el;
}

// ---- Modèles de meme (#12) ---------------------------------------------
const TEMPLATES = [
  { name: 'Impact top + bottom', icon: '🔠', apply: () => { addTextAt('TOP TEXT', { yPct: 0.12, fontFrac: 0.1 }); const b = addTextAt('BOTTOM TEXT', { yPct: 0.88, fontFrac: 0.1 }); return b; } },
  { name: 'Caption at the top', icon: '⬆️', apply: () => addTextAt('CAPTION', { yPct: 0.1, fontFrac: 0.09 }) },
  { name: 'Caption at the bottom', icon: '⬇️', apply: () => addTextAt('CAPTION', { yPct: 0.9, fontFrac: 0.09 }) },
  { name: 'Big centered text', icon: '🅰️', apply: () => addTextAt('WOW', { yPct: 0.5, fontFrac: 0.2 }) },
  { name: 'Top banner', icon: '📃', apply: () => { setBgMode('color'); $('bgColor').value = '#111114'; updateBg(); return addTextAt('WHEN YOU...', { yPct: 0.14, fontFrac: 0.085 }); } },
  { name: 'Color background + text', icon: '🎨', apply: () => { setBgMode('color'); $('bgColor').value = '#f5342a'; updateBg(); return addTextAt('MOOD', { yPct: 0.5, fontFrac: 0.16, outline: false }); } },
];
function buildTemplatePop() {
  const p = $('templatePop'); p.replaceChildren();
  TEMPLATES.forEach((t) => {
    const b = document.createElement('button'); b.className = 'tpl-item';
    b.innerHTML = `<span class="tpl-ic"></span><span class="tpl-nm"></span>`;
    b.querySelector('.tpl-ic').textContent = t.icon;
    b.querySelector('.tpl-nm').textContent = t.name;
    b.onclick = () => { const last = t.apply(); if (last) select(last.id); renderElements(); commit(); p.classList.add('hidden'); };
    p.appendChild(b);
  });
}
buildTemplatePop();
$('tbTemplate').onclick = () => $('templatePop').classList.toggle('hidden');

// ---- Tailles de police nommées (#46) -----------------------------------
$('elSizes').querySelectorAll('button').forEach((b) => {
  b.onclick = () => { const el = cur(); if (el && el.type === 'text') { el.fontFrac = clamp(+b.dataset.size, 0.02, 1); renderElements(); commit(); } };
});

// ---- Glisser-déposer un fichier sur la scène (#14) ----------------------
function fileKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return { kind: 'image', mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) };
  if (ext === 'gif') return { kind: 'gif', mime: 'image/gif' };
  if (['mp4', 'webm', 'mov'].includes(ext)) return { kind: 'video', mime: 'video/' + (ext === 'mov' ? 'quicktime' : ext) };
  if (['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) return { kind: 'audio', mime: 'audio/' + ext };
  return null;
}
function addImageFromDataUrl(dataUrl) {
  const img = new Image();
  img.onload = () => { const ratio = img.naturalWidth / img.naturalHeight || 1; const el = { id: rid(), type: 'image', src: dataUrl, _img: img, ratio, xPct: 0.5, yPct: 0.5, wPct: 0.4, rot: 0, opacity: 1, z: els.length }; els.push(el); select(el.id); renderElements(); commit(); };
  img.src = dataUrl;
}
async function addDroppedFile(file) {
  const info = fileKind(file.name);
  if (!info) { $('sendErr').textContent = 'Unsupported file type.'; return; }
  // Image / vidéo / gif → calque manipulable ; son → fond média (meme audio).
  if (info.kind === 'image') {
    const reader = new FileReader();
    reader.onload = () => addImageFromDataUrl(reader.result);
    reader.readAsDataURL(file);
  } else if (info.kind === 'video' || info.kind === 'gif') {
    addVideoLayer(file, info);
  } else {
    base.media = { file, name: file.name, mime: info.mime, kind: info.kind };
    base.img = null; setBgMode('media');
    $('bgMediaName').textContent = `${file.name} (${info.kind})`;
    updateBg(); commit();
  }
}

// ---- Calque vidéo / GIF (déplaçable, redimensionnable, rotatif) ---------
function addVideoLayer(file, info) {
  if (features.video === false) { $('sendErr').textContent = 'Videos/GIFs are disabled on this channel.'; return; }
  const url = URL.createObjectURL(file);
  const el = {
    id: rid(), type: 'video', kind: info.kind, name: file.name, ratio: 16 / 9,
    // Le son de la vidéo importée est CONSERVÉ par défaut (bouton 🔊/🔇 dans la
    // liste des calques). Un GIF n'a jamais de piste audio.
    muted: false,
    xPct: 0.5, yPct: 0.5, wPct: 0.5, rot: 0, opacity: 1,
    z: els.length ? Math.max(...els.map((x) => x.z)) + 1 : 0,
  };
  mediaFiles.set(el.id, { file, url });
  if (info.kind === 'gif') {
    const im = new Image();
    im.onload = () => { el.ratio = (im.naturalWidth / im.naturalHeight) || 1; renderElements(); };
    im.src = url;
  } else {
    const v = document.createElement('video');
    v.onloadedmetadata = () => {
      el.ratio = (v.videoWidth / v.videoHeight) || 16 / 9;
      el.durMs = Math.round((v.duration || 0) * 1000);
      updateDurationUI(); // le meme dure au moins aussi longtemps que ce calque
      renderElements();
    };
    v.src = url;
  }
  els.push(el); select(el.id); renderElements(); commit();
}
['dragover', 'dragenter'].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add('drop-hover'); }));
['dragleave', 'drop'].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.target !== stage) return; stage.classList.remove('drop-hover'); }));
stage.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) addDroppedFile(f); });

// ---- Coller une image du presse-papiers (#15) --------------------------
window.addEventListener('paste', (e) => {
  const inField = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (inField) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    const f = item.getAsFile();
    if (f) { const r = new FileReader(); r.onload = () => addImageFromDataUrl(r.result); r.readAsDataURL(f); e.preventDefault(); }
    return;
  }
  // Coller un LIEN d'image/GIF/vidéo : importé via le serveur (anti-SSRF) puis posé sur la scène.
  const text = (e.clipboardData?.getData('text') || '').trim();
  if (/^https:\/\/\S+$/i.test(text)) { importMediaUrl(text, null); e.preventDefault(); }
});

// ---- Reprendre le dernier meme (#40) -----------------------------------
const LAST_KEY = 'md_editor_last';
function saveLast() { try { localStorage.setItem(LAST_KEY, snapshot()); showLastBtn(); } catch { /* ignore */ } }
function showLastBtn() { try { if (localStorage.getItem(LAST_KEY)) $('tbLast').classList.remove('hidden'); } catch { /* ignore */ } }
$('tbLast').onclick = () => { try { const snap = localStorage.getItem(LAST_KEY); if (snap) { restore(snap); pushHistory(); } } catch { /* ignore */ } };
showLastBtn();

// Dessin (crayon + gomme)
let drawTool = 'pen';
$('tbDraw').onclick = () => {
  drawMode = !drawMode;
  $('tbDraw').classList.toggle('active', drawMode);
  $('drawTools').classList.toggle('hidden', !drawMode);
  drawCanvas.style.pointerEvents = drawMode ? 'auto' : 'none';
  $('elements').style.pointerEvents = drawMode ? 'none' : 'auto';
};
function setTool(t) { drawTool = t; $('drawPen').classList.toggle('active', t === 'pen'); $('drawEraser').classList.toggle('active', t === 'eraser'); }
$('drawPen').onclick = () => setTool('pen');
$('drawEraser').onclick = () => setTool('eraser');
setTool('pen');
$('drawClear').onclick = () => { strokes = []; renderStrokes(); commit(); };
let stroke = null;
drawCanvas.addEventListener('pointerdown', (e) => {
  if (!drawMode) return;
  const { W, H, left, top } = stagePx();
  stroke = { color: $('drawColor').value, sizeFrac: (+$('drawSize').value) / W, erase: drawTool === 'eraser', points: [{ x: (e.clientX - left) / W, y: (e.clientY - top) / H }] };
  strokes.push(stroke); drawCanvas.setPointerCapture(e.pointerId);
});
drawCanvas.addEventListener('pointermove', (e) => {
  if (!stroke) return;
  const { W, H, left, top } = stagePx();
  stroke.points.push({ x: (e.clientX - left) / W, y: (e.clientY - top) / H }); renderStrokes();
});
drawCanvas.addEventListener('pointerup', () => { if (stroke) { stroke = null; commit(); } });

function resizeDrawCanvas() { const { W, H } = stagePx(); drawCanvas.width = W; drawCanvas.height = H; renderStrokes(); }
function renderStrokes(ctx = dctx, W = drawCanvas.width, H = drawCanvas.height) {
  // N'effacer QUE le canvas de dessin live (redessin pendant le trait).
  // Depuis bake(), ctx est le canvas de COMPOSITION : un clearRect y détruirait
  // tout ce qui vient d'être composé (texte/images/fond) → memes envoyés vides.
  if (ctx === dctx) ctx.clearRect(0, 0, W, H);
  for (const s of strokes) {
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(1, s.sizeFrac * W); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    s.points.forEach((p, i) => { const x = p.x * W, y = p.y * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ---- Fond ---------------------------------------------------------------
document.querySelectorAll('#bgMode button').forEach((b) => b.onclick = () => { setBgMode(b.dataset.bg); commit(); });
function setBgMode(mode) {
  base.mode = mode;
  document.querySelectorAll('#bgMode button').forEach((b) => b.classList.toggle('active', b.dataset.bg === mode));
  $('bgColorWrap').classList.toggle('hidden', mode !== 'color');
  $('bgMediaWrap').classList.toggle('hidden', mode !== 'media');
  updateBg();
}
$('bgColor').oninput = () => updateBg();
$('bgColor').onchange = () => commit();
$('bgPick').onclick = async () => {
  const f = await api.pickFile(); if (!f) return;
  const ext = f.name.split('.').pop().toLowerCase();
  const kind = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image' : ext === 'gif' ? 'gif' : ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : 'audio';
  const mimes = { image: 'image/' + (ext === 'jpg' ? 'jpeg' : ext), gif: 'image/gif', video: 'video/' + (ext === 'mov' ? 'quicktime' : ext), audio: 'audio/' + ext };
  base.media = { file: f, name: f.name, mime: mimes[kind], kind };
  base.img = null;
  if (kind === 'image') { try { const d = await api.fileDataUrl(f); base.media.dataUrl = d; const im = new Image(); im.onload = () => { base.img = im; updateBg(); }; im.src = d; } catch { /* ignore */ } }
  $('bgMediaName').textContent = `${f.name} (${kind})`;
  updateBg(); commit();
};
function updateBg() {
  updateBgTrimBtn();
  const bg = $('stageBg'), v = $('stageVideo'), im = $('stageImg');
  bg.style.background = ''; v.classList.add('hidden'); im.classList.add('hidden'); v.src = ''; im.src = '';
  if (base.mode === 'color') bg.style.background = $('bgColor').value;
  else if (base.mode === 'media' && base.media) {
    const url = base.media.dataUrl || (base.media.file ? URL.createObjectURL(base.media.file) : '');
    if (!url) return;
    if (base.media.kind === 'video') {
      v.src = url; v.classList.remove('hidden');
      // Durée du fond vidéo → impose la durée du meme (updateDurationUI).
      v.onloadedmetadata = () => { if (base.media) { base.media.durMs = Math.round((v.duration || 0) * 1000); updateDurationUI(); } };
      v.play?.().catch(() => {});
    }
    else if (base.media.kind === 'audio') {
      bg.style.background = 'linear-gradient(135deg,#1c1c22,#141418)';
      // Durée du fond sonore → elle aussi impose la durée du meme.
      if (!(base.media.durMs > 0)) {
        const m = base.media;
        const a = new Audio(); a.preload = 'metadata';
        a.onloadedmetadata = () => { if (a.duration > 0 && base.media === m) { m.durMs = Math.round(a.duration * 1000); updateDurationUI(); } };
        a.src = url;
      }
    }
    else { im.src = url; im.classList.remove('hidden'); }
  }
}

// ---- Sons attachés au meme ---------------------------------------------
// Plusieurs sons peuvent être empilés (fichiers et/ou sons de la
// bibliothèque) ; ils sont joués ensemble à l'apparition du meme et listés
// dans le panneau de droite, sous les calques.
function addSound(s) {
  if (sounds.length >= MAX_SOUNDS) {
    $('sendErr').textContent = `${MAX_SOUNDS} sounds max per meme.`;
    return false;
  }
  if (s.assetId && sounds.some((x) => x.assetId === s.assetId)) return false; // déjà attaché
  sounds.push(s);
  probeSoundDuration(s);
  renderSounds(); commit();
  return true;
}
function removeSound(i) {
  const [gone] = sounds.splice(i, 1);
  if (gone && gone._url) { try { URL.revokeObjectURL(gone._url); } catch { /* ignore */ } }
  sndStop();
  renderSounds(); commit();
}
// Durée d'un son : lue dans les métadonnées, puis mémorisée sur l'objet. Elle
// entre dans le calcul de la durée du meme (le son ne doit pas être coupé par
// un meme plus court que lui) et borne sa timeline de découpe.
function probeSoundDuration(s) {
  if (s.durMs > 0) return;
  const src = soundSrc(s);
  if (!src) return;
  const a = new Audio();
  a.preload = 'metadata';
  a.onloadedmetadata = () => {
    if (!(a.duration > 0) || !sounds.includes(s)) return;
    s.durMs = Math.round(a.duration * 1000);
    updateDurationUI();
  };
  a.src = src;
}

// Source lisible d'un son : fichier local (objet URL mis en cache) ou URL signée.
function soundSrc(s) {
  if (s.file) { if (!s._url) s._url = URL.createObjectURL(s.file); return s._url; }
  return s.url || null;
}

// ---- Lecteur d'écoute UNIQUE (sons attachés, soundboard, bibliothèque) ----
// Un seul son est testé à la fois, quel que soit l'endroit d'où on le lance.
// Recliquer sur le bouton du son en cours le met en PAUSE (puis le reprend là
// où il s'est arrêté) au lieu de le relancer depuis le début.
let sndPlayer = null; // { audio, key, btn, node }
function sndIcon() {
  if (sndPlayer?.btn) sndPlayer.btn.textContent = sndPlayer.audio.paused ? '▶' : '⏸';
}
function sndStop() {
  if (sndPlayer) {
    try { sndPlayer.audio.pause(); } catch { /* ignore */ }
    if (sndPlayer.btn) sndPlayer.btn.textContent = '▶';
    sndPlayer = null;
  }
  document.querySelectorAll('.playing').forEach((n) => n.classList.remove('playing'));
}
// `key` identifie le son (objet du son attaché, URL myinstants, id d'asset) :
// c'est lui qui distingue « remettre en pause » de « jouer un autre son ».
function sndToggle(key, src, { node = null, btn = null } = {}) {
  if (sndPlayer && sndPlayer.key === key) {
    const { audio } = sndPlayer;
    // Le bouton peut venir d'un rendu plus récent que celui qui a lancé le son.
    sndPlayer.btn = btn || sndPlayer.btn; sndPlayer.node = node || sndPlayer.node;
    if (audio.paused) { audio.volume = siteVolume; audio.play().catch(() => {}); sndPlayer.node?.classList.add('playing'); }
    else { audio.pause(); sndPlayer.node?.classList.remove('playing'); }
    sndIcon();
    return;
  }
  sndStop();
  const audio = new Audio(src);
  audio.volume = siteVolume;
  sndPlayer = { audio, key, btn, node };
  node?.classList.add('playing');
  audio.onended = () => sndStop();
  audio.play().catch(() => {});
  sndIcon();
}
function sndPlay(s, row, btn) {
  const src = soundSrc(s);
  if (!src) { $('sendErr').textContent = 'This sound must be picked again (file not kept).'; return; }
  sndToggle(s, src, { node: row, btn });
}

function renderSounds() {
  const box = $('soundsList'); box.replaceChildren();
  $('soundsBadge').textContent = String(sounds.length);
  $('soundName').textContent = sounds.length
    ? `${sounds.length} sound${sounds.length > 1 ? 's' : ''} attached`
    : 'No sound';
  if (!sounds.length) {
    const empty = document.createElement('div');
    empty.className = 'sounds-empty';
    empty.textContent = 'No sound. Add a file or pick one from the soundboard.';
    box.appendChild(empty);
    return;
  }
  sounds.forEach((s, i) => {
    const row = document.createElement('div'); row.className = 'sound-row';
    const name = document.createElement('span');
    name.className = 'sname'; name.textContent = s.name || 'Sound'; name.title = s.name || 'Sound';
    const tag = document.createElement('span');
    tag.className = 'stag'; tag.textContent = s.assetId ? 'library' : (s.file ? 'file' : 'missing');
    const play = document.createElement('button');
    play.textContent = '▶'; play.title = 'Preview (click again to pause)';
    play.onclick = () => sndPlay(s, row, play);
    // Le son en cours survit au re-rendu de la liste : on lui rebranche sa ligne.
    if (sndPlayer && sndPlayer.key === s) {
      sndPlayer.btn = play; sndPlayer.node = row;
      if (!sndPlayer.audio.paused) row.classList.add('playing');
      sndIcon();
    }
    const cut = document.createElement('button');
    cut.textContent = '✂';
    cut.title = s.trim ? `Cut: ${fmtT(s.trim.s)} → ${fmtT(s.trim.e)} — click to adjust` : 'Cut this sound';
    if (s.trim) cut.style.color = 'var(--accent)';
    cut.onclick = () => trimSound(s);
    const del = document.createElement('button');
    del.textContent = '🗑'; del.title = 'Remove this sound';
    del.onclick = () => removeSound(i);
    row.append(name, tag, play, cut, del);
    box.appendChild(row);
  });
}

async function pickSoundFile() {
  const f = await api.pickFile(); if (!f) return;
  const ext = f.name.split('.').pop().toLowerCase();
  addSound({ file: f, name: f.name, mime: 'audio/' + ext });
}
$('soundPick').onclick = pickSoundFile;
$('soundsAdd').onclick = pickSoundFile;
// Raccourci vers le popover Son (recherche myinstants + bibliothèque + partagés).
// stopPropagation : sans lui, le listener global « clic en dehors » refermerait
// le popover dans la foulée (ce bouton n'est ni #tbSound ni dans #soundPop).
$('soundsBrowse').onclick = (e) => {
  e.stopPropagation();
  closeToolPops('soundPop');
  $('soundPop').classList.remove('hidden');
  onSoundPopOpen();
};
renderSounds();

// ============================================================
//  Découpe (timeline basique) — ✂ sur un calque vidéo, sur le fond média
//  ou sur un son attaché.
//
//  NON destructive : seul l'intervalle gardé `{ s, e }` (secondes) est mémorisé
//  sur l'objet (calque, fond, son) ; le fichier d'origine n'est jamais retouché,
//  on peut donc rouvrir la découpe et l'élargir. L'intervalle est appliqué à
//  l'ENVOI, différemment selon le média :
//   - vidéo → `comp.layers[].trim`, coupé par ffmpeg (chemin serveur) ou joué
//     de `s` à `e` par l'encodage navigateur ;
//   - son  → découpé ici en WebAudio et envoyé comme un fichier WAV ordinaire,
//     qui repasse donc par processMedia comme n'importe quel upload.
// ============================================================
const MIN_TRIM_S = 0.1;
function fmtT(v) {
  const t = Math.max(0, v || 0);
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;
}
// Intervalle réellement gardé, borné à la durée connue du média.
// null → rien à couper (pas de découpe, ou découpe couvrant tout le média).
function trimRange(o, dur) {
  const t = o && o.trim;
  if (!t || !(dur > 0)) return t ? { s: Math.max(0, +t.s || 0), e: Math.max(MIN_TRIM_S, +t.e || 0) } : null;
  const s = clamp(+t.s || 0, 0, Math.max(0, dur - MIN_TRIM_S));
  const e = clamp(+t.e || dur, s + MIN_TRIM_S, dur);
  if (s <= 0.001 && e >= dur - 0.001) return null;
  return { s, e };
}
// Badge « ✂ 0:01.2 → 0:03.4 » des listes (calques, sons).
function trimLabel(o) {
  return o && o.trim ? `✂ ${fmtT(o.trim.s)} → ${fmtT(o.trim.e)}` : '';
}

let trimJob = null; // { media, kind, dur, s, e, onApply, raf, objUrl }
function trimStopMedia() {
  if (!trimJob) return;
  cancelAnimationFrame(trimJob.raf); trimJob.raf = 0;
  try { trimJob.media.pause(); } catch { /* ignore */ }
}
function trimClose() {
  if (!trimJob) return;
  trimStopMedia();
  if (trimJob.objUrl) { try { URL.revokeObjectURL(trimJob.objUrl); } catch { /* ignore */ } }
  $('trimStage').replaceChildren();
  $('trimModal').classList.add('hidden');
  trimJob = null;
}
function trimPaint() {
  if (!trimJob) return;
  const { dur, s, e } = trimJob;
  const pct = (t) => `${clamp(t / (dur || 1), 0, 1) * 100}%`;
  $('trimSel').style.left = pct(s);
  $('trimSel').style.width = `${clamp((e - s) / (dur || 1), 0, 1) * 100}%`;
  $('trimHStart').style.left = pct(s);
  $('trimHEnd').style.left = pct(e);
  $('trimStartVal').textContent = fmtT(s);
  $('trimEndVal').textContent = fmtT(e);
  $('trimKeptVal').textContent = fmtT(e - s);
  const cur = $('trimCursor');
  const t = trimJob.media.currentTime || 0;
  cur.classList.toggle('hidden', !(t > 0));
  cur.style.left = pct(t);
}
// Ouvre la timeline. `src` peut être un File/Blob ou une URL ; `durHint` sert
// tant que les métadonnées ne sont pas chargées (la durée réelle prime).
function openTrimModal({ name, kind, src, durHint, trim, onApply }) {
  trimClose();
  sndStop(); // une écoute en cours parlerait par-dessus la découpe
  $('trimErr').textContent = '';
  $('trimName').textContent = name || (kind === 'video' ? 'Video' : 'Sound');
  const stage = $('trimStage'); stage.replaceChildren();

  let objUrl = null;
  const url = (typeof src === 'string') ? src : (objUrl = URL.createObjectURL(src));
  let media;
  if (kind === 'video') {
    media = document.createElement('video');
    media.src = url; media.playsInline = true; media.preload = 'metadata';
    media.volume = siteVolume;
    stage.appendChild(media);
  } else {
    const ic = document.createElement('div'); ic.className = 'trim-audio-ic'; ic.textContent = '🎵';
    stage.appendChild(ic);
    media = new Audio(url); media.preload = 'metadata'; media.volume = siteVolume;
  }

  const dur = Math.max(MIN_TRIM_S, (durHint || 0) / 1000 || MIN_TRIM_S);
  trimJob = { media, kind, dur, s: 0, e: dur, onApply, raf: 0, objUrl };
  if (trim) { trimJob.s = Math.max(0, +trim.s || 0); trimJob.e = Math.max(trimJob.s + MIN_TRIM_S, +trim.e || dur); }
  // La durée annoncée par le média fait foi (un calque peut n'avoir aucune
  // durée connue si ses métadonnées n'étaient pas encore chargées).
  media.onloadedmetadata = () => {
    if (!trimJob || !(media.duration > 0)) return;
    trimJob.dur = media.duration;
    if (!trim) trimJob.e = media.duration;
    trimJob.e = Math.min(trimJob.e, media.duration);
    trimJob.s = Math.min(trimJob.s, Math.max(0, trimJob.e - MIN_TRIM_S));
    media.currentTime = trimJob.s;
    trimPaint();
  };
  media.onerror = () => { $('trimErr').textContent = 'This media cannot be read here — pick it again.'; };
  $('trimModal').classList.remove('hidden');
  trimPaint();
}

// Glisser des poignées / clic sur la piste.
(function initTrimTrack() {
  const track = $('trimTrack');
  const timeAt = (clientX) => {
    const r = track.getBoundingClientRect();
    return clamp((clientX - r.left) / (r.width || 1), 0, 1) * (trimJob?.dur || 1);
  };
  const grab = (which) => (e) => {
    if (!trimJob) return;
    e.preventDefault(); e.stopPropagation();
    const move = (ev) => {
      const t = timeAt(ev.clientX);
      if (which === 's') trimJob.s = Math.min(t, trimJob.e - MIN_TRIM_S);
      else trimJob.e = Math.max(t, trimJob.s + MIN_TRIM_S);
      trimJob.s = clamp(trimJob.s, 0, trimJob.dur); trimJob.e = clamp(trimJob.e, 0, trimJob.dur);
      trimPaint();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  $('trimHStart').addEventListener('pointerdown', grab('s'));
  $('trimHEnd').addEventListener('pointerdown', grab('e'));
  // Clic sur la piste (hors poignées) : déplace la tête de lecture.
  track.addEventListener('pointerdown', (e) => {
    if (!trimJob || e.target.classList.contains('trim-h')) return;
    try { trimJob.media.currentTime = timeAt(e.clientX); } catch { /* ignore */ }
    trimPaint();
  });
})();

// Lecture de l'extrait gardé : s'arrête net à la poignée de fin.
$('trimPlay').onclick = () => {
  if (!trimJob) return;
  const { media } = trimJob;
  if (!media.paused) { trimStopMedia(); $('trimPlay').textContent = '▶ Play'; return; }
  try { media.currentTime = trimJob.s; } catch { /* ignore */ }
  media.volume = siteVolume;
  media.play().catch(() => {});
  $('trimPlay').textContent = '⏸ Pause';
  const tick = () => {
    if (!trimJob) return;
    if (trimJob.media.currentTime >= trimJob.e) { trimStopMedia(); $('trimPlay').textContent = '▶ Play'; trimPaint(); return; }
    trimPaint();
    trimJob.raf = requestAnimationFrame(tick);
  };
  trimJob.raf = requestAnimationFrame(tick);
};
$('trimReset').onclick = () => { if (trimJob) { trimJob.s = 0; trimJob.e = trimJob.dur; trimPaint(); } };
$('trimCancel').onclick = () => trimClose();
$('trimOk').onclick = () => {
  if (!trimJob) return;
  const { s, e, dur, onApply } = trimJob;
  // Intervalle couvrant tout le média → on retire la découpe plutôt que d'en
  // mémoriser une qui ne coupe rien (et ferait travailler ffmpeg pour rien).
  const whole = s <= 0.001 && e >= dur - 0.001;
  trimClose();
  onApply(whole ? null : { s: +s.toFixed(3), e: +e.toFixed(3) });
};

// ---- Découpe d'un son : WebAudio → WAV ----------------------------------
// Le WAV part comme un fichier ordinaire : le serveur le re-transcode (et le
// normalise) comme tout upload, la garantie anti-injection est intacte.
function encodeWav(chans, rate, len) {
  const nch = chans.length;
  const buf = new ArrayBuffer(44 + len * nch * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + len * nch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nch, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * nch * 2, true);
  view.setUint16(32, nch * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, len * nch * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const v = clamp(chans[c][i] || 0, -1, 1);
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
async function cutAudioToFile(source, trim, name) {
  const raw = (source instanceof Blob) ? await source.arrayBuffer() : await (await fetch(source)).arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('WebAudio unavailable');
  const actx = new AC();
  try {
    const buf = await actx.decodeAudioData(raw);
    const s = clamp(trim.s, 0, Math.max(0, buf.duration - MIN_TRIM_S));
    const e = clamp(trim.e, s + MIN_TRIM_S, buf.duration);
    const from = Math.floor(s * buf.sampleRate);
    const to = Math.min(buf.length, Math.ceil(e * buf.sampleRate));
    const len = Math.max(1, to - from);
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c).subarray(from, to));
    const base = (name || 'sound').replace(/\.[^.]+$/, '').slice(0, 60);
    return new File([encodeWav(chans, buf.sampleRate, len)], `${base}-cut.wav`, { type: 'audio/wav' });
  } finally { try { actx.close(); } catch { /* ignore */ } }
}

// Points d'entrée de la découpe (listes de calques et de sons, fond média).
function trimVideoLayer(el) {
  const mf = mediaFiles.get(el.id);
  if (!mf) { $('sendErr').textContent = 'This video must be picked again.'; return; }
  openTrimModal({
    name: el.name || 'Video', kind: 'video', src: mf.file, durHint: el.durMs, trim: el.trim,
    onApply: (t) => { if (t) el.trim = t; else delete el.trim; renderElements(); commit(); },
  });
}
function trimSound(s) {
  const src = soundSrc(s);
  if (!src) { $('sendErr').textContent = 'This sound must be picked again (file not kept).'; return; }
  openTrimModal({
    name: s.name || 'Sound', kind: 'audio', src: s.file || src, durHint: s.durMs, trim: s.trim,
    onApply: (t) => { if (t) s.trim = t; else delete s.trim; renderSounds(); commit(); },
  });
}
$('bgTrim').onclick = () => {
  const m = base.media;
  if (!m || !m.file || !['video', 'audio'].includes(m.kind)) return;
  openTrimModal({
    name: m.name || 'Background', kind: m.kind === 'video' ? 'video' : 'audio', src: m.file,
    durHint: m.durMs, trim: m.trim,
    onApply: (t) => { if (t) m.trim = t; else delete m.trim; updateBgTrimBtn(); updateBg(); commit(); },
  });
};
// Le bouton ✂ du fond n'a de sens que sur une vidéo ou un son encore présents.
function updateBgTrimBtn() {
  const m = base.media;
  const on = !!(m && m.file && ['video', 'audio'].includes(m.kind));
  $('bgTrim').classList.toggle('hidden', !on);
  if (on) $('bgTrim').textContent = m.trim ? `✂ ${fmtT(m.trim.s)} → ${fmtT(m.trim.e)}` : '✂ Cut';
}

// ---- Volume d'écoute LOCAL du site (coin bas droit) ---------------------
// Master volume appliqué à tout ce qui est joué DANS l'éditeur (aperçus,
// soundboard). N'affecte jamais le volume envoyé aux destinataires.
let siteVolume = clamp(parseInt(localStorage.getItem('md_site_volume') ?? '70', 10), 0, 100) / 100;
function localVol(v) { return clamp((v ?? 0.7) * siteVolume, 0, 1); }
function updateSiteVolIcon() {
  const b = $('siteVolIcon');
  if (b) b.textContent = siteVolume === 0 ? '🔇' : siteVolume < 0.5 ? '🔉' : '🔊';
}
(function initSiteVolume() {
  const slider = $('siteVol'); if (!slider) return;
  slider.value = Math.round(siteVolume * 100);
  updateSiteVolIcon();
  slider.oninput = () => {
    siteVolume = clamp(+slider.value, 0, 100) / 100;
    localStorage.setItem('md_site_volume', String(Math.round(siteVolume * 100)));
    updateSiteVolIcon();
    // Applique en direct à ce qui joue déjà.
    if (sndPlayer) sndPlayer.audio.volume = siteVolume;
    document.querySelectorAll('#previewScreen video, #previewScreen audio').forEach((m) => { m.volume = localVol(m._baseVol); });
    for (const a of pvAudios) a.volume = localVol(a._baseVol);
  };
  let lastNonZero = siteVolume || 0.7;
  $('siteVolIcon').onclick = () => {
    if (siteVolume > 0) { lastNonZero = siteVolume; siteVolume = 0; }
    else siteVolume = lastNonZero;
    slider.value = Math.round(siteVolume * 100);
    slider.oninput();
  };
})();

// ---- GIFs Giphy + import d'un média par URL ------------------------------
async function importMediaUrl(url, filename) {
  $('sendErr').textContent = '';
  $('gifMsg').textContent = 'Importing…';
  try {
    const blob = await api.mediaFromUrl(url);
    const extMap = { 'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };
    const ext = extMap[blob.type] || 'png';
    const file = new File([blob], filename || `pasted.${ext}`, { type: blob.type });
    addDroppedFile(file);
    $('gifMsg').textContent = '';
    closeToolPops();
  } catch (e) {
    $('gifMsg').textContent = e.message;
    $('sendErr').textContent = e.message;
  }
}

$('gifSearch').onclick = doGifSearch;
$('gifQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') doGifSearch(); });
async function doGifSearch() {
  const q = $('gifQuery').value.trim();
  const box = $('gifResults'); box.replaceChildren();
  if (!q) return;
  $('gifMsg').textContent = 'Searching…';
  const res = await api.searchGifs(q);
  if (res?.error) { $('gifMsg').textContent = res.error; return; }
  if (res?.enabled === false) { $('gifMsg').textContent = 'GIF search is not configured on this server (set GIPHY_API_KEY).'; return; }
  const list = res?.results || [];
  $('gifMsg').textContent = list.length ? '' : 'No results.';
  for (const g of list) {
    const img = document.createElement('img');
    img.src = g.preview; img.title = g.title; img.loading = 'lazy';
    img.onclick = () => importMediaUrl(g.url, `${(g.title || 'giphy').replace(/[^\w-]+/g, '_').slice(0, 40)}.gif`);
    box.appendChild(img);
  }
}

// ---- Soundboard myinstants (#13) ---------------------------------------
// Écoute d'un son déjà accessible par URL (bibliothèque, soundboard partagé) :
// même lecteur unique que les sons attachés, donc même pause au reclic.
function sbPlay(src, node, btn) { sndToggle(src, src, { node, btn }); }
// Écoute d'un son myinstants : le mp3 passe par le proxy serveur (CSP). Le
// téléchargement n'a lieu qu'au premier démarrage — reprendre après une pause
// ne redemande rien au serveur.
async function sbRemotePlay(url, node, btn) {
  if (sndPlayer && sndPlayer.key === url) { sndToggle(url, null, { node, btn }); return; }
  const d = await api.previewSound(url);
  if (d && d.error) { $('sbMsg').textContent = d.error; return; }
  sndToggle(url, d, { node, btn });
}
function useLibrarySound(asset) {
  // url : sert à l'aperçu local ; le serveur, lui, retrouve le son par son id.
  const added = addSound({ assetId: asset.id, name: asset.name, url: asset.url || null });
  $('sbMsg').textContent = added
    ? `Sound « ${asset.name} » attached (${sounds.length}/${MAX_SOUNDS}).`
    : `« ${asset.name} » is already attached (or ${MAX_SOUNDS} sounds max).`;
}

$('sbSearch').onclick = doSbSearch;
$('sbQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSbSearch(); });

// Ligne « son myinstants » (écoute + import), partagée par la recherche et par
// la liste des tendances.
function sbResultItem(r) {
  const item = document.createElement('div'); item.className = 'sb-item';
  const name = document.createElement('span'); name.className = 'sb-name'; name.textContent = r.title; name.title = r.title;
  const play = document.createElement('button'); play.className = 'btn btn-ghost'; play.textContent = '▶';
  play.title = 'Listen (click again to pause)';
  play.onclick = () => sbRemotePlay(r.url, item, play);
  const imp = document.createElement('button'); imp.className = 'btn btn-ghost'; imp.textContent = 'Import';
  imp.onclick = async () => { imp.disabled = true; imp.textContent = '…'; try { await api.importSound(r.url, r.title); $('sbMsg').textContent = `« ${r.title} » added to your library.`; refreshStorage(); loadLibrary(); } catch (e) { $('sbMsg').textContent = e.message; } finally { imp.disabled = false; imp.textContent = 'Import'; } };
  item.append(name, play, imp);
  return item;
}

async function doSbSearch() {
  const q = $('sbQuery').value.trim();
  const box = $('sbResults'); box.replaceChildren();
  if (!q) return;
  $('sbMsg').textContent = 'Searching…';
  const res = await api.searchSounds(q);
  if (res && res.error) { $('sbMsg').textContent = res.error; return; }
  $('sbMsg').textContent = res.length ? '' : 'No results.';
  for (const r of res) box.appendChild(sbResultItem(r));
}

// --- Tendances myinstants (idée d'Epi) ----------------------------------
// Parcourir la soundboard sans rien avoir à chercher : les sons du moment,
// par région. Chargé à la PREMIÈRE ouverture du popover Son (pas au démarrage
// de l'éditeur : c'est un appel réseau sortant qu'on ne fait qu'à la demande).
let sbTrendLoaded = false;
async function loadTrending(region) {
  const box = $('sbTrending'); if (!box) return;
  sbTrendLoaded = true;
  box.replaceChildren();
  const wait = document.createElement('div'); wait.className = 'muted small'; wait.textContent = 'Loading…';
  box.appendChild(wait);
  const res = await api.trendingSounds(region || $('sbRegion').value);
  box.replaceChildren();
  if (res && res.error) { box.innerHTML = '<div class="muted small"></div>'; box.firstChild.textContent = res.error; return; }
  // Le serveur renvoie la liste des régions disponibles : le sélecteur est
  // rempli à partir d'elle, jamais dupliqué dans le HTML.
  const sel = $('sbRegion');
  if (!sel.options.length && Array.isArray(res.regions)) {
    for (const r of res.regions) { const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; sel.appendChild(o); }
    sel.value = region || 'world';
  }
  const list = res.results || [];
  if (!list.length) { box.innerHTML = '<div class="muted small">No trending sound right now.</div>'; return; }
  for (const r of list) box.appendChild(sbResultItem(r));
}
$('sbRegion').onchange = () => loadTrending($('sbRegion').value);
$('sbTrendReload').onclick = () => loadTrending($('sbRegion').value);

// --- Ma bibliothèque : favoris & catégories (#9) -------------------------
let libSounds = [];
let sbFavOnly = false;
let sbCat = '';

function renderLibrary() {
  const box = $('sbLibrary'); box.replaceChildren();
  // Alimente le sélecteur de catégories.
  const cats = [...new Set(libSounds.map((a) => (a.data && a.data.category) || '').filter(Boolean))].sort();
  const sel = $('sbLibCat'); const cur = sel.value;
  sel.replaceChildren();
  const optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = 'All categories'; sel.appendChild(optAll);
  for (const c of cats) { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); }
  sel.value = cats.includes(cur) ? cur : '';
  sbCat = sel.value;

  let list = libSounds.slice();
  if (sbFavOnly) list = list.filter((a) => a.data && a.data.favorite);
  if (sbCat) list = list.filter((a) => (a.data && a.data.category) === sbCat);
  // Favoris d'abord.
  list.sort((a, b) => (b.data?.favorite ? 1 : 0) - (a.data?.favorite ? 1 : 0));

  if (!list.length) { box.innerHTML = '<div class="muted small">No sounds.</div>'; return; }
  for (const a of list) {
    const item = document.createElement('div'); item.className = 'sb-item';
    const fav = document.createElement('button'); fav.className = 'btn btn-ghost'; fav.textContent = a.data?.favorite ? '★' : '☆';
    fav.title = a.data?.favorite ? 'Remove from favorites' : 'Add to favorites';
    fav.onclick = async () => { try { await api.updateAsset(a.id, { favorite: !a.data?.favorite }); a.data = { ...(a.data || {}), favorite: !a.data?.favorite }; renderLibrary(); } catch { /* ignore */ } };
    const name = document.createElement('span'); name.className = 'sb-name'; name.textContent = a.name; name.title = a.name;
    const play = document.createElement('button'); play.className = 'btn btn-ghost'; play.textContent = '▶';
    play.title = 'Listen (click again to pause)';
    play.onclick = () => { if (a.url) sbPlay(a.url, item, play); };
    const cat = document.createElement('button'); cat.className = 'btn btn-ghost'; cat.textContent = '🏷';
    cat.title = 'Catégorie'; cat.onclick = async () => {
      const v = prompt('Sound category:', a.data?.category || ''); if (v === null) return;
      try { await api.updateAsset(a.id, { category: v.trim() }); a.data = { ...(a.data || {}), category: v.trim() }; renderLibrary(); } catch { /* ignore */ }
    };
    const use = document.createElement('button'); use.className = 'btn btn-ghost'; use.textContent = 'Use';
    use.onclick = () => useLibrarySound(a);
    const del = document.createElement('button'); del.className = 'btn btn-ghost'; del.textContent = '🗑';
    del.onclick = async () => { try { await api.deleteAsset(a.id); loadLibrary(); refreshStorage(); } catch { /* ignore */ } };
    item.append(fav, name, play, cat, use, del); box.appendChild(item);
  }
}

async function loadLibrary() {
  try { libSounds = await api.listAssets('sound'); } catch { libSounds = []; }
  renderLibrary();
}
$('sbLibCat').onchange = () => renderLibrary();
$('sbFavOnly').onclick = () => { sbFavOnly = !sbFavOnly; $('sbFavOnly').textContent = sbFavOnly ? '★' : '☆'; $('sbFavOnly').classList.toggle('active', sbFavOnly); renderLibrary(); };
loadLibrary();

// --- Soundboard partagé du channel (#4) : lecture seule + « Utiliser » ----
async function loadShared() {
  const box = $('sbShared'); box.replaceChildren();
  let sounds = [];
  try { sounds = await api.listSharedSounds(); } catch { /* ignore */ }
  if (!sounds.length) { box.innerHTML = '<div class="muted small">No shared sounds.</div>'; return; }
  // Regroupe par catégorie.
  const groups = {};
  for (const a of sounds) { const c = (a.data && a.data.category) || ''; (groups[c] ||= []).push(a); }
  for (const cat of Object.keys(groups).sort()) {
    if (cat) { const h = document.createElement('div'); h.className = 'muted small'; h.style.margin = '4px 0 2px'; h.textContent = cat; box.appendChild(h); }
    for (const a of groups[cat]) {
      const item = document.createElement('div'); item.className = 'sb-item';
      const name = document.createElement('span'); name.className = 'sb-name'; name.textContent = a.name; name.title = a.name;
      const play = document.createElement('button'); play.className = 'btn btn-ghost'; play.textContent = '▶';
      play.title = 'Listen (click again to pause)';
      play.onclick = () => { if (a.url) sbPlay(a.url, item, play); };
      const use = document.createElement('button'); use.className = 'btn btn-ghost'; use.textContent = 'Use';
      use.onclick = () => useLibrarySound(a);
      item.append(name, play, use); box.appendChild(item);
    }
  }
}
loadShared();

// ---- Options d'affichage -----------------------------------------------
function bindOptions() {
  // Bouger le curseur raccourcit le meme ; le remonter au maximum le remet en
  // suivi automatique du média le plus long (un média ajouté ensuite rallonge
  // de nouveau le meme, au lieu de rester bloqué sur l'ancienne valeur).
  $('optDur').oninput = (e) => {
    options.durationS = +e.target.value;
    options.durAuto = options.durationS >= autoDurationS();
    updateDurationUI();
  };
  $('durFull').onclick = () => { options.durAuto = true; updateDurationUI(); commit(); };
  $('optVol').oninput = (e) => { options.volume = +e.target.value / 100; $('volVal').textContent = e.target.value; };
  $('optAnim').onchange = (e) => { options.animation = e.target.value; };
  $('optAnimIn').oninput = (e) => { options.animInMs = +e.target.value; $('animInVal').textContent = (+e.target.value / 1000).toFixed(2); };
  $('optAnimOut').oninput = (e) => { options.animOutMs = +e.target.value; $('animOutVal').textContent = (+e.target.value / 1000).toFixed(2); };
}

// ---- Durée du meme : calée sur le média le plus long --------------------
// Le meme dure aussi longtemps que son média le plus long — vidéos (calques ou
// fond), fond sonore et sons à l'apparition confondus — et jamais plus : le
// curseur ne permet que de le RACCOURCIR, ce qui coupe tout d'un coup (ffmpeg
// borne la composition, l'overlay du destinataire arrête les sons avec le meme).
// Chaque média compte pour son extrait gardé quand il a été découpé (✂).
function mediaDurationS() {
  let ms = 0;
  const keep = (o, dur) => {
    if (!(dur > 0)) return;
    const cut = trimRange(o, dur);
    ms = Math.max(ms, (cut ? cut.e - cut.s : dur) * 1000);
  };
  for (const el of els) {
    if (el.hidden || el.type !== 'video' || el.kind === 'gif') continue;
    keep(el, (el.durMs || 0) / 1000);
  }
  const bg = base.mode === 'media' ? base.media : null;
  if (bg && ['video', 'audio'].includes(bg.kind)) keep(bg, (bg.durMs || 0) / 1000);
  for (const s of sounds) keep(s, (s.durMs || 0) / 1000);
  return ms / 1000;
}
// Durée « pleine » (entière, plafonnée par le réglage serveur) du meme.
function autoDurationS() {
  const media = mediaDurationS();
  return media > 0 ? clamp(Math.ceil(media), 1, window._maxVideoS || 15) : 0;
}
function updateDurationUI() {
  const auto = autoDurationS();
  const slider = $('optDur');
  slider.disabled = false;
  if (auto > 0) {
    // Le curseur s'arrête à la durée du média le plus long : allonger au-delà
    // ne ferait que figer la dernière image / laisser du silence.
    slider.max = auto;
    if (options.durAuto !== false) options.durationS = auto;
    options.durationS = clamp(options.durationS, 1, auto);
    $('durAuto').textContent = options.durationS >= auto
      ? `(longest media: ${fmtT(mediaDurationS())})`
      : `(cut from ${fmtT(mediaDurationS())} — everything stops here)`;
  } else {
    slider.max = Math.max(30, window._maxVideoS || 15);
    $('durAuto').textContent = '';
  }
  $('durFull').classList.toggle('hidden', !(auto > 0 && options.durationS < auto));
  slider.value = options.durationS;
  $('durVal').textContent = options.durationS;
  const badge = $('durBadge');
  if (badge) badge.textContent = `⏱ ${options.durationS}s`;
}

// ---- Destinataires ------------------------------------------------------
function buildTargets(groups, members) {
  const gc = $('groupChips'); gc.replaceChildren();
  groups.forEach((g) => { const b = document.createElement('button'); b.textContent = `${g.name} (${g.count})`; b.onclick = () => { toggle(selGroups, g.name, b); updateTargetBadge(); }; gc.appendChild(b); });
  const mc = $('memberChips'); mc.replaceChildren();
  memberBtns.clear();
  members.forEach((m) => {
    const b = document.createElement('button');
    const dot = document.createElement('span'); dot.className = 'dot';
    const name = document.createElement('span'); name.textContent = m.username;
    b.append(dot, name);
    if (selMembers.has(m.discordId)) b.classList.add('active');
    b.onclick = () => { toggle(selMembers, m.discordId, b); updateTargetBadge(); };
    memberBtns.set(m.discordId, { btn: b, name: m.username });
    mc.appendChild(b);
  });
  renderPresence();                       // ré-applique l'état connu aux puces neuves
}
function toggle(set, v, btn) { if (set.has(v)) { set.delete(v); btn.classList.remove('active'); } else { set.add(v); btn.classList.add('active'); } }
function updateTargetBadge() {
  const n = selGroups.size + selMembers.size;
  $('targetBadge').textContent = n ? `${n} targeted` : 'everyone';
  $('targetBadge').className = 'badge' + (n ? ' accent' : '');
  updatePresenceWarn();
}

// ---- Présence des destinataires -----------------------------------------
// Un meme n'est remis qu'aux appareils connectés au moment de l'envoi : savoir
// qui est là — et qui est en « ne pas déranger » — évite de tirer dans le vide.
// L'éditeur est une page sans WebSocket : il interroge /presence en boucle.
const memberBtns = new Map();      // discordId -> { btn, name }
let presence = new Map();          // discordId -> { status, dndUntil }
let presenceOthers = 0;            // appareils connectés sans membre associé
let presenceOn = false;            // faux tant qu'on n'a rien reçu (ou flag coupé)
let presenceTimer = null;

const PRESENCE = {
  online: { icon: '🟢', label: 'online' },
  dnd: { icon: '🌙', label: 'do not disturb' },
  off: { icon: '🔕', label: 'notifications off' },
  offline: { icon: '⚪', label: 'offline' },
};
const PRESENCE_CLASSES = Object.keys(PRESENCE).map((k) => 'st-' + k);
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function refreshPresence() {
  let p;
  try { p = await api.getPresence(); }
  catch { return; }                       // réseau : on garde le dernier état connu
  presenceOn = p && p.enabled !== false;
  presence = new Map((p?.members || []).map((m) => [m.discordId, m]));
  presenceOthers = p?.others || 0;
  renderPresence();
}

// Un état inconnu (serveur plus récent que cette page) vaut « hors ligne ».
function statusOf(discordId) {
  const st = presence.get(discordId)?.status;
  return PRESENCE[st] ? st : 'offline';
}
function statusText(discordId) {
  const st = statusOf(discordId);
  const until = presence.get(discordId)?.dndUntil;
  return st === 'dnd' && until ? `${PRESENCE.dnd.label} until ${hhmm(until)}` : PRESENCE[st].label;
}

function renderPresence() {
  const line = $('presenceLine');
  if (!presenceOn) { line.classList.add('hidden'); return; }
  const counts = { online: 0, dnd: 0, off: 0, offline: 0 };
  for (const [id, { btn }] of memberBtns) {
    const st = statusOf(id);
    counts[st]++;
    btn.classList.remove(...PRESENCE_CLASSES);
    btn.classList.add('st-' + st);
    btn.title = statusText(id);
  }
  const parts = Object.keys(PRESENCE).filter((k) => counts[k])
    .map((k) => `${PRESENCE[k].icon} ${counts[k]} ${PRESENCE[k].label}`);
  if (presenceOthers) parts.push(`+${presenceOthers} unlinked device${presenceOthers > 1 ? 's' : ''}`);
  line.replaceChildren(...parts.map((t) => { const s = document.createElement('span'); s.textContent = t; return s; }));
  line.classList.toggle('hidden', parts.length === 0);
  updatePresenceWarn();
}

// Destinataires explicitement ciblés qui ne verront rien maintenant : le meme
// n'est pas rejoué à leur retour, autant le savoir avant d'appuyer sur Envoyer.
function updatePresenceWarn() {
  const warn = $('presenceWarn');
  const unreachable = presenceOn
    ? [...selMembers].filter((id) => statusOf(id) !== 'online')
      .map((id) => `${memberBtns.get(id)?.name || id} (${statusText(id)})`)
    : [];
  warn.textContent = unreachable.length ? `⚠️ Won't see it right now: ${unreachable.join(', ')}.` : '';
  warn.classList.toggle('hidden', unreachable.length === 0);
}

// Rafraîchissement périodique, suspendu quand l'onglet passe en arrière-plan
// (rien à afficher, et l'éditeur reste ouvert des heures).
function startPresenceLoop() {
  clearInterval(presenceTimer);
  presenceTimer = setInterval(() => { if (!document.hidden) refreshPresence(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPresence(); });
}

// ---- Emplacement chez le destinataire (placement direct, intégré) -------
// Un mini-écran 16/9 dans le panneau : on glisse/redimensionne le cadre du
// meme directement — remplace la grille d'ancrage ET l'ancienne modale.
function syncPlaceOptions() {
  options.scale = placeBox.wPct;   // fallback pour anciens clients (box prioritaire)
  options.anchor = 'center';
}
function renderMiniBox() {
  const prev = $('miniScreen'), box = $('miniBox');
  if (!prev) return;
  const pw = prev.clientWidth, ph = prev.clientHeight;
  if (!pw) return requestAnimationFrame(renderMiniBox);
  const w = placeBox.wPct * pw, h = w * 9 / 16;
  box.style.width = w + 'px'; box.style.height = h + 'px';
  box.style.left = (placeBox.xPct * pw) + 'px'; box.style.top = (placeBox.yPct * ph) + 'px';
}
function initMiniPlace() {
  const prev = $('miniScreen'), box = $('miniBox'), handle = $('miniHandle');
  let d = null, r = null;
  box.onpointerdown = (e) => {
    if (e.target === handle) return;
    const pw = prev.clientWidth, ph = prev.clientHeight;
    d = { sx: e.clientX, sy: e.clientY, x0: placeBox.xPct * pw, y0: placeBox.yPct * ph, pw, ph };
    box.setPointerCapture(e.pointerId); e.preventDefault();
  };
  box.onpointermove = (e) => {
    if (!d) return;
    const h = placeBox.wPct * d.pw * 9 / 16;
    placeBox.xPct = clamp((d.x0 + e.clientX - d.sx) / d.pw, 0, 1 - placeBox.wPct);
    placeBox.yPct = clamp((d.y0 + e.clientY - d.sy) / d.ph, 0, Math.max(0, 1 - h / d.ph));
    syncPlaceOptions(); renderMiniBox();
  };
  box.onpointerup = () => { if (d) { d = null; commit(); } };
  handle.onpointerdown = (e) => {
    r = { sx: e.clientX, w0: placeBox.wPct * prev.clientWidth, pw: prev.clientWidth };
    handle.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault();
  };
  handle.onpointermove = (e) => {
    if (!r) return;
    placeBox.wPct = clamp((r.w0 + e.clientX - r.sx) / r.pw, 0.05, 1);
    placeBox.xPct = clamp(placeBox.xPct, 0, 1 - placeBox.wPct);
    syncPlaceOptions(); renderMiniBox();
  };
  handle.onpointerup = () => { if (r) { r = null; commit(); } };
  $('miniReset').onclick = () => { placeBox = { xPct: 0.25, yPct: 0.25, wPct: 0.5 }; syncPlaceOptions(); renderMiniBox(); commit(); };
  syncPlaceOptions();
  renderMiniBox();
}

// ---- Baking (rendu final identique 16/9) --------------------------------
// which : 'all' | 'under' (z < minVideoZ) | 'over' (z >= minVideoZ) — permet
// de respecter l'ordre des calques quand des vidéos sont composées serveur.
// Le dessin (strokes) est TOUJOURS au-dessus, comme dans l'éditeur.

// Source dessinable d'un calque à l'instant présent. Pendant l'encodage vidéo
// navigateur, `renderSources` substitue aux nœuds de l'éditeur des <video>
// dédiés (remis à zéro, non bouclés, audibles) : le rendu et l'aperçu de
// l'éditeur ne se marchent alors pas dessus.
let renderSources = null;   // Map el.id -> élément dessinable, null hors encodage
function layerSource(el) {
  if (renderSources && renderSources.has(el.id)) return renderSources.get(el.id);
  if (el.type === 'video') { const n = nodeCache.get(el.id); return n ? n.firstChild : null; }
  return el._img || null;
}
// Un <video> pas encore décodé (ou une image pas encore chargée) dessinerait du
// vide, voire lèverait : on saute le calque plutôt que de gâcher la frame.
function sourceReady(src) {
  if (!src) return false;
  if (src.tagName === 'VIDEO') return src.readyState >= 2 && src.videoWidth > 0;
  return (src.naturalWidth || src.width || 0) > 0;
}

// Texte d'un calque, ligne par ligne, bloc centré sur (cx, cy).
// L'interligne vaut 1 em — exactement le `line-height: 1` de l'aperçu DOM, sans
// quoi aperçu et rendu final cesseraient de se superposer.
// Les contours sont tracés AVANT tous les remplissages : ligne par ligne, le
// contour d'une ligne mordrait sur le remplissage de la précédente.
const textLinesOf = (el) => String(el.text || '').split('\n');
function drawTextLines(ctx, el, fpx, cx, cy) {
  const lines = textLinesOf(el);
  const top = cy - ((lines.length - 1) * fpx) / 2;
  if (el.outline) {
    ctx.strokeStyle = '#000'; ctx.lineWidth = fpx * 0.12;
    lines.forEach((line, i) => ctx.strokeText(line, cx, top + i * fpx));
  }
  ctx.fillStyle = el.color;
  lines.forEach((line, i) => ctx.fillText(line, cx, top + i * fpx));
}

// GÉOMÉTRIE COMMUNE au rendu figé (bake) et à l'encodage vidéo navigateur :
// position, rotation, opacité et corner-pin sont calculés ICI et nulle part
// ailleurs — deux implémentations finiraient inévitablement par diverger.
// `keep` choisit les calques concernés par la passe en cours.
function drawSceneLayers(ctx, EW, EH, keep) {
  for (const el of [...els].sort((a, b) => a.z - b.z)) {
    if (el.hidden || !keep(el)) continue;
    const src = el.type === 'text' ? null : layerSource(el);
    if (el.type !== 'text' && !sourceReady(src)) continue;
    ctx.save(); ctx.globalAlpha = el.opacity; ctx.translate(el.xPct * EW, el.yPct * EH); ctx.rotate(el.rot * Math.PI / 180);
    if (hasQuad(el)) {
      drawElementWarped(ctx, el, EW, src);
    } else if (el.type === 'text') {
      const fpx = el.fontFrac * EW;
      ctx.font = `800 ${fpx}px Impact, "Arial Black", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      drawTextLines(ctx, el, fpx, 0, 0);
    } else {
      const w = el.wPct * EW, h = w / el.ratio; ctx.drawImage(src, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }
}

// Canvas de composition statique. Les calques vidéo/gif en sont exclus : étant
// animés, ils sont composés soit par le navigateur (composeSceneToVideo), soit
// par ffmpeg côté serveur.
function bakeCanvas(transparent, which = 'all', minVideoZ = Infinity) {
  const EW = 1280, EH = 720;
  const c = document.createElement('canvas'); c.width = EW; c.height = EH;
  const ctx = c.getContext('2d');
  if (!transparent) {
    if (base.mode === 'color') { ctx.fillStyle = $('bgColor').value; ctx.fillRect(0, 0, EW, EH); }
    else if (base.mode === 'media' && base.img) { drawContain(ctx, base.img, EW, EH); }
  }
  const keep = which === 'under' ? (el) => el.type !== 'video' && el.z < minVideoZ
    : which === 'over' ? (el) => el.type !== 'video' && el.z >= minVideoZ
      : (el) => el.type !== 'video';
  drawSceneLayers(ctx, EW, EH, keep);
  if (which !== 'under') renderStrokes(ctx, EW, EH);
  return c;
}
function bake(transparent, which = 'all', minVideoZ = Infinity) {
  return bakeCanvas(transparent, which, minVideoZ).toDataURL('image/png');
}

// ---- Rendu déformé (corner pin) sur canvas ------------------------------
// Rend l'élément dans un canvas local puis le warpe par homographie
// (maillage de triangles — canvas 2D ne sait pas faire de perspective).
// `source` : image/vidéo à déformer (null pour un texte, rendu ici même).
// Un canvas de travail est réutilisé par calque — pendant l'encodage on repasse
// ici 30 fois par seconde, en allouer un neuf à chaque frame ferait ramer le GC.
const warpScratch = new Map();   // el.id -> canvas de travail
function warpScratchFor(el, w, h) {
  let c = warpScratch.get(el.id);
  if (!c) { c = document.createElement('canvas'); warpScratch.set(el.id, c); }
  c.width = w; c.height = h;     // réassigner width remet aussi le canvas à zéro
  return c;
}
function drawElementWarped(ctx, el, EW, source) {
  let src;
  if (el.type === 'text') {
    src = document.createElement('canvas');
    const fpx = el.fontFrac * EW;
    const meas = src.getContext('2d');
    meas.font = `800 ${fpx}px Impact, "Arial Black", sans-serif`;
    // La ligne la plus large fixe la largeur ; la hauteur suit le nombre de
    // lignes (interligne 1 em + la marge d'une ligne seule).
    const lines = textLinesOf(el);
    const widest = lines.reduce((m, l) => Math.max(m, meas.measureText(l || ' ').width), 0);
    src.width = Math.max(4, Math.ceil(widest + fpx * 0.3));
    src.height = Math.max(4, Math.ceil((lines.length - 1) * fpx + fpx * 1.3));
    const s = src.getContext('2d');
    s.font = `800 ${fpx}px Impact, "Arial Black", sans-serif`;
    s.textAlign = 'center'; s.textBaseline = 'middle'; s.lineJoin = 'round';
    drawTextLines(s, el, fpx, src.width / 2, src.height / 2);
  } else if (source) {
    // Images ET vidéos : la frame courante est d'abord rendue à la taille du
    // calque, puis déformée — même maillage pour les deux, donc même rendu.
    const w = el.wPct * EW, h = w / el.ratio;
    src = warpScratchFor(el, Math.max(4, Math.round(w)), Math.max(4, Math.round(h)));
    const sctx = src.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(source, 0, 0, src.width, src.height);
  } else return;
  // Coins déformés en repère local CENTRÉ (le ctx est déjà translaté/roté).
  const corners = quadCorners(el, src.width, src.height).map(([x, y]) => [x - src.width / 2, y - src.height / 2]);
  const w = src.width, h = src.height;
  const Hm = homography([[0, 0], [w, 0], [w, h], [0, h]], corners);
  const proj = (x, y) => {
    const d = Hm[6] * x + Hm[7] * y + Hm[8];
    return [(Hm[0] * x + Hm[1] * y + Hm[2]) / d, (Hm[3] * x + Hm[4] * y + Hm[5]) / d];
  };
  const N = 12;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x0 = w * i / N, x1 = w * (i + 1) / N, y0 = h * j / N, y1 = h * (j + 1) / N;
    warpTriangle(ctx, src, [x0, y0], [x1, y0], [x0, y1], proj(x0, y0), proj(x1, y0), proj(x0, y1));
    warpTriangle(ctx, src, [x1, y0], [x1, y1], [x0, y1], proj(x1, y0), proj(x1, y1), proj(x0, y1));
  }
}
function warpTriangle(ctx, img, s0, s1, s2, d0, d1, d2) {
  const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
  if (!den) return;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(d0[0], d0[1]); ctx.lineTo(d1[0], d1[1]); ctx.lineTo(d2[0], d2[1]); ctx.closePath(); ctx.clip();
  const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / den;
  const b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / den;
  const cc = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / den;
  const dd = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / den;
  ctx.transform(a, b, cc, dd, d0[0] - a * s0[0] - cc * s0[1], d0[1] - b * s0[0] - dd * s0[1]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

// Coins ABSOLUS (px canvas 1280x720) d'un calque vidéo déformé, rotation incluse
// — envoyés au serveur qui applique un filtre perspective ffmpeg.
function videoQuadPx(el) {
  const CW = 1280, CH = 720;
  const w = el.wPct * CW, h = w / el.ratio;
  const cx = el.xPct * CW, cy = el.yPct * CH;
  const rad = (el.rot || 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  return quadCorners(el, w, h).map(([x, y]) => {
    const lx = x - w / 2, ly = y - h / 2;
    return [Math.round(cx + lx * cos - ly * sin), Math.round(cy + lx * sin + ly * cos)];
  });
}
// Équivalent du `scale=1280:720:force_original_aspect_ratio=decrease` + overlay
// centré du serveur. Accepte une <img> comme une <video> (dimensions natives
// lues sur l'un ou l'autre jeu de propriétés).
function drawContain(ctx, img, W, H) {
  const iw = img.naturalWidth || img.videoWidth || img.width;
  const ih = img.naturalHeight || img.videoHeight || img.height;
  if (!iw || !ih) return;
  const r = iw / ih, cr = W / H;
  let w = W, h = H; if (r > cr) h = W / r; else w = H * r;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

// ============================================================
//  Composition de la vidéo DANS LE NAVIGATEUR (canvas + MediaRecorder)
//  ---------------------------------------------------------------------
//  Le serveur tourne sur une petite machine : composer un meme animé avec
//  ffmpeg la sature. Quand le navigateur en est capable, il rend lui-même la
//  scène frame par frame et la vidéo obtenue part comme un `media` ordinaire
//  — elle repasse donc par le pipeline de validation serveur habituel.
//  TOUT échec (support manquant, exception, délai dépassé, fond transparent)
//  retombe SILENCIEUSEMENT sur le chemin serveur (calques + comp), inchangé :
//  l'utilisateur ne doit jamais voir passer une erreur d'encodage, seule la
//  console en garde la raison.
// ============================================================
const ENC_FPS = 30;                // même cadence que le composer serveur
const ENC_VIDEO_BPS = 4_500_000;   // ~8 Mo pour 15 s : large sous la limite d'upload
const ENC_AUDIO_BPS = 128_000;
const ENC_GUARD_MS = 10_000;       // garde-fou au-delà de la durée de la scène
// VP9 d'abord (meilleure qualité à débit égal), VP8 en repli.
const ENC_MIMES = [
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
];

function clientEncodeSupport() {
  if (typeof MediaRecorder === 'undefined') return { ok: false, reason: 'MediaRecorder indisponible' };
  if (!window.HTMLCanvasElement || !HTMLCanvasElement.prototype.captureStream) {
    return { ok: false, reason: 'canvas.captureStream() indisponible' };
  }
  if (!(window.AudioContext || window.webkitAudioContext)) return { ok: false, reason: 'WebAudio indisponible' };
  let mimeType = null;
  for (const m of ENC_MIMES) {
    try { if (MediaRecorder.isTypeSupported(m)) { mimeType = m; break; } } catch { /* ignore */ }
  }
  if (!mimeType) return { ok: false, reason: 'aucun profil WebM supporté par MediaRecorder' };
  return { ok: true, mimeType };
}

// Les <video> de l'encodage vivent hors écran mais DANS le document : un média
// détaché peut ne jamais décoder de frame selon le moteur.
function encodeStage() {
  let box = $('encodeStage');
  if (!box) {
    box = document.createElement('div');
    box.id = 'encodeStage';
    box.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;overflow:hidden;pointer-events:none';
    document.body.appendChild(box);
  }
  return box;
}
function openEncodeVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.src = url; v.preload = 'auto'; v.playsInline = true; v.loop = false;
    // NON muet : la piste doit alimenter le graphe WebAudio. createMediaElementSource
    // détourne la sortie de l'élément, rien ne sort donc des haut-parleurs.
    v.muted = false; v.volume = 1;
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error('calque vidéo illisible'));
    encodeStage().appendChild(v);
  });
}

// Découpe appliquée à une source d'encodage : la lecture démarrera à `s`, et la
// source sera figée à `e` par la boucle de rendu — le canvas continue alors de
// dessiner sa dernière image, exactement comme le `tpad=stop_mode=clone` du
// serveur pour une vidéo plus courte que la scène.
function applyTrimToSource(v, o) {
  const cut = trimRange(o, v.duration || (o.durMs || 0) / 1000);
  if (cut) v._trim = cut;
}
// Fige les sources arrivées au bout de leur extrait. Appelée à chaque frame :
// l'événement `timeupdate` ne bat qu'environ 4 fois par seconde et laisserait
// passer jusqu'à un quart de seconde de vidéo coupée.
function holdTrimmedSources(videoEls) {
  for (const v of videoEls) {
    if (v._trim && !v.paused && v.currentTime >= v._trim.e) { try { v.pause(); } catch { /* ignore */ } }
  }
}

// Une frame complète de la scène animée, dans l'ORDRE EXACT du filtergraph
// serveur : couleur de fond → habillage « under » → calques vidéo (z croissant)
// → habillage « over ». Les deux habillages sont des canvas gravés une seule
// fois, strictement les mêmes pixels que les PNG envoyés au serveur.
function drawEncodeFrame(ctx, EW, EH, plan, under, over, sources, bgSource) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  // Rééchantillonnage soigné : ffmpeg met à l'échelle en bicubique, le réglage
  // par défaut du canvas est bien plus grossier — les deux rendus s'écarteraient
  // visiblement sur un calque fortement réduit.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Noir quand le fond est un média : c'est la couleur de base opaque que le
  // serveur pose sous le calque plein cadre dans ce même cas.
  ctx.fillStyle = plan.bg || '#000';
  ctx.fillRect(0, 0, EW, EH);
  // Fond média, cadré en « contain » comme l'aperçu et comme le calque
  // `full: true` que le serveur place en premier.
  if (bgSource && sourceReady(bgSource)) drawContain(ctx, bgSource, EW, EH);
  if (under) ctx.drawImage(under, 0, 0);
  renderSources = sources;
  try { drawSceneLayers(ctx, EW, EH, (el) => plan.vidIds.has(el.id)); }
  finally { renderSources = null; }
  if (over) ctx.drawImage(over, 0, 0);
}

async function composeSceneToVideo(plan, mimeType, onProgress) {
  const EW = 1280, EH = 720;
  const durationMs = clamp(plan.durationS, 0.5, window._maxVideoS || 15) * 1000;
  const urls = [];
  const teardown = [];
  let guardT = null;

  const run = async () => {
    // L'onglet caché suspend requestAnimationFrame : le canvas cesserait d'être
    // redessiné et la vidéo se figerait sur une image, avec un son qui continue.
    // On préfère replier sur le serveur que livrer ça.
    if (document.hidden) throw new Error('onglet en arrière-plan');
    const under = plan.hasUnder ? bakeCanvas(true, 'under', plan.minVideoZ) : null;
    const over = plan.hasOver ? bakeCanvas(true, 'over', plan.minVideoZ) : null;

    // Sources dédiées pour les vidéos — jamais celles de l'éditeur, qui bouclent,
    // sont muettes et n'en sont pas au même point de lecture. Les GIF, eux,
    // réutilisent le <img> vivant de la scène (un GIF hors écran n'anime pas).
    const sources = new Map();
    const videoEls = [];
    // Sous-ensemble de `videoEls` dont la piste entre dans le mixage : un calque
    // muet est joué (il faut ses images) mais n'alimente pas le graphe WebAudio.
    const audioEls = [];

    // Fond média plein cadre (scène opaque, cf. sceneIsTransparent). Une vidéo
    // de fond reçoit sa propre source — et son audio entre dans le mix, comme
    // le calque `full: true` correspondant côté serveur. Une image ou un GIF
    // réutilisent l'élément vivant de la scène.
    let bgSource = null;
    if (plan.bgMedia) {
      if (plan.bgMedia.kind === 'video') {
        const url = URL.createObjectURL(plan.bgMedia.file); urls.push(url);
        bgSource = await openEncodeVideo(url);
        applyTrimToSource(bgSource, plan.bgMedia);
        videoEls.push(bgSource); audioEls.push(bgSource);
      } else {
        bgSource = bgVisualEl(plan.bgMedia);
      }
    }

    for (const el of plan.vids) {
      if (el.kind === 'gif') continue;
      const file = mediaFiles.get(el.id).file;
      const url = URL.createObjectURL(file); urls.push(url);
      const v = await openEncodeVideo(url);
      applyTrimToSource(v, el);
      sources.set(el.id, v); videoEls.push(v);
      if (!el.muted) audioEls.push(v);
      // Un élément dont la sortie n'est PAS détournée vers WebAudio sortirait
      // sur les haut-parleurs pendant l'encodage : on le coupe explicitement.
      else v.muted = true;
    }

    const canvas = document.createElement('canvas'); canvas.width = EW; canvas.height = EH;
    const ctx = canvas.getContext('2d', { alpha: false });
    const stream = canvas.captureStream(ENC_FPS);

    // captureStream() d'un canvas ne porte AUCUNE piste audio : on mixe
    // nous-mêmes celles des calques vidéo. Pas de normalisation de sonie ici —
    // le serveur applique déjà un loudnorm EBU R128 au ré-encodage.
    if (audioEls.length) {
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      teardown.push(() => { try { actx.close(); } catch { /* ignore */ } });
      if (actx.state === 'suspended') { try { await actx.resume(); } catch { /* ignore */ } }
      const dest = actx.createMediaStreamDestination();
      for (const v of audioEls) {
        try { actx.createMediaElementSource(v).connect(dest); }
        catch (e) { console.warn('[compose] piste audio ignorée :', e.message); }
      }
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    }

    const rec = new MediaRecorder(stream, {
      mimeType, videoBitsPerSecond: ENC_VIDEO_BPS, audioBitsPerSecond: ENC_AUDIO_BPS,
    });
    // Coupe l'enregistreur si le garde-fou (ou une erreur) court-circuite la
    // suite : sans ça il continuerait à tourner dans le vide après le repli.
    teardown.push(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ } });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => {
      rec.onstop = () => resolve();
      rec.onerror = (e) => reject(new Error('MediaRecorder: ' + (e?.error?.name || 'erreur')));
    });
    stopped.catch(() => { /* l'échec est relevé par le await plus bas */ });

    // Lecture en temps réel depuis le début. Une vidéo plus courte que la scène
    // se termine et reste affichée sur sa dernière image, que le canvas continue
    // de dessiner : c'est exactement le `tpad=stop_mode=clone` du serveur.
    for (const v of videoEls) { try { v.currentTime = v._trim ? v._trim.s : 0; } catch { /* ignore */ } }
    await Promise.all(videoEls.map((v) => (v.play() || Promise.resolve()).catch(() => {})));

    let raf = 0; let running = true;
    teardown.push(() => { running = false; cancelAnimationFrame(raf); for (const v of videoEls) { try { v.pause(); } catch { /* ignore */ } } });
    const t0 = performance.now();
    let lastPct = -1;
    const tick = () => {
      if (!running) return;
      holdTrimmedSources(videoEls);
      drawEncodeFrame(ctx, EW, EH, plan, under, over, sources, bgSource);
      // Progression au pour-cent près : inutile de retoucher le DOM à 60 Hz.
      const r = clamp((performance.now() - t0) / durationMs, 0, 1);
      const pct = Math.round(r * 100);
      if (onProgress && pct !== lastPct) { lastPct = pct; onProgress(r); }
      raf = requestAnimationFrame(tick);
    };
    drawEncodeFrame(ctx, EW, EH, plan, under, over, sources, bgSource); // évite une 1re frame noire
    rec.start();
    raf = requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, durationMs));
    running = false; cancelAnimationFrame(raf);
    rec.stop();
    await stopped;
    if (onProgress) onProgress(1);
    return new Blob(chunks, { type: mimeType.split(';')[0] });
  };

  // Le garde-fou court contre l'encodage : si le second gagne, le premier
  // continue de se dénouer en arrière-plan — d'où le catch neutre, sinon son
  // rejet (démonté par le finally) remonterait en « unhandled rejection ».
  const job = run();
  job.catch(() => { /* le repli est déjà décidé par la course ci-dessous */ });
  // Troisième concurrent : l'onglet qui passe en arrière-plan. rAF y est
  // suspendu, l'enregistrement continuerait sur une image figée — on abandonne
  // pour repartir sur le chemin serveur, qui lui rendra la scène complète.
  let onHidden = null;
  const hidden = new Promise((_, reject) => {
    onHidden = () => { if (document.hidden) reject(new Error('onglet passé en arrière-plan')); };
    document.addEventListener('visibilitychange', onHidden);
  });
  hidden.catch(() => { /* idem : la course tranche */ });
  try {
    return await Promise.race([job, hidden, new Promise((_, reject) => {
      guardT = setTimeout(() => reject(new Error('délai d\'encodage dépassé')), durationMs + ENC_GUARD_MS);
    })]);
  } finally {
    document.removeEventListener('visibilitychange', onHidden);
    clearTimeout(guardT);
    renderSources = null;
    for (const fn of teardown) { try { fn(); } catch { /* ignore */ } }
    for (const u of urls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
    const box = $('encodeStage'); if (box) box.replaceChildren();
  }
}

// Tente la composition navigateur. Renvoie un `media` prêt à envoyer, ou null
// pour dire « garde le chemin serveur » (jamais d'exception vers l'appelant).
async function composeIfPossible(plan, onProgress) {
  if (!plan) return null;
  // Seule une scène à canal alpha reste au serveur : lui seul sait sortir du
  // WebM VP9 alpha, que `MediaRecorder` ne produit pas sous Chromium. Un fond
  // couleur ou un fond média plein cadre passent ici (cf. sceneIsTransparent).
  if (plan.transparent) {
    console.warn('[compose] scène à fond transparent → composition serveur : MediaRecorder ne conserve pas l\'alpha');
    return null;
  }
  const sup = clientEncodeSupport();
  if (!sup.ok) { console.warn(`[compose] ${sup.reason} → composition serveur`); return null; }
  try {
    const blob = await composeSceneToVideo(plan, sup.mimeType, onProgress);
    if (!blob || blob.size < 1024) throw new Error('flux vidéo vide');
    const mb = blob.size / 1048576, max = window._maxUploadMb || 25;
    if (mb > max) throw new Error(`vidéo composée trop lourde (${mb.toFixed(1)} Mo > ${max} Mo)`);
    // `composed` : marqueur interne (ignoré par memeForm/assetForm) permettant
    // de reconnaître une vidéo déjà assemblée d'un simple fichier de fond.
    return { file: new File([blob], 'meme.webm', { type: blob.type }), mime: blob.type, filename: 'meme.webm', composed: true };
  } catch (e) {
    console.warn('[compose] encodage navigateur abandonné → composition serveur :', e.message);
    return null;
  }
}

function textForModeration() { return els.filter((e) => e.type === 'text').map((e) => e.text).join(' ').trim(); }
function hasContent() { return els.length || strokes.length || (base.mode === 'media' && base.media); }

// Fond média dont le fichier est réellement présent (pas restauré d'un historique).
function currentBgMedia() {
  return base.mode === 'media' && base.media && base.media.file ? base.media : null;
}

// Élément vivant qui porte le fond média : il donne ses dimensions naturelles,
// et c'est lui qu'on dessine (un GIF de fond y anime déjà tout seul).
function bgVisualEl(bgMedia) {
  if (!bgMedia) return null;
  if (bgMedia.kind === 'video') return $('stageVideo');
  if (bgMedia.kind === 'image' || bgMedia.kind === 'gif') return $('stageImg');
  return null; // fond sonore : aucun visuel
}

// Un fond média est cadré en « contain » : il ne couvre tout le cadre que si son
// rapport est celui du canvas. Sinon il subsiste des bandes, que le serveur rend
// TRANSPARENTES — le meme flotte alors sur l'écran du destinataire. Un canvas
// aplati par MediaRecorder ne sait pas reproduire ça, d'où le test.
function bgFillsCanvas(bgMedia) {
  const el = bgVisualEl(bgMedia);
  if (!el || !sourceReady(el)) return false;
  const w = el.videoWidth || el.naturalWidth || 0;
  const h = el.videoHeight || el.naturalHeight || 0;
  if (!w || !h) return false;
  const scale = Math.min(1280 / w, 720 / h);
  return (1280 - w * scale) < 1 && (720 - h * scale) < 1; // bandes sous le pixel
}

// La scène a-t-elle besoin d'une sortie à canal alpha ? Décidé ICI et transmis
// explicitement au serveur (comp.transparent), au lieu de lui laisser déduire
// « pas de couleur de fond ⇒ alpha » : cette déduction rangeait le fond « None »
// ET tout fond média dans le même sac, imposant un encodage VP9 alpha coûteux à
// des scènes pourtant parfaitement opaques.
function sceneIsTransparent(bgMedia) {
  if (base.mode === 'color') return false;
  return !bgFillsCanvas(bgMedia);
}

// Description UNIQUE d'une scène animée, partagée par le payload serveur
// (calques + comp) et par l'encodage navigateur : une seule source de vérité,
// sinon les deux chemins finiraient par ne plus décrire la même scène.
// Renvoie null si la scène n'a aucun calque vidéo/gif exploitable.
function animatedScenePlan() {
  const vids = els.filter((e) => !e.hidden && e.type === 'video' && mediaFiles.get(e.id)?.file)
    .sort((a, b) => a.z - b.z);
  if (!vids.length) return null;
  const minVideoZ = Math.min(...vids.map((v) => v.z));
  const bgMedia = currentBgMedia();
  return {
    vids,
    vidIds: new Set(vids.map((v) => v.id)),
    bgMedia,
    transparent: sceneIsTransparent(bgMedia),
    minVideoZ,
    // Statiques SOUS la première vidéo → PNG « under » ; le reste (+ le dessin)
    // → overlay du dessus. L'ordre des calques est ainsi respecté.
    hasUnder: els.some((e) => !e.hidden && e.type !== 'video' && e.z < minVideoZ),
    hasOver: els.some((e) => !e.hidden && e.type !== 'video' && e.z >= minVideoZ) || strokes.length > 0,
    bg: base.mode === 'color' ? $('bgColor').value : null,
    durationS: options.durationS,
  };
}

function buildPayload() {
  const opts = { ...options };
  opts.box = placeBox;
  const payload = { text: textForModeration(), options: opts, groups: [...selGroups], mentions: [...selMembers] };
  // Sons : assets de la bibliothèque (par id) et/ou fichiers encore présents.
  // `trim`/`url` sont internes à l'éditeur : la découpe est appliquée par
  // applySoundCuts() juste avant l'envoi, qui les remplace par un fichier.
  payload.sounds = sounds
    .filter((s) => s.assetId || s.file)
    .map((s) => (s.assetId
      ? { assetId: s.assetId, name: s.name, trim: s.trim || null, url: s.url || null }
      : { file: s.file, mime: s.mime, filename: s.name, trim: s.trim || null }));

  const bgMedia = currentBgMedia();
  const hasStatic = els.some((e) => !e.hidden && e.type !== 'video') || strokes.length > 0;
  // Calques vidéo/gif visibles, avec fichier encore présent, en z croissant.
  const plan = animatedScenePlan();

  if (plan) {
    // --- Composition serveur : fond + calques vidéo + statiques. -----------
    // L'ordre des calques est RESPECTÉ : les éléments statiques situés SOUS la
    // première vidéo partent dans un PNG « under » (calque plein cadre sous les
    // vidéos), le reste (et le dessin) dans l'overlay du dessus.
    if (bgMedia && bgMedia.kind === 'audio') {
      throw new Error('Audio background + video layers is not supported. Use "Sound on appear" instead.');
    }
    const { vids, minVideoZ, hasUnder, hasOver } = plan;

    const files = []; const layers = [];
    if (bgMedia) { // fond vidéo/gif/image plein cadre, sous les calques
      files.push({ file: bgMedia.file, filename: bgMedia.name });
      layers.push({ full: true });
    }
    if (hasUnder) {
      files.push({ file: dataURLtoBlobLocal(bake(true, 'under', minVideoZ)), filename: 'under.png' });
      layers.push({ full: true });
    }
    for (const el of vids) {
      const L = { xPct: el.xPct, yPct: el.yPct, wPct: el.wPct, rot: el.rot, opacity: el.opacity };
      if (el.muted) L.mute = true; // le composer serveur écarte cette piste du mixage
      const cut = trimRange(el, (el.durMs || 0) / 1000);
      if (cut) L.trim = cut; // ffmpeg ne décode que l'extrait gardé
      if (hasQuad(el)) L.quad = videoQuadPx(el); // déformation (corner pin) appliquée par ffmpeg
      files.push({ file: mediaFiles.get(el.id).file, filename: el.name || 'layer' });
      layers.push(L);
    }
    opts.bakedText = true;
    payload.layers = files;
    // `transparent` est explicite : sans lui le serveur déduirait l'alpha de
    // l'absence de couleur et encoderait en VP9 alpha une scène opaque.
    payload.comp = { v: 1, bg: plan.bg, transparent: plan.transparent, durationS: plan.durationS, layers };
    if (hasOver) payload.overlay = { dataUrl: bake(true, 'over', minVideoZ), filename: 'overlay.png' };
  } else if (bgMedia && bgMedia.kind === 'video' && trimRange(bgMedia, (bgMedia.durMs || 0) / 1000)) {
    // --- Fond vidéo DÉCOUPÉ, sans calque : la coupe est faite par ffmpeg, on
    // repasse donc par la composition (un unique calque plein cadre) plutôt que
    // par l'envoi brut, qui livrerait la vidéo entière.
    opts.bakedText = true;
    payload.layers = [{ file: bgMedia.file, filename: bgMedia.name }];
    payload.comp = {
      v: 1, bg: null, transparent: sceneIsTransparent(bgMedia), durationS: options.durationS,
      layers: [{ full: true, trim: trimRange(bgMedia, (bgMedia.durMs || 0) / 1000) }],
    };
    if (hasStatic) payload.overlay = { dataUrl: bake(true), filename: 'overlay.png' };
  } else if (bgMedia && ['video', 'gif', 'audio'].includes(bgMedia.kind)) {
    // --- Fond vidéo/gif/son seul : envoi brut + overlay PNG (chemin léger). ---
    // `trim` n'a de sens ici que pour un fond SON : c'est le seul média que
    // l'éditeur découpe lui-même (une vidéo découpée est partie en composition).
    payload.media = {
      file: bgMedia.file, mime: bgMedia.mime, filename: bgMedia.name,
      trim: bgMedia.kind === 'audio' ? (bgMedia.trim || null) : null,
    };
    if (hasStatic) { opts.bakedText = true; payload.overlay = { dataUrl: bake(true), filename: 'overlay.png' }; }
  } else {
    // --- Image / couleur / transparent → tout est composé dans un PNG. ---
    opts.bakedText = true;
    payload.media = { dataUrl: bake(false), filename: 'meme.png' };
  }
  return payload;
}

// Payload d'envoi. Une scène animée est d'abord tentée EN LOCAL : si le
// navigateur sait composer la vidéo, elle remplace calques + comp + overlay par
// un `media` ordinaire et le serveur n'a plus à lancer ffmpeg pour l'assembler.
// Sinon on renvoie tel quel le payload serveur, sans rien dire à l'utilisateur.
// Applique les découpes de SON (les vidéos, elles, sont coupées à l'encodage).
// Un son découpé part comme un fichier WAV : plus d'assetId, le serveur reçoit
// l'extrait tel quel et le transcode comme n'importe quel upload.
async function applySoundCuts(payload) {
  const clean = (s) => { const c = { ...s }; delete c.trim; delete c.url; return c; };
  const out = [];
  for (const s of payload.sounds || []) {
    if (!s.trim) { out.push(clean(s)); continue; }
    const src = s.file || s.url;
    if (!src) { out.push(clean(s)); continue; }
    // Échec = envoi bloqué : livrer le son ENTIER alors que l'utilisateur l'a
    // coupé serait pire qu'une erreur affichée.
    const file = await cutAudioToFile(src, s.trim, s.filename || s.name || 'sound')
      .catch((e) => { throw new Error(`Could not cut the sound « ${s.name || 'sound'} » (${e.message}).`); });
    out.push({ file, mime: 'audio/wav', filename: file.name });
  }
  payload.sounds = out;
  // Fond SON découpé : même traitement, le fichier de fond est remplacé par
  // l'extrait (le fond vidéo, lui, passe par la composition).
  const m = payload.media;
  if (m && m.trim && m.file) {
    const file = await cutAudioToFile(m.file, m.trim, m.filename || 'sound')
      .catch((e) => { throw new Error(`Could not cut the background sound (${e.message}).`); });
    payload.media = { file, mime: 'audio/wav', filename: file.name };
  } else if (m && m.trim) {
    delete m.trim;
  }
  return payload;
}

async function buildPayloadForSend(onProgress) {
  const payload = await applySoundCuts(buildPayload());
  if (!payload.layers) return payload;
  const media = await composeIfPossible(animatedScenePlan(), onProgress);
  if (!media) return payload;
  const out = { ...payload, media };
  delete out.layers; delete out.comp; delete out.overlay; // tout est gravé dans la vidéo
  return out;
}

// Rendu à stocker dans la bibliothèque. Une scène animée (calques vidéo/GIF ou
// fond vidéo/GIF) est enregistrée comme les envois : la vidéo est composée dans
// le navigateur quand c'est possible, par le serveur sinon. Une scène fixe reste
// une image aplatie, plus légère.
// → { media } pour une vidéo déjà composée ou une image, { layers, comp, overlay }
//   quand la composition revient au serveur.
async function assetRender(onProgress) {
  const p = await buildPayloadForSend(onProgress);
  if (p.layers) return { layers: p.layers, comp: p.comp, overlay: p.overlay || null };
  // Vidéo composée dans le navigateur : elle est stockée comme n'importe quel
  // média (le serveur la ré-encode en MP4 via le pipeline habituel).
  if (p.media?.composed) return { media: p.media };
  // Fond vidéo/GIF seul : un unique calque plein cadre, l'habillage statique
  // (textes, images, dessin) restant gravé par-dessus via l'overlay.
  const bg = p.media;
  if (bg?.file && ['video', 'gif'].includes(base.media?.kind)) {
    return {
      layers: [{ file: bg.file, filename: bg.filename }],
      comp: {
        v: 1, bg: null, transparent: sceneIsTransparent(currentBgMedia()),
        durationS: options.durationS, layers: [{ full: true }],
      },
      overlay: p.overlay || null,
    };
  }
  return { media: { dataUrl: bake(false), filename: 'meme.png' } };
}

// Blob depuis un dataURL (le calque « under » part en fichier multipart).
function dataURLtoBlobLocal(dataUrl) {
  const [meta, b64] = String(dataUrl).split(',');
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ---- Envoi / planification / bibliothèque -------------------------------
// L'encodage navigateur se fait en TEMPS RÉEL (jusqu'à 15 s) : sans retour
// visuel, l'éditeur passerait pour figé. On reste sur ses codes habituels —
// libellé du bouton + ligne de message — plutôt que d'inventer un widget.
function encodeProgressUI(btn, hint) {
  let announced = false;
  return (ratio) => {
    btn.textContent = `🎬 Rendering ${Math.round(clamp(ratio, 0, 1) * 100)}%`;
    if (!announced && hint) {
      announced = true;
      hint.style.color = 'var(--muted)';
      hint.textContent = 'Rendering the animation in your browser — keep this tab visible.';
    }
  };
}
function clearHint(hint) { if (hint) { hint.style.color = ''; hint.textContent = ''; } }

// ---- Vider l'éditeur après l'envoi -------------------------------------
// Préférence mémorisée par navigateur, comme le volume d'écoute. Décochée par
// défaut : le comportement d'origine (la scène reste en place) ne change pas
// pour qui n'en veut pas.
const CLEAR_KEY = 'md_clear_after_send';
const clearAfterBox = $('clearAfterSend');
try { clearAfterBox.checked = localStorage.getItem(CLEAR_KEY) === '1'; } catch { /* ignore */ }
clearAfterBox.onchange = () => {
  try { localStorage.setItem(CLEAR_KEY, clearAfterBox.checked ? '1' : '0'); } catch { /* ignore */ }
};

// Remet la scène à zéro : calques, dessin, fond, sons attachés et lien vers la
// bibliothèque. Les réglages d'affichage (durée, position, taille, volume) et
// les destinataires sont CONSERVÉS — ce sont des habitudes d'envoi, pas le
// contenu du meme. Le meme envoyé reste récupérable par « ↩️ Last », que
// `saveLast()` a mémorisé juste avant l'envoi.
function clearScene() {
  for (const mf of mediaFiles.values()) { try { URL.revokeObjectURL(mf.url); } catch { /* ignore */ } }
  mediaFiles.clear();
  for (const s of sounds) { if (s._url) { try { URL.revokeObjectURL(s._url); } catch { /* ignore */ } } }
  sndStop();
  els = []; strokes = []; sounds = [];
  base.media = null; base.img = null;
  selId = null; $('elCard').classList.add('hidden');
  currentAsset = null;             // le prochain « 💾 Save » crée une entrée neuve
  setBgMode('none');
  $('bgMediaName').textContent = '';
  renderElements(); renderStrokes(); renderSounds(); renderMiniBox();
  // Historique reparti de zéro : annuler ne doit pas ressusciter des calques
  // dont les fichiers viennent d'être libérés.
  history = [snapshot()]; hIndex = 0; updateUndoButtons();
  updateWeight();
}

$('sendBtn').onclick = async () => {
  $('sendErr').textContent = '';
  if (!hasContent()) { $('sendErr').textContent = 'Add at least one element or a background.'; return; }
  const btn = $('sendBtn'); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    saveLast(); // mémorise la scène pour « Reprendre le dernier » (#40)
    const payload = await buildPayloadForSend(encodeProgressUI(btn, $('sendErr')));
    clearHint($('sendErr'));
    btn.textContent = 'Sending…';
    const r = await api.sendMeme(payload);
    btn.textContent = r?.pending ? 'Pending moderation ⏳'
      : r?.queued ? `Queued — sending ${r.warmupRemainS ? `in ~${r.warmupRemainS}s` : 'after warmup'} ⏳`
        : 'Sent ✅';
    // Le meme est accepté (en attente de modération ou en file compris) : la
    // scène a fait son office.
    if (clearAfterBox.checked) clearScene();
    setTimeout(() => { btn.textContent = 'Send the meme 🚀'; btn.disabled = false; }, (r?.pending || r?.queued) ? 2600 : 1200);
  } catch (e) { clearHint($('sendErr')); $('sendErr').textContent = e.message; btn.textContent = 'Send the meme 🚀'; btn.disabled = false; }
};

// ---- Bibliothèque de memes enregistrés ---------------------------------
// Un meme enregistré = son RENDU (image, déjà transcodé côté serveur, renvoyé
// tel quel) + sa SCÈNE (calques, réglages d'affichage) pour pouvoir le rouvrir
// et le retoucher. Les fichiers locaux (calques vidéo, fond vidéo/son, son
// fichier) ne sont pas sérialisables : ils sont aplatis dans le rendu et
// signalés à l'utilisateur avant l'enregistrement.
let currentAsset = null;   // meme actuellement ouvert depuis la bibliothèque
let libMemes = [];
const LIB_MAX_SCENE_MB = 8;   // doit rester ≤ MAX_ASSET_DATA_BYTES côté serveur

// Scène animée : le rendu enregistré sera une vidéo composée par le serveur.
function isAnimatedScene() {
  return els.some((e) => !e.hidden && e.type === 'video' && mediaFiles.get(e.id)?.file)
    || (base.mode === 'media' && ['video', 'gif'].includes(base.media?.kind) && base.media?.file);
}

// Avertissements affichés avant l'enregistrement. Le RENDU garde tout (l'animation
// comprise) ; ce sont les sources rééditables qui ne survivent pas toutes.
function unsavableParts() {
  const parts = [];
  if (isAnimatedScene()) parts.push('video/GIF layers stay in the rendered video but cannot be edited again');
  if (base.mode === 'media' && base.media?.kind === 'audio') parts.push('the sound background is not kept');
  // Un son fichier n'est pas stocké : seuls les sons de la bibliothèque le sont.
  if (sounds.some((s) => !s.assetId)) parts.push('sound files are not kept (only library sounds are)');
  return parts;
}

// Scène débarrassée de tout ce qui n'a pas survécu à la sérialisation : ce qui
// est rouvert correspond alors exactement à la vignette enregistrée.
function sceneForSave() {
  const s = JSON.parse(snapshot());
  s.els = s.els.filter((e) => e.type !== 'video');
  if (s.base.media && !s.base.media.dataUrl) {
    s.base.media = null;
    if (s.base.mode === 'media') s.base.mode = 'none';
  }
  s.sounds = (s.sounds || []).filter((x) => x.assetId);
  return s;
}

function openSaveModal() {
  $('sendErr').textContent = '';
  if (!hasContent()) { $('sendErr').textContent = 'Nothing to save.'; return; }
  $('saveName').value = currentAsset ? currentAsset.name : 'My meme';
  $('saveErr').textContent = '';
  $('saveReplaceWrap').classList.toggle('hidden', !currentAsset);
  if (currentAsset) { $('saveReplace').checked = true; $('saveReplaceName').textContent = currentAsset.name; }
  const parts = unsavableParts();
  const warn = $('saveWarn');
  warn.classList.toggle('hidden', !parts.length);
  warn.textContent = parts.length ? `⚠️ ${parts.join(' · ')}.` : '';
  $('saveModal').classList.remove('hidden');
  $('saveName').focus();
}
$('saveBtn').onclick = openSaveModal;
$('saveCancel').onclick = () => $('saveModal').classList.add('hidden');
$('saveOk').onclick = async () => {
  const name = ($('saveName').value || 'Meme').trim();
  const btn = $('saveOk'); btn.disabled = true; btn.textContent = '…';
  $('saveErr').textContent = '';
  try {
    // Rendu figé une fois pour toutes (image aplatie, ou vidéo composée si la
    // scène est animée) : renvoyable et téléchargeable tel quel, sans
    // recomposition côté serveur.
    const render = await assetRender(encodeProgressUI(btn, $('saveErr')));
    clearHint($('saveErr'));
    const data = {
      text: textForModeration(),
      options: { ...options, box: placeBox, bakedText: true },
      scene: sceneForSave(),
      // Sons rejoués à l'identique quand le meme est renvoyé depuis la bibliothèque.
      soundAssetIds: sounds.filter((s) => s.assetId).map((s) => s.assetId),
    };
    const sceneMb = JSON.stringify(data).length / 1048576;
    if (sceneMb > LIB_MAX_SCENE_MB) {
      throw new Error(`This meme is too heavy to be saved (${sceneMb.toFixed(1)} MB of layers, max ${LIB_MAX_SCENE_MB} MB). Remove or shrink some images.`);
    }
    const replace = currentAsset && $('saveReplace').checked;
    const r = replace
      ? await api.replaceAsset(currentAsset.id, { kind: 'meme', name, ...render, data })
      : await api.addAsset({ kind: 'meme', name, ...render, data });
    currentAsset = { id: r.id || currentAsset?.id, name };
    $('saveModal').classList.add('hidden');
    refreshStorage();
    libMemes = [];   // liste à recharger au prochain affichage
    $('sendErr').style.color = 'var(--success)';
    $('sendErr').textContent = replace ? 'Meme updated in your library ✓' : 'Saved to your library ✓';
    setTimeout(() => { $('sendErr').style.color = ''; $('sendErr').textContent = ''; }, 2500);
  } catch (e) { clearHint($('saveErr')); $('saveErr').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Save'; }
};

// --- Modale « Ma bibliothèque » ------------------------------------------
let libFilter = 'all';   // all | fav | anim
let libSort = 'recent';  // recent | name | size

$('tbLibrary').onclick = () => openLibrary();
$('libClose').onclick = () => closeLibrary();
$('libModal').onclick = (e) => { if (e.target === $('libModal')) closeLibrary(); };
$('libSearch').oninput = () => {
  $('libSearchClear').classList.toggle('hidden', !$('libSearch').value);
  renderMemeLib();
};
$('libSearchClear').onclick = () => {
  $('libSearch').value = ''; $('libSearchClear').classList.add('hidden');
  renderMemeLib(); $('libSearch').focus();
};
$('libSort').onchange = () => { libSort = $('libSort').value; renderMemeLib(); };
for (const b of document.querySelectorAll('.lib-chip')) {
  b.onclick = () => {
    libFilter = b.dataset.filter;
    document.querySelectorAll('.lib-chip').forEach((x) => x.classList.toggle('active', x === b));
    renderMemeLib();
  };
}
// Échap ferme la bibliothèque, sauf pendant un renommage (l'input le gère).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('libModal').classList.contains('hidden')) return;
  if (document.activeElement?.classList.contains('lib-name')) return;
  closeLibrary();
});

function closeLibrary() {
  $('libModal').classList.add('hidden');
  // Les vignettes vidéo continueraient à tourner en arrière-plan.
  $('libGrid').replaceChildren();
}

async function openLibrary() {
  $('libModal').classList.remove('hidden');
  $('libMsg').textContent = '';
  $('libTargetBadge').textContent = $('targetBadge').textContent;
  $('libGrid').innerHTML = '<div class="lib-empty">Loading…</div>';
  await loadMemeLib();
}

async function loadMemeLib() {
  try { libMemes = await api.listAssets('meme'); }
  catch (e) { libMemes = []; $('libMsg').textContent = e.message; }
  renderMemeLib();
}

const isAnimatedAsset = (a) => a.data?.mediaType === 'video' || a.data?.mediaType === 'gif';

function renderMemeLib() {
  const box = $('libGrid'); box.replaceChildren();
  const q = ($('libSearch').value || '').trim().toLowerCase();
  let list = libMemes.slice();
  if (libFilter === 'fav') list = list.filter((a) => a.data?.favorite);
  else if (libFilter === 'anim') list = list.filter(isAnimatedAsset);
  if (q) list = list.filter((a) => (a.name || '').toLowerCase().includes(q));

  const by = {
    recent: (a, b) => b.createdAt - a.createdAt,
    name: (a, b) => (a.name || '').localeCompare(b.name || ''),
    size: (a, b) => b.sizeMb - a.sizeMb,
  }[libSort];
  // Favoris en tête quel que soit le tri : c'est le geste de rangement du panneau.
  list.sort((a, b) => ((b.data?.favorite ? 1 : 0) - (a.data?.favorite ? 1 : 0)) || by(a, b));

  $('libCount').textContent = libMemes.length
    ? `${list.length}${list.length === libMemes.length ? '' : ` / ${libMemes.length}`} meme${libMemes.length > 1 ? 's' : ''}`
    : '';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty';
    if (!libMemes.length) empty.innerHTML = '<b>Your library is empty</b>Compose a meme, then hit 💾 Save to keep it here — ready to resend in one click.';
    else empty.innerHTML = '<b>Nothing matches</b>Try another search or filter.';
    box.appendChild(empty);
    return;
  }
  for (const a of list) box.appendChild(memeCard(a));
}

function memeCard(a) {
  const card = document.createElement('div'); card.className = 'lib-card';
  const animated = isAnimatedAsset(a);

  // --- Vignette ---
  const shot = document.createElement('div'); shot.className = 'lib-shot';
  if (a.url && animated) {
    // Aperçu animé au survol seulement : une grille de vidéos en lecture
    // continue coûterait cher et ferait clignoter la modale.
    const v = document.createElement('video');
    v.src = a.url; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
    shot.onmouseenter = () => v.play?.().catch(() => {});
    shot.onmouseleave = () => { try { v.pause(); v.currentTime = 0; } catch { /* ignore */ } };
    shot.appendChild(v);
  } else if (a.url) {
    const img = document.createElement('img');
    img.src = a.url; img.alt = a.name; img.loading = 'lazy';
    shot.appendChild(img);
  } else {
    shot.classList.add('empty'); shot.textContent = 'No preview';
  }
  shot.title = a.data?.hasScene ? 'Open in the editor' : 'This meme has no editable scene';
  shot.onclick = () => (a.data?.hasScene ? openMemeAsset(a) : downloadMemeAsset(a));

  const badges = document.createElement('div'); badges.className = 'lib-badges';
  if (animated) { const b = document.createElement('span'); b.className = 'lib-badge'; b.textContent = '▶ ANIMATED'; badges.appendChild(b); }
  if (a.data?.soundAssetIds?.length) {
    const b = document.createElement('span'); b.className = 'lib-badge';
    b.textContent = `🔊 ${a.data.soundAssetIds.length}`; badges.appendChild(b);
  }
  if (badges.children.length) shot.appendChild(badges);

  const fav = document.createElement('button');
  fav.className = 'lib-fav' + (a.data?.favorite ? ' on' : '');
  fav.textContent = a.data?.favorite ? '★' : '☆';
  fav.title = a.data?.favorite ? 'Remove from favorites' : 'Add to favorites';
  fav.onclick = async (e) => {
    e.stopPropagation();
    const next = !a.data?.favorite;
    try { await api.updateAsset(a.id, { favorite: next }); a.data = { ...(a.data || {}), favorite: next }; renderMemeLib(); }
    catch (err) { $('libMsg').textContent = err.message; }
  };
  shot.appendChild(fav);

  // --- Nom, renommable sur place ---
  const info = document.createElement('div'); info.className = 'lib-info';
  const name = document.createElement('input');
  name.className = 'lib-name'; name.value = a.name; name.title = 'Click to rename'; name.maxLength = 80;
  const commitName = async () => {
    const v = name.value.trim();
    if (!v || v === a.name) { name.value = a.name; return; }
    try { await api.updateAsset(a.id, { name: v }); a.name = v; $('libMsg').textContent = `Renamed to « ${v} ».`; }
    catch (e) { name.value = a.name; $('libMsg').textContent = e.message; }
  };
  name.onblur = commitName;
  name.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
    else if (e.key === 'Escape') { e.stopPropagation(); name.value = a.name; name.blur(); }
  };
  info.appendChild(name);

  const meta = document.createElement('div'); meta.className = 'lib-meta';
  meta.textContent = [
    new Date(a.createdAt).toLocaleDateString(),
    `${a.sizeMb} MB`,
    a.data?.hasScene ? null : 'not editable',
  ].filter(Boolean).join(' · ');

  // --- Actions ---
  const actions = document.createElement('div'); actions.className = 'lib-actions';
  const send = document.createElement('button');
  send.className = 'btn btn-primary lib-send'; send.textContent = '🚀 Send'; send.title = 'Send as is to the selected recipients';
  send.onclick = () => sendMemeAsset(a, send);

  const edit = document.createElement('button');
  edit.className = 'lib-icon'; edit.textContent = '✏️';
  // Les calques vidéo ne sont pas sérialisables : un meme animé se rouvre sur sa
  // partie fixe (textes, images, réglages), pas sur son mouvement.
  edit.title = !a.data?.hasScene ? 'No editable scene (saved with an older version)'
    : animated ? 'Reopen in the editor (without the video layers)'
      : 'Reopen in the editor';
  edit.disabled = !a.data?.hasScene;
  edit.onclick = () => openMemeAsset(a);

  const dl = document.createElement('button');
  dl.className = 'lib-icon'; dl.textContent = '📥';
  dl.title = `Download (${assetExt(a).toUpperCase()})`;
  dl.disabled = !a.url;
  dl.onclick = () => downloadMemeAsset(a, dl);

  const del = document.createElement('button');
  del.className = 'lib-icon danger'; del.textContent = '🗑'; del.title = 'Delete';
  // Suppression irréversible → confirmation sur un second clic (pas de
  // window.confirm : indisponible/bloquant selon l'hôte qui embarque l'éditeur).
  let armed = false;
  del.onclick = async () => {
    if (!armed) {
      armed = true; del.textContent = '✓?'; del.classList.add('armed'); del.title = 'Click again to delete';
      setTimeout(() => { armed = false; del.textContent = '🗑'; del.classList.remove('armed'); del.title = 'Delete'; }, 5000);
      return;
    }
    del.disabled = true;
    try {
      await api.deleteAsset(a.id);
      if (currentAsset?.id === a.id) currentAsset = null;
      libMemes = libMemes.filter((x) => x.id !== a.id);
      renderMemeLib(); refreshStorage();
      $('libMsg').textContent = `« ${a.name} » deleted.`;
    } catch (e) { $('libMsg').textContent = e.message; del.disabled = false; }
  };
  actions.append(send, edit, dl, del);

  card.append(shot, info, meta, actions);
  return card;
}

// Format du fichier téléchargé. Les memes animés sortent tels quels (MP4, ou
// WebM quand le fond est transparent). Les memes fixes sont stockés en WebP par
// le serveur : on les reconvertit en PNG, seul format universellement accepté
// partout où l'on colle une image (et la transparence survit).
function assetExt(a) {
  const m = (a.mime || '').toLowerCase();
  return { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/gif': 'gif' }[m]
    || (m.startsWith('video/') ? 'mp4' : 'png');
}

// WebP → PNG via canvas (le rendu est same-origin, le canvas reste exploitable).
function webpToPng(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      cv.toBlob((png) => resolve(png || blob), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
    img.src = url;
  });
}

// Téléchargement du rendu. On passe par un blob : l'attribut `download` seul
// ignorerait le nom de fichier voulu sur certains hôtes, et l'URL signée
// expire — mieux vaut échouer visiblement ici qu'ouvrir un onglet vide.
async function downloadMemeAsset(a, btn) {
  if (!a.url) { $('libMsg').textContent = 'This meme has no media to download.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  $('libMsg').textContent = '';
  try {
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
    let blob = await res.blob();
    if (assetExt(a) === 'png' && blob.type !== 'image/png') blob = await webpToPng(blob);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(a.name || 'meme').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}.${assetExt(a)}`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    $('libMsg').textContent = `Downloaded « ${a.name} ».`;
  } catch (e) { $('libMsg').textContent = e.message; }
  finally { if (btn) { btn.disabled = false; btn.textContent = '📥'; } }
}

// Rouvre un meme enregistré dans l'éditeur (retouche puis renvoi/ré-enregistrement).
async function openMemeAsset(a) {
  $('libMsg').textContent = 'Opening…';
  try {
    const full = await api.getAsset(a.id);
    const scene = full?.data?.scene;
    if (!scene) { $('libMsg').textContent = 'This meme has no editable scene (saved with an older version). You can still send it.'; return; }
    restore(JSON.stringify(scene));
    // Les URL des sons étaient signées pour 2 h : on reprend celles de la
    // bibliothèque courante, sinon l'aperçu resterait muet.
    if (sounds.length) {
      await loadLibrary();
      const before = sounds.length;
      sounds = sounds.filter((s) => {
        const fresh = libSounds.find((x) => x.id === s.assetId);
        if (fresh) { s.url = fresh.url; s.name = fresh.name; return true; }
        return false;   // son supprimé de la bibliothèque depuis l'enregistrement
      });
      if (sounds.length < before) $('libMsg').textContent = 'Note: some attached sounds no longer exist.';
      renderSounds();
    }
    pushHistory(); updateWeight();
    currentAsset = { id: full.id, name: full.name };
    $('libModal').classList.add('hidden');
    $('sendErr').style.color = 'var(--success)';
    $('sendErr').textContent = `« ${full.name} » opened — edit it, then send or save.`;
    setTimeout(() => { $('sendErr').style.color = ''; $('sendErr').textContent = ''; }, 3000);
  } catch (e) { $('libMsg').textContent = e.message; }
}

// Envoi direct, sans repasser par la scène : le serveur rejoue le rendu déjà
// transcodé vers les destinataires sélectionnés dans le panneau.
async function sendMemeAsset(a, btn) {
  btn.disabled = true; btn.textContent = '…';
  $('libMsg').textContent = '';
  try {
    const r = await api.sendAsset(a.id, { groups: [...selGroups], mentions: [...selMembers] });
    $('libMsg').textContent = r?.pending ? `« ${a.name} » pending moderation ⏳`
      : r?.queued ? `« ${a.name} » queued (warmup) ⏳`
        : `« ${a.name} » sent ✅`;
  } catch (e) { $('libMsg').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = '🚀 Send'; }
}

// Aperçu — rejoue le meme EXACTEMENT comme chez le destinataire :
// position/taille (placement), animation d'entrée ET de sortie, vidéos en
// lecture, son à l'apparition, volume, durée.
let pvTimer = null; let pvTimer2 = null; const pvAudios = [];
function stopPreview() {
  clearTimeout(pvTimer); clearTimeout(pvTimer2); pvTimer = pvTimer2 = null;
  for (const a of pvAudios) { try { a.pause(); } catch { /* ignore */ } }
  pvAudios.length = 0;
  $('previewScreen').replaceChildren();
}
// `cutOf` : l'objet découpé (calque ou fond) dont l'extrait doit être respecté,
// pour que l'aperçu montre bien ce que verront les destinataires.
function pvVideo(src, vol, cutOf) {
  const v = document.createElement('video');
  v.src = src; v.autoplay = true; v.playsInline = true;
  v._baseVol = vol ?? 0.7;
  v.volume = localVol(v._baseVol); v.muted = v.volume === 0;
  applyPreviewTrim(v, cutOf);
  v.play?.().catch(() => {});
  return v;
}
// Démarre à `s` et fige à `e`. Sert aux vidéos comme aux sons de l'aperçu.
function applyPreviewTrim(m, cutOf) {
  if (!cutOf || !cutOf.trim) return;
  const start = () => {
    const cut = trimRange(cutOf, m.duration || 0);
    if (!cut) return;
    m._cut = cut;
    try { m.currentTime = cut.s; } catch { /* ignore */ }
  };
  if (m.readyState >= 1) start(); else m.addEventListener('loadedmetadata', start, { once: true });
  m.addEventListener('timeupdate', () => {
    if (m._cut && m.currentTime >= m._cut.e) { try { m.pause(); } catch { /* ignore */ } }
  });
}
$('previewBtn').onclick = renderPreview;
$('previewClose').onclick = () => { stopPreview(); $('previewModal').classList.add('hidden'); };
$('previewReplay').onclick = renderPreview;
function renderPreview() {
  if (!hasContent()) { $('sendErr').textContent = 'Compose a meme first.'; return; }
  $('previewModal').classList.remove('hidden');
  stopPreview();
  const scr = $('previewScreen');
  requestAnimationFrame(() => {
    const W = scr.clientWidth, H = scr.clientHeight, refW = Math.min(W, H * 16 / 9);
    let w = clamp(placeBox.wPct, 0.05, 1) * refW; let h = w * 9 / 16;
    let x = clamp(placeBox.xPct, 0, 1) * W, y = clamp(placeBox.yPct, 0, 1) * H;
    if (x + w > W) x = W - w; if (y + h > H) y = H - h;
    const vol = options.volume;

    const st = document.createElement('div'); st.className = 'pstage';
    st.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;opacity:${options.opacity ?? 0.95}`;

    // Fond (couleur / image / vidéo / son).
    if (base.mode === 'color') st.style.background = $('bgColor').value;
    else if (base.mode === 'media' && base.media) {
      if (base.media.kind === 'video' && base.media.file) {
        const v = pvVideo(URL.createObjectURL(base.media.file), vol, base.media);
        v.className = 'pv-full'; st.appendChild(v);
      } else if (base.media.kind === 'audio' && base.media.file) {
        st.style.background = 'linear-gradient(135deg,#1c1c22,#141418)';
        const a = new Audio(URL.createObjectURL(base.media.file));
        a._baseVol = vol; a.volume = localVol(vol); applyPreviewTrim(a, base.media); a.play().catch(() => {}); pvAudios.push(a);
      } else if (base.media.dataUrl || base.media.file) {
        const im = document.createElement('img'); im.className = 'pv-full';
        im.src = base.media.dataUrl || URL.createObjectURL(base.media.file);
        st.appendChild(im);
      }
    }

    // Ordre des calques respecté : statiques SOUS la première vidéo, puis
    // vidéos, puis statiques + dessin au-dessus (comme chez le destinataire).
    const pvVids = els.filter((e) => !e.hidden && e.type === 'video').sort((a, b) => a.z - b.z);
    const minVZ = pvVids.length ? Math.min(...pvVids.map((v) => v.z)) : Infinity;
    if (els.some((e) => !e.hidden && e.type !== 'video' && e.z < minVZ)) {
      const u = document.createElement('img'); u.className = 'pv-full'; u.src = bake(true, 'under', minVZ); st.appendChild(u);
    }
    for (const el of pvVids) {
      const mf = mediaFiles.get(el.id); if (!mf) continue;
      // Un calque coupé (🔇) reste muet dans l'aperçu, comme chez le destinataire.
      const n = el.kind === 'gif' ? (() => { const i = document.createElement('img'); i.src = mf.url; return i; })() : pvVideo(mf.url, el.muted ? 0 : vol, el);
      n.className = 'pv-el';
      const nw = el.wPct * w, nh = nw / el.ratio;
      const distort = hasQuad(el) ? ` ${cssMatrix3d(el, nw, nh)}` : '';
      n.style.cssText = `left:${el.xPct * w}px;top:${el.yPct * h}px;width:${nw}px;`
        + `transform-origin:0 0;transform:rotate(${el.rot}deg) translate(-50%,-50%)${distort};opacity:${el.opacity}`;
      st.appendChild(n);
    }
    if (els.some((e) => !e.hidden && e.type !== 'video' && e.z >= minVZ) || strokes.length) {
      const o = document.createElement('img'); o.className = 'pv-full'; o.src = bake(true, 'over', minVZ); st.appendChild(o);
    }

    const tag = document.createElement('div'); tag.className = 'pv-sender'; tag.textContent = 'you'; st.appendChild(tag);

    const cls = { fade: 'pv-fade', slide: 'pv-slide', bounce: 'pv-bounce', shake: 'pv-shake', none: '' }[options.animation] || '';
    if (cls) { st.classList.add(cls); st.style.animationDuration = `${options.animInMs || 350}ms`; }
    scr.appendChild(st);

    // Sons à l'apparition (fichiers locaux et/ou assets de la bibliothèque),
    // joués ensemble comme chez le destinataire.
    for (const s of sounds) {
      const src = soundSrc(s);
      if (!src) continue;
      const a = new Audio(src); a._baseVol = vol; a.volume = localVol(vol);
      applyPreviewTrim(a, s); // son découpé : l'aperçu ne joue que l'extrait gardé
      a.play().catch(() => {}); pvAudios.push(a);
    }

    // Fin après la durée réglée : animation de sortie puis disparition.
    pvTimer = setTimeout(() => {
      st.style.transitionDuration = `${options.animOutMs || 350}ms`;
      st.classList.add('pv-out');
      pvTimer2 = setTimeout(() => {
        st.remove();
        for (const a of pvAudios) { try { a.pause(); } catch { /* ignore */ } }
        pvAudios.length = 0;
      }, (options.animOutMs || 350) + 50);
    }, clamp(options.durationS, 0.5, 60) * 1000);
  });
}

// Planification
$('scheduleBtn').onclick = () => { if (!hasContent()) { $('sendErr').textContent = 'Compose a meme first.'; return; } $('schModal').classList.remove('hidden'); };
$('schCancel').onclick = () => $('schModal').classList.add('hidden');
$('schType').onchange = (e) => {
  const t = e.target.value;
  $('schIn').classList.toggle('hidden', !(t === 'in' || t === 'afterStart'));
  $('schAt').classList.toggle('hidden', t !== 'at');
  $('schRec').classList.toggle('hidden', t !== 'recurring');
};
function buildDays() { const c = $('schDays'); DAYS.forEach(([lbl, val]) => { const b = document.createElement('button'); b.textContent = lbl; b.dataset.day = val; b.onclick = () => b.classList.toggle('active'); c.appendChild(b); }); }
$('schOk').onclick = async () => {
  $('schErr').textContent = '';
  const t = $('schType').value;
  let trigger = {};
  if (t === 'in') trigger = { type: 'at', delayMs: (+$('schMinutes').value || 1) * 60000 };
  else if (t === 'afterStart') trigger = { type: 'at', delayMs: (+$('schMinutes').value || 1) * 60000 }; // planifié maintenant depuis le client
  else if (t === 'at') { const dt = $('schDatetime').value; if (!dt) { $('schErr').textContent = 'Pick a date.'; return; } trigger = { type: 'at', at: new Date(dt).getTime() }; }
  else { const days = [...$('schDays').querySelectorAll('.active')].map((b) => +b.dataset.day); if (!days.length) { $('schErr').textContent = 'Pick at least one day.'; return; } trigger = { type: 'recurring', days, time: $('schTime').value || '12:00' }; }
  const btn = $('schOk'); btn.disabled = true; btn.textContent = '…';
  try {
    // Même composition navigateur que pour un envoi : le serveur compose sinon
    // les calques avec ffmpeg dès la création de la planification.
    const payload = await buildPayloadForSend(encodeProgressUI(btn, $('schErr')));
    clearHint($('schErr'));
    await api.scheduleMeme({ ...payload, label: $('schLabel').value || '', trigger });
    $('schModal').classList.add('hidden'); $('sendErr').style.color = 'var(--success)'; $('sendErr').textContent = 'Meme scheduled ✓';
    setTimeout(() => { $('sendErr').style.color = ''; $('sendErr').textContent = ''; }, 2500);
  } catch (e) { clearHint($('schErr')); $('schErr').textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = 'Schedule'; }
};
