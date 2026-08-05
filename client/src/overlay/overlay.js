// ============================================================
//  Overlay renderer — affiche les memes.
//
//  • Cadre TOUJOURS 16/9 (ancre+taille OU cadre libre défini à la main).
//  • Tailles texte/éléments RELATIVES au cadre 16/9 → rendu identique
//    quel que soit l'écran/la résolution.
//  • Modes : file d'attente (un à la fois + cooldown) ou concurrent (N max).
//  • Sécurité : tout texte via textContent (jamais innerHTML).
// ============================================================
(() => {
  const root = document.getElementById('root');
  const queue = [];
  let active = 0;              // memes actuellement à l'écran
  let cooldownUntil = 0;
  let settings = null;
  const api = window.memedrop;

  api.getConfig().then((c) => { settings = c; });
  api.onOverlaySettings((c) => { settings = c; });
  api.onOverlayClear(() => { root.replaceChildren(); active = 0; cooldownUntil = 0; hideCooldown(); pump(); });
  api.onOverlayMeme(({ meme, settings: s }) => {
    settings = s || settings;
    // Son de notification discret à l'arrivée (#34), opt-in et jamais si mute.
    if (settings?.fun?.notifySound && settings?.playback?.muteAll !== true) notifyPop();
    queue.push(meme);
    pump();
  });
  // Toast temporaire (réaction reçue / action de blocage) — #6/#15.
  api.onOverlayToast?.(({ text }) => showToast(text));
  // Réactions flottantes (#3), « Vu par » (#1), effets de seuil (#7).
  api.onOverlayFloat?.(({ emoji }) => floatEmoji(emoji));
  api.onOverlaySeen?.(({ name }) => showSeen(name));
  api.onOverlayMilestone?.((info) => celebrate(info));
  api.onOverlayDownload?.((info) => showDownload(info));

  function showToast(text) {
    const t = document.createElement('div');
    t.className = 'md-toast';
    t.textContent = text;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 2600);
  }

  // --- Réactions flottantes (#3) : emoji qui monte et s'estompe ------------
  function floatEmoji(emoji) {
    if (!emoji) return;
    const el = document.createElement('div');
    el.className = 'md-float';
    el.textContent = emoji;
    // Départ en bas, colonne aléatoire au centre de l'écran.
    const left = 42 + Math.random() * 16;           // 42%..58%
    el.style.left = `${left}vw`;
    el.style.setProperty('--drift', `${(Math.random() * 80 - 40).toFixed(0)}px`);
    el.style.setProperty('--rot', `${(Math.random() * 40 - 20).toFixed(0)}deg`);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  // --- « Vu par » (#1) : pastille cumulée en haut à droite -----------------
  let seenBox = null;
  let seenTimer = null;
  function showSeen(name) {
    if (!seenBox) {
      seenBox = document.createElement('div');
      seenBox.className = 'md-seen';
      document.body.appendChild(seenBox);
    }
    const pill = document.createElement('span');
    pill.className = 'md-seen-pill';
    pill.textContent = `👀 ${name}`;
    seenBox.appendChild(pill);
    requestAnimationFrame(() => pill.classList.add('show'));
    // Ne garde que les 5 derniers spectateurs affichés.
    while (seenBox.children.length > 5) seenBox.firstChild.remove();
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => {
      if (seenBox) { seenBox.classList.add('fade'); setTimeout(() => { seenBox?.remove(); seenBox = null; }, 500); }
    }, 4000);
  }

  // --- Effets de seuil de réactions (#7) : confettis + son -----------------
  function celebrate(info) {
    const total = info?.total || 0;
    // Bannière.
    const banner = document.createElement('div');
    banner.className = 'md-milestone';
    banner.textContent = `🎉 ${total} reactions!`;
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('show'));
    setTimeout(() => { banner.classList.remove('show'); setTimeout(() => banner.remove(), 500); }, 2600);
    // Confettis.
    const colors = ['#ff4d2e', '#ffd23f', '#3fd0ff', '#7cff6b', '#c86bff', '#ffffff'];
    const N = 80;
    for (let i = 0; i < N; i++) {
      const c = document.createElement('div');
      c.className = 'md-confetti';
      c.style.left = `${Math.random() * 100}vw`;
      c.style.background = colors[i % colors.length];
      c.style.setProperty('--x', `${(Math.random() * 200 - 100).toFixed(0)}px`);
      c.style.setProperty('--delay', `${(Math.random() * 0.4).toFixed(2)}s`);
      c.style.setProperty('--dur', `${(1.6 + Math.random() * 1.2).toFixed(2)}s`);
      c.style.setProperty('--rot', `${(Math.random() * 720 - 360).toFixed(0)}deg`);
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 3200);
    }
    // Son de célébration (WebAudio, aucun fichier requis) — respecte le mute.
    if (settings?.playback?.muteAll !== true && settings?.fun?.soundEffects !== false) chime();
  }

  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const notes = [523.25, 659.25, 783.99, 1046.5]; // Do-Mi-Sol-Do (arpège)
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = f;
        const t0 = ctx.currentTime + i * 0.09;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.4);
      });
      setTimeout(() => { try { ctx.close(); } catch { /* ignore */ } }, 900);
    } catch { /* ignore */ }
  }

  const clamp = (v, min, max) => Math.min(max, Math.max(min, Number.isFinite(+v) ? +v : min));

  function maxActive() {
    const pb = settings?.playback || {};
    return pb.displayMode === 'concurrent' ? clamp(pb.maxConcurrent ?? 3, 1, 12) : 1;
  }

  // Calcule le cadre 16/9 (position + taille en px écran).
  // Taille ET position du cadre expéditeur : relatives à une ZONE DE RÉFÉRENCE
  // 16/9 centrée dans l'écran (refW×refH). Sur un écran 16/9 elle couvre tout ;
  // sur un ultrawide (21/9, 32/9) elle est centrée → le placement choisi par
  // l'expéditeur tombe au même endroit visuel sur n'importe quel écran.
  function computeStage(opt) {
    const W = window.innerWidth, H = window.innerHeight;
    const refW = Math.min(W, H * 16 / 9); // largeur d'un cadre 16/9 plein écran
    const refH = refW * 9 / 16;
    const offX = (W - refW) / 2, offY = (H - refH) / 2;
    const ov = settings?.overlay || {};
    const senderControls = ov.allowSenderPosition !== false && (opt.box || opt.anchor || opt.scale);

    let w, h, x, y;

    if (senderControls && opt.box && Number.isFinite(+opt.box.wPct)) {
      // L'expéditeur a défini un cadre libre (page de placement avant envoi)
      // exprimé en fractions d'un écran 16/9 → mappé sur la zone de référence.
      w = clamp(opt.box.wPct, 0.02, 1) * refW;
      h = w * 9 / 16;
      x = offX + clamp(opt.box.xPct ?? 0.5 - opt.box.wPct / 2, 0, 1) * refW;
      y = offY + clamp(opt.box.yPct ?? 0.5, 0, 1) * refH;
    } else if (senderControls && (opt.anchor || opt.scale)) {
      ({ w, h, x, y } = anchorBox(opt.anchor || 'center', clamp(opt.scale ?? 0.5, 0.02, 1), W, H, refW, ov.marginPct));
    } else if (ov.mode === 'manual' && ov.manual) {
      w = clamp(ov.manual.wPct, 0.02, 1) * refW;
      h = w * 9 / 16;
      x = clamp(ov.manual.xPct, 0, 1) * W;
      y = clamp(ov.manual.yPct, 0, 1) * H;
    } else {
      ({ w, h, x, y } = anchorBox(ov.anchor || 'center', clamp((ov.sizePct ?? 42) / 100, 0.02, 1), W, H, refW, ov.marginPct));
    }

    // Cap taille max en pixels (utile quand l'expéditeur choisit).
    const cap = senderControls ? (ov.maxWidthPx || 0) : 0;
    if (cap > 0 && w > cap) { w = cap; h = w * 9 / 16; }

    // Ne jamais dépasser l'écran.
    if (w > W) { w = W; h = w * 9 / 16; }
    if (h > H) { h = H; w = h * 16 / 9; }
    x = clamp(x, 0, W - w);
    y = clamp(y, 0, H - h);
    return { x, y, w, h };
  }

  function anchorBox(anchor, scale, W, H, refW, marginPct) {
    const margin = (clamp(marginPct ?? 3, 0, 20) / 100) * Math.min(W, H);
    let w = scale * refW;
    let h = w * 9 / 16;
    if (h > H * 0.98) { h = H * 0.98; w = h * 16 / 9; }
    let x, y;
    if (anchor.includes('left')) x = margin;
    else if (anchor.includes('right')) x = W - w - margin;
    else x = (W - w) / 2;
    if (anchor.includes('top')) y = margin;
    else if (anchor.includes('bottom')) y = H - h - margin;
    else y = (H - h) / 2;
    return { w, h, x, y };
  }

  // Volume : la valeur locale est un PLAFOND. L'expéditeur choisit son volume,
  // mais on ne dépasse jamais le « volume max » réglé sur ce client.
  function effectiveVolume(opt) {
    const pb = settings?.playback || {};
    if (pb.muteAll) return 0;
    return clamp(Math.min(pb.volume ?? 0.7, opt.volume ?? 1), 0, 1);
  }

  function maxDurationFor(kind, opt) {
    const pb = settings?.playback || {};
    const caps = { image: pb.maxImageDurationS, gif: pb.maxGifDurationS, video: pb.maxVideoDurationS, audio: pb.maxAudioDurationS, text: pb.maxImageDurationS };
    const cap = caps[kind] || 15;
    return clamp(opt.durationS ?? Math.min(cap, 6), 0.5, cap);
  }

  // Texte dimensionné RELATIVEMENT à la largeur du cadre 16/9 (stageW en px).
  function makeText(text, opt, inCard, stageW) {
    const el = document.createElement('div');
    el.className = 'meme-text ' + (inCard ? 'in-card' : 'pos-' + (['top', 'center', 'bottom'].includes(opt.textPos) ? opt.textPos : 'bottom'));
    el.textContent = text;
    el.style.color = /^#[0-9a-fA-F]{6}$/.test(opt.textColor || '') ? opt.textColor : '#ffffff';
    // Largeur : c'est la ligne la PLUS LONGUE qui dicte la taille. Se fonder sur
    // la longueur totale rapetisserait tout le bloc à chaque ligne ajoutée
    // (pour un texte d'une seule ligne, les deux reviennent au même).
    const lines = String(text || '').split('\n');
    const len = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const frac = len < 20 ? 0.11 : len < 60 ? 0.075 : len < 120 ? 0.055 : 0.045;
    let px = Math.max(10, frac * stageW);
    // Hauteur : n lignes ne doivent pas déborder du cadre 16/9.
    if (lines.length > 1) {
      const stageH = stageW * 9 / 16;
      px = Math.max(10, Math.min(px, (stageH * (inCard ? 0.8 : 0.7)) / (lines.length * 1.15)));
    }
    el.style.fontSize = `${px}px`;
    el.style.setProperty('--stroke', `${Math.max(1, px * 0.06)}px`);
    return el;
  }

  function pump() {
    while (queue.length && active < maxActive()) {
      if (maxActive() === 1 && Date.now() < cooldownUntil) {
        showCooldown();
        setTimeout(pump, cooldownUntil - Date.now() + 20);
        return;
      }
      const meme = queue.shift();
      active++;
      try { show(meme); } catch (e) { console.error(e); done(meme, null); }
    }
    if (!(queue.length && Date.now() < cooldownUntil)) hideCooldown();
  }

  // --- Compte à rebours de cooldown (#33) : file d'attente en mode « queue » ---
  let cdEl = null, cdTimer = null;
  function showCooldown() {
    if (!cdEl) {
      cdEl = document.createElement('div');
      cdEl.className = 'md-cooldown';
      document.body.appendChild(cdEl);
    }
    cdEl.style.display = 'flex';
    clearInterval(cdTimer);
    const tick = () => {
      const remain = Math.max(0, cooldownUntil - Date.now());
      const waiting = queue.length;
      cdEl.textContent = `⏳ ${(remain / 1000).toFixed(1)}s` + (waiting > 1 ? ` · ${waiting} queued` : waiting === 1 ? ' · 1 queued' : '');
      if (remain <= 0 && waiting === 0) hideCooldown();
    };
    tick(); cdTimer = setInterval(tick, 100);
  }
  function hideCooldown() { clearInterval(cdTimer); if (cdEl) cdEl.style.display = 'none'; }

  // --- Son de notification (#34) : petit « pop » WebAudio, aucun fichier ---
  function notifyPop() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ctx = new AC();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(880, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
      g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.22);
      setTimeout(() => { try { ctx.close(); } catch { /* ignore */ } }, 500);
    } catch { /* ignore */ }
  }

  // --- Barre de progression de téléchargement (#13) ------------------------
  let dlEl = null, dlBar = null, dlHideT = null;
  function showDownload(info) {
    if (!dlEl) {
      dlEl = document.createElement('div'); dlEl.className = 'md-download';
      const lbl = document.createElement('span'); lbl.textContent = '⬇️';
      const track = document.createElement('div'); track.className = 'md-dl-track';
      dlBar = document.createElement('div'); dlBar.className = 'md-dl-bar'; track.appendChild(dlBar);
      dlEl.append(lbl, track); document.body.appendChild(dlEl);
    }
    dlEl.style.display = 'flex';
    dlBar.style.width = `${clamp(info.pct ?? 0, 0, 100)}%`;
    clearTimeout(dlHideT);
    if (info.done || (info.pct ?? 0) >= 100) dlHideT = setTimeout(() => { if (dlEl) dlEl.style.display = 'none'; }, 500);
  }

  // --- Carte d'erreur média (#45) : média illisible → message au lieu du silence ---
  function mediaErrorCard() {
    const card = document.createElement('div');
    card.className = 'error-card';
    card.textContent = '⚠️ Media failed to load';
    return card;
  }

  function show(meme) {
    const opt = meme.options || {};
    const kind = meme.kind || 'text';
    const { x, y, w, h } = computeStage(opt);
    const ov = settings?.overlay || {};
    const senderControls = ov.allowSenderPosition !== false;

    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.style.left = `${x}px`;
    stage.style.top = `${y}px`;
    stage.style.width = `${w}px`;
    stage.style.height = `${h}px`;
    stage.style.opacity = String(clamp(senderControls && opt.opacity != null ? opt.opacity : (ov.opacity ?? 0.95), 0.1, 1));
    // Léger décalage en cascade si plusieurs memes simultanés au même endroit.
    if (active > 1) { const off = (active - 1) * 18; stage.style.transform = `translate(${off}px, ${off}px)`; }

    const anim = ['none', 'fade', 'slide', 'bounce', 'shake'].includes(opt.animation) ? opt.animation : 'fade';
    const inClass = { none: 'anim-none-in', fade: 'anim-fade-in', slide: 'anim-slide-in', bounce: 'anim-bounce-in', shake: 'anim-shake' }[anim];
    // Durées d'animation choisies par l'expéditeur (bornées côté serveur).
    const animInMs = clamp(opt.animInMs ?? 350, 80, 5000);
    const animOutMs = clamp(opt.animOutMs ?? 350, 80, 5000);
    stage.style.animationDuration = `${animInMs}ms`;

    if (meme.sender) {
      const tag = document.createElement('div');
      tag.className = 'sender-tag';
      // L'étiquette est ancrée au-dessus du cadre (top: -34px). Si le cadre est
      // tout en haut de l'écran, elle sortirait de l'écran (clippée) → on la
      // bascule À L'INTÉRIEUR du cadre pour que le nom reste visible.
      if (y < 40) tag.classList.add('inside');
      // Avatar de l'expéditeur, à gauche du pseudo. Repli : pastille avec
      // l'initiale (couleur stable dérivée du pseudo) si pas d'avatar Discord
      // connu ou si son chargement échoue — il y a TOUJOURS une image.
      const letterAvatar = () => {
        const d = document.createElement('div');
        d.className = 'sender-avatar sender-avatar-letter';
        d.textContent = (String(meme.sender).trim()[0] || '?').toUpperCase();
        const hue = [...String(meme.sender)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
        d.style.background = `hsl(${hue} 60% 40%)`;
        return d;
      };
      if (meme.senderAvatar) {
        const av = document.createElement('img');
        av.className = 'sender-avatar';
        av.src = meme.senderAvatar;
        av.addEventListener('error', () => av.replaceWith(letterAvatar()));
        tag.appendChild(av);
      } else {
        tag.appendChild(letterAvatar());
      }
      const name = document.createElement('span');
      name.className = 'sender-name';
      name.textContent = String(meme.sender);
      // Style personnalisé du pseudo (profil de l'expéditeur) : couleur + glow.
      const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : null);
      const color = hex(meme.senderColor) || '#ffffff';
      const glow = hex(meme.senderGlow) || hex(meme.senderColor) || '#ff4d2e';
      name.style.color = color;
      name.style.textShadow = `0 0 6px ${glow}, 0 0 16px ${glow}`;
      tag.appendChild(name);
      stage.appendChild(tag);
    }

    let mediaEl = null;
    const durationS = maxDurationFor(kind, opt);
    let endTimer = null;
    const finish = () => { clearTimeout(endTimer); animateOut(stage, anim, animOutMs, () => done(meme, stage)); };

    const isMediaKind = kind === 'image' || kind === 'gif' || kind === 'video' || kind === 'audio';
    if (isMediaKind && !meme.localPath) {
      // Média attendu mais fichier local manquant (téléchargement échoué) :
      // carte d'erreur explicite plutôt qu'une carte de texte vide et muette.
      const box = document.createElement('div'); box.className = 'media-box';
      box.appendChild(mediaErrorCard());
      if (meme.text && !opt.bakedText) box.appendChild(makeText(meme.text, opt, false, w));
      stage.appendChild(box);
      endTimer = setTimeout(finish, durationS * 1000);
    } else if (kind === 'text' || !meme.localPath) {
      const wantBg = ov.textBackground !== false;
      if (wantBg) {
        const card = document.createElement('div');
        card.className = 'text-card';
        card.appendChild(makeText(meme.text || '', opt, true, w));
        stage.appendChild(card);
      } else {
        // Pas de fond : juste le texte, centré verticalement, lisible (contour).
        const t = makeText(meme.text || '', { ...opt, textPos: 'center' }, false, w);
        t.classList.add('no-bg');
        stage.appendChild(t);
      }
      endTimer = setTimeout(finish, durationS * 1000);
    } else if (kind === 'image') {
      const box = document.createElement('div'); box.className = 'media-box';
      const img = document.createElement('img'); img.src = meme.localPath;
      img.addEventListener('error', () => box.replaceChildren(mediaErrorCard()));
      box.appendChild(img);
      if (meme.text && !opt.bakedText) box.appendChild(makeText(meme.text, opt, false, w));
      stage.appendChild(box);
      endTimer = setTimeout(finish, durationS * 1000);
    } else if (kind === 'gif' || kind === 'video') {
      const box = document.createElement('div'); box.className = 'media-box';
      mediaEl = document.createElement('video');
      mediaEl.src = meme.localPath;
      mediaEl.autoplay = true;
      mediaEl.playsInline = true;
      if (kind === 'gif' || meme.media?.muted) { mediaEl.muted = true; mediaEl.loop = true; }
      else { mediaEl.volume = effectiveVolume(opt); mediaEl.muted = effectiveVolume(opt) === 0; }
      mediaEl.addEventListener('error', () => { box.replaceChildren(mediaErrorCard()); });
      box.appendChild(mediaEl);
      // Éléments composés (texte/stickers/dessin) au-dessus de la vidéo —
      // fichier local (téléchargé par le main), la CSP bloque le distant.
      if (meme.localOverlayPath || meme.overlay?.url) {
        const ov = document.createElement('img'); ov.className = 'overlay-layer'; ov.src = meme.localOverlayPath || meme.overlay.url; box.appendChild(ov);
      }
      if (meme.text && !opt.bakedText) box.appendChild(makeText(meme.text, opt, false, w));
      stage.appendChild(box);
      mediaEl.addEventListener('ended', () => { if (!mediaEl.loop) finish(); });
      endTimer = setTimeout(finish, durationS * 1000);
      mediaEl.play?.().catch(() => {});
    } else if (kind === 'audio') {
      const card = document.createElement('div'); card.className = 'audio-card';
      const bars = document.createElement('div'); bars.className = 'bars';
      for (let i = 0; i < 7; i++) { const s = document.createElement('span'); s.style.animationDelay = `${i * 0.1}s`; bars.appendChild(s); }
      card.appendChild(bars);
      if (meme.localOverlayPath || meme.overlay?.url) { const o = document.createElement('img'); o.className = 'overlay-layer'; o.src = meme.localOverlayPath || meme.overlay.url; card.appendChild(o); }
      if (meme.text && !opt.bakedText) card.appendChild(makeText(meme.text, { ...opt, textColor: '#ffffff' }, true, w));
      mediaEl = document.createElement('audio');
      mediaEl.src = meme.localPath; mediaEl.autoplay = true;
      mediaEl.volume = effectiveVolume(opt); mediaEl.muted = effectiveVolume(opt) === 0;
      card.appendChild(mediaEl);
      stage.appendChild(card);
      mediaEl.addEventListener('ended', finish);
      endTimer = setTimeout(finish, durationS * 1000);
      mediaEl.play?.().catch(() => {});
    }

    // Sons additionnels (assets) joués ensemble à l'apparition, indépendants du
    // média. Fichier local obligatoire : la CSP de l'overlay refuse l'audio distant.
    const sfxPaths = meme.localSoundPaths?.length ? meme.localSoundPaths
      : (meme.localSoundPath ? [meme.localSoundPath] : []);
    for (const src of sfxPaths) {
      const sfx = document.createElement('audio');
      sfx.src = src; sfx.autoplay = true;
      sfx.volume = effectiveVolume(opt);
      sfx.muted = sfx.volume === 0;
      stage.appendChild(sfx);
      sfx.play?.().catch(() => {});
    }

    stage.classList.add(inClass);
    root.appendChild(stage);
    // Accusé « affiché » (#2) — le meme est réellement à l'écran.
    if (meme.id && meme.id !== 'test') api.memeDisplayed?.(meme.id, meme.channel);
  }

  function animateOut(stage, anim, outMs, cb) {
    const outClass = { slide: 'anim-slide-out' }[anim] || 'anim-fade-out';
    stage.classList.remove('anim-fade-in', 'anim-slide-in', 'anim-bounce-in', 'anim-shake', 'anim-none-in');
    stage.style.animationDuration = `${outMs}ms`;
    stage.classList.add(outClass);
    setTimeout(cb, outMs + 20);
  }

  function done(meme, stage) {
    // Couper le son AVANT de retirer la scène : un <audio>/<video> détaché du
    // document continue de jouer sous Chromium. Un son plus long que le meme
    // (ou un meme volontairement raccourci par l'expéditeur) continuait donc
    // à s'entendre alors que plus rien n'était affiché.
    if (stage) {
      for (const m of stage.querySelectorAll('audio, video')) {
        try { m.pause(); m.removeAttribute('src'); m.load(); } catch { /* ignore */ }
      }
    }
    if (stage && stage.parentNode) stage.remove();
    active = Math.max(0, active - 1);
    try { api.memeFinished(meme.id); } catch {}
    // Cooldown uniquement en mode file d'attente.
    if (maxActive() === 1) cooldownUntil = Date.now() + clamp(settings?.playback?.cooldownS ?? 10, 0, 600) * 1000;
    pump();
  }
})();
