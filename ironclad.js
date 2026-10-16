/*
 * Ironclad browser runtime. The game itself is Java compiled to JavaScript by TeaVM (classes.js); this file
 * is everything the Android layer did: a Canvas 2D renderer with the same conventions as AndroidGfx, sprite
 * and font loading behind a splash, pointer input, localStorage saves, and the synth streamed through Web
 * Audio. The Java side reaches it through the global IC object (see web/src/.../JS.java).
 */
'use strict';
(function () {
  const IC = (window.IC = {});
  const BASE_W = 540, BASE_H = 960;
  const MAX_ASPECT = 0.75;          // wider screens get a portrait column, like a phone or tablet
  const MAX_BACKING_W = 1280;       // sprites are drawn for 1080 px across; more pixels only cost fill rate
  // the Android build's SharedPreferences file name, as a key prefix. The browser version is the free edition and
  // every site under rblizz24.github.io shares one localStorage, so it keeps its own save beside the old full one.
  const STORE = 'projectmtb.free.';
  const FONT_FILES = ['BebasNeue.otf', 'Play-Bold.ttf', 'Play-Regular.ttf', 'AlfaSlabOne.ttf'];
  const FONT_FALLBACK = ['Impact, sans-serif', 'sans-serif', 'sans-serif', 'Georgia, serif'];

  let canvas, ctx;
  let scale = 1, backing = 1, logicalW = BASE_W, logicalH = BASE_H, viewVersion = 0;
  let booted = false, gameReady = false;

  // ------------------------------------------------------------------ logging (also read by the CI smoke test)
  const logLines = [];
  IC.log = function (msg) {
    logLines.push(String(msg));
    if (logLines.length > 200) logLines.shift();
    console.log('[ironclad] ' + msg);
  };
  IC.logLines = function () { return logLines.slice(); };
  window.addEventListener('error', function (e) { IC.log('error: ' + (e.message || e)); });

  // ------------------------------------------------------------------ layout

  function layout() {
    const W = Math.max(1, window.innerWidth), H = Math.max(1, window.innerHeight);
    const gw = Math.min(W, Math.floor(H * MAX_ASPECT));
    scale = Math.min(gw / BASE_W, H / BASE_H);       // CSS pixels per logical unit
    logicalW = gw / scale;
    logicalH = H / scale;
    const dpr = window.devicePixelRatio || 1;
    backing = Math.min(dpr, MAX_BACKING_W / gw);
    canvas.style.width = gw + 'px';
    canvas.style.height = H + 'px';
    canvas.width = Math.round(gw * backing);
    canvas.height = Math.round(H * backing);
    initContext();
    viewVersion++;
  }

  function initContext() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'alphabetic';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    lastFont = '';
  }

  IC.viewVersion = function () { return viewVersion; };
  IC.viewW = function () { return logicalW; };
  IC.viewH = function () { return logicalH; };
  IC.pixelScale = function () { return scale * backing; };

  // ------------------------------------------------------------------ transform stack (mirrors Gfx save/restore)
  // [a, b, c, d, e, f] maps logical units to device pixels; x' = a*x + c*y + e, y' = b*x + d*y + f

  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let ctxDirty = true;

  function resetTransform() {
    const k = scale * backing;
    m = [k, 0, 0, k, 0, 0];
    stack.length = 0;
    ctxDirty = true;
  }

  function applyM() {
    if (ctxDirty) {
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctxDirty = false;
    }
  }

  IC.save = function () { stack.push(m.slice()); };
  IC.restore = function () { if (stack.length) { m = stack.pop(); ctxDirty = true; } };
  IC.translate = function (x, y) {
    m[4] += m[0] * x + m[2] * y;
    m[5] += m[1] * x + m[3] * y;
    ctxDirty = true;
  };
  IC.rotate = function (r) {
    const cs = Math.cos(r), sn = Math.sin(r);
    const a = m[0], b = m[1], c = m[2], d = m[3];
    m[0] = a * cs + c * sn; m[1] = b * cs + d * sn;
    m[2] = c * cs - a * sn; m[3] = d * cs - b * sn;
    ctxDirty = true;
  };
  IC.scale = function (sx, sy) {
    m[0] *= sx; m[1] *= sx; m[2] *= sy; m[3] *= sy;
    ctxDirty = true;
  };

  /** Set the context to m * T(x,y) * R(rot) * S(sx,sy) for one sprite. */
  function spriteTransform(x, y, rot, sx, sy) {
    let a = m[0], b = m[1], c = m[2], d = m[3];
    const e = m[4] + a * x + c * y, f = m[5] + b * x + d * y;
    if (rot !== 0) {
      const cs = Math.cos(rot), sn = Math.sin(rot);
      const a2 = a * cs + c * sn, b2 = b * cs + d * sn;
      c = c * cs - a * sn; d = d * cs - b * sn; a = a2; b = b2;
    }
    ctx.setTransform(a * sx, b * sx, c * sy, d * sy, e, f);
    ctxDirty = true;
  }

  // ------------------------------------------------------------------ colours

  const colours = new Map();
  function col(argb) {
    let s = colours.get(argb);
    if (s === undefined) {
      const a = ((argb >>> 24) & 255) / 255;
      s = 'rgba(' + ((argb >> 16) & 255) + ',' + ((argb >> 8) & 255) + ',' + (argb & 255) + ',' + a.toFixed(3) + ')';
      if (colours.size > 8192) colours.clear();
      colours.set(argb, s);
    }
    return s;
  }

  // ------------------------------------------------------------------ sprites

  const sprites = [];          // handle -> {name, w, h, img, fb, tints}
  const byName = new Map();
  const baseNames = [];        // sprites loaded before the game starts (everything but paint variants)
  const PAINT = /_p[1-7]$/;

  IC.img = function (name) { const h = byName.get(name); return h === undefined ? -1 : h; };
  IC.imgW = function (h) { return sprites[h].w; };
  IC.imgH = function (h) { return sprites[h].h; };
  IC.baseCount = function () { return baseNames.length; };
  IC.baseName = function (i) { return baseNames[i]; };

  function register(list) {
    for (const [name, pw, ph] of list) {
      const h = sprites.length;
      sprites.push({ name: name, w: pw / 2, h: ph / 2, img: null, fb: -1, tints: null });
      byName.set(name, h);
    }
    for (const s of sprites) {
      if (PAINT.test(s.name)) {
        const fb = byName.get(s.name.replace(PAINT, ''));
        if (fb !== undefined) s.fb = fb;
      } else {
        baseNames.push(s.name);
      }
    }
  }

  function loadSprite(h) {
    return new Promise(function (resolve) {
      const s = sprites[h];
      const im = new Image();
      im.decoding = 'async';
      im.onload = function () { s.img = im; resolve(true); };
      im.onerror = function () { IC.log('missing sprite ' + s.name); resolve(false); };
      im.src = 'assets/sprites/' + s.name + '.png';
    });
  }

  /** Load handles with a few requests in flight at a time, reporting progress. */
  async function loadAll(handles, onProgress, parallel) {
    let next = 0, done = 0;
    async function worker() {
      while (next < handles.length) {
        const h = handles[next++];
        await loadSprite(h);
        done++;
        if (onProgress) onProgress(done / handles.length);
      }
    }
    const workers = [];
    for (let i = 0; i < parallel; i++) workers.push(worker());
    await Promise.all(workers);
  }

  function imageOf(h) {
    const s = sprites[h];
    if (s.img) return s.img;
    return s.fb >= 0 ? sprites[s.fb].img : null;
  }

  IC.spr = function (h, x, y, rot, sx, sy, alpha) {
    if (!(alpha > 0.003)) return;
    const im = imageOf(h);
    if (!im) return;
    const s = sprites[h];
    spriteTransform(x, y, rot, sx, sy);
    ctx.globalAlpha = alpha >= 1 ? 1 : alpha;
    ctx.drawImage(im, -s.w / 2, -s.h / 2, s.w, s.h);
    ctx.globalAlpha = 1;
  };

  /** Flat silhouettes for shadows and flashes, cached per sprite and colour (4 bits per channel, as Android). */
  function silhouette(h, argb) {
    const s = sprites[h];
    const im = imageOf(h);
    if (!im) return null;
    const key = ((argb >> 20) & 0xF) << 8 | ((argb >> 12) & 0xF) << 4 | ((argb >> 4) & 0xF);
    if (!s.tints || s.tints.src !== im) s.tints = { src: im, map: new Map() };
    let c = s.tints.map.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = 'rgb(' + (((key >> 8) & 15) * 17) + ',' + (((key >> 4) & 15) * 17) + ',' + ((key & 15) * 17) + ')';
      g.fillRect(0, 0, c.width, c.height);
      s.tints.map.set(key, c);
    }
    return c;
  }

  IC.tint = function (h, x, y, rot, sc, argb) {
    const a = (argb >>> 24) & 255;
    if (a === 0) return;
    const sil = silhouette(h, argb);
    if (!sil) return;
    const s = sprites[h];
    spriteTransform(x, y, rot, sc, sc);
    ctx.globalAlpha = a / 255;
    ctx.drawImage(sil, -s.w / 2, -s.h / 2, s.w, s.h);
    ctx.globalAlpha = 1;
  };

  IC.sprRect = function (h, x, y, w, hh, alpha) {
    if (!(alpha > 0.003)) return;
    const im = imageOf(h);
    if (!im) return;
    applyM();
    ctx.globalAlpha = alpha >= 1 ? 1 : alpha;
    ctx.drawImage(im, x, y, w, hh);
    ctx.globalAlpha = 1;
  };

  // ------------------------------------------------------------------ shapes

  function roundRectPath(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  IC.fillRect = function (x, y, w, h, c) {
    if ((c >>> 24) === 0) return;
    applyM();
    ctx.fillStyle = col(c);
    ctx.fillRect(x, y, w, h);
  };
  IC.fillRoundRect = function (x, y, w, h, r, c) {
    if ((c >>> 24) === 0 || w <= 0 || h <= 0) return;
    applyM();
    ctx.fillStyle = col(c);
    roundRectPath(x, y, w, h, r);
    ctx.fill();
  };
  IC.strokeRect = function (x, y, w, h, lw, c) {
    if ((c >>> 24) === 0) return;
    applyM();
    ctx.strokeStyle = col(c);
    ctx.lineWidth = lw;
    ctx.strokeRect(x, y, w, h);
  };
  IC.strokeRoundRect = function (x, y, w, h, r, lw, c) {
    if ((c >>> 24) === 0 || w <= 0 || h <= 0) return;
    applyM();
    ctx.strokeStyle = col(c);
    ctx.lineWidth = lw;
    roundRectPath(x, y, w, h, r);
    ctx.stroke();
  };
  IC.fillCircle = function (x, y, r, c) {
    if ((c >>> 24) === 0 || !(r > 0)) return;
    applyM();
    ctx.fillStyle = col(c);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  IC.strokeCircle = function (x, y, r, lw, c) {
    if ((c >>> 24) === 0 || !(r > 0)) return;
    applyM();
    ctx.strokeStyle = col(c);
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  /** Clockwise radians from +x in screen space, the same convention as the core and Android's drawArc. */
  IC.arc = function (x, y, r, a0, sweep, lw, c) {
    if ((c >>> 24) === 0 || !(r > 0) || sweep === 0) return;
    applyM();
    ctx.strokeStyle = col(c);
    ctx.lineWidth = lw;
    ctx.beginPath();
    if (Math.abs(sweep) >= Math.PI * 2) ctx.arc(x, y, r, 0, Math.PI * 2);
    else ctx.arc(x, y, r, a0, a0 + sweep, sweep < 0);
    ctx.stroke();
  };
  IC.line = function (x1, y1, x2, y2, lw, c) {
    if ((c >>> 24) === 0) return;
    applyM();
    ctx.strokeStyle = col(c);
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  let polyN = 0;
  IC.polyBegin = function () { applyM(); ctx.beginPath(); polyN = 0; };
  IC.polyPt = function (x, y) { if (polyN++ === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); };
  IC.polyFill = function (c) {
    if (polyN < 3) return;
    ctx.closePath();
    ctx.fillStyle = col(c);
    ctx.fill();
  };

  // ------------------------------------------------------------------ text

  let lastFont = '';
  function setFont(f, size) {
    const px = Math.round(size * 4) / 4;
    const s = px + 'px IC' + f + ',' + FONT_FALLBACK[f];
    if (s !== lastFont) { ctx.font = s; lastFont = s; }
  }
  const ALIGN = ['left', 'center', 'right'];
  IC.text = function (s, x, y, f, size, c, align) {
    if ((c >>> 24) === 0) return;
    applyM();
    setFont(f, size);
    ctx.textAlign = ALIGN[align] || 'left';
    ctx.fillStyle = col(c);
    ctx.fillText(s, x, y);
  };
  IC.textWidth = function (s, f, size) {
    setFont(f, size);
    return ctx.measureText(s).width;
  };

  async function loadFonts() {
    const jobs = FONT_FILES.map(function (file, i) {
      if (!window.FontFace) return Promise.resolve();
      const face = new FontFace('IC' + i, 'url(assets/fonts/' + file + ')');
      return face.load().then(function (f) { document.fonts.add(f); }).catch(function () { IC.log('font failed: ' + file); });
    });
    await Promise.all(jobs);
  }

  // ------------------------------------------------------------------ storage and device

  const memoryStore = new Map();   // when localStorage is blocked (private mode, sandboxed previews)
  IC.shas = function (k) {
    try { return window.localStorage.getItem(STORE + k) !== null; } catch (e) { return memoryStore.has(k); }
  };
  IC.sget = function (k) {
    try { const v = window.localStorage.getItem(STORE + k); return v === null ? '' : v; } catch (e) { return memoryStore.get(k) || ''; }
  };
  IC.sput = function (k, v) {
    try { window.localStorage.setItem(STORE + k, v); } catch (e) { memoryStore.set(k, v); }
  };
  IC.query = function (name) {
    try { return new URLSearchParams(window.location.search).has(name); } catch (e) { return false; }
  };
  IC.vibrate = function (ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* not allowed */ } };
  IC.copyText = function (text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(function () { }); return; }
    } catch (e) { /* fall through */ }
    try {
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t);
    } catch (e) { /* no clipboard */ }
  };
  IC.openUrl = function (url) { try { window.open(url, '_blank', 'noopener'); } catch (e) { /* popup blocked */ } };

  // ------------------------------------------------------------------ input

  let touchFn = null, backFn = null, visibleFn = null;
  const pointerSlot = new Map();   // browser pointer ids can be large; the game gets small slots 0..9

  function slotFor(id, create) {
    let s = pointerSlot.get(id);
    if (s === undefined && create) {
      const used = new Set(pointerSlot.values());
      s = 0;
      while (used.has(s)) s++;
      pointerSlot.set(id, s);
    }
    return s;
  }

  function toLogical(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
  }

  function sendTouch(kind, e) {
    if (!touchFn) return;
    const create = kind === 0;
    const s = slotFor(e.pointerId, create);
    if (s === undefined) return;
    const p = toLogical(e);
    try { touchFn(kind, s, p[0], p[1]); } catch (err) { IC.log('touch error: ' + err); }
    if (kind >= 2) pointerSlot.delete(e.pointerId);
  }

  function installInput() {
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      unlockAudio();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
      sendTouch(0, e);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!pointerSlot.has(e.pointerId)) return;
      e.preventDefault();
      sendTouch(1, e);
    });
    canvas.addEventListener('pointerup', function (e) { e.preventDefault(); sendTouch(2, e); });
    canvas.addEventListener('pointercancel', function (e) { sendTouch(3, e); });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    installKeyboard();
    window.addEventListener('keydown', function (e) {
      if (e.target === kb) return;      // typing in the seed box
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (backFn) backFn();
      }
    });
    // the phone's back gesture: keep one history entry in hand and give it to the game first
    try {
      history.pushState({ ironclad: 1 }, '');
      window.addEventListener('popstate', function () {
        let used = false;
        try { used = backFn ? !!backFn() : false; } catch (err) { IC.log('back error: ' + err); }
        if (used) history.pushState({ ironclad: 1 }, '');
      });
    } catch (err) { /* history not available */ }
    document.addEventListener('visibilitychange', function () {
      const visible = !document.hidden;
      if (visibleFn) visibleFn(visible);
      if (actx) { if (visible) actx.resume(); else actx.suspend(); }
      lastT = 0;
    });
  }

  // ---- the seed box: a real (invisible) text input laid over the game's box, so phones bring up their keyboard.
  // The input is the source of truth while open; the game reads it each frame, formats it and writes it back.
  let kb = null, kbWanted = false, kbRect = null, kbText = null, kbEnter = false;

  function installKeyboard() {
    kb = document.createElement('input');
    kb.type = 'text';
    kb.setAttribute('autocapitalize', 'characters');
    kb.setAttribute('autocomplete', 'off');
    kb.setAttribute('autocorrect', 'off');
    kb.setAttribute('spellcheck', 'false');
    kb.setAttribute('enterkeyhint', 'done');
    kb.setAttribute('aria-label', 'Seed');
    kb.maxLength = 12;
    kb.style.cssText = 'position:fixed;display:none;opacity:0.01;font-size:16px;border:0;padding:0;margin:0;'
      + 'background:transparent;color:transparent;caret-color:transparent;outline:none;z-index:5;';
    document.body.appendChild(kb);
    kb.addEventListener('input', function () { kbText = kb.value; });
    kb.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); kbEnter = true; }
      else if (e.key === 'Escape') { e.preventDefault(); kb.blur(); if (backFn) backFn(); }
    });
  }

  function placeKeyboard() {
    if (!kb) return;
    if (!kbWanted || !kbRect) { kb.style.display = 'none'; return; }
    const r = canvas.getBoundingClientRect();
    kb.style.display = 'block';
    kb.style.left = (r.left + kbRect[0] * scale) + 'px';
    kb.style.top = (r.top + kbRect[1] * scale) + 'px';
    kb.style.width = (kbRect[2] * scale) + 'px';
    kb.style.height = (kbRect[3] * scale) + 'px';
  }

  IC.keyboard = function (show, text) {
    kbWanted = show;
    if (!kb) return;
    if (show) {
      kb.value = text;
      placeKeyboard();
      try { kb.focus({ preventScroll: true }); } catch (e) { /* needs a tap on iOS: the box itself */ }
    } else {
      kbRect = null;
      placeKeyboard();
      kb.blur();
    }
  };
  IC.keyboardText = function (text) { if (kb && kb.value !== text) kb.value = text; };
  IC.textField = function (x, y, w, h) {
    if (!kbRect || kbRect[0] !== x || kbRect[1] !== y || kbRect[2] !== w || kbRect[3] !== h) { kbRect = [x, y, w, h]; placeKeyboard(); }
  };
  IC.hasText = function () { return kbText !== null; };
  IC.takeText = function () { const t = kbText; kbText = null; return t === null ? '' : t; };
  IC.takeEnter = function () { const e = kbEnter; kbEnter = false; return e; };

  IC.onTouch = function (fn) { touchFn = fn; };
  IC.onBack = function (fn) { backFn = fn; };
  IC.onVisible = function (fn) { visibleFn = fn; };

  // ------------------------------------------------------------------ audio
  // The synth renders mono 16-bit at its own rate (22050 Hz). The context runs at that rate when the browser
  // allows it; otherwise samples are resampled linearly. Browsers only start audio after a tap.

  let actx = null, proc = null, fillFn = null, synthRate = 22050, step = 1;
  let fifo = new Float32Array(16384), fifoStart = 0, fifoLen = 0, phase = 0;

  IC.audioInit = function (fn, rate) { fillFn = fn; synthRate = rate; };
  IC.apush = function (v) {
    if (fifoStart + fifoLen >= fifo.length) {
      fifo.copyWithin(0, fifoStart, fifoStart + fifoLen);
      fifoStart = 0;
      if (fifoLen >= fifo.length) return;
    }
    fifo[fifoStart + fifoLen++] = v / 32768;
  };

  function ensure(n) {
    let guard = 0;
    while (fifoLen < n && guard++ < 64) {
      const before = fifoLen;
      try { fillFn(Math.max(256, n - fifoLen)); } catch (err) { IC.log('audio error: ' + err); return false; }
      if (fifoLen === before) return false;
    }
    return fifoLen >= n;
  }

  function onAudio(ev) {
    const out = ev.outputBuffer.getChannelData(0);
    const n = out.length;
    if (!fillFn || !gameReady) { out.fill(0); return; }
    if (step === 1) {
      if (!ensure(n)) { out.fill(0); return; }
      out.set(fifo.subarray(fifoStart, fifoStart + n));
      fifoStart += n; fifoLen -= n;
      return;
    }
    const need = Math.ceil(phase + n * step) + 2;
    if (!ensure(need)) { out.fill(0); return; }
    let p = phase;
    for (let i = 0; i < n; i++) {
      const k = p | 0, t = p - k;
      out[i] = fifo[fifoStart + k] * (1 - t) + fifo[fifoStart + k + 1] * t;
      p += step;
    }
    const used = p | 0;
    fifoStart += used; fifoLen -= used; phase = p - used;
  }

  function unlockAudio() {
    if (!fillFn) return;
    try {
      if (!actx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try { actx = new AC({ sampleRate: synthRate }); } catch (e) { actx = new AC(); }
        step = synthRate / actx.sampleRate;
        const size = actx.sampleRate <= 24000 ? 1024 : 2048;
        proc = actx.createScriptProcessor(size, 0, 1);
        proc.onaudioprocess = onAudio;
        proc.connect(actx.destination);
        IC.log('audio ' + actx.sampleRate + ' Hz, block ' + size);
      }
      if (actx.state !== 'running' && !document.hidden) actx.resume();
    } catch (err) {
      IC.log('audio unavailable: ' + err);
    }
  }

  // ------------------------------------------------------------------ frame loop

  let frameFn = null, lastT = 0, frames = 0, frameErrors = 0;
  IC.startLoop = function (fn) {
    frameFn = fn;
    requestAnimationFrame(tick);
  };
  IC.frameCount = function () { return frames; };

  function tick(t) {
    requestAnimationFrame(tick);
    const dt = lastT === 0 ? 1 / 60 : Math.min(0.25, (t - lastT) / 1000);
    lastT = t;
    resetTransform();
    try {
      frameFn(dt);
      frames++;
    } catch (err) {
      if (frameErrors++ < 5) IC.log('frame error: ' + (err && err.stack ? err.stack : err));
    }
  }

  // ------------------------------------------------------------------ splash and boot

  let splashLogo = -1, progress = 0, splashText = 'MUSTERING THE REGIMENT';

  function drawSplash() {
    resetTransform();
    applyM();
    const w = logicalW, h = logicalH;
    IC.fillRect(0, 0, w, h, 0xFF14110E | 0);
    if (splashLogo >= 0 && sprites[splashLogo].img) {
      const s = sprites[splashLogo];
      const lw = Math.min(w - 8, 620);
      IC.spr(splashLogo, w / 2, h * 0.40, 0, lw / s.w, lw / s.w, 1);
    }
    const bw = 220, bx = w / 2 - bw / 2, by = h * 0.68;
    IC.fillRect(bx - 2, by - 2, bw + 4, 12, 0xFF000000 | 0);
    IC.fillRect(bx, by, bw, 8, 0xFF2A2621 | 0);
    IC.fillRect(bx, by, Math.max(8, bw * progress), 8, 0xFF66673F | 0);
    IC.text(splashText, w / 2, by + 34, 1, 14, 0xFFA99178 | 0, 1);
  }

  IC.ready = function () {
    gameReady = true;
    document.body.classList.add('ready');
    IC.log('ready: ' + sprites.length + ' sprites, view ' + Math.round(logicalW) + 'x' + Math.round(logicalH));
    // paint variants trickle in after start; until each arrives it draws as its base scheme
    const rest = [];
    sprites.forEach(function (s, h) { if (!s.img && PAINT.test(s.name)) rest.push(h); });
    loadAll(rest, null, 4);
  };

  IC.boot = async function (ready) {
    if (booted) return;
    booted = true;
    canvas = document.getElementById('game');
    ctx = canvas.getContext('2d', { alpha: false });
    layout();
    window.addEventListener('resize', layout);
    installInput();
    let list;
    try {
      const r = await fetch('sprites.json');
      list = await r.json();
    } catch (err) {
      IC.log('sprite manifest failed: ' + err);
      list = [];
    }
    register(list);
    const fontsDone = loadFonts();
    splashLogo = IC.img('title_logo');
    if (splashLogo >= 0) await loadSprite(splashLogo);
    let splashRaf = 0;
    const splashLoop = function () { drawSplash(); splashRaf = requestAnimationFrame(splashLoop); };
    splashLoop();
    const base = [];
    sprites.forEach(function (s, h) { if (!PAINT.test(s.name) && !s.img) base.push(h); });
    await loadAll(base, function (f) { progress = 0.05 + 0.85 * f; }, 8);
    await fontsDone;
    progress = 1;
    splashText = 'READY';
    drawSplash();
    cancelAnimationFrame(splashRaf);
    // let the finished splash reach the screen before the game's (synchronous) start-up work
    setTimeout(function () {
      try { ready(); } catch (err) { IC.log('start failed: ' + (err && err.stack ? err.stack : err)); }
    }, 30);
  };
})();
