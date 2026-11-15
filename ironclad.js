/*
 * Ironclad browser runtime. The game itself is Java compiled to JavaScript by TeaVM (classes.js); this file
 * is everything the Android layer did: a renderer with the same conventions as AndroidGfx (WebGL 2, or Canvas 2D
 * where WebGL 2 is missing: see "WebGL renderer"), sprite
 * and font loading behind a splash, pointer input, localStorage saves, and the synth streamed through Web
 * Audio. The Java side reaches it through the global IC object (see web/src/.../JS.java).
 */
'use strict';
(function () {
  const IC = (window.IC = {});
  const BASE_W = 540, BASE_H = 960;
  const MAX_ASPECT = 0.75;          // wider screens get a portrait column, like a phone or tablet
  const MAX_BACKING_W = 1280;       // sprites are drawn for 1080 px across; more pixels only cost fill rate
  // the Android build's SharedPreferences file name, as a key prefix. Every site under rblizz24.github.io shares one
  // localStorage, so the 3.0 test build keeps its own save beside the old free edition's.
  const STORE = 'ironclad3test.';
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
    if (!ctx) return;      // (WebGL: nothing to set)
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
  // per save level, how many ctx.save()s clipCircle made inside it (a canvas clip only comes off with ctx.restore())
  const clips = [];
  let ctxDirty = true;

  function resetTransform() {
    if (gl) glFrameStart();
    const k = scale * backing;
    m = [k, 0, 0, k, 0, 0];
    stack.length = 0;
    if (!gl) for (const n of clips) for (let i = 0; i < n; i++) ctx.restore();
    clips.length = 0;
    ctxDirty = true;
  }

  function applyM() {
    if (ctxDirty && ctx) {
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctxDirty = false;
    }
  }

  IC.save = function () { stack.push(m.slice()); clips.push(0); };
  IC.restore = function () {
    if (stack.length) {
      m = stack.pop();
      for (let n = clips.pop(); n > 0; n--) ctx.restore();
      ctxDirty = true;
    }
  };
  /** Gfx.clipCircle: narrow drawing to a circle until the matching restore (only between save and restore). */
  IC.clipCircle = function (x, y, r) {
    if (!clips.length) return;
    applyM();
    ctx.save();
    clips[clips.length - 1]++;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
  };
  /** Gfx.clipOutCircle: everything but a circle. */
  IC.clipOutCircle = function (x, y, r) {
    if (!clips.length) return;
    applyM();
    ctx.save();
    clips[clips.length - 1]++;
    ctx.beginPath();
    ctx.rect(-1e6, -1e6, 2e6, 2e6);
    ctx.arc(x, y, r, 0, Math.PI * 2, true);
    ctx.clip('evenodd');
  };
  /** Gfx.clipPoly: the polygon begun with polyBegin and polyPt. */
  IC.clipPoly = function () {
    if (!clips.length || polyN < 3) return;
    ctx.closePath();
    ctx.save();
    clips[clips.length - 1]++;
    ctx.clip();
  };
  /** Gfx.clipRect: the same, to a rectangle. */
  IC.clipRect = function (x, y, w, h) {
    if (!clips.length) return;
    applyM();
    ctx.save();
    clips[clips.length - 1]++;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
  };
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

  // ------------------------------------------------------------------ night light map (Gfx.beginLight)
  // Drawing goes into a small offscreen canvas filled with the ambient colour, with additive ('lighter') blending;
  // lightEnd multiplies it over the frame.

  let lightCanvas = null, screenCtx = null, screenM = null, screenStack = null;
  IC.lightBegin = function (ambient, res, zoom) {
    if (screenCtx) return;
    const z = zoom > 0 ? zoom : 1;      // the battlefield's camera zoom: drawing comes in its view units
    const w = Math.max(1, Math.round(logicalW * res)), h = Math.max(1, Math.round(logicalH * res));
    if (!lightCanvas) lightCanvas = document.createElement('canvas');
    if (lightCanvas.width !== w || lightCanvas.height !== h) { lightCanvas.width = w; lightCanvas.height = h; }
    screenCtx = ctx;
    screenM = m.slice();
    screenStack = stack.slice();
    ctx = lightCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = col((ambient | 0xFF000000) >>> 0);
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    m = [w / logicalW * z, 0, 0, h / logicalH * z, 0, 0];
    stack.length = 0;
    ctxDirty = true;
  };
  IC.lightAdd = function (add) {
    if (screenCtx) ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
  };
  IC.lightEnd = function () {
    if (!screenCtx) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx = screenCtx;
    screenCtx = null;
    m = screenM;
    stack.length = 0;
    for (let i = 0; i < screenStack.length; i++) stack.push(screenStack[i]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 1;
    ctx.drawImage(lightCanvas, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctxDirty = true;
  };

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
      im.onload = function () { if (!s.freed) s.img = im; resolve(true); };
      im.onerror = function () { IC.log('missing picture ' + s.name); resolve(false); };
      im.src = s.src || ('assets/sprites/' + s.name + '.png');
    });
  }

  // ---- other pictures (Platform.loadImage: a painted level's squares, its shade), sized from images.json at once and
  // drawn once they arrive; a few in flight at a time, the latest asked for first
  let imageSizes = {};
  const imageQueue = [];
  let imagesInFlight = 0;
  function pumpImages() {
    while (imagesInFlight < 6 && imageQueue.length) {
      const h = imageQueue.pop();
      if (sprites[h].freed) continue;
      imagesInFlight++;
      loadSprite(h).then(function () { imagesInFlight--; pumpImages(); });
    }
  }
  IC.loadImage = function (path, ppu) {
    const wh = imageSizes[path];
    if (!wh) return -1;
    const h = sprites.length;
    const k = ppu > 0 ? ppu : 1;
    sprites.push({ name: path, src: 'assets/' + path, pw: wh[0], ph: wh[1], w: wh[0] / k, h: wh[1] / k,
                   img: null, fb: -1, tints: null, freed: false });
    imageQueue.push(h);
    pumpImages();
    return h;
  };
  IC.imgPxW = function (h) { return sprites[h].pw || sprites[h].w * 2; };
  IC.imgPxH = function (h) { return sprites[h].ph || sprites[h].h * 2; };
  IC.freeImage = function (h) { const s = sprites[h]; if (s) { s.freed = true; s.img = null; s.tints = null; s.shades = null; } };

  // ---- texts and data from assets/, fetched as the game asks (it reads them at once: a level's layout as it starts)
  function getSync(path, binary) {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', 'assets/' + path, false);
      if (binary) x.overrideMimeType('text/plain; charset=x-user-defined');
      x.send(null);
      if (x.status !== 200 && x.status !== 0) return null;
      return x.responseText;
    } catch (err) {
      return null;
    }
  }
  IC.loadText = function (path) {
    const t = getSync(path, false);
    return t === null ? null : t;
  };
  // (a gzipped file, the height maps, is unpacked here: pako, MIT; HeightMap reads it either way)
  let bytes = new Uint8Array(0);
  IC.loadBytes = function (path) {
    const t = getSync(path, true);
    if (t === null) return -1;
    let b = new Uint8Array(t.length);
    for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 255;
    if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b && window.pako) {
      try { b = window.pako.ungzip(b); } catch (err) { IC.log('ungzip ' + path + ': ' + err); }
    }
    bytes = b;
    return b.length;
  };
  IC.byteAt = function (i) { return bytes[i]; };

  // ---- drawing into a picture of its own (Gfx.bake) or a layer laid over the screen at an opacity (Gfx.layer)
  const targets = [];
  function pushTarget(c, nm) {
    targets.push({ ctx: ctx, m: m, stack: stack.slice(), clips: clips.slice(), font: lastFont });
    ctx = c.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'alphabetic';
    ctx.imageSmoothingEnabled = true;
    lastFont = '';
    m = nm;
    stack.length = 0;
    clips.length = 0;
    ctxDirty = true;
  }
  function popTarget() {
    const t = targets.pop();
    for (const n of clips) for (let i = 0; i < n; i++) ctx.restore();
    ctx = t.ctx;
    m = t.m;
    stack.length = 0;
    for (const e of t.stack) stack.push(e);
    clips.length = 0;
    for (const e of t.clips) clips.push(e);
    lastFont = t.font;
    ctxDirty = true;
  }
  IC.bakeBegin = function (name, w, h, pw, ph, px) {
    if (pw * ph > 4096 * 4096) return -1;
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    const hd = sprites.length;
    sprites.push({ name: name, w: w, h: h, img: c, fb: -1, tints: null, baking: true });
    pushTarget(c, [px, 0, 0, px, pw / 2, ph / 2]);
    return hd;
  };
  IC.bakeEnd = function () { if (targets.length) popTarget(); };
  const layerCanvases = [];
  IC.layerBegin = function (alpha) {
    const depth = targets.length;
    let c = layerCanvases[depth];
    const cw = ctx.canvas.width, chh = ctx.canvas.height;
    if (!c) { c = document.createElement('canvas'); layerCanvases[depth] = c; }
    if (c.width !== cw || c.height !== chh) { c.width = cw; c.height = chh; }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, chh);
    const was = m.slice();
    pushTarget(c, was);
    targets[targets.length - 1].layer = { canvas: c, alpha: alpha };
  };
  IC.layerEnd = function () {
    if (!targets.length) return;
    const l = targets[targets.length - 1].layer;
    popTarget();
    if (!l) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.max(0, Math.min(1, l.alpha));
    ctx.drawImage(l.canvas, 0, 0);
    ctx.restore();
    ctxDirty = true;
  };

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
      c.width = im.naturalWidth || im.width;
      c.height = im.naturalHeight || im.height;
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

  // part of a sprite (u, v as fractions of its size): a ground tile cut off where its fill ends
  IC.sprSub = function (h, u0, v0, u1, v1, x, y, w, hh, alpha) {
    if (!(alpha > 0.003)) return;
    const im = imageOf(h);
    if (!im) return;
    const iw = im.width, ih = im.height;
    const sx = Math.round(u0 * iw), sy = Math.round(v0 * ih);
    const sw = Math.max(1, Math.round(u1 * iw) - sx), sh = Math.max(1, Math.round(v1 * ih) - sy);
    applyM();
    ctx.globalAlpha = alpha >= 1 ? 1 : alpha;
    ctx.drawImage(im, sx, sy, sw, sh, x, y, w, hh);
    ctx.globalAlpha = 1;
  };

  // ------------------------------------------------------------------ triangles (a model's faces) and meshes

  /** The sprite's picture darkened to q/16 (a face turned from the light), cached per sprite. */
  function shaded(h, q) {
    const im = imageOf(h);
    if (!im) return null;
    if (q >= 16) return im;
    const s = sprites[h];
    if (!s.shades || s.shades.src !== im) s.shades = { src: im, by: [] };
    let c = s.shades.by[q];
    if (!c) {
      c = document.createElement('canvas');
      c.width = im.naturalWidth || im.width;
      c.height = im.naturalHeight || im.height;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0);
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = 'rgba(0,0,0,' + (1 - q / 16).toFixed(3) + ')';
      g.fillRect(0, 0, c.width, c.height);
      s.shades.by[q] = c;
    }
    return c;
  }

  /** Draw the picture im's triangle (pixel corners u, v) onto the triangle x, y (logical units under m). */
  function drawTri(im, u0, v0, u1, v1, u2, v2, x0, y0, x1, y1, x2, y2) {
    const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (Math.abs(det) < 1e-9) return;
    // the map from the picture to the face: x = a*u + c*v + e
    const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
    const c = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
    const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
    const d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
    const e = x0 - a * u0 - c * v0, f = y0 - b * u0 - d * v0;
    // a hair bigger than the face, so its neighbours meet without a seam
    const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
    const k = 1.04;
    ctx.save();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.beginPath();
    ctx.moveTo(cx + (x0 - cx) * k, cy + (y0 - cy) * k);
    ctx.lineTo(cx + (x1 - cx) * k, cy + (y1 - cy) * k);
    ctx.lineTo(cx + (x2 - cx) * k, cy + (y2 - cy) * k);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(im, 0, 0);
    ctx.restore();
    ctxDirty = true;
  }

  IC.tri = function (h, u0, v0, u1, v1, u2, v2, x0, y0, x1, y1, x2, y2, shade) {
    const q = Math.max(0, Math.min(16, Math.round(shade * 16)));
    const im = shaded(h, q);
    if (!im) return;
    const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
    drawTri(im, u0 * iw, v0 * ih, u1 * iw, v1 * ih, u2 * iw, v2 * ih, x0, y0, x1, y1, x2, y2);
  };

  // a picture laid through a grid of points (Gfx.spriteMesh: the painted ground lifted by its heights). The canvas has
  // no mesh, so the grid is taken a few cells at a time: a cell still a parallelogram is one drawImage, a bent one two
  // triangles.
  let meshXY = new Float32Array(2048), meshN = 0;
  IC.meshBegin = function () { meshN = 0; };
  IC.meshPt = function (x, y) {
    if (meshN * 2 + 2 > meshXY.length) { const b = new Float32Array(meshXY.length * 2); b.set(meshXY); meshXY = b; }
    meshXY[meshN * 2] = x; meshXY[meshN * 2 + 1] = y; meshN++;
  };
  IC.meshDraw = function (h, mw, mh, alpha) {
    if (!(alpha > 0.003)) return;
    const im = imageOf(h);
    if (!im || meshN < (mw + 1) * (mh + 1)) return;
    const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
    const kx = Math.max(1, Math.round(mw / 4)), ky = Math.max(1, Math.round(mh / 4));
    const P = function (i, j) { return (j * (mw + 1) + i) * 2; };
    ctx.globalAlpha = alpha >= 1 ? 1 : alpha;
    for (let j = 0; j < mh; j += ky) {
      const j2 = Math.min(mh, j + ky);
      for (let i = 0; i < mw; i += kx) {
        const i2 = Math.min(mw, i + kx);
        const A = P(i, j), B = P(i2, j), C = P(i, j2), D = P(i2, j2);
        const ax = meshXY[A], ay = meshXY[A + 1], bx = meshXY[B], by = meshXY[B + 1];
        const cx = meshXY[C], cy = meshXY[C + 1], dx = meshXY[D], dy = meshXY[D + 1];
        const su = i / mw * iw, sv = j / mh * ih, eu = i2 / mw * iw, ev = j2 / mh * ih;
        const ex = bx + cx - ax - dx, ey = by + cy - ay - dy;
        if (ex * ex + ey * ey < 0.01) {
          const sw = eu - su, sh = ev - sv;
          ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          ctx.transform((bx - ax) / sw, (by - ay) / sw, (cx - ax) / sh, (cy - ay) / sh, ax, ay);
          ctx.drawImage(im, su, sv, sw, sh, 0, 0, sw, sh);
          ctxDirty = true;
        } else {
          drawTri(im, su, sv, eu, sv, eu, ev, ax, ay, bx, by, dx, dy);
          drawTri(im, su, sv, eu, ev, su, ev, ax, ay, dx, dy, cx, cy);
        }
      }
    }
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
  let polyN = 0, partN = 0;
  IC.polyBegin = function () { applyM(); ctx.beginPath(); polyN = 0; partN = 0; };
  IC.polyNext = function () { if (partN > 0) ctx.closePath(); partN = 0; };
  IC.polyPt = function (x, y) { polyN++; if (partN++ === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); };
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
  // the free site's saves were kept under 'projectmtb.free.' before the rename: carry them over once, so an update
  // doesn't start anyone from scratch (only if nothing has been saved under the new name yet)
  (function migrateOldSave() {
    const OLD = 'projectmtb.free.';
    try {
      const ls = window.localStorage;
      let fresh = true;
      const old = [];
      for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (key === null) continue;
        if (key.indexOf(STORE) === 0) fresh = false;
        else if (key.indexOf(OLD) === 0) old.push(key);
      }
      if (fresh) for (const key of old) ls.setItem(STORE + key.substring(OLD.length), ls.getItem(key));
    } catch (e) { /* storage blocked: nothing to carry over */ }
  })();
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
  /** The seed box's PASTE: the clipboard's text arrives as the box's text (the browser may ask first). */
  IC.pasteText = function () {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (t) { if (typeof t === 'string') kbText = t; }).catch(function () { });
      }
    } catch (e) { /* no clipboard access: the box still takes a paste from the keyboard */ }
  };
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
      musicVisible(visible);
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
    musicUnlock();
  }

  // ------------------------------------------------------------------ the soundtrack
  // Two voices, each an MP3 from assets/music fetched and decoded whole, then played by a looping buffer source: the
  // files are made to loop between loopFrom and loopTo (the same music either side, tools/assetgen/music.py), and a
  // buffer source loops there to the sample, so nothing has to be started on cue. Each goes through a gain node (fades
  // work on iOS too, where an element's volume can't be set), in an AudioContext of its own at 32 kHz: the effects'
  // context runs at 22 kHz, which would dull the music; 32 kHz keeps all a 128 kbps MP3 holds, in a third less memory
  // than 48. Decoding waits for the first tap (an AudioContext needs one).

  const MUSIC_RATE = 32000;
  // three voices: two for the music (one can fade into the other) and the level's ambience
  const mv = [null, null, null];
  let mctx = null;
  // the muffle (the upgrade cards, the radio, the pause menu): every voice through one low-pass, 0 clear to 1 muffled
  let mfilter = null, muffle = 0;
  function muffleHz(x) { return Math.min(20000 * Math.pow(700 / 20000, x), (mctx ? mctx.sampleRate : 32000) * 0.45); }
  function musicOut() {
    if (!mfilter) {
      mfilter = mctx.createBiquadFilter();
      mfilter.type = 'lowpass';
      mfilter.Q.value = 0.707;
      mfilter.frequency.value = muffleHz(muffle);
      mfilter.connect(mctx.destination);
    }
    return mfilter;
  }

  function musicUnlock() {
    try {
      if (!mctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { mctx = new AC({ sampleRate: MUSIC_RATE }); } catch (e) { mctx = new AC(); } }
      }
      if (mctx && mctx.state !== 'running' && !document.hidden) mctx.resume();
    } catch (err) { mctx = null; }
    for (const v of mv) if (v) startVoice(v);
  }

  // A voice is one or more parts (a level track's drums, bass and the rest: tools/assetgen/stems.py), each its own MP3
  // of the same length, decoded whole and started together on the context's clock so they stay in lockstep; each part
  // has its own gain (its level), under the voice's (its volume).
  function decodePart(v, p) {
    if (!mctx || !p.data || p.decoding || p.buf) return;
    p.decoding = true;
    const data = p.data;
    p.data = null;
    let settled = false;
    const done = function (buf) {
      if (settled) return;
      settled = true;
      p.decoding = false;
      if (v.dead) return;
      p.buf = buf;
      startVoice(v);
    };
    const fail = function (err) {
      if (settled) return;
      settled = true;
      p.decoding = false;
      p.failed = true;
      IC.log('music ' + p.file + ': ' + err);
      startVoice(v);
    };
    try {
      const pr = mctx.decodeAudioData(data, done, fail);
      if (pr && pr.then) pr.then(done, fail);
    } catch (err) { fail(err); }
  }

  function startVoice(v) {
    if (!mctx || v.dead) return;
    let ready = true;
    for (const p of v.parts) {
      if (p.failed) continue;
      if (!p.buf) { ready = false; decodePart(v, p); }
    }
    if (!ready || !v.started || v.playing) return;
    try {
      const g = mctx.createGain();
      g.gain.value = v.vol;
      g.connect(musicOut());
      v.gain = g;
      const t = mctx.currentTime + 0.05;
      const at = v.at > 0 && v.at < v.to ? v.at : 0;
      for (const p of v.parts) {
        if (!p.buf) continue;
        const pg = mctx.createGain();
        pg.gain.value = p.level;
        pg.connect(g);
        const src = mctx.createBufferSource();
        src.buffer = p.buf;
        src.loop = true;
        src.loopStart = v.from;
        src.loopEnd = v.to > v.from ? v.to : p.buf.duration;
        src.connect(pg);
        src.start(t, at);
        p.src = src;
        p.gain = pg;
      }
      v.playing = true;
      v.t0 = t - at;
      for (const p of v.parts) if (p.pend) { applyLayer(v, p, p.pend); p.pend = null; }
    } catch (err) { IC.log('music ' + v.name + ': ' + err); }
  }

  function newVoice(slot, name, files, from, to, at) {
    IC.musicStop(slot);
    const v = { name: name, from: from, to: to, at: at || 0, vol: 0, gain: null, started: false, playing: false,
                dead: false, t0: 0, parts: [] };
    for (const file of files) {
      const p = { file: file, data: null, buf: null, src: null, gain: null, level: 1, decoding: false, failed: false, pend: null };
      v.parts.push(p);
      fetch('assets/music/' + file + '.mp3')
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (data) { if (v.dead) return; p.data = data; decodePart(v, p); })
        .catch(function (err) { p.failed = true; IC.log('music ' + file + ': ' + err); });
    }
    mv[slot] = v;
  }

  IC.musicLoad = function (slot, name, from, to, at) { newVoice(slot, name, [name], from, to, at); };
  IC.musicLoadParts = function (slot, name, parts, from, to, at) {
    const files = String(parts).split('|').filter(function (x) { return x.length > 0; })
      .map(function (x) { return name + '.' + x; });
    newVoice(slot, name, files.length ? files : [name], from, to, at);
  };

  /** Where a playing voice is in its file (s), looped back into its loop. */
  function voicePos(v) {
    let t = mctx.currentTime - v.t0;
    if (t < 0) return 0;
    if (v.to > v.from && t >= v.to) t = v.from + (t - v.from) % (v.to - v.from);
    return t;
  }

  /** A part's level: to `level` over `fade` s, from when the voice reaches `at` s into its file (at < 0: now). */
  function applyLayer(v, p, c) {
    if (!p.gain) { p.level = c.level; return; }
    const now = mctx.currentTime;
    let when = now;
    if (c.at >= 0) {
      const pos = voicePos(v);
      let wait = c.at - pos;
      if (wait < -0.02 && v.to > v.from) wait += v.to - v.from;
      when = now + Math.max(0, wait);
    }
    try {
      const g = p.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.setValueAtTime(g.value, when);
      g.linearRampToValueAtTime(c.level, when + Math.max(0.005, c.fade));
    } catch (err) { p.gain.gain.value = c.level; }
    p.level = c.level;
  }

  IC.musicLayer = function (slot, part, level, at, fade) {
    const v = mv[slot];
    if (!v || part < 0 || part >= v.parts.length) return;
    const p = v.parts[part];
    const c = { level: Math.max(0, Math.min(1, level)), at: at, fade: fade };
    if (!v.playing) { p.level = c.level; p.pend = null; return; }
    applyLayer(v, p, c);
  };
  IC.musicStart = function (slot) {
    const v = mv[slot];
    if (!v) return;
    v.started = true;
    startVoice(v);
  };
  IC.musicVolume = function (slot, x) {
    const v = mv[slot];
    if (!v) return;
    v.vol = Math.max(0, Math.min(1, x));
    if (v.gain) { try { v.gain.gain.setTargetAtTime(v.vol, mctx.currentTime, 0.015); } catch (err) { v.gain.gain.value = v.vol; } }
  };
  IC.musicMuffle = function (x) {
    muffle = Math.max(0, Math.min(1, x));
    if (mfilter) {
      try { mfilter.frequency.setTargetAtTime(muffleHz(muffle), mctx.currentTime, 0.05); }
      catch (err) { mfilter.frequency.value = muffleHz(muffle); }
    }
  };
  IC.musicStop = function (slot) {
    const v = mv[slot];
    if (!v) return;
    mv[slot] = null;
    v.dead = true;
    for (const p of v.parts) {
      if (p.src) { try { p.src.stop(); p.src.disconnect(); } catch (err) { /* gone */ } }
      if (p.gain) { try { p.gain.disconnect(); } catch (err) { /* gone */ } }
      p.src = null; p.buf = null; p.data = null;
    }
    if (v.gain) { try { v.gain.disconnect(); } catch (err) { /* gone */ } }
  };
  IC.musicPosition = function (slot) {
    const v = mv[slot];
    if (!v || !v.playing || !mctx || mctx.state !== 'running') return -1;
    let t = mctx.currentTime - v.t0 - (mctx.outputLatency || mctx.baseLatency || 0);
    if (t < 0) return 0;
    if (v.to > v.from && t >= v.to) t = v.from + (t - v.from) % (v.to - v.from);
    return t;
  };
  function musicVisible(visible) {
    // the context's clock stops with it, so the voices and their positions pick up where they were
    if (mctx) { try { if (visible) mctx.resume(); else mctx.suspend(); } catch (err) { /* ignore */ } }
  }

  // ------------------------------------------------------------------ WebGL renderer
  /*
   * The canvas code above draws a model's faces one clipped triangle at a time and the lifted ground a few cells at a
   * time: 5 fps in a fight (Nov 15, "the browser version is basically unplayable"). Where the browser has WebGL 2 the
   * same IC calls are drawn on the GPU in batches instead, as the phone draws them: pictures, silhouettes, faces and
   * meshes as textured triangles (up to 8 pictures to a batch), shapes as distance fields (smooth edges at any
   * scale), polygons cut into triangles (earcut), clips in the stencil buffer, text from an atlas of drawn strings,
   * bakes, layers and the light map in framebuffers. ?canvas keeps the old renderer, which stays the fallback.
   */
  let gl = null, glGen = 0, glLost = false, maxTex = 4096;
  const GLV = 10;                         // floats per vertex: x, y (target pixels), u, v, colour (4 bytes), p0..p3, mode
  const UNITS = 8, SCRATCH = 8;           // picture units a batch samples; the unit kept for uploads
  const MAXV = 65532, MAXI = 196608;
  const vBuf = new ArrayBuffer(MAXV * GLV * 4);
  const vF32 = new Float32Array(vBuf), vU32 = new Uint32Array(vBuf);
  const iBuf = new Uint16Array(MAXI);
  let nV = 0, nI = 0;
  let uRes = null, uFlip = null, uClip = null, whiteTex = null;
  const unitTex = [null, null, null, null, null, null, null, null];
  let unitsUsed = 0, nextUnit = 0;        // bit i: this batch samples unit i
  let blend = 0;                          // 0 over, 1 add ('lighter'), 2 multiply
  let tgt = null;                         // what's drawn into: {fb, tex, w, h, depth (clips in force), sb (stencil)}
  const screenTgt = { fb: null, tex: null, w: 1, h: 1, depth: 0, sb: true, gen: 0 };
  const gtargets = [];                    // the targets bake, layer and the light map put in front of it
  let recording = null;                   // a bake's calls, kept to draw it again if the GPU drops its pictures
  const glStats = { draws: 0, uploads: 0, atlasResets: 0, mb: 0 };
  IC.renderer = function () { return gl ? 'webgl2' : 'canvas'; };
  IC.glStats = function (area) {
    glStats.mb = Math.round(texBytes / 1048576);
    const s = Object.assign({}, glStats);
    glStats.draws = 0; glStats.uploads = 0;
    if (area) glStats.area = 0; else delete glStats.area;
    return s;
  };

  // modes (the low 4 bits; the picture unit is above them): 0 picture x colour, 1 silhouette (colour x the picture's
  // alpha), 2 flat colour, and distance fields over uv (units from the shape's middle): 3 disc (p0 radius), 4 ring
  // (radius, half width), 5 box (half width, half height, corner radius, half stroke or 0 filled), 6 capsule along x
  // (half length, half width), 7 arc (radius, half width, start, sweep > 0), 8 all but a disc (radius)
  const GL_VS = `#version 300 es
in vec2 aPos; in vec2 aUv; in vec4 aCol; in vec4 aP; in float aMode;
uniform vec2 uRes; uniform float uFlip;
out vec2 vUv; out vec4 vCol; out vec4 vP; flat out int vMode;
void main() {
  vec2 c = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y * uFlip, 0.0, 1.0);
  vUv = aUv; vCol = aCol; vP = aP; vMode = int(aMode + 0.5);
}`;
  const GL_FS = `#version 300 es
precision highp float;
uniform sampler2D uT0, uT1, uT2, uT3, uT4, uT5, uT6, uT7;
uniform int uClip;
in vec2 vUv; in vec4 vCol; in vec4 vP; flat in int vMode;
out vec4 o;
// (a picture shown smaller than its pixels takes its sharper mip level sooner, closer to the canvas's high-quality
// smoothing than plain trilinear)
const float BIAS = -0.5;
vec4 pic(int u, vec2 uv) {
  if (u < 4) {
    if (u < 2) return u == 0 ? texture(uT0, uv, BIAS) : texture(uT1, uv, BIAS);
    return u == 2 ? texture(uT2, uv, BIAS) : texture(uT3, uv, BIAS);
  }
  if (u < 6) return u == 4 ? texture(uT4, uv, BIAS) : texture(uT5, uv, BIAS);
  return u == 6 ? texture(uT6, uv, BIAS) : texture(uT7, uv, BIAS);
}
float box(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
void main() {
  int mode = vMode & 15;
  if (mode == 0) { o = pic(vMode >> 4, vUv) * vCol; return; }
  if (mode == 1) { o = vCol * pic(vMode >> 4, vUv).a; return; }
  if (mode == 2) { o = vCol; return; }
  vec2 p = vUv;
  float d;
  if (mode == 3) d = length(p) - vP.x;
  else if (mode == 4) d = abs(length(p) - vP.x) - vP.y;
  else if (mode == 5) { d = box(p, vP.xy - vP.z) - vP.z; if (vP.w > 0.0) d = abs(d) - vP.w; }
  else if (mode == 6) { p.x = max(abs(p.x) - vP.x, 0.0); d = length(p) - vP.y; }
  else if (mode == 7) {
    float t = mod(atan(p.y, p.x) - vP.z, 6.28318531);
    if (t <= vP.w) d = abs(length(p) - vP.x) - vP.y;
    else {
      vec2 e0 = vP.x * vec2(cos(vP.z), sin(vP.z)), e1 = vP.x * vec2(cos(vP.z + vP.w), sin(vP.z + vP.w));
      d = min(length(p - e0), length(p - e1)) - vP.y;
    }
  } else d = vP.x - length(p);
  float c = clamp(0.5 - d / max(fwidth(d), 1e-5), 0.0, 1.0);
  if (uClip == 1 && c < 0.5) discard;
  o = vCol * c;
}`;

  function glShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  /** Program, buffers and state: at start, and again when a lost context comes back. */
  function glSetup() {
    const p = gl.createProgram();
    gl.attachShader(p, glShader(gl.VERTEX_SHADER, GL_VS));
    gl.attachShader(p, glShader(gl.FRAGMENT_SHADER, GL_FS));
    ['aPos', 'aUv', 'aCol', 'aP', 'aMode'].forEach(function (n, i) { gl.bindAttribLocation(p, i, n); });
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    uRes = gl.getUniformLocation(p, 'uRes');
    uFlip = gl.getUniformLocation(p, 'uFlip');
    uClip = gl.getUniformLocation(p, 'uClip');
    for (let i = 0; i < UNITS; i++) gl.uniform1i(gl.getUniformLocation(p, 'uT' + i), i);
    gl.uniform1i(uClip, 0);
    gl.bindVertexArray(gl.createVertexArray());
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    const S = GLV * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, S, 16);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, S, 20);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, S, 36);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    blend = 0;
    maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    whiteTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + SCRATCH);
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    for (let i = 0; i < UNITS; i++) bindUnit(i, whiteTex);
    unitsUsed = 0;
    nV = 0; nI = 0;
    atlasTex = null;
    atlas.clear();
    screenTgt.gen = glGen;
    tgt = null;
    gtargets.length = 0;
    useTarget(screenTgt);
  }

  // ---- batches

  function flush() {
    if (nI > 0) {
      if (glStats.area !== undefined) dbgAreaTo(dbgKind);
      gl.bufferData(gl.ARRAY_BUFFER, vF32.subarray(0, nV * GLV), gl.STREAM_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, iBuf.subarray(0, nI), gl.STREAM_DRAW);
      gl.drawElements(gl.TRIANGLES, nI, gl.UNSIGNED_SHORT, 0);
      glStats.draws++;
    }
    nV = 0; nI = 0; unitsUsed = 0; dbgI = 0;
  }
  // (testing: the screen pixels the triangles cover, overdraw included, put to the call that drew them)
  let dbgI = 0, dbgKind = '?';
  const dbgArea = {};
  function dbgAreaTo(kind) {
    let a = 0;
    const W = tgt.w, H = tgt.h;
    const cx = function (v) { return v < 0 ? 0 : v > W ? W : v; }, cy = function (v) { return v < 0 ? 0 : v > H ? H : v; };
    for (let k = dbgI; k + 2 < nI; k += 3) {
      const p = iBuf[k] * GLV, q = iBuf[k + 1] * GLV, r = iBuf[k + 2] * GLV;
      const px = cx(vF32[p]), py = cy(vF32[p + 1]), qx = cx(vF32[q]), qy = cy(vF32[q + 1]), rx = cx(vF32[r]), ry = cy(vF32[r + 1]);
      a += Math.abs((qx - px) * (ry - py) - (rx - px) * (qy - py)) / 2;
    }
    a /= W * H;
    glStats.area += a;
    const key = kind + (tgt === screenTgt ? '' : '@off');
    dbgArea[key] = (dbgArea[key] || 0) + a;
    dbgI = nI;
  }
  IC.glKind = function (k) {
    if (glStats.area === undefined || !gl) return;
    dbgAreaTo(dbgKind);
    dbgKind = k || '?';
  };
  IC.glAreas = function () { const r = Object.assign({}, dbgArea); for (const k in dbgArea) delete dbgArea[k]; return r; };
  /** Room in the batch for v more vertices and i more indices (call before unitFor: a flush forgets the units). */
  function room(v, i) { if (nV + v > MAXV || nI + i > MAXI) flush(); }
  function vtx(x, y, u, v, c, p0, p1, p2, p3, mode) {
    const o = nV * GLV;
    vF32[o] = x; vF32[o + 1] = y; vF32[o + 2] = u; vF32[o + 3] = v; vU32[o + 4] = c;
    vF32[o + 5] = p0; vF32[o + 6] = p1; vF32[o + 7] = p2; vF32[o + 8] = p3; vF32[o + 9] = mode;
    return nV++;
  }
  function quadIdx(b) {
    iBuf[nI++] = b; iBuf[nI++] = b + 1; iBuf[nI++] = b + 2;
    iBuf[nI++] = b; iBuf[nI++] = b + 2; iBuf[nI++] = b + 3;
  }
  /** The rectangle (x0, y0)-(x1, y1) through the affine (a..f), uv laid over it corner to corner. */
  function affQuad(a, b, c, d, e, f, x0, y0, x1, y1, u0, v0, u1, v1, col, p0, p1, p2, p3, mode) {
    const base = nV;
    vtx(a * x0 + c * y0 + e, b * x0 + d * y0 + f, u0, v0, col, p0, p1, p2, p3, mode);
    vtx(a * x1 + c * y0 + e, b * x1 + d * y0 + f, u1, v0, col, p0, p1, p2, p3, mode);
    vtx(a * x1 + c * y1 + e, b * x1 + d * y1 + f, u1, v1, col, p0, p1, p2, p3, mode);
    vtx(a * x0 + c * y1 + e, b * x0 + d * y1 + f, u0, v1, col, p0, p1, p2, p3, mode);
    quadIdx(base);
  }
  // m * T(x, y) * R(rot) * S(sx, sy), into A..F
  let A = 1, B = 0, C = 0, D = 1, E = 0, F = 0;
  function at(x, y, rot, sx, sy) {
    let a = m[0], b = m[1], c = m[2], d = m[3];
    E = m[4] + a * x + c * y;
    F = m[5] + b * x + d * y;
    if (rot !== 0) {
      const cs = Math.cos(rot), sn = Math.sin(rot);
      const a2 = a * cs + c * sn, b2 = b * cs + d * sn;
      c = c * cs - a * sn; d = d * cs - b * sn; a = a2; b = b2;
    }
    A = a * sx; B = b * sx; C = c * sy; D = d * sy;
  }
  /** Target pixels to a logical unit, under m. */
  function devK() { return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1; }
  /** argb as premultiplied RGBA bytes (little-endian), its alpha times k. */
  function pc(argb, k) {
    let a = ((argb >>> 24) & 255) * k;
    if (a > 255) a = 255;
    const f = a / 255;
    const r = (((argb >> 16) & 255) * f + 0.5) | 0, g = (((argb >> 8) & 255) * f + 0.5) | 0;
    const b = ((argb & 255) * f + 0.5) | 0, al = (a + 0.5) | 0;
    return (r | (g << 8) | (b << 16) | (al << 24)) >>> 0;
  }
  /** Grey v at alpha a, premultiplied: (1, a) a picture at opacity a; (s, 1) a face darkened to s. */
  function gc(v, a) {
    const x = (v * a * 255 + 0.5) | 0, y = (a * 255 + 0.5) | 0;
    return (x | (x << 8) | (x << 16) | (y << 24)) >>> 0;
  }

  // ---- pictures

  function bindUnit(i, t) {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, t);
    unitTex[i] = t;
  }
  /** A unit holding texture t for this batch (a batch full of other pictures is drawn first). */
  function unitFor(t) {
    for (let i = 0; i < UNITS; i++) if (unitTex[i] === t) { unitsUsed |= 1 << i; return i; }
    if (unitsUsed === (1 << UNITS) - 1) flush();
    let i = nextUnit;
    for (let k = 0; k < UNITS; k++) { i = (nextUnit + k) % UNITS; if (!(unitsUsed & (1 << i))) break; }
    nextUnit = (i + 1) % UNITS;
    bindUnit(i, t);
    unitsUsed |= 1 << i;
    return i;
  }
  /** Take a texture out of every unit (before it's deleted or drawn into). */
  function unbindTex(t) {
    for (let i = 0; i < UNITS; i++) if (unitTex[i] === t) { flush(); bindUnit(i, whiteTex); }
  }
  function upload(im) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + SCRATCH);
    gl.bindTexture(gl.TEXTURE_2D, t);
    const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    } catch (err) {
      IC.log('picture upload failed (' + w + 'x' + h + '): ' + err);
    }
    glStats.uploads++;
    const r = { t: t, w: w, h: h, gen: glGen, used: glFrame, bytes: w * h * 16 / 3, im: im };
    live.add(r);
    texBytes += r.bytes;
    return r;
  }
  // pictures not drawn for a while give their GPU memory back once the uploads pass a budget (drawn again, they're
  // uploaded again): a run's levels, menus and paint schemes would otherwise all stay on a phone's GPU
  const TEX_BUDGET = 224 * 1024 * 1024;
  const live = new Set();
  let texBytes = 0, glFrame = 0;
  function evict() {
    if (texBytes <= TEX_BUDGET) return;
    const old = Array.from(live).filter(function (r) { return r.used < glFrame - 120; });
    old.sort(function (a, b) { return a.used - b.used; });
    flush();
    for (const r of old) {
      if (texBytes <= TEX_BUDGET * 0.75) break;
      dropUpload(r);
    }
  }
  function dropUpload(r) {
    if (!live.delete(r)) return;
    texBytes -= r.bytes;
    if (r.im && r.im.__ic === r) r.im.__ic = null;
    if (r.gen === glGen) { unbindTex(r.t); gl.deleteTexture(r.t); }
  }
  /** Sprite h's texture, uploaded the first time it's drawn; null until its picture has arrived. */
  function texOf(h) {
    const s = sprites[h];
    if (s.glt) return s.glt.gen === glGen ? s.glt : null;
    const im = imageOf(h);
    if (!im) return null;
    let r = im.__ic;
    if (!r || r.gen !== glGen) {
      if (r) dropUpload(r);
      r = im.__ic = upload(im);
    }
    r.used = glFrame;
    return r;
  }

  // ---- targets: the screen, a bake's picture, a layer, the light map

  function useTarget(t) {
    flush();
    tgt = t;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
    gl.uniform2f(uRes, t.w, t.h);
    gl.uniform1f(uFlip, t.fb ? -1 : 1);
    applyStencil();
  }
  function applyStencil() {
    if (tgt.depth > 0) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.EQUAL, tgt.depth, 0xFF);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    } else {
      gl.disable(gl.STENCIL_TEST);
    }
  }
  function setBlend(b) {
    if (b === blend) return;
    flush();
    blend = b;
    if (b === 1) gl.blendFunc(gl.ONE, gl.ONE);
    else if (b === 2) gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  /** A w x h picture to draw into (the old one if it still fits). */
  function fbTarget(w, h, old) {
    if (old && old.gen === glGen) {
      if (old.w === w && old.h === h) return old;
      dropTarget(old, true);
    }
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + SCRATCH);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt ? tgt.fb : null);
    return { fb: fb, tex: tex, w: w, h: h, depth: 0, sb: null, gen: glGen };
  }
  function dropTarget(t, withTex) {
    flush();
    if (t.fb) gl.deleteFramebuffer(t.fb);
    if (t.sb && t.sb !== true) gl.deleteRenderbuffer(t.sb);
    t.fb = null; t.sb = null;
    if (withTex && t.tex) { unbindTex(t.tex); gl.deleteTexture(t.tex); t.tex = null; }
  }
  /** A stencil for the target being drawn into, the first time something clips in it. */
  function ensureStencil(t) {
    if (t.sb) return;
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, t.w, t.h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
    t.sb = rb;
    gl.stencilMask(0xFF);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
  }
  function clearTarget(r, g, b, a) {
    flush();
    gl.clearColor(r, g, b, a);
    gl.stencilMask(0xFF);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | (tgt.sb ? gl.STENCIL_BUFFER_BIT : 0));
  }
  function glPush(t, nm) {
    flush();
    gtargets.push({ tgt: tgt, m: m, stack: stack.slice(), clips: clips.slice(), blend: blend, rec: recording });
    if (t.tex) unbindTex(t.tex);       // never sample what's being drawn into
    m = nm;
    stack.length = 0;
    clips.length = 0;
    t.depth = 0;
    useTarget(t);
    setBlend(0);
  }
  function glPop() {
    flush();
    const r = gtargets.pop();
    m = r.m;
    stack.length = 0;
    for (const e of r.stack) stack.push(e);
    clips.length = 0;
    for (const e of r.clips) clips.push(e);
    useTarget(r.tgt);
    setBlend(r.blend);
    return r;
  }
  /** A quad given in the target's own pixels. */
  function devQuad(x0, y0, x1, y1, u0, v0, u1, v1, col, mode) {
    affQuad(1, 0, 0, 1, 0, 0, x0, y0, x1, y1, u0, v0, u1, v1, col, 0, 0, 0, 0, mode);
  }
  function mipmap(tex) {
    gl.activeTexture(gl.TEXTURE0 + SCRATCH);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  function glFrameStart() {
    while (gtargets.length) glPop();     // (a frame that failed halfway)
    if (++glFrame % 60 === 0) evict();
    recording = null;
    screenTgt.w = canvas.width;
    screenTgt.h = canvas.height;
    screenTgt.depth = 0;
    useTarget(screenTgt);
    setBlend(0);
    gl.colorMask(true, true, true, true);
    gl.uniform1i(uClip, 0);
    clearTarget(0, 0, 0, 1);
  }

  // ---- clips: each one counts the stencil up inside it; drawing passes where the count is the clips in force

  function clipStart() {
    if (!clips.length) return false;
    flush();
    ensureStencil(tgt);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xFF);
    gl.stencilFunc(gl.EQUAL, tgt.depth, 0xFF);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    gl.colorMask(false, false, false, false);
    gl.uniform1i(uClip, 1);
    return true;
  }
  function clipDone() {
    flush();
    gl.colorMask(true, true, true, true);
    gl.uniform1i(uClip, 0);
    tgt.depth++;
    clips[clips.length - 1]++;
    applyStencil();
  }
  function unclip(n) {
    if (n <= 0) return;
    flush();
    const d = Math.max(0, tgt.depth - n);
    if (d === 0) {
      gl.stencilMask(0xFF);
      gl.clearStencil(0);
      gl.clear(gl.STENCIL_BUFFER_BIT);
    } else {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.LESS, d, 0xFF);          // where the count is above d, set it to d
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      gl.colorMask(false, false, false, false);
      room(4, 6);
      devQuad(0, 0, tgt.w, tgt.h, 0, 0, 0, 0, 0, 2);
      flush();
      gl.colorMask(true, true, true, true);
    }
    tgt.depth = d;
    applyStencil();
  }

  // ---- polygons: each part cut into triangles

  let pXY = new Float64Array(512), pN = 0;
  const pParts = [0];
  const TRI3 = [0, 1, 2];
  function polyEmit(col) {
    pParts.push(pN);
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
    for (let p = 0; p + 1 < pParts.length; p++) {
      const s = pParts[p], n = pParts[p + 1] - s;
      if (n < 3) continue;
      const idx = n === 3 ? TRI3 : window.earcut ? window.earcut(pXY.subarray(s * 2, (s + n) * 2)) : null;
      room(n, idx ? idx.length : (n - 2) * 3);
      const base = nV;
      for (let i = s; i < s + n; i++) {
        const x = pXY[i * 2], y = pXY[i * 2 + 1];
        vtx(a * x + c * y + e, b * x + d * y + f, 0, 0, col, 0, 0, 0, 0, 2);
      }
      if (idx) for (let k = 0; k < idx.length; k++) iBuf[nI++] = base + idx[k];
      else for (let k = 1; k + 1 < n; k++) { iBuf[nI++] = base; iBuf[nI++] = base + k; iBuf[nI++] = base + k + 1; }
    }
    pParts.pop();
  }

  // ---- text: each string drawn once into an atlas (white; tinted as it's drawn), at the size it's shown

  const TA_W = 2048, TA_H = 1024;
  let atlasTex = null, shelfX = 0, shelfY = 0, shelfH = 0, tctx = null, tFont = '';
  const atlas = new Map();
  function atlasReset() {
    flush();
    atlas.clear();
    shelfX = 0; shelfY = 0; shelfH = 0;
    glStats.atlasResets++;
  }
  function textEntry(s, f, px) {
    const key = f + '|' + px + '|' + s;
    let e = atlas.get(key);
    if (e) return e;
    if (!atlasTex) {
      atlasTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + SCRATCH);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TA_W, TA_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      atlas.clear();
      shelfX = 0; shelfY = 0; shelfH = 0;
    }
    const font = px + 'px IC' + f + ',' + FONT_FALLBACK[f];
    const g = tctx;
    g.font = font;
    const mt = g.measureText(s);
    const W = mt.width;
    const left = Math.max(0, Math.ceil(mt.actualBoundingBoxLeft || 0));
    const right = Math.ceil(Math.max(W, mt.actualBoundingBoxRight || 0));
    const top = Math.ceil(Math.max(mt.fontBoundingBoxAscent || px, mt.actualBoundingBoxAscent || 0));
    const bot = Math.ceil(Math.max(mt.fontBoundingBoxDescent || px * 0.35, mt.actualBoundingBoxDescent || 0));
    const P = 2;
    const cw = left + right + P * 2, ch = top + bot + P * 2;
    if (cw > TA_W || ch > TA_H) return null;
    if (shelfX + cw > TA_W) { shelfY += shelfH; shelfX = 0; shelfH = 0; }
    if (shelfY + ch > TA_H) atlasReset();
    const x = shelfX, y = shelfY;
    shelfX += cw;
    if (ch > shelfH) shelfH = ch;
    const cv = g.canvas;
    cv.width = cw;                      // (resizing clears it, and its state)
    cv.height = ch;
    g.font = font;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#fff';
    g.fillText(s, P + left, P + top);
    tFont = '';
    gl.activeTexture(gl.TEXTURE0 + SCRATCH);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    e = { u0: x / TA_W, v0: y / TA_H, u1: (x + cw) / TA_W, v1: (y + ch) / TA_H, ox: P + left, oy: P + top, cw: cw, ch: ch, w: W };
    atlas.set(key, e);
    return e;
  }

  // ---- the IC calls, drawn this way

  const G = {};
  const canvasFreeImage = IC.freeImage;
  G.save = IC.save;
  G.translate = IC.translate;
  G.rotate = IC.rotate;
  G.scale = IC.scale;
  G.restore = function () {
    if (!stack.length) return;
    m = stack.pop();
    unclip(clips.pop());
  };
  G.clipCircle = function (x, y, r) {
    if (!clipStart()) return;
    at(x, y, 0, 1, 1);
    const e = r + 1.5 / devK();
    room(4, 6);
    affQuad(A, B, C, D, E, F, -e, -e, e, e, -e, -e, e, e, 0, r, 0, 0, 0, 3);
    clipDone();
  };
  G.clipOutCircle = function (x, y, r) {
    if (!clipStart()) return;
    // the whole target, uv its points in the circle's units
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12) { clipDone(); return; }
    room(4, 6);
    const base = nV;
    const cx = [0, tgt.w, tgt.w, 0], cy = [0, 0, tgt.h, tgt.h];
    for (let i = 0; i < 4; i++) {
      const X = cx[i] - m[4], Y = cy[i] - m[5];
      const lx = (m[3] * X - m[2] * Y) / det, ly = (m[0] * Y - m[1] * X) / det;
      vtx(cx[i], cy[i], lx - x, ly - y, 0, r, 0, 0, 0, 8);
    }
    quadIdx(base);
    clipDone();
  };
  G.clipRect = function (x, y, w, h) {
    if (!clipStart()) return;
    room(4, 6);
    affQuad(m[0], m[1], m[2], m[3], m[4], m[5], x, y, x + w, y + h, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2);
    clipDone();
  };
  G.polyBegin = function () { pN = 0; pParts.length = 1; pParts[0] = 0; };
  G.polyNext = function () { if (pN > pParts[pParts.length - 1]) pParts.push(pN); };
  G.polyPt = function (x, y) {
    if (pN * 2 + 2 > pXY.length) { const b = new Float64Array(pXY.length * 2); b.set(pXY); pXY = b; }
    pXY[pN * 2] = x; pXY[pN * 2 + 1] = y; pN++;
  };
  G.polyFill = function (c) {
    if (pN < 3 || (c >>> 24) === 0) return;
    polyEmit(pc(c, 1));
  };
  G.clipPoly = function () {
    if (pN < 3 || !clipStart()) return;
    polyEmit(0);
    clipDone();
  };

  G.spr = function (h, x, y, rot, sx, sy, alpha) {
    if (!(alpha > 0.003)) return;
    room(4, 6);
    const t = texOf(h);
    if (!t) return;
    const mode = unitFor(t.t) << 4;
    const s = sprites[h], hw = s.w / 2, hh = s.h / 2;
    at(x, y, rot, sx, sy);
    affQuad(A, B, C, D, E, F, -hw, -hh, hw, hh, 0, 0, 1, 1, gc(1, alpha >= 1 ? 1 : alpha), 0, 0, 0, 0, mode);
  };
  G.tint = function (h, x, y, rot, sc, argb) {
    if (((argb >>> 24) & 255) === 0) return;
    room(4, 6);
    const t = texOf(h);
    if (!t) return;
    const mode = (unitFor(t.t) << 4) | 1;
    const s = sprites[h], hw = s.w / 2, hh = s.h / 2;
    at(x, y, rot, sc, sc);
    affQuad(A, B, C, D, E, F, -hw, -hh, hw, hh, 0, 0, 1, 1, pc(argb, 1), 0, 0, 0, 0, mode);
  };
  G.sprRect = function (h, x, y, w, hh, alpha) {
    if (!(alpha > 0.003)) return;
    room(4, 6);
    const t = texOf(h);
    if (!t) return;
    const mode = unitFor(t.t) << 4;
    affQuad(m[0], m[1], m[2], m[3], m[4], m[5], x, y, x + w, y + hh, 0, 0, 1, 1, gc(1, alpha >= 1 ? 1 : alpha), 0, 0, 0, 0, mode);
  };
  G.sprSub = function (h, u0, v0, u1, v1, x, y, w, hh, alpha) {
    if (!(alpha > 0.003)) return;
    room(4, 6);
    const t = texOf(h);
    if (!t) return;
    const iw = t.w, ih = t.h;
    const sx = Math.round(u0 * iw), sy = Math.round(v0 * ih);
    const sw = Math.max(1, Math.round(u1 * iw) - sx), sh = Math.max(1, Math.round(v1 * ih) - sy);
    const mode = unitFor(t.t) << 4;
    affQuad(m[0], m[1], m[2], m[3], m[4], m[5], x, y, x + w, y + hh, sx / iw, sy / ih, (sx + sw) / iw, (sy + sh) / ih,
      gc(1, alpha >= 1 ? 1 : alpha), 0, 0, 0, 0, mode);
  };
  G.tri = function (h, u0, v0, u1, v1, u2, v2, x0, y0, x1, y1, x2, y2, shade) {
    room(3, 3);
    const t = texOf(h);
    if (!t) return;
    const mode = unitFor(t.t) << 4;
    const col = gc(shade < 0 ? 0 : shade > 1 ? 1 : shade, 1);
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
    const base = nV;
    vtx(a * x0 + c * y0 + e, b * x0 + d * y0 + f, u0, v0, col, 0, 0, 0, 0, mode);
    vtx(a * x1 + c * y1 + e, b * x1 + d * y1 + f, u1, v1, col, 0, 0, 0, 0, mode);
    vtx(a * x2 + c * y2 + e, b * x2 + d * y2 + f, u2, v2, col, 0, 0, 0, 0, mode);
    iBuf[nI++] = base; iBuf[nI++] = base + 1; iBuf[nI++] = base + 2;
  };
  G.meshBegin = IC.meshBegin;
  G.meshPt = IC.meshPt;
  G.meshDraw = function (h, mw, mh, alpha) {
    if (!(alpha > 0.003) || mw < 1 || mh < 1) return;
    const n = (mw + 1) * (mh + 1);
    if (meshN < n || n > MAXV) return;
    room(n, mw * mh * 6);
    const t = texOf(h);
    if (!t) return;
    const mode = unitFor(t.t) << 4;
    const col = gc(1, alpha >= 1 ? 1 : alpha);
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
    const base = nV;
    for (let j = 0, k = 0; j <= mh; j++) {
      for (let i = 0; i <= mw; i++, k += 2) {
        const x = meshXY[k], y = meshXY[k + 1];
        vtx(a * x + c * y + e, b * x + d * y + f, i / mw, j / mh, col, 0, 0, 0, 0, mode);
      }
    }
    for (let j = 0; j < mh; j++) {
      for (let i = 0; i < mw; i++) {
        const p = base + j * (mw + 1) + i, q = p + mw + 1;
        iBuf[nI++] = p; iBuf[nI++] = p + 1; iBuf[nI++] = q + 1;
        iBuf[nI++] = p; iBuf[nI++] = q + 1; iBuf[nI++] = q;
      }
    }
  };

  // shapes: distance fields, a pixel and a half of margin for the smooth edge. A stroke under a pixel wide is drawn
  // a pixel wide and fainter, as the canvas draws it.
  let SW = 0, SC = 0;
  function strokeOf(lw, argb, k) {
    let w = lw, f = 1;
    if (w * k < 1) { f = w * k; w = 1 / k; }
    SW = w / 2;
    SC = pc(argb, f);
  }
  G.fillRect = function (x, y, w, h, c) {
    if ((c >>> 24) === 0) return;
    room(4, 6);
    affQuad(m[0], m[1], m[2], m[3], m[4], m[5], x, y, x + w, y + h, 0, 0, 0, 0, pc(c, 1), 0, 0, 0, 0, 2);
  };
  function box(x, y, w, h, r, sw, col) {
    const hx = Math.abs(w) / 2, hy = Math.abs(h) / 2;
    const e = sw + 1.5 / devK();
    at(x + w / 2, y + h / 2, 0, 1, 1);
    room(4, 6);
    affQuad(A, B, C, D, E, F, -hx - e, -hy - e, hx + e, hy + e, -hx - e, -hy - e, hx + e, hy + e, col, hx, hy, r, sw, 5);
  }
  G.fillRoundRect = function (x, y, w, h, r, c) {
    if ((c >>> 24) === 0 || w <= 0 || h <= 0) return;
    box(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)), 0, pc(c, 1));
  };
  G.strokeRect = function (x, y, w, h, lw, c) {
    if ((c >>> 24) === 0 || !(lw > 0)) return;
    strokeOf(lw, c, devK());
    box(x, y, w, h, 0, SW, SC);
  };
  G.strokeRoundRect = function (x, y, w, h, r, lw, c) {
    if ((c >>> 24) === 0 || w <= 0 || h <= 0 || !(lw > 0)) return;
    strokeOf(lw, c, devK());
    box(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)), SW, SC);
  };
  G.fillCircle = function (x, y, r, c) {
    if ((c >>> 24) === 0 || !(r > 0)) return;
    const e = r + 1.5 / devK();
    at(x, y, 0, 1, 1);
    room(4, 6);
    affQuad(A, B, C, D, E, F, -e, -e, e, e, -e, -e, e, e, pc(c, 1), r, 0, 0, 0, 3);
  };
  G.strokeCircle = function (x, y, r, lw, c) {
    if ((c >>> 24) === 0 || !(r > 0) || !(lw > 0)) return;
    const k = devK();
    strokeOf(lw, c, k);
    const e = r + SW + 1.5 / k;
    at(x, y, 0, 1, 1);
    room(4, 6);
    affQuad(A, B, C, D, E, F, -e, -e, e, e, -e, -e, e, e, SC, r, SW, 0, 0, 4);
  };
  G.arc = function (x, y, r, a0, sweep, lw, c) {
    if ((c >>> 24) === 0 || !(r > 0) || sweep === 0 || !(lw > 0)) return;
    if (Math.abs(sweep) >= Math.PI * 2) { G.strokeCircle(x, y, r, lw, c); return; }
    const k = devK();
    strokeOf(lw, c, k);
    if (sweep < 0) { a0 += sweep; sweep = -sweep; }
    const e = r + SW + 1.5 / k;
    at(x, y, 0, 1, 1);
    room(4, 6);
    affQuad(A, B, C, D, E, F, -e, -e, e, e, -e, -e, e, e, SC, r, SW, a0, sweep, 7);
  };
  G.line = function (x1, y1, x2, y2, lw, c) {
    if ((c >>> 24) === 0 || !(lw > 0)) return;
    const k = devK();
    strokeOf(lw, c, k);
    const dx = x2 - x1, dy = y2 - y1, hl = Math.sqrt(dx * dx + dy * dy) / 2;
    at((x1 + x2) / 2, (y1 + y2) / 2, hl > 0 ? Math.atan2(dy, dx) : 0, 1, 1);
    const e = SW + 1.5 / k;
    room(4, 6);
    affQuad(A, B, C, D, E, F, -hl - e, -e, hl + e, e, -hl - e, -e, hl + e, e, SC, hl, SW, 0, 0, 6);
  };

  G.text = function (s, x, y, f, size, c, align) {
    if (!s || (c >>> 24) === 0 || !(size > 0)) return;
    const k = devK();
    const px = Math.round(size * k * 4) / 4;
    if (px < 1) return;
    room(4, 6);
    const e = textEntry(s, f, px);
    if (!e) return;
    const mode = (unitFor(atlasTex) << 4) | 1;
    const sc = size / px;               // units to an atlas pixel
    const shift = align === 1 ? e.w / 2 : align === 2 ? e.w : 0;
    let x0 = x - (e.ox + shift) * sc, y0 = y - e.oy * sc;
    if (m[1] === 0 && m[2] === 0 && m[0] > 0 && m[3] > 0) {
      // upright: on whole pixels, as crisp as the canvas draws it
      x0 = (Math.round(m[0] * x0 + m[4]) - m[4]) / m[0];
      y0 = (Math.round(m[3] * y0 + m[5]) - m[5]) / m[3];
    }
    affQuad(m[0], m[1], m[2], m[3], m[4], m[5], x0, y0, x0 + e.cw * sc, y0 + e.ch * sc, e.u0, e.v0, e.u1, e.v1,
      pc(c, 1), 0, 0, 0, 0, mode);
  };
  G.textWidth = function (s, f, size) {
    const px = Math.round(size * 4) / 4;
    const font = px + 'px IC' + f + ',' + FONT_FALLBACK[f];
    if (font !== tFont) { tctx.font = font; tFont = font; }
    return tctx.measureText(s).width;
  };

  G.freeImage = function (h) {
    const s = sprites[h];
    if (s && s.img && s.img.__ic) dropUpload(s.img.__ic);
    canvasFreeImage(h);
  };

  // a bake: drawn into a picture of its own, which becomes the sprite; its calls are kept to draw it again
  G.bakeBegin = function (name, w, h, pw, ph, px) {
    if (pw * ph > 4096 * 4096 || pw > maxTex || ph > maxTex) return -1;
    const T = fbTarget(pw, ph, null);
    const hd = sprites.length;
    const rec = [];
    sprites.push({ name: name, w: w, h: h, img: null, fb: -1, tints: null, baking: true,
                   glt: { t: T.tex, w: pw, h: ph, gen: glGen }, bake: { pw: pw, ph: ph, px: px, rec: rec } });
    glPush(T, [px, 0, 0, px, pw / 2, ph / 2]);
    gtargets[gtargets.length - 1].bake = hd;
    clearTarget(0, 0, 0, 0);
    recording = rec;
    return hd;
  };
  G.bakeEnd = function () {
    if (!gtargets.length) return;
    const T = tgt;
    const r = glPop();
    recording = r.rec;
    if (r.bake !== undefined) {
      dropTarget(T, false);
      mipmap(T.tex);
    }
  };
  /** After a lost context comes back: every bake drawn again from its kept calls. */
  function replayBakes() {
    for (let hd = 0; hd < sprites.length; hd++) {
      const s = sprites[hd];
      if (!s.bake) continue;
      const B = s.bake;
      const T = fbTarget(B.pw, B.ph, null);
      s.glt = { t: T.tex, w: B.pw, h: B.ph, gen: glGen };
      glPush(T, [B.px, 0, 0, B.px, B.pw / 2, B.ph / 2]);
      clearTarget(0, 0, 0, 0);
      for (const call of B.rec) {
        try { call[0].apply(null, call[1]); } catch (err) { /* draw what can be */ }
      }
      glPop();
      dropTarget(T, false);
      mipmap(T.tex);
    }
  }

  // a layer: what's drawn until layerEnd, laid over the target at an opacity
  const layerTs = [];
  G.layerBegin = function (alpha) {
    const depth = gtargets.length;
    const L = layerTs[depth] = fbTarget(tgt.w, tgt.h, layerTs[depth]);
    glPush(L, m.slice());
    const r = gtargets[gtargets.length - 1];
    r.layer = L;
    r.alpha = alpha;
    clearTarget(0, 0, 0, 0);
  };
  G.layerEnd = function () {
    if (!gtargets.length) return;
    const r = glPop();
    if (!r.layer) return;
    const a = Math.max(0, Math.min(1, r.alpha));
    if (a <= 0.003) return;
    room(4, 6);
    const mode = unitFor(r.layer.tex) << 4;
    devQuad(0, 0, tgt.w, tgt.h, 0, 0, 1, 1, gc(1, a), mode);
  };

  // the light map: lights added over the ambient colour, then multiplied over the target
  let lightT = null, lightRec = null;
  G.lightBegin = function (ambient, res, zoom) {
    if (lightRec) return;
    const z = zoom > 0 ? zoom : 1;
    const w = Math.max(1, Math.round(logicalW * res)), h = Math.max(1, Math.round(logicalH * res));
    lightT = fbTarget(w, h, lightT);
    glPush(lightT, [w / logicalW * z, 0, 0, h / logicalH * z, 0, 0]);
    lightRec = gtargets[gtargets.length - 1];
    clearTarget(((ambient >> 16) & 255) / 255, ((ambient >> 8) & 255) / 255, (ambient & 255) / 255, 1);
    setBlend(1);
  };
  G.lightAdd = function (add) { if (lightRec) setBlend(add ? 1 : 0); };
  G.lightEnd = function () {
    if (!lightRec) return;
    while (gtargets.length && gtargets[gtargets.length - 1] !== lightRec) glPop();
    const r = glPop();
    lightRec = null;
    setBlend(2);
    room(4, 6);
    const mode = unitFor(lightT.tex) << 4;
    devQuad(0, 0, tgt.w, tgt.h, 0, 0, 1, 1, gc(1, 1), mode);
    setBlend(r.blend);
  };

  /** WebGL 2 on the page's canvas, the IC calls turned over to it. False if this browser can't. */
  function installGL() {
    let c = null;
    try {
      c = canvas.getContext('webgl2', { alpha: false, antialias: !IC.query('noaa'), depth: false, stencil: true,
        premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    } catch (err) { c = null; }
    if (!c) return false;
    gl = c;
    try {
      glSetup();
    } catch (err) {
      IC.log('WebGL setup failed: ' + err);
      gl = null;
      // a canvas that has given out a WebGL context can't give a 2D one: a fresh element takes its place
      const fresh = canvas.cloneNode(false);
      canvas.parentNode.replaceChild(fresh, canvas);
      canvas = fresh;
      return false;
    }
    tctx = document.createElement('canvas').getContext('2d');
    for (const k of Object.keys(G)) {
      const f = G[k];
      if (k === 'bakeBegin' || k === 'bakeEnd' || k === 'textWidth' || k === 'freeImage') { IC[k] = f; continue; }
      IC[k] = function () {
        if (recording !== null) recording.push([f, Array.prototype.slice.call(arguments)]);
        return f.apply(null, arguments);
      };
    }
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      glLost = true;
      IC.log('WebGL context lost');
    });
    canvas.addEventListener('webglcontextrestored', function () {
      try {
        glGen++;
        live.clear();
        texBytes = 0;
        glSetup();
        replayBakes();
        glLost = false;
        IC.log('WebGL context restored');
      } catch (err) {
        IC.log('WebGL restore failed: ' + err);
      }
    });
    return true;
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
    if (gl) flush();
  }

  // ------------------------------------------------------------------ splash and boot

  let splashLogo = -1, progress = 0, splashText = 'MUSTERING TROOPS';

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
    if (gl) flush();
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
    // WebGL 2 where the browser has it (?canvas: the old Canvas 2D renderer, also the fallback)
    if (IC.query('canvas') || !installGL()) ctx = canvas.getContext('2d', { alpha: false });
    IC.log('renderer: ' + IC.renderer());
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
    try {
      const r = await fetch('images.json');
      imageSizes = await r.json();
    } catch (err) {
      IC.log('image manifest failed: ' + err);
    }
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
    if (gl) atlasReset();      // (strings drawn before the fonts arrived were drawn in the fallback font)
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
