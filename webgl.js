/*
 * The page's WebGL 2 context for the phone's GPU renderer (core.gl.GlGfx, compiled into classes.js): each call of
 * core.gl.GL arrives here through web.WebGL as numbers, and is made on the context. OpenGL ES 3.0 names its objects
 * by ints, WebGL by objects, so the objects are kept here under ints (never 0, which is GL's "none"; never reused).
 * The constants are the same in both, so they pass as they are. Data comes by reference: web.WebGL stages a Java
 * array (the typed array TeaVM keeps it in) and the next call that takes data reads it.
 *
 * Also here: the atlas's text (web.WebGlyphs), drawn on a canvas of its own in the game's fonts.
 */
'use strict';
(function () {
  const G = (window.ICGL = {});
  let gl = null;
  let objs = new Map(), nextId = 1;
  let locs = new Map();                   // program -> (uniform name -> its int)
  let exts = '';

  function put(o) {
    if (!o) return 0;
    const id = nextId++;
    objs.set(id, o);
    return id;
  }
  function obj(id) { return id > 0 ? objs.get(id) || null : null; }
  function take(id) { const o = obj(id); objs.delete(id); return o; }

  /** The context to draw on (a new one after a loss: every object of the old one is gone). */
  G.attach = function (context) {
    gl = context;
    objs = new Map();
    locs = new Map();
    // the extensions the renderer looks for, by their OpenGL ES names; asking for one in WebGL turns it on
    const want = {
      EXT_color_buffer_float: 'GL_EXT_color_buffer_float',
      EXT_color_buffer_half_float: 'GL_EXT_color_buffer_half_float',
      EXT_float_blend: 'GL_EXT_float_blend',
      OES_texture_float_linear: 'GL_OES_texture_float_linear',
    };
    const have = [];
    for (const k of Object.keys(want)) {
      try { if (gl.getExtension(k)) have.push(want[k]); } catch (err) { /* not offered */ }
    }
    exts = have.join(' ');
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (window.IC) IC.log('GPU renderer on WebGL 2: ' + G.getString(0x1F01) + (exts ? ' (' + exts + ')' : ''));
  };

  // ---- data staged for the next call that takes some: a typed array (sa), its elements [so, so + sn). WebGL 2 takes
  // an offset and a count with the array, so nothing is made a frame: a texture's data, where WebGL wants another
  // type of array over the same bytes (a Java byte[] is an Int8Array; WebGL reads bytes from a Uint8Array), gets a
  // view of the whole array, made once for each array
  let sa = null, so = 0, sn = 0;
  G.stageNone = function () { sa = null; };
  G.stage = function (a, off, n) { sa = a; so = off; sn = n; };
  const views = new WeakMap();
  function viewAs(C, a) {
    if (a instanceof C) return a;
    let v = views.get(a);
    if (!v || !(v instanceof C)) {
      v = new C(a.buffer, a.byteOffset, (a.byteLength / C.BYTES_PER_ELEMENT) | 0);
      views.set(a, v);
    }
    return v;
  }
  /** The staged array as WebGL wants it for a texture of this type, and the staged offset in its elements (texOff). */
  let texOff = 0;
  function texData(type) {
    if (!sa) return null;
    let v;
    switch (type) {
      case 0x1401: v = viewAs(Uint8Array, sa); break;                                    // UNSIGNED_BYTE
      case 0x1406: v = viewAs(Float32Array, sa); break;                                  // FLOAT
      case 0x140B: case 0x1403: v = viewAs(Uint16Array, sa); break;                      // HALF_FLOAT, UNSIGNED_SHORT
      case 0x1405: v = viewAs(Uint32Array, sa); break;                                   // UNSIGNED_INT
      default: v = sa;
    }
    texOff = so * sa.BYTES_PER_ELEMENT / v.BYTES_PER_ELEMENT;
    return v;
  }

  // ---- shaders and programs
  G.createShader = function (type) { return put(gl.createShader(type)); };
  G.shaderSource = function (s, src) { gl.shaderSource(obj(s), src); };
  G.compileShader = function (s) { gl.compileShader(obj(s)); };
  G.compiled = function (s) { return !!gl.getShaderParameter(obj(s), gl.COMPILE_STATUS); };
  G.shaderLog = function (s) { return gl.getShaderInfoLog(obj(s)) || ''; };
  G.deleteShader = function (s) { const o = take(s); if (o) gl.deleteShader(o); };
  G.createProgram = function () { return put(gl.createProgram()); };
  G.attachShader = function (p, s) { gl.attachShader(obj(p), obj(s)); };
  G.bindAttribLocation = function (p, i, name) { gl.bindAttribLocation(obj(p), i, name); };
  G.linkProgram = function (p) { gl.linkProgram(obj(p)); };
  G.linked = function (p) { return !!gl.getProgramParameter(obj(p), gl.LINK_STATUS); };
  G.programLog = function (p) { return gl.getProgramInfoLog(obj(p)) || ''; };
  G.useProgram = function (p) { gl.useProgram(obj(p)); };
  G.getUniformLocation = function (p, name) {
    let m = locs.get(p);
    if (!m) { m = new Map(); locs.set(p, m); }
    let id = m.get(name);
    if (id === undefined) {
      const l = gl.getUniformLocation(obj(p), name);
      id = l ? put(l) : -1;
      m.set(name, id);
    }
    return id;
  };
  G.uniform1i = function (l, v) { if (l > 0) gl.uniform1i(obj(l), v); };
  G.uniform1f = function (l, v) { if (l > 0) gl.uniform1f(obj(l), v); };
  G.uniform2f = function (l, a, b) { if (l > 0) gl.uniform2f(obj(l), a, b); };
  G.uniform3f = function (l, a, b, c) { if (l > 0) gl.uniform3f(obj(l), a, b, c); };
  G.uniform4f = function (l, a, b, c, d) { if (l > 0) gl.uniform4f(obj(l), a, b, c, d); };
  G.uniform4fv = function (l, n, v, off) { if (l > 0 && n > 0) gl.uniform4fv(obj(l), v, off, n * 4); };
  G.uniform3fv = function (l, n, v, off) { if (l > 0 && n > 0) gl.uniform3fv(obj(l), v, off, n * 3); };

  // ---- vertices
  G.genVertexArray = function () { return put(gl.createVertexArray()); };
  G.bindVertexArray = function (v) { gl.bindVertexArray(obj(v)); };
  G.deleteVertexArray = function (v) { const o = take(v); if (o) gl.deleteVertexArray(o); };
  G.genBuffer = function () { return put(gl.createBuffer()); };
  G.bindBuffer = function (t, b) { gl.bindBuffer(t, obj(b)); };
  G.bufferData = function (t, bytes, u) {
    if (sa && sn > 0) gl.bufferData(t, sa, u, so, sn);
    else gl.bufferData(t, bytes, u);
  };
  G.bufferSubData = function (t, off) { if (sa && sn > 0) gl.bufferSubData(t, off, sa, so, sn); };
  G.deleteBuffer = function (b) { const o = take(b); if (o) gl.deleteBuffer(o); };
  G.enableVertexAttribArray = function (i) { gl.enableVertexAttribArray(i); };
  G.vertexAttribPointer = function (i, size, type, norm, stride, off) { gl.vertexAttribPointer(i, size, type, norm, stride, off); };
  G.vertexAttribDivisor = function (i, d) { gl.vertexAttribDivisor(i, d); };
  G.drawElements = function (m, n, t, off) { gl.drawElements(m, n, t, off); };
  G.drawArrays = function (m, f, n) { gl.drawArrays(m, f, n); };
  G.drawArraysInstanced = function (m, f, n, k) { gl.drawArraysInstanced(m, f, n, k); };

  // ---- textures
  G.genTexture = function () { return put(gl.createTexture()); };
  G.deleteTexture = function (t) { const o = take(t); if (o) gl.deleteTexture(o); };
  G.activeTexture = function (u) { gl.activeTexture(u); };
  G.bindTexture = function (t, x) { gl.bindTexture(t, obj(x)); };
  G.texImage2D = function (t, lv, ifmt, w, h, b, fmt, type) {
    const v = texData(type);
    if (v) gl.texImage2D(t, lv, ifmt, w, h, b, fmt, type, v, texOff);
    else gl.texImage2D(t, lv, ifmt, w, h, b, fmt, type, null);
  };
  G.texSubImage2D = function (t, lv, x, y, w, h, fmt, type) {
    const v = texData(type);
    if (v) gl.texSubImage2D(t, lv, x, y, w, h, fmt, type, v, texOff);
  };
  G.texParameteri = function (t, n, v) { gl.texParameteri(t, n, v); };
  G.generateMipmap = function (t) { gl.generateMipmap(t); };
  G.pixelStorei = function (n, v) { gl.pixelStorei(n, v); };
  /** A sprite's picture into the bound texture, premultiplied (GlGfx's pictures are): its size (w << 16 | h), or -1. */
  G.texSprite = function (h) {
    const im = IC.spriteImg(h);
    if (!im) return -1;
    const w = im.naturalWidth || im.width, hh = im.naturalHeight || im.height;
    if (!(w > 0 && hh > 0)) return -1;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    } catch (err) {
      IC.log('picture upload failed (' + w + 'x' + hh + '): ' + err);
      return -1;
    } finally {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    return (w << 16) | hh;
  };
  G.spriteState = function (h) { return IC.spriteState(h); };
  G.genSampler = function () { return put(gl.createSampler()); };
  G.bindSampler = function (u, s) { gl.bindSampler(u, obj(s)); };
  G.samplerParameteri = function (s, n, v) { gl.samplerParameteri(obj(s), n, v); };

  // ---- what's drawn into
  G.genFramebuffer = function () { return put(gl.createFramebuffer()); };
  G.deleteFramebuffer = function (f) { const o = take(f); if (o) gl.deleteFramebuffer(o); };
  G.bindFramebuffer = function (t, f) { gl.bindFramebuffer(t, obj(f)); };
  G.framebufferTexture2D = function (t, a, tt, x, lv) { gl.framebufferTexture2D(t, a, tt, obj(x), lv); };
  G.framebufferRenderbuffer = function (t, a, rt, rb) { gl.framebufferRenderbuffer(t, a, rt, obj(rb)); };
  G.checkFramebufferStatus = function (t) { return gl.checkFramebufferStatus(t); };
  G.blitFramebuffer = function (x0, y0, x1, y1, dx0, dy0, dx1, dy1, mask, filter) {
    gl.blitFramebuffer(x0, y0, x1, y1, dx0, dy0, dx1, dy1, mask, filter);
  };
  G.genRenderbuffer = function () { return put(gl.createRenderbuffer()); };
  G.deleteRenderbuffer = function (r) { const o = take(r); if (o) gl.deleteRenderbuffer(o); };
  G.bindRenderbuffer = function (t, r) { gl.bindRenderbuffer(t, obj(r)); };
  G.renderbufferStorage = function (t, f, w, h) { gl.renderbufferStorage(t, f, w, h); };
  G.renderbufferStorageMultisample = function (t, s, f, w, h) { gl.renderbufferStorageMultisample(t, s, f, w, h); };
  G.readPixels = function (x, y, w, h, fmt, type) {
    const v = texData(type);
    if (v) gl.readPixels(x, y, w, h, fmt, type, v, texOff);
  };

  // ---- state
  G.viewport = function (x, y, w, h) { gl.viewport(x, y, w, h); };
  G.scissor = function (x, y, w, h) { gl.scissor(x, y, w, h); };
  G.clearColor = function (r, g, b, a) { gl.clearColor(r, g, b, a); };
  G.clearStencil = function (s) { gl.clearStencil(s); };
  G.clearDepth = function (d) { gl.clearDepth(d); };
  G.clear = function (m) { gl.clear(m); };
  G.colorMask = function (r, g, b, a) { gl.colorMask(r, g, b, a); };
  G.depthMask = function (on) { gl.depthMask(on); };
  G.depthFunc = function (f) { gl.depthFunc(f); };
  G.enable = function (c) { gl.enable(c); };
  G.disable = function (c) { gl.disable(c); };
  G.blendFunc = function (s, d) { gl.blendFunc(s, d); };
  G.blendFuncSeparate = function (sr, dr, sa, da) { gl.blendFuncSeparate(sr, dr, sa, da); };
  G.blendEquation = function (m) { gl.blendEquation(m); };
  const att = [[], [0], [0, 0], [0, 0, 0]];
  G.invalidateFramebuffer = function (t, n, a0, a1, a2) {
    const a = att[n];
    if (n > 0) a[0] = a0;
    if (n > 1) a[1] = a1;
    if (n > 2) a[2] = a2;
    gl.invalidateFramebuffer(t, a);
  };
  G.stencilFunc = function (f, r, m) { gl.stencilFunc(f, r, m); };
  G.stencilOp = function (f, zf, zp) { gl.stencilOp(f, zf, zp); };
  G.stencilMask = function (m) { gl.stencilMask(m); };
  G.getInteger = function (n) { const v = gl.getParameter(n); return typeof v === 'number' ? v | 0 : 0; };
  G.getString = function (n) {
    if (n === 0x1F02) return 'OpenGL ES 3.0 (WebGL 2)';                            // VERSION
    if (n === 0x1F03) return exts;                                                   // EXTENSIONS
    if (n === 0x1F01) {                                                              // RENDERER
      try {
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        if (d) return String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL));
      } catch (err) { /* hidden */ }
      return String(gl.getParameter(gl.RENDERER));
    }
    const v = gl.getParameter(n);
    return v === null || v === undefined ? null : String(v);
  };
  G.getError = function () { return gl.getError(); };
  G.flush = function () { gl.flush(); };
  G.finish = function () { gl.finish(); };

  // ---- text for the atlas (web.WebGlyphs): measured and drawn on a canvas kept for reading back
  let tc = null, tx = null, tcW = 0, tcH = 0, tFont = '';
  function textCtx(w, h) {
    if (!tc) {
      tc = document.createElement('canvas');
      tc.width = tcW = 256;
      tc.height = tcH = 64;
      tx = tc.getContext('2d', { willReadFrequently: true });
      tFont = '';
    }
    if (w > tcW || h > tcH) {
      tc.width = tcW = Math.max(tcW, w);
      tc.height = tcH = Math.max(tcH, h);
      tFont = '';                         // (a canvas made bigger forgets its state)
    }
    return tx;
  }
  function font(g, f, px) {
    const s = IC.fontCss(f, px);
    if (s !== tFont) { g.font = s; tFont = s; }
  }
  /** s's advance at px pixels; its bounds round the pen into b: left of it, right of it, above, below. */
  G.glyphMeasure = function (s, f, px, b) {
    const g = textCtx(1, 1);
    font(g, f, px);
    const m = g.measureText(s);
    const adv = m.width;
    const fa = m.fontBoundingBoxAscent !== undefined ? m.fontBoundingBoxAscent : px * 0.8;
    const fd = m.fontBoundingBoxDescent !== undefined ? m.fontBoundingBoxDescent : px * 0.25;
    const al = m.actualBoundingBoxLeft !== undefined ? m.actualBoundingBoxLeft : 0;
    const ar = m.actualBoundingBoxRight !== undefined ? m.actualBoundingBoxRight : adv;
    const aa = m.actualBoundingBoxAscent !== undefined ? m.actualBoundingBoxAscent : fa;
    const ad = m.actualBoundingBoxDescent !== undefined ? m.actualBoundingBoxDescent : fd;
    b[0] = Math.max(0, al);
    b[1] = Math.max(adv, ar);
    b[2] = Math.max(fa, aa);
    b[3] = Math.max(fd, ad);
    return adv;
  };
  /** s at px pixels, its pen at (ox, oy) of a w x h picture: its coverage, a byte a pixel, into out from off. */
  G.glyphDraw = function (s, f, px, ox, oy, w, h, out, off) {
    const g = textCtx(w, h);
    font(g, f, px);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillText(s, ox, oy);
    const d = g.getImageData(0, 0, w, h).data;
    const o = new Uint8Array(out.buffer, out.byteOffset + off, w * h);
    for (let i = 0, k = 3, n = w * h; i < n; i++, k += 4) o[i] = d[k];
  };
})();
