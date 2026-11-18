/*
 * The test build's gate (Nov 2026: shared with friends while testing, never the release). Before the game starts it
 * asks for the password, makes the key from it and decrypts the game's code (classes.lock, sealed by
 * web/tools/lock.mjs), then starts the game. The key is kept in this browser, so the password is asked for once.
 * A build without the lock (the CI smoke test's) just starts.
 */
'use strict';
(function () {
  const KEEP = 'ironclad3test.gate';

  function fail(why) {
    document.getElementById('failwhy').textContent = why;
    document.getElementById('fail').classList.add('show');
    if (window.IC) IC.log('fail: ' + why);
  }

  function start() {
    if (typeof main !== 'function') { fail('The game code did not load.'); return; }
    try { main(); } catch (e) { fail('Start-up error: ' + (e && e.message ? e.message : e)); }
  }

  function runCode(bytes) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
      const s = document.createElement('script');
      s.onload = function () { URL.revokeObjectURL(url); resolve(); };
      s.onerror = function () { reject(new Error('the game code would not run')); };
      s.src = url;
      document.body.appendChild(s);
    });
  }

  function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(s) { const t = atob(s); const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; }

  async function keyFrom(password, lock) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(lock.salt), iterations: lock.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }

  async function open(key, sealed) {
    const iv = sealed.subarray(0, 12), body = sealed.subarray(12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, body));
  }

  function remembered() { try { return window.localStorage.getItem(KEEP); } catch (e) { return null; } }
  function remember(raw) { try { window.localStorage.setItem(KEEP, raw); } catch (e) { /* storage blocked */ } }
  function forget() { try { window.localStorage.removeItem(KEEP); } catch (e) { /* storage blocked */ } }

  function showGate(lock, sealed) {
    const gate = document.getElementById('gate');
    const input = document.getElementById('gatepw');
    const msg = document.getElementById('gatemsg');
    const btn = document.getElementById('gatego');
    gate.classList.add('show');
    let busy = false;
    async function tryIt() {
      if (busy) return;
      const pw = (input.value || '').trim().toLowerCase();
      if (!pw) { msg.textContent = 'ENTER THE PASSWORD'; return; }
      busy = true;
      btn.disabled = true;
      msg.textContent = 'CHECKING...';
      try {
        const key = await keyFrom(pw, lock);
        const code = await open(key, sealed);
        remember(b64(new Uint8Array(await crypto.subtle.exportKey('raw', key))));
        msg.textContent = 'ACCESS GRANTED';
        gate.classList.remove('show');
        input.blur();
        await runCode(code);
        start();
      } catch (e) {
        msg.textContent = 'WRONG PASSWORD';
        input.select();
      }
      busy = false;
      btn.disabled = false;
    }
    btn.addEventListener('click', tryIt);
    input.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); tryIt(); } });
    setTimeout(function () { try { input.focus(); } catch (e) { /* needs a tap on iOS */ } }, 50);
  }

  async function boot() {
    let lock = null;
    try {
      const r = await fetch('lock.json', { cache: 'no-store' });
      if (r.ok) lock = await r.json();
    } catch (e) { lock = null; }
    if (!lock) {
      // not locked: the plain code
      const s = document.createElement('script');
      s.onload = start;
      s.onerror = function () { fail('The game code (classes.js) did not load.'); };
      s.src = 'classes.js' + (window.IC_BUILD ? '?v=' + window.IC_BUILD : '');
      document.body.appendChild(s);
      return;
    }
    if (!window.crypto || !crypto.subtle) { fail('This browser can\'t open the test build (it needs a secure https page).'); return; }
    let sealed;
    try {
      const r = await fetch('classes.lock', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      sealed = new Uint8Array(await r.arrayBuffer());
    } catch (e) { fail('The game code did not load: ' + e.message); return; }
    const kept = remembered();
    if (kept) {
      try {
        const key = await crypto.subtle.importKey('raw', unb64(kept), { name: 'AES-GCM' }, false, ['decrypt']);
        const code = await open(key, sealed);
        await runCode(code);
        start();
        return;
      } catch (e) { forget(); }      // a new password since: ask again
    }
    showGate(lock, sealed);
  }

  window.addEventListener('load', boot);
})();
