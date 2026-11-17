// ==UserScript==
// @name         Hiperdex Comfy Reader
// @namespace    https://github.com/YoruCAnime/Anime-site-scripts
// @version      1.5.2
// @description  hiperdex.com: smooth arrow-key scrolling while reading (tap Up / Down for a small smooth step, hold to glide at an even speed, Shift = faster) no ads (the ad companies' scripts are not let in, so no pop-up tabs on clicks; ad boxes and sponsored cards hidden), a chapter opens again where you stopped reading it, and what you read here is saved to your atsu.moe account too (chapter, how far, Reading list). The home page gets atsu-style "Continue Reading" and "Updates For You" rows, and a series page a "Resume" button with your read chapters marked. On a chapter, K starts / stops auto-scroll (a speed bar from a slow creep to fast, bottom right), Home goes to the home page and End to the series page. Left / Right arrows do nothing on hiperdex. Every other key is left as it is. On a phone (Firefox + Tampermonkey) a small button bar on chapters does the same: home, series page, auto-scroll.
// @author       YoruC
// @homepageURL  https://github.com/YoruCAnime/Atsumoe-stuff
// @updateURL    https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/hiperdex/hiperdex-comfy.user.js
// @downloadURL  https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/hiperdex/hiperdex-comfy.user.js
// @match        https://hiperdex.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      atsu.moe
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------- ads: hidden with one style rule (no checking, no timers) ----------
  // hiperdex draws its ads with one part of the page ("AdSlot": a row above and below the chapter, boxes on the
  // other pages) and fills it with code from ad companies. The row and the boxes are hidden; ad frames that get in
  // some other way are hidden by where they come from.
  // "Sponsored / Partner feature" cards among the series are links marked rel="sponsored".
  const HIDE = '[data-loc*="components/AdSlot"], .ad-unit, a[rel~="sponsored"], '
    + 'iframe[src*="magsrv.com"], iframe[src*="a-ads.com"], iframe[src*="acceptable.a-ads"], iframe[src*="jads.co"], '
    + 'iframe[src*="juicyads"], iframe[src*="exoclick"], iframe[src*="exosrv"], ins[class*="adsby"], ins[data-zoneid]';
  const style = document.createElement('style');
  style.id = 'hdc-style';
  const SOFT = '#9ec5f8';      // soft light blue (hiperdex's own blue-500 is hard on the eyes)
  // hiperdex's own reader progress bar (reader setting, left or right of the pages): the filled part in soft blue
  style.textContent = HIDE + ' { display: none !important; }'
    + ' div.fixed.top-0.bottom-0 div.rounded-full > div.bg-blue-500 { background-color: ' + SOFT + ' !important; }';

  // ---------- ads: their scripts are not let in ----------
  // The pop-up tab on any click comes from an ad company's "pop-under" script (a.pemsrv.com/popunder1000.js); the
  // banners come from a.magsrv.com and poweredby.jads.co. One browser rule for this page ("scripts only from
  // hiperdex itself and Cloudflare") keeps every outside script from loading, whatever ad company is used next.
  // The rule is the browser's own (a Content-Security-Policy), so nothing has to watch the page.
  const RULE = "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://*.hiperdex.com https://*.cloudflare.com "
    + "https://static.cloudflareinsights.com https://*.google.com https://*.gstatic.com https://*.hcaptcha.com";
  function setUp() {
    const head = document.head || document.documentElement;
    if (!document.getElementById('hdc-rule')) {
      const meta = document.createElement('meta');
      meta.id = 'hdc-rule'; meta.httpEquiv = 'Content-Security-Policy'; meta.content = RULE;
      head.insertBefore(meta, head.firstChild);
    }
    if (!style.isConnected) head.appendChild(style);
  }
  if (document.head) setUp();
  else {                                                       // this early the page has no <head> yet: wait for it
    const mo = new MutationObserver(() => { if (document.head) { mo.disconnect(); setUp(); } });
    mo.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => { mo.disconnect(); setUp(); });
  }
  // A second pop-up is in hiperdex's own ad code (no outside script needed): on a click anywhere it opens a new tab
  // and sends it to an ad. hiperdex's own buttons and links never open tabs that way (they are ordinary links), so
  // on this site the page is simply not allowed to open tabs or windows by itself. Links you click that are meant
  // to open in a new tab still do. Set POPUPS to true if some hiperdex feature ever needs its own window.
  const POPUPS = false;
  if (!POPUPS) {
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      // the ad code gets a stand-in for "its" window, so it neither breaks with an error nor tries something else
      const dud = () => ({ closed: true, close() {}, focus() {}, blur() {}, postMessage() {}, location: { href: '', replace() {}, assign() {} }, document: { write() {}, close() {}, open() {} }, opener: null });
      // Firefox (Tampermonkey there may keep the script apart from the page): the page can only call what is handed
      // over to it with Firefox's own exportFunction / cloneInto
      const own = typeof exportFunction === 'function' && w !== window;
      const fn = own ? function () { return cloneInto(dud(), w, { cloneFunctions: true }); } : function () { return dud(); };
      w.open = own ? exportFunction(fn, w) : fn;
    } catch (e) { /* the page's window is out of reach: the rule above still stands */ }
  }

  // ---------- feel (the same numbers as Atsu Comfy Reader; change to taste) ----------
  const TAP = 0.20;         // one tap moves this much of the screen
  const GLIDE = 0.70;       // holding moves this many screens per second
  const FAST = 2.5;         // Shift makes taps and gliding this much faster
  const HOLD_DELAY = 170;   // ms a key must be held before gliding starts (a tap is shorter)
  const TAP_TAU = 0.075;    // s, how quickly a tap settles
  const RAMP_UP = 0.14;     // s, glide speeding up
  const RAMP_DOWN = 0.055;  // s, glide stopping after the key is let go

  const root = () => document.scrollingElement || document.documentElement;
  // a chapter page (/manga/<series>/<number>): the pages are img[alt="Page N"] and the window itself scrolls
  const reading = () => /^\/manga\/[^/]+\/\d/.test(location.pathname) && !!document.querySelector('img[alt^="Page "]')
    && root().scrollHeight > innerHeight + 20;
  const maxTop = () => root().scrollHeight - innerHeight;

  // never take the arrows from text boxes (comments), sliders, open lists or other add-ons' boxes
  function leaveAlone(e) {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!t || !t.closest) return false;
    if (t.closest('#hdc-auto')) return false;               // our speed bar never keeps the keys
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    if (t.tagName === 'INPUT') return !/^(button|submit|reset|checkbox|radio)$/i.test(t.type);
    return !!t.closest('[role="textbox"],[role="listbox"],[role="menu"],[role="option"],[role="menuitem"],[role="dialog"],[role="slider"],#malp,#MalData,[id^="flash"],.mal-sync');
  }

  // ---------- motion ----------
  let pos = null;       // our own (fractional) scroll position
  let lastSet = -1;     // what the page reported after our last write
  let pending = 0;      // distance still to travel from taps
  let vel = 0;          // gliding speed now, px/s
  let hold = null;      // {dir, key, fast, t0} while Up / Down is held
  let raf = 0, lastT = 0;

  function run() {
    if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(frame); }
  }

  function frame(t) {
    const dt = Math.min(0.05, Math.max(0, (t - lastT) / 1000));
    lastT = t;
    // a phone: while your finger is on the page or the page still slides from a flick, auto-scroll waits (it would
    // fight your finger) and carries on from where you let it go
    if (auto.on && fingerBusy()) { pos = null; raf = requestAnimationFrame(frame); return; }
    const el = root();
    const cur = el.scrollTop;
    // the mouse wheel, scrollbar or the site moved the page: carry on from there
    if (pos === null || Math.abs(cur - lastSet) > 2) pos = cur;

    const step = pending * (1 - Math.exp(-dt / TAP_TAU));
    pending -= step;

    let want = 0;
    if (hold && t - hold.t0 >= HOLD_DELAY) want = hold.dir * GLIDE * innerHeight * (hold.fast ? FAST : 1);
    vel += (want - vel) * (1 - Math.exp(-dt / (want ? RAMP_UP : RAMP_DOWN)));
    if (!want && Math.abs(vel) < 30) vel = 0;

    // auto-scroll (K): waits while "back where you stopped" is still placing the page, and while no pages are in
    let av = 0;
    if (auto.on) {
      if (!chapterPath()) autoSet(false);
      else if (!(rd && rd.resume)) av = autoSpeed();
    }
    pos += step + vel * dt + av * dt;
    const max = maxTop();
    if (pos <= 0) { pos = 0; if (pending < 0) pending = 0; if (vel < 0) vel = 0; }
    if (pos >= max) { pos = max; if (pending > 0) pending = 0; if (vel > 0) vel = 0; }
    window.scrollTo({ top: pos, behavior: 'instant' });
    lastSet = el.scrollTop;

    if (!auto.on && !hold && vel === 0 && Math.abs(pending) < 0.5) {
      pending = 0; raf = 0; pos = null;
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  // ---------- keys: Up / Down (and Shift while holding), K auto-scroll, Home / End, Left / Right switched off ----------
  function onKeyDown(e) {
    if (e.key === 'Shift') { if (hold) hold.fast = true; return; }
    const mods = e.ctrlKey || e.altKey || e.metaKey;
    // Left / Right do nothing on hiperdex (no jumping to another chapter by accident). Alt+Left (browser back) and
    // text boxes keep them.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mods && !leaveAlone(e)) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (!mods && !e.shiftKey && (e.key === 'k' || e.key === 'K') && !leaveAlone(e) && chapterPath()) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) autoSet(!auto.on);
      return;
    }
    // on a chapter: Home = hiperdex's home page, End = this series' page (all its chapters)
    if ((e.key === 'Home' || e.key === 'End') && !mods && !e.shiftKey && !leaveAlone(e) && chapterPath()) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) goTo(e.key === 'Home' ? '/' : '/manga/' + location.pathname.split('/')[2]);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (leaveAlone(e) || !reading()) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;                                    // holding is handled by the glide
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    hold = { dir, key: e.key, fast: e.shiftKey, t0: performance.now() };
    if (Math.sign(pending) !== dir) pending = 0;            // turning round: drop the old tap
    pending += dir * innerHeight * TAP * (e.shiftKey ? FAST : 1);
    run();
  }

  function onKeyUp(e) {
    if (e.key === 'Shift') { if (hold) hold.fast = false; return; }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.ctrlKey || e.altKey || e.metaKey) && !leaveAlone(e)) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (hold && e.key === hold.key) {
      e.preventDefault(); e.stopImmediatePropagation();
      hold = null;                                           // stops gliding at once (a short ease out)
      run();
    }
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', () => { hold = null; });

  // ---------- auto-scroll: K on a chapter starts / stops it; a small speed bar sits bottom right while it runs ----------
  // The speed goes from a slow creep (6 px a second) up to fast reading (700 px a second) and is remembered. Drag
  // the bar or turn the mouse wheel over it. Up / Down, the wheel and the scrollbar still work while it runs. It
  // waits at the end of a chapter and carries on when you open the next one; it stops when you leave the chapters.
  const AUTO_MIN = 6, AUTO_MAX = 700, AUTO_KEY = 'hdc:auto';
  const auto = { on: false, v: 35, el: null, fade: 0 };     // v = bar position 0..100
  try { const s = JSON.parse(localStorage.getItem(AUTO_KEY) || '{}'); if (s && s.v >= 0 && s.v <= 100) auto.v = s.v; } catch (e) { /* default */ }
  const chapterPath = () => /^\/manga\/[^/]+\/\d/.test(location.pathname);
  const autoSpeed = () => AUTO_MIN * Math.pow(AUTO_MAX / AUTO_MIN, auto.v / 100);
  function autoBar() {
    if (auto.el || !document.body) return auto.el;
    const st = document.createElement('style');
    st.textContent = '#hdc-auto{position:fixed;right:18px;bottom:18px;z-index:2147482990;display:flex;align-items:center;gap:10px;'
      + 'padding:7px 12px;border-radius:999px;background:rgba(24,24,28,.9);color:#eee;font:12px/1 system-ui,sans-serif;'
      + 'box-shadow:0 4px 18px rgba(0,0,0,.35);transition:opacity .35s;user-select:none}'
      + '#hdc-auto.dim{opacity:0}#hdc-auto.dim.ph{pointer-events:none}#hdc-auto:hover{opacity:1}#hdc-auto b{font-weight:600;letter-spacing:.02em}'
      + '#hdc-auto input{width:140px;accent-color:' + SOFT + ';cursor:pointer;margin:0}'
      + '#hdc-auto .sp{min-width:52px;text-align:right;opacity:.8;font-variant-numeric:tabular-nums}#hdc-auto .k{opacity:.55}';
    document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'hdc-auto'; el.title = 'Auto-scroll speed (K stops it)';
    el.innerHTML = '<b>Auto</b><input type="range" min="0" max="100" step="1"><span class="sp"></span><span class="k">K</span>';
    const r = el.querySelector('input');
    r.value = auto.v;
    r.addEventListener('input', () => autoSpeedSet(+r.value));
    r.addEventListener('keydown', (e) => e.preventDefault());           // keys keep scrolling the page, not the bar
    r.addEventListener('pointerup', () => r.blur());
    el.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); autoSpeedSet(auto.v + (e.deltaY < 0 ? 3 : -3)); }, { passive: false });
    el.addEventListener('pointerenter', () => autoWake());
    document.body.appendChild(el);
    auto.el = el; autoLabel();
    return el;
  }
  function autoLabel() {
    if (!auto.el) return;
    const s = autoSpeed();
    auto.el.querySelector('.sp').textContent = (s < 20 ? 'creep ' : '') + Math.round(s) + '/s';
    auto.el.querySelector('input').value = auto.v;
  }
  function autoWake() {                                       // shown for 3 s, then gone (hover / wheel / K / a phone button brings it back)
    if (!auto.el) return;
    auto.el.classList.remove('dim');
    clearTimeout(auto.fade);
    auto.fade = setTimeout(() => auto.el && auto.el.classList.add('dim'), 3000);
  }
  function autoSpeedSet(v) {
    auto.v = Math.max(0, Math.min(100, Math.round(v)));
    autoLabel(); autoWake();
    clearTimeout(auto.saveT);
    auto.saveT = setTimeout(() => { try { localStorage.setItem(AUTO_KEY, JSON.stringify({ v: auto.v })); } catch (e) { /* full */ } }, 400);
  }
  function autoSet(on) {
    auto.on = on;
    if (on) { const el = autoBar(); if (el) { el.style.display = ''; if (PHONE) { el.classList.add('ph'); el.title = 'Auto-scroll speed'; } } autoWake(); run(); }
    else if (auto.el) auto.el.style.display = 'none';
    tbShow();
  }

  // a page change inside hiperdex, the way its own links do it (the chapter reader has no home / series link), so
  // nothing reloads
  function goTo(path) {
    const a = [...document.querySelectorAll('a[href]')].find(x => x.getAttribute('href') === path || x.getAttribute('href') === location.origin + path);
    if (a) { a.click(); return; }
    try {
      history.pushState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (e) { location.assign(path); }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { hold = null; pending = 0; vel = 0; } });

  // ---------- phone (touch screen, no keys): a small button bar on chapters, bottom right ----------
  // ⌂ = home page, ☰ = this series' page (Home / End on a keyboard), ▶ = auto-scroll on / off (K); while it runs the
  // speed bar sits above the buttons. The bar fades after a few seconds and still works when faded.
  const PHONE = (() => { try { return matchMedia('(hover: none) and (pointer: coarse)').matches; } catch (e) { return false; } })();
  const finger = { down: 0, until: 0 };
  const fingerBusy = () => finger.down > 0 || performance.now() < finger.until;
  if (PHONE) {
    const touch = (e) => { finger.down = e.touches.length; if (!finger.down) finger.until = performance.now() + 350; };
    ['touchstart', 'touchend', 'touchcancel'].forEach(t => window.addEventListener(t, touch, { capture: true, passive: true }));
    // the page still sliding after a flick (not our own scrolling): wait until it stops
    window.addEventListener('scroll', () => {
      const now = performance.now();
      if (auto.on && !finger.down && now < finger.until + 1200 && Math.abs(root().scrollTop - lastSet) > 2) finger.until = now + 250;
    }, { passive: true });
  }
  const tb = { el: null, fade: 0 };
  const ICON = {
    home: '<svg viewBox="0 0 24 24"><path d="M3 11 12 3l9 8v10h-6v-6H9v6H3z"/></svg>',
    series: '<svg viewBox="0 0 24 24"><path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h16v2H4z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>',
  };
  function tbBar() {
    if (tb.el || !document.body) return tb.el;
    const st = document.createElement('style');
    st.textContent = '#hdc-tb{position:fixed;right:12px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147482991;display:flex;gap:8px;'
      + 'padding:6px;border-radius:999px;background:rgba(24,24,28,.88);box-shadow:0 4px 18px rgba(0,0,0,.35);transition:opacity .35s;'
      + '-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none}'
      + '#hdc-tb.dim{opacity:.35}#hdc-tb button{all:unset;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;color:#eee}'
      + '#hdc-tb button:active{background:rgba(255,255,255,.14)}#hdc-tb button.on{background:' + SOFT + ';color:#1a2333}'
      + '#hdc-tb svg{width:20px;height:20px;fill:currentColor}'
      + '#hdc-auto.ph{bottom:calc(72px + env(safe-area-inset-bottom,0px));right:12px;padding:10px 14px}#hdc-auto.ph .k{display:none}'
      + '#hdc-auto.ph input{width:150px}';
    document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'hdc-tb';
    el.innerHTML = `<button data-a="home" aria-label="Home page">${ICON.home}</button><button data-a="series" aria-label="Series page">${ICON.series}</button>`
      + `<button data-a="auto" aria-label="Auto-scroll">${ICON.play}</button>`;
    // the reader opens / closes its own top bar on a tap: taps on our buttons stay ours
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup'].forEach(t => el.addEventListener(t, (e) => { e.stopPropagation(); tbWake(); }, { passive: true }));
    el.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const b = e.target.closest('button'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'auto') autoSet(!auto.on);
      else goTo(a === 'home' ? '/' : '/manga/' + location.pathname.split('/')[2]);
    });
    document.body.appendChild(el);
    tb.el = el;
    return el;
  }
  function tbWake() {
    if (auto.on) autoWake();
    if (!tb.el) return;
    tb.el.classList.remove('dim');
    clearTimeout(tb.fade);
    tb.fade = setTimeout(() => tb.el && tb.el.classList.add('dim'), 3000);
  }
  function tbShow() {                                          // every second and when auto-scroll turns on / off
    if (!PHONE) return;
    if (!chapterPath()) { if (tb.el) tb.el.style.display = 'none'; return; }
    const fresh = !tb.el;
    const el = tbBar(); if (!el) return;
    if (fresh) tbWake();
    if (el.style.display === 'none' || !el.isConnected) { if (!el.isConnected) document.body.appendChild(el); el.style.display = ''; tbWake(); }
    const b = el.querySelector('[data-a="auto"]');
    if (b.classList.contains('on') !== auto.on) { b.classList.toggle('on', auto.on); b.innerHTML = auto.on ? ICON.stop : ICON.play; }
  }

  // ---------- atsu.moe: what you read here goes onto your atsu account too ----------
  // The same calls atsu's own reader and bookmark button make, with your atsu login, through Tampermonkey (the way
  // Comix Continue Reading does it). The series is found on atsu by its exact title (hiperdex has no AniList ids).
  // It only ever moves atsu forward: a chapter atsu already has further along is left alone. A chapter atsu does
  // not have (yet) is skipped. Nothing here runs while you are not on a chapter page.
  const ATSU = 'https://atsu.moe';
  const KEY = 'hdc:v1';
  const DAY = 864e5, MIN = 6e4;
  const DONE = 0.97;          // read this far = finished
  const START_AT = 0.05;      // a chapter counts as being read from 5 % on (opening one by mistake changes nothing)
  const SYNC_EVERY = 30e3;    // while reading, at most one save every 30 s (and when you finish or leave)
  const canAtsu = typeof GM_xmlhttpRequest === 'function';

  let db = {};
  try { db = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { db = {}; }
  db.series = db.series || {}; db.atsu = db.atsu || {}; db.sent = db.sent || {}; db.spot = db.spot || {};
  const save = () => {
    const keys = Object.keys(db.sent);
    if (keys.length > 400) keys.slice(0, keys.length - 300).forEach(k => delete db.sent[k]);
    const spots = Object.keys(db.spot);                        // the 300 chapters read last keep their place
    if (spots.length > 400) spots.sort((a, b) => db.spot[a].ts - db.spot[b].ts).slice(0, spots.length - 300).forEach(k => delete db.spot[k]);
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* storage blocked */ }
  };
  const atsu = { busy: false, want: null, downUntil: db.down || 0, sentAt: {}, flying: {}, chapters: {}, cur: null, marked: {}, told: {} };

  function atsuReq(method, path, body) {
    return new Promise((res) => {
      GM_xmlhttpRequest({
        method, url: ATSU + path, timeout: 20000,
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => { let j = null; try { j = JSON.parse(r.responseText); } catch (e) { /* not JSON */ } res({ status: r.status, json: j }); },
        onerror: () => res({ status: 0, json: null }),
        ontimeout: () => res({ status: 0, json: null }),
      });
    });
  }
  // atsu not answering (down, offline): stop asking for 10 minutes
  const atsuDown = (r) => { if (r.status === 0 || r.status >= 500) { atsu.downUntil = db.down = Date.now() + 10 * MIN; save(); return true; } return false; };
  const signedOut = (r) => r.status === 401 || r.status === 403;
  const norm = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function tell(key, text) { if (atsu.told[key]) return; atsu.told[key] = 1; note(text); }

  // hiperdex's own name(s) for the series
  async function hiperSeries(slug) {
    const k = db.series[slug];
    if (k && Date.now() - k.at < 7 * DAY) return k;
    try {
      const r = await fetch('/api/trpc/series.bySlug?input=' + encodeURIComponent(JSON.stringify({ json: { slug } })), { credentials: 'same-origin' });
      const p = (await r.json()).result.data.json;
      let other = [];
      try { other = typeof p.alternativeTitles === 'string' ? JSON.parse(p.alternativeTitles) : (p.alternativeTitles || []); } catch (e) { /* not a list */ }
      const s = { slug, title: p.title, names: [p.title].concat(Array.isArray(other) ? other : []).map(String).filter(Boolean).slice(0, 14), at: Date.now() };
      if (!s.title) return null;
      db.series[slug] = s; save();
      return s;
    } catch (e) { return null; }
  }

  // the atsu manga with the same name (never a novel of the same story)
  async function atsuManga(s) {
    const known = db.atsu[s.slug];
    if (known && known.id) return known;
    if (known && known.none && Date.now() - known.at < 3 * DAY) return null;      // not on atsu: look again in 3 days
    const tidy = (t) => String(t).replace(/[\u2018\u2019`\u00b4]/g, "'").replace(/\s+/g, ' ').trim();
    const q = new URLSearchParams({ q: tidy(s.title), query_by: 'title,englishTitle,otherNames,authors,acronyms', query_by_weights: '4,3,2,2,1', filter_by: 'hidden:!=true', per_page: '6' });
    const r = await atsuReq('GET', '/collections/manga/documents/search?' + q);
    if (atsuDown(r) || !r.json) return null;
    const want = new Set(s.names.map(norm).filter(Boolean));
    const docs = (r.json.hits || []).map((h) => h.document).filter((d) => d && d.id && d.medium !== 'Novel');
    const named = (d) => [d.title, d.englishTitle, ...(Array.isArray(d.otherNames) ? d.otherNames : [])].some((n) => want.has(norm(n)));
    for (const d of docs.filter(named).slice(0, 3)) {
      const p = await atsuReq('GET', '/api/manga/page?id=' + encodeURIComponent(d.id));
      if (atsuDown(p)) return null;
      const mp = (p.json && p.json.mangaPage) || {};
      if (mp.medium === 'Novel') continue;
      const groups = [mp.sourcePreference && mp.sourcePreference.scanlationMangaId, ...(mp.scanlators || []).map((g) => g && g.id)].filter(Boolean).slice(0, 10);
      const m = { id: d.id, type: mp.type || d.type || 'Manga', title: mp.title || d.title, groups };
      db.atsu[s.slug] = m; save();
      return m;
    }
    db.atsu[s.slug] = { none: 1, at: Date.now() }; save();
    return null;
  }

  // atsu's chapter with the same number (and the one after it, so atsu's "next chapter" works); when several
  // groups translated it: the one you already read on atsu, else the one atsu itself would open
  async function atsuChapter(m, number) {
    let c = atsu.chapters[m.id];
    const find = () => {
      const same = c.list.filter((x) => Math.abs(+x.number - number) < 1e-6);
      if (!same.length) return null;
      const mine = c.list.filter((x) => x.progress && x.scanlationMangaId != null).sort((a, b) => (b.progress.ts || 0) - (a.progress.ts || 0))[0];
      const pick = same.find((x) => x.progress) || (mine && same.find((x) => x.scanlationMangaId === mine.scanlationMangaId))
        || (m.groups || []).map((g) => same.find((x) => x.scanlationMangaId === g)).find(Boolean) || same[0];
      const later = c.list.filter((x) => +x.number > number).sort((a, b) => a.number - b.number);
      const next = later.find((x) => x.scanlationMangaId === pick.scanlationMangaId) || later[0];
      return { ch: pick, next: next ? next.id : undefined };
    };
    if (c && Date.now() - c.at < 30 * MIN) return find();
    const r = await atsuReq('GET', '/api/manga/allChapters?mangaId=' + encodeURIComponent(m.id));
    if (atsuDown(r) || !r.json || !Array.isArray(r.json.chapters)) return null;
    c = atsu.chapters[m.id] = { at: Date.now(), list: r.json.chapters.filter((x) => x && x.id && x.number != null) };
    return find();
  }

  // atsu's own page sizes for a chapter (its pages can be anything from one picture to a 16000 px strip)
  async function atsuDims(m, ch) {
    if (ch.dims !== undefined) return;
    const r = await atsuReq('GET', `/api/read/chapter?mangaId=${encodeURIComponent(m.id)}&chapterId=${encodeURIComponent(ch.id)}`);
    const ps = r.json && r.json.readChapter && r.json.readChapter.pages;
    ch.dims = Array.isArray(ps) && ps.length && ps.every((x) => x && x.width > 0 && x.height > 0) ? ps.map((x) => x.height / x.width) : null;
  }
  // the atsu page at that share, picked like atsu's reader does: by page heights in a strip, else by page number
  function atsuPage(ch, frac, pages, isStrip) {
    const d = ch.dims;
    if (isStrip && d && d.length === pages) {
      const want = frac * d.reduce((a, b) => a + b, 0);
      let sum = 0;
      for (let i = 0; i < d.length; i++) { sum += d[i]; if (sum >= want) return i; }
      return pages - 1;
    }
    return isStrip ? Math.min(pages - 1, Math.floor(frac * pages)) : Math.round(frac * (pages - 1));
  }

  // one save of the open chapter: a single request, so it also gets out when you close the tab
  function atsuSend(job, frac) {
    const { m, c, key } = job;
    const done = frac >= DONE;
    const f = done ? 1 : Math.max(0, Math.min(1, frac));
    const pages = Math.max(1, +c.ch.pageCount || 1);
    const now = Date.now();
    const strip = m.type !== 'Manga';
    const item = {
      mangaScanlationId: c.ch.scanlationMangaId != null ? c.ch.scanlationMangaId : '',
      mangaId: m.id, chapterId: c.ch.id,
      page: done ? pages - 1 : atsuPage(c.ch, f, pages, strip), pages, frac: f,
      ts: now, strip, nextChapterId: c.next, readMs: 0, day: ymd(now),
    };
    atsu.sentAt[key] = now;
    atsu.flying[key] = f;                                                     // on its way: don't send it twice
    return atsuReq('POST', '/api/read/syncProgress', { progress: [item] }).then((r) => {
      delete atsu.flying[key];
      if (signedOut(r)) { tell('signin', 'Sign in on atsu.moe to keep your reading there too'); return false; }
      if (atsuDown(r) || r.status < 200 || r.status >= 300) return false;
      db.sent[key] = f; save();
      c.ch.progress = { page: item.page, pages, frac: f, ts: now };
      return true;
    });
  }

  // started here but not in your atsu list: add it as Reading (Plan to read moves to Reading too). Your list is
  // read fresh each time, so a status you set on atsu (Completed, On hold, Dropped...) is never overwritten.
  async function atsuBookmark(m) {
    if (atsu.marked[m.id]) return;                                             // once per manga per visit
    const r = await atsuReq('GET', '/api/user/bookmarkIds');
    if (signedOut(r)) { tell('signin', 'Sign in on atsu.moe to keep your reading there too'); return; }
    if (atsuDown(r) || !r.json || !Array.isArray(r.json.bookmarks)) return;
    atsu.marked[m.id] = 1;
    const mine = r.json.bookmarks.find((b) => b.mangaId === m.id);
    const st = mine && mine.status;
    if (st && st !== 'PlanToRead') return;
    const w = await atsuReq('POST', '/api/user/syncBookmarks', [{ mangaId: m.id, status: 'Reading', type: m.type, synced: false, ts: Date.now() }]);
    if (w.status >= 200 && w.status < 300) note(st ? 'Moved to Reading on atsu' : 'Added to your Reading list on atsu');
    else delete atsu.marked[m.id];
  }

  async function atsuSync(job) {
    if (Date.now() < atsu.downUntil) return;
    const s = await hiperSeries(job.slug);
    if (!s) return;
    const m = await atsuManga(s);
    if (!m) return;
    const c = await atsuChapter(m, job.num);
    if (!c) { await atsuBookmark(m); return; }                 // atsu does not have this chapter (yet)
    await atsuDims(m, c.ch);
    atsu.cur = { m, c, key: job.key };
    const frac = rd && rd.key === job.key ? rd.peak : job.frac;
    const p = c.ch.progress;
    const theirs = p ? (p.frac || (p.pages ? (p.page + 1) / p.pages : 0)) : 0;
    if (theirs >= Math.min(1, frac) - 0.005) { db.sent[job.key] = Math.max(frac, theirs); save(); }   // atsu is already this far
    else if (!await atsuSend(atsu.cur, frac)) return;
    await atsuBookmark(m);
  }

  async function pump() {
    if (atsu.busy || !atsu.want) return;
    const job = atsu.want;
    atsu.want = null; atsu.busy = true;
    try { await atsuSync(job); } catch (e) { /* try again on the next save */ }
    atsu.busy = false;
    if (atsu.want) pump();
  }

  // ---------- how far into the chapter you are (0 top .. 1 the end of the last page at the bottom of the screen) ----------
  let rd = null;        // the open chapter: {key, slug, num, at, peak}
  function chapterHere() {
    const m = /^\/manga\/([^/]+)\/(\d+(?:\.\d+)?)\/?$/.exec(location.pathname);
    return m ? { key: m[1] + '/' + m[2], slug: decodeURIComponent(m[1]), num: +m[2] } : null;
  }
  // hiperdex draws a box for every page at once and puts the pictures in during the first seconds (4 at first,
  // the rest about 5 s later). The boxes are the pages: the box of "Page 1" and every box built like it.
  function boxes() {
    const first = document.querySelector('img[alt^="Page "]');
    const wrap = first && first.parentElement, list = wrap && wrap.parentElement && wrap.parentElement.parentElement;
    if (!list) return null;
    const out = [];
    for (const k of list.children) { const d = k.firstElementChild; if (d && d.className === wrap.className) out.push(d); }
    return out.length ? out : null;
  }
  const hasPic = (b) => !!b.querySelector('img[alt^="Page "]');
  // 0 at the top .. 1 when the end of the last page is at the bottom of the screen; null until every page is in
  function pctNow(bs) {
    bs = bs || boxes();
    if (!bs || !bs.every(hasPic)) return null;
    const a = bs[0].getBoundingClientRect(), b = bs[bs.length - 1].getBoundingClientRect();
    const h = b.bottom - a.top;
    if (!(h > innerHeight * 1.3)) return null;
    return Math.max(0, Math.min(1, -a.top / (h - innerHeight)));
  }
  // the page at the reading line (a third down the screen) and how far into it: [page number from 1, 0..1]
  function pageNow(bs) {
    const line = innerHeight / 3;
    for (let n = 0; n < bs.length; n++) {
      const r = bs[n].getBoundingClientRect();
      if (r.bottom > line) return [n + 1, r.height ? Math.max(0, Math.min(1, (line - r.top) / r.height)) : 0];
    }
    return [bs.length, 1];
  }
  function later(leaving) {
    if (!canAtsu || !rd || Date.now() < atsu.downUntil) return;
    const frac = rd.peak >= DONE ? 1 : rd.peak;
    if (frac < START_AT) return;
    const key = rd.key;
    const sent = Math.max(db.sent[key] != null ? db.sent[key] : -1, atsu.flying[key] != null ? atsu.flying[key] : -1);
    if (sent >= frac - 0.005) return;                          // nothing new for atsu
    if (!leaving && frac < 1 && atsu.sentAt[key] && Date.now() - atsu.sentAt[key] < SYNC_EVERY) return;
    const cur = atsu.cur;
    if (leaving && cur && cur.key === key && !atsu.busy) { atsuSend(cur, frac); return; }   // known chapter: one request
    atsu.want = { key, slug: rd.slug, num: rd.num, frac };
    pump();
  }
  // where you are in the chapter is remembered (on this computer), so it opens there again
  function remember(p, bs) {
    if (!rd || rd.resume) return;                              // not while the page is still being put back
    const old = db.spot[rd.key];
    if (old && Math.abs(old.f - p) < 0.003) return;
    const at = pageNow(bs);
    db.spot[rd.key] = { f: +p.toFixed(4), p: at[0], o: +at[1].toFixed(4), ts: Date.now() };
    save();
  }
  function measure() {
    if (!rd || Date.now() - rd.at < 2500) return;             // the chapter before may still be in the page
    const bs = boxes(), p = pctNow(bs);
    if (p != null) { if (p > rd.peak) rd.peak = p; remember(p, bs); }
    later(false);
  }

  // ---------- opening a chapter again: back to where you stopped ----------
  // The place is kept as "page 14, 69 % down it". The pictures arrive during the first seconds and change the
  // page's length, so the place is put back again and again until every page is in and nothing has moved for 2 s
  // (20 s at most). Any key, wheel, click or touch of yours ends that at once: the page is yours.
  const RESUME_FOR = 20000;
  function resumeStop() { if (rd && rd.resume) { clearInterval(rd.resume.timer); rd.resume = null; } }
  function resumeStart() {
    const sp = db.spot[rd.key];
    if (!sp || !(sp.f > 0.02) || sp.f >= DONE) return;            // nothing to go back to (or the chapter was finished)
    const me = rd, t0 = Date.now();
    let still = 0, told = false;
    const tick = () => {
      if (rd !== me || !me.resume) return;
      if (Date.now() - t0 > RESUME_FOR) return resumeStop();
      const bs = boxes();
      if (!bs || bs.length < (sp.p || 1)) return;              // the reader is not drawn yet
      let want;
      if (sp.p) {
        const r = bs[sp.p - 1].getBoundingClientRect();
        want = Math.max(0, Math.round(r.top + scrollY + sp.o * r.height - innerHeight / 3));
      } else {                                                 // only the share is known (read on atsu): by height
        const a = bs[0].getBoundingClientRect(), z = bs[bs.length - 1].getBoundingClientRect();
        want = Math.max(0, Math.round(a.top + scrollY + sp.f * Math.max(0, z.bottom - a.top - innerHeight)));
      }
      if (Math.abs(scrollY - want) > 2) { window.scrollTo({ top: want, behavior: 'instant' }); still = 0; } else still++;
      if (!told) { told = true; note('Back where you stopped: ' + Math.round(sp.f * 100) + '%'); }
      if (still >= 8 && bs.every(hasPic) && [...document.querySelectorAll('img[alt^="Page "]')].every(x => x.complete)) resumeStop();
    };
    me.resume = { timer: setInterval(tick, 250) };
    if (me.peak < sp.f) me.peak = Math.min(sp.f, DONE - 0.001);
    tick();
  }
  ['wheel', 'keydown', 'pointerdown', 'touchstart'].forEach(t => window.addEventListener(t, (e) => { if (e.isTrusted !== false) resumeStop(); }, { capture: true, passive: true }));

  function onPath() {
    const h = chapterHere();
    if ((h && h.key) === (rd && rd.key)) return;
    if (rd) { resumeStop(); later(true); }
    rd = h ? Object.assign(h, { at: Date.now(), peak: 0, resume: null }) : null;
    atsu.cur = null;
    if (rd) resumeStart();
  }

  {
    let wait = 0;
    window.addEventListener('scroll', () => { if (rd && !wait) wait = setTimeout(() => { wait = 0; measure(); }, 800); }, { passive: true });
    setInterval(() => { if (!document.hidden) { onPath(); if (rd) measure(); onPage(); } }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden || !rd) return;
      const p = pctNow();
      if (p != null && Date.now() - rd.at >= 2500) { if (p > rd.peak) rd.peak = p; remember(p, boxes()); }
      later(true);
    });
    window.addEventListener('pagehide', () => { if (rd) { const p = pctNow(); if (p != null && Date.now() - rd.at >= 2500) remember(p, boxes()); later(true); } });
    const first = () => { onPath(); onPage(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', first); else setTimeout(first, 0);   // after the rest of this script is set up
  }

  // ---------- home page: "Continue Reading" + "Updates For You" (like atsu's), series page: "Resume" ----------
  // What you read comes from three places: this script's own place per chapter (this computer), hiperdex's own
  // reading list (signed in: every chapter you open is noted there) and, for series also linked to atsu, atsu's
  // Continue Reading (when you read further on atsu). The newest one wins.
  // Cost: nothing runs on chapter pages; the home / series page asks hiperdex a few small questions, remembered:
  // your list (2 min), the newest updates (5 min), a series' chapter list (6 h), atsu's Continue Reading (2 min).
  db.meta = db.meta || {}; db.chap = db.chap || {};
  const SHOW_CR = 8, SHOW_UP = 12, UPDATE_AGE = 60 * DAY;
  const api = async (name, input) => {
    try {
      const r = await fetch('/api/trpc/' + name + '?input=' + encodeURIComponent(JSON.stringify({ json: input })), { credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      return { status: r.status, data: j && j.result && j.result.data ? j.result.data.json : null };
    } catch (e) { return { status: 0, data: null }; }
  };
  const ms = (t) => { const v = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t || ''); return isFinite(v) ? v : 0; };
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const numTxt = (n) => String(+(+n).toFixed(2));
  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    const [v, u] = s < 3600 ? [Math.max(1, Math.round(s / 60)), 'minute'] : s < 86400 ? [Math.round(s / 3600), 'hour'] : s < 30 * 86400 ? [Math.round(s / 86400), 'day']
      : s < 365 * 86400 ? [Math.round(s / (30 * 86400)), 'month'] : [Math.round(s / (365 * 86400)), 'year'];
    return v + ' ' + u + (v === 1 ? '' : 's') + ' ago';
  }
  const shortAgo = (t) => ago(t).replace(/ minutes?/, 'm').replace(/ hours?/, 'h').replace(/ days?/, 'd').replace(/ months?/, 'mo').replace(/ years?/, 'y');

  const home = { lib: 0, latest: 0, cr: 0, queue: [], running: 0, html: '', place: null };
  const libStatus = (st) => ({ want_to_read: 'Planned', plan_to_read: 'Planned', reading: 'Reading', on_hold: 'On hold', completed: 'Completed', dropped: 'Dropped', rereading: 'Re-reading' }[st]
    || String(st || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));

  // your hiperdex reading list (needs you signed in on hiperdex; signed out = only this computer's reading)
  async function loadLib() {
    if (Date.now() - Math.max(home.lib, (db.lib && db.lib.at) || 0) < 2 * MIN) return false;   // (also across reloads)
    home.lib = Date.now();
    const items = [];
    for (let page = 1; page <= 20; page++) {
      const r = await api('library.list', { page, limit: 50 });
      if (!r.data || !Array.isArray(r.data.items)) { if (page === 1) { db.lib = { at: Date.now(), items: [], out: r.status === 401 || r.status === 403 ? 1 : 0 }; save(); return true; } break; }
      for (const x of r.data.items) {
        if (!x || !x.seriesSlug) continue;
        items.push({ id: x.seriesId, slug: x.seriesSlug, status: x.status, last: x.lastChapterNumber != null ? +x.lastChapterNumber : null, at: ms(x.lastReadAt), added: ms(x.createdAt) });
        db.meta[x.seriesSlug] = Object.assign(db.meta[x.seriesSlug] || {}, { id: x.seriesId, title: x.seriesTitle, cover: x.seriesCoverUrl, st: x.seriesStatus });
      }
      if (page >= (r.data.totalPages || 1)) break;
    }
    db.lib = { at: Date.now(), items }; save();
    return true;
  }
  // the newest chapters on hiperdex (one small question, the one the home page asks itself): fresh "latest" numbers
  async function loadLatest() {
    if (Date.now() - Math.max(home.latest, db.latestAt || 0) < 5 * MIN) return false;
    home.latest = db.latestAt = Date.now();
    const r = await api('recommendations.latestChapters', { limit: 39, page: 1, maxRating: 'pornographic', seriesType: 'all' });
    if (!Array.isArray(r.data)) return false;
    const mine = mySlugs();
    let changed = false;
    for (const x of r.data) {
      if (!x || !mine.has(x.seriesSlug)) continue;
      db.meta[x.seriesSlug] = Object.assign(db.meta[x.seriesSlug] || {}, { id: x.seriesId, title: x.seriesTitle, cover: x.seriesCoverUrl, st: x.seriesStatus });
      const c = db.chap[x.seriesSlug] || (db.chap[x.seriesSlug] = { at: 0, nums: [], latest: 0, latestAt: 0 });
      for (const ch of x.chapters || []) {
        const n = +ch.number, t = ms(ch.createdAt);
        if (!c.nums.includes(n)) { c.nums.push(n); c.nums.sort((a, b) => a - b); }
        if (n >= c.latest) { c.latest = n; c.latestAt = Math.max(c.latestAt || 0, t); changed = true; }
      }
    }
    if (changed) save();
    return changed;
  }
  // atsu's Continue Reading, for series that are linked to atsu (read here before)
  function loadAtsuCr() {
    if (!canAtsu || Date.now() < atsu.downUntil || Date.now() - Math.max(home.cr, (db.cr && db.cr.at) || 0) < 2 * MIN) return Promise.resolve(false);
    if (!Object.values(db.atsu).some((x) => x && x.id)) return Promise.resolve(false);
    home.cr = Date.now();
    return atsuReq('GET', '/api/infinite/continueReading?page=0&perPage=24').then((r) => {
      if (atsuDown(r) || !r.json || !Array.isArray(r.json.items)) return false;
      db.cr = { at: Date.now(), items: r.json.items.filter((x) => x && x.id && x.continueReading).map((x) => ({
        id: x.id, num: +x.continueReading.number, f: +x.continueReading.frac || 0, ts: ms(x.continueReading.ts) })) };
      save();
      return true;
    });
  }
  // a series' chapters (numbers and when the newest came out); its id, name and cover
  function chapDue(slug) { const c = db.chap[slug]; return !c || Date.now() - c.at > 6 * 3600e3 || !db.meta[slug] || !db.meta[slug].cover; }
  function queueSeries(slugs) {
    home.busy = home.busy || new Set();                  // being fetched right now: not asked for twice
    for (const sl of slugs) if (chapDue(sl) && !home.queue.includes(sl) && !home.busy.has(sl) && home.queue.length < 30) home.queue.push(sl);
    // start up to 2; stop as soon as one does not start (tab in the background / left the page): before 1.5.0 this
    // went round for ever then and froze the tab, so hiperdex "kept loading" until a new tab was opened
    for (let i = 0; i < 2 && home.running < 2 && home.queue.length; i++) {
      const was = home.running;
      seriesNext();
      if (home.running === was) break;
    }
  }
  async function seriesNext() {
    if (!home.queue.length || document.hidden || !pageKind()) return;
    home.running++;
    const sl = home.queue.shift();
    home.busy.add(sl);
    try {
      let m = db.meta[sl];
      if (!m || !m.id || !m.cover) {
        const r = await api('series.bySlug', { slug: sl });
        if (r.data && r.data.id) m = db.meta[sl] = Object.assign(m || {}, { id: r.data.id, title: r.data.title, cover: r.data.coverUrl, st: r.data.status });
      }
      if (m && m.id) {
        const r = await api('series.chapters', { seriesId: m.id });
        if (Array.isArray(r.data)) {
          const pub = r.data.filter((c) => c && c.number != null && (!c.status || c.status === 'published') && !c.isDeleted);
          const nums = [...new Set(pub.map((c) => +c.number))].sort((a, b) => a - b);
          const top = pub.reduce((a, c) => (+c.number > +a.number || (+c.number === +a.number && ms(c.createdAt) > ms(a.createdAt)) ? c : a), pub[0] || { number: 0 });
          db.chap[sl] = { at: Date.now(), nums: nums.slice(-600), latest: +top.number || 0, latestAt: pub.length ? Math.max(...pub.map((c) => ms(c.createdAt))) : 0 };
        }
      }
    } catch (e) { /* next time */ }
    home.busy.delete(sl);
    home.running--;
    if (!home.queue.length || home.running === 0) { save(); renderSoon(); }
    if (home.queue.length) setTimeout(seriesNext, 150);
  }

  // everything you read, one entry per series: {slug, num, f (null = not known), ts, src, done:Set, part:{num: f}, status}
  function reads() {
    const by = {};
    const get = (slug) => by[slug] || (by[slug] = { slug, best: null, done: new Set(), part: {}, status: null, at: 0 });
    for (const [k, v] of Object.entries(db.spot)) {
      const i = k.lastIndexOf('/'), e = get(k.slice(0, i)), num = +k.slice(i + 1);
      if (!v || !isFinite(num)) continue;
      if (v.f >= DONE) e.done.add(num); else e.part[num] = Math.max(e.part[num] || 0, v.f);
      if (!v.atsu && (!e.best || v.ts > e.best.ts)) e.best = { num, f: v.f, ts: v.ts, src: v.imp || 'here' };
    }
    // read elsewhere (imported from atsu / comix): up to that chapter
    for (const [sl, u] of Object.entries(db.upto || {})) {
      if (!u || !isFinite(u.n)) continue;
      const e = get(sl);
      e.upto = u;
      if (!e.best || (u.ts || 1) > e.best.ts + MIN) e.best = { num: u.n, f: u.inc ? 1 : e.part[u.n] != null ? e.part[u.n] : 0, ts: u.ts || 1, src: u.src };
    }
    const tracked = (db.imp && db.imp.tracked) || {};
    for (const x of (db.lib && db.lib.items) || []) {
      const e = get(x.slug);
      e.status = x.status; e.added = x.added;
      const tr = tracked[x.slug];
      const ours = tr && x.last != null && Math.abs(x.last - tr.n) < 1e-6 && Math.abs(x.at - tr.at) < 30 * MIN;   // the import's own write
      if (!ours && x.last != null && x.at && (!e.best || x.at > e.best.ts + MIN)) {
        const f = e.done.has(x.last) || upDone(e.upto, x.last) ? 1 : e.part[x.last] != null ? e.part[x.last] : null;
        e.best = { num: x.last, f, ts: x.at, src: 'list' };
      }
    }
    const bySlug = {};
    for (const [sl, a] of Object.entries(db.atsu)) if (a && a.id) bySlug[a.id] = sl;
    for (const x of (db.cr && db.cr.items) || []) {
      const sl = bySlug[x.id];
      if (!sl || !isFinite(x.num)) continue;
      const e = get(sl);
      if (!e.best || x.ts > e.best.ts + MIN) e.best = { num: x.num, f: x.f, ts: x.ts, src: 'atsu' };
      if (x.f >= DONE) e.done.add(x.num);
    }
    return by;
  }
  function mySlugs() {
    const out = new Set();
    for (const [sl, e] of Object.entries(reads())) if (e.best || (e.status && !/^(dropped|completed)$/.test(e.status))) out.add(sl);
    return out;
  }
  // where a series continues: the chapter itself, or the next one when it was finished
  function nextUp(e, nums) {
    const b = e.best;
    if (!b) return null;
    if (b.f != null && b.f >= DONE) {
      const nx = (nums || []).find((n) => n > b.num + 1e-6);
      return nx != null ? { num: nx, f: 0, next: true, ts: b.ts, src: b.src } : { num: b.num, f: 1, end: true, ts: b.ts, src: b.src };
    }
    return { num: b.num, f: b.f, ts: b.ts, src: b.src };
  }

  // ---------- drawing ----------
  const CSS = `
    #hdc-home { display: flex; flex-direction: column; gap: 28px; }
    #hdc-home .hdc-h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    #hdc-home h2 { font-size: 1.25rem; font-weight: 600; color: var(--foreground, #eee); display: flex; align-items: center; gap: 6px; }
    #hdc-home h2 small { font-size: .8rem; color: var(--muted-foreground, #999); font-weight: 400; }
    #hdc-home .hdc-btn { font-size: .8rem; color: var(--muted-foreground, #aaa); background: var(--card, #1b1b1f); border: 1px solid var(--border, #2a2a30);
      border-radius: 8px; padding: 5px 12px; cursor: pointer; }
    #hdc-home .hdc-btn:hover { color: var(--foreground, #fff); }
    #hdc-home .hdc-cr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    @media (max-width: 760px) { #hdc-home .hdc-cr { grid-template-columns: 1fr; } }
    #hdc-home .hdc-row { display: flex; gap: 12px; align-items: center; padding: 8px; border-radius: 10px; background: var(--card, #1b1b1f);
      border: 1px solid var(--border, #26262c); color: inherit; text-decoration: none; min-width: 0; transition: background .15s; }
    #hdc-home .hdc-row:hover { background: var(--muted, #26262c); }
    #hdc-home .hdc-row img { width: 46px; height: 62px; object-fit: cover; border-radius: 6px; flex: none; background: #222; }
    #hdc-home .hdc-txt { min-width: 0; flex: 1; }
    #hdc-home .hdc-t { font-size: .92rem; font-weight: 500; color: var(--foreground, #eee); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #hdc-home .hdc-s { font-size: .78rem; color: var(--muted-foreground, #999); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #hdc-home .hdc-bar { height: 3px; border-radius: 3px; background: rgba(255,255,255,.08); margin-top: 7px; overflow: hidden; }
    #hdc-home .hdc-bar i { display: block; height: 100%; background: var(--primary, #3b82f6); }
    #hdc-home .hdc-up { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 14px; }
    @media (max-width: 1100px) { #hdc-home .hdc-up { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    @media (max-width: 640px) { #hdc-home .hdc-up { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    #hdc-home .hdc-card { color: inherit; text-decoration: none; min-width: 0; }
    #hdc-home .hdc-cv { position: relative; aspect-ratio: 3 / 4.2; border-radius: 10px; overflow: hidden; background: #222; }
    #hdc-home .hdc-cv img { width: 100%; height: 100%; object-fit: cover; transition: transform .2s; }
    #hdc-home .hdc-card:hover .hdc-cv img { transform: scale(1.04); }
    #hdc-home .hdc-tag { position: absolute; top: 6px; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 6px; background: rgba(0,0,0,.72); color: #fff; }
    #hdc-home .hdc-tag.l { left: 6px; } #hdc-home .hdc-tag.r { right: 6px; }
    #hdc-home .hdc-tag.st { background: var(--primary, #3b82f6); }
    #hdc-home .hdc-tag.new { background: #e11d48; }
    #hdc-home .hdc-card .hdc-t { margin-top: 7px; font-size: .86rem; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    #hdc-home .hdc-card .hdc-s { margin-top: 2px; }
    section[data-hdc-off] { display: none !important; }
    #hdc-sim h2 { font-size: 1.25rem; font-weight: 600; color: var(--foreground, #eee); margin: 32px 0 14px; }
    #hdc-sim .hdc-simg { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 14px; }
    @media (max-width: 900px) { #hdc-sim .hdc-simg { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    @media (max-width: 560px) { #hdc-sim .hdc-simg { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    #hdc-sim .hdc-card { color: inherit; text-decoration: none; min-width: 0; }
    #hdc-sim .hdc-cv { aspect-ratio: 3 / 4.2; border-radius: 10px; overflow: hidden; background: #222; }
    #hdc-sim .hdc-cv img { width: 100%; height: 100%; object-fit: cover; transition: transform .2s; }
    #hdc-sim .hdc-card:hover .hdc-cv img { transform: scale(1.04); }
    #hdc-sim .hdc-t { margin-top: 7px; font-size: .84rem; font-weight: 500; color: var(--foreground, #eee); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    #hdc-sim .hdc-s { font-size: .74rem; color: var(--muted-foreground, #999); margin-top: 2px; }
    #hdc-imp { margin-bottom: 18px; }
    #hdc-imp .hdc-imp { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 10px 14px;
      border-radius: 10px; background: var(--card, #1b1b1f); border: 1px solid var(--border, #26262c); font-size: .85rem; color: var(--muted-foreground, #aaa); }
    #hdc-imp .hdc-imp a { color: var(--primary, #3b82f6); }
    #hdc-imp .hdc-bar { width: 100%; height: 3px; border-radius: 3px; background: rgba(255,255,255,.08); overflow: hidden; }
    #hdc-imp .hdc-bar i { display: block; height: 100%; background: var(--primary, #3b82f6); transition: width .3s; }
    #hdc-imp .hdc-btn { font-size: .8rem; color: var(--muted-foreground, #aaa); background: var(--card, #1b1b1f); border: 1px solid var(--border, #2a2a30);
      border-radius: 8px; padding: 5px 12px; cursor: pointer; }
    #hdc-imp .hdc-miss { width: 100%; max-height: 160px; overflow: auto; font-size: .75rem; line-height: 1.5; }
    #hdc-resume { text-decoration: none; }
    button[data-hdc-dim] { background: transparent !important; color: var(--foreground, #eee) !important; border: 1px solid var(--border, #2a2a30) !important; }
    button[data-hdc-dim]:hover { background: var(--accent, #26262c) !important; }
    .hdc-mark { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 6px; background: rgba(59,130,246,.18); color: #93c5fd; white-space: nowrap; }
    .hdc-mark.done { background: rgba(255,255,255,.07); color: var(--muted-foreground, #999); }
    [data-hdc-read] > a { opacity: .55; }
    [data-hdc-last] { box-shadow: inset 3px 0 0 var(--primary, #3b82f6); }
  `;
  function addCss() {
    if (document.getElementById('hdc-home-css') || !document.head) return;
    const st = document.createElement('style'); st.id = 'hdc-home-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  function pageKind() {
    if (location.pathname === '/' || location.pathname === '') return 'home';
    const m = /^\/manga\/([^/]+)\/?$/.exec(location.pathname);
    return m ? 'series' : null;
  }
  const seriesSlug = () => { const m = /^\/manga\/([^/]+)\/?$/.exec(location.pathname); return m ? decodeURIComponent(m[1]) : null; };

  function homeHtml() {
    const by = reads();
    // Continue Reading: series with a chapter opened, newest first
    const cr = [];
    for (const e of Object.values(by)) {
      if (!e.best) continue;
      const c = db.chap[e.slug], m = db.meta[e.slug] || {};
      const up = nextUp(e, c && c.nums);
      if (!up || !m.title) continue;
      cr.push({ e, m, c, up });
    }
    cr.sort((a, b) => b.up.ts - a.up.ts);
    // Updates For You: your series with a new chapter lately, newest update first. Signed in: only series that are
    // on your hiperdex list (one you removed from it is not shown)
    const ups = [];
    const listed = db.lib && !db.lib.out && Array.isArray(db.lib.items) && db.lib.items.length > 0;
    for (const e of Object.values(by)) {
      if (e.status && /^(dropped)$/.test(e.status)) continue;
      if (!e.best && !e.status) continue;
      if (listed && !e.status) continue;
      const c = db.chap[e.slug], m = db.meta[e.slug] || {};
      if (!c || !c.latestAt || !m.title || Date.now() - c.latestAt > UPDATE_AGE) continue;
      ups.push({ e, m, c });
    }
    ups.sort((a, b) => b.c.latestAt - a.c.latestAt);
    if (!cr.length && !ups.length) return '';
    const when = (up) => (up.ts > 1e12 ? ' · ' + ago(up.ts) : '');
    const fromTxt = { atsu: ' · on atsu', comix: ' · from comix' };
    let h = '';
    if (cr.length) {
      const all = home.allCr;
      h += `<div><div class="hdc-h"><h2>Continue Reading <small>${cr.length}</small></h2>${cr.length > SHOW_CR ? `<button class="hdc-btn" data-hdc="more">${all ? 'Show less' : 'See all'}</button>` : ''}</div><div class="hdc-cr">`;
      for (const { e, m, c, up } of cr.slice(0, all ? 60 : SHOW_CR)) {
        const pct = up.f == null ? null : Math.round(Math.min(1, up.f) * 100);
        const total = c && c.latest ? ' / ' + numTxt(c.latest) : '';
        const what = up.end ? 'Up to date' : up.next ? 'Next' : pct == null ? '' : pct + '%';
        const from = fromTxt[up.src] || '';
        h += `<a class="hdc-row" href="/manga/${encodeURIComponent(e.slug)}/${numTxt(up.num)}" data-hdc-slug="${esc(e.slug)}" data-hdc-num="${numTxt(up.num)}" data-hdc-f="${up.f == null ? '' : up.f}" data-hdc-src="${up.src}" data-hdc-ts="${up.ts}">
          <img src="${esc(m.cover || '')}" alt="" loading="lazy">
          <div class="hdc-txt"><div class="hdc-t" title="${esc(m.title)}">${esc(m.title)}</div>
          <div class="hdc-s">Chapter ${numTxt(up.num)}${total}${what ? ' – ' + what : ''}${when(up)}${from}</div>
          <div class="hdc-bar"><i style="width:${pct == null ? 0 : up.next ? 0 : pct}%"></i></div></div></a>`;
      }
      h += '</div></div>';
    }
    if (ups.length) {
      h += `<div><div class="hdc-h"><h2>Updates For You</h2></div><div class="hdc-up">`;
      for (const { e, m, c } of ups.slice(0, SHOW_UP)) {
        const readTop = Math.max(-1, ...[...e.done], e.best && e.best.f != null && e.best.f >= DONE ? e.best.num : -1,
          ...(e.upto ? (c.nums || []).filter((n) => upDone(e.upto, n)) : []), e.best && !e.upto ? e.best.num : -1);
        // hiperdex puts a series on your list as "want to read" when you open a chapter: started = Reading
        const st = !e.status || (e.best && /^(want_to_read|plan_to_read)$/.test(e.status)) ? 'Reading' : libStatus(e.status);
        const isNew = readTop >= 0 && c.latest > readTop + 1e-6;
        const go = readTop >= 0 ? nextUp(e, c.nums) : null;
        const href = go && !go.end ? `/manga/${encodeURIComponent(e.slug)}/${numTxt(go.num)}` : `/manga/${encodeURIComponent(e.slug)}`;
        h += `<a class="hdc-card" href="${href}"><div class="hdc-cv"><img src="${esc(m.cover || '')}" alt="" loading="lazy">
          <span class="hdc-tag l st">${esc(st)}</span>${readTop >= 0 ? `<span class="hdc-tag r${isNew ? ' new' : ''}">${numTxt(readTop)} / ${numTxt(c.latest)}</span>` : ''}</div>
          <div class="hdc-t" title="${esc(m.title)}">${esc(m.title)}</div><div class="hdc-s">Ch. ${numTxt(c.latest)} · ${shortAgo(c.latestAt)}</div></a>`;
      }
      h += '</div></div>';
    }
    return h;
  }

  // the home page's column (hiperdex's <main> with its sections); our block goes first, hiperdex's own small
  // "Continue Reading" box (your list, without chapters) is hidden while ours is there
  function homeMain() {
    const sec = document.querySelector('main section[data-loc*="pages/Home"]') || document.querySelector('main section');
    return sec && sec.parentElement && sec.parentElement.tagName === 'MAIN' ? sec.parentElement : null;
  }
  function placeHome() {
    const main = homeMain();
    if (!main) return;
    let box = document.getElementById('hdc-home');
    if (!home.html) { if (box) box.remove(); unhideTheirs(); return; }
    if (!box) {
      box = document.createElement('section'); box.id = 'hdc-home';
      box.addEventListener('click', onHomeClick);
    }
    if (box.dataset.html !== home.html) { box.innerHTML = home.html; box.dataset.html = home.html; }
    if (homeRef(main) !== box) main.insertBefore(box, homeRef(main));
    for (const h2 of main.querySelectorAll('section h2')) {
      if (h2.closest('#hdc-home') || h2.textContent.trim() !== 'Continue Reading') continue;
      const s = h2.closest('section');
      if (s && !s.hasAttribute('data-hdc-off')) s.setAttribute('data-hdc-off', '');
    }
  }
  // where our rows go: first in the column, or right after the import box while it shows
  const homeRef = (main) => { const imp = document.getElementById('hdc-imp'); return imp && imp.parentElement === main ? imp.nextElementSibling : main.firstElementChild; };
  const unhideTheirs = () => document.querySelectorAll('section[data-hdc-off]').forEach((s) => s.removeAttribute('data-hdc-off'));
  function onHomeClick(e) {
    const b = e.target.closest('[data-hdc="more"]');
    if (b) { e.preventDefault(); home.allCr = !home.allCr; render(); return; }
    const ib = e.target.closest('[data-hdc="imp"],[data-hdc="imphide"],[data-hdc="miss"]');
    if (ib) {
      e.preventDefault();
      const what = ib.dataset.hdc;
      if (what === 'imp') { localStorage.removeItem(IMP.JOB); db.imp.hide = 0; runImport(); }
      else if (what === 'imphide') { db.imp.hide = 1; save(); impPaint(); }
      else { home.showMiss = !home.showMiss; impPaint(); }
      return;
    }
    // a place read on atsu: this chapter opens at that share here too
    const a = e.target.closest('a.hdc-row');
    if (a && a.dataset.hdcSrc === 'atsu' && a.dataset.hdcF) {
      const key = a.dataset.hdcSlug + '/' + a.dataset.hdcNum, f = +a.dataset.hdcF;
      const old = db.spot[key];
      if (f > 0.02 && f < DONE && (!old || old.ts < +a.dataset.hdcTs)) { db.spot[key] = { f, p: 0, o: 0, ts: +a.dataset.hdcTs, atsu: 1 }; save(); }
    }
  }

  // ---------- series page: "Resume" first in the button row, your chapters marked in the list ----------
  function chapterRows(slug) {
    const out = new Map();
    for (const a of document.querySelectorAll('a[href^="/manga/"]')) {
      const m = /^\/manga\/([^/]+)\/(\d+(?:\.\d+)?)\/?$/.exec(a.getAttribute('href') || '');
      if (m && decodeURIComponent(m[1]) === slug && a.parentElement) out.set(+m[2], a.parentElement);
    }
    return out;
  }
  function placeSeries() {
    const slug = seriesSlug();
    if (!slug) return;
    const e = reads()[slug];
    const rows = chapterRows(slug);
    const nums = rows.size ? [...rows.keys()].sort((a, b) => a - b) : (db.chap[slug] && db.chap[slug].nums);
    const up = e ? nextUp(e, nums) : null;
    // the button
    const first = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Read first');
    home.ready = !!first && rows.size > 0;
    home.btn = 0; home.marks = 0;
    let btn = document.getElementById('hdc-resume');
    if (!first || !up || up.end) { if (btn) btn.remove(); if (first) first.removeAttribute('data-hdc-dim'); }
    else {
      const pct = up.f == null || up.next ? null : Math.round(Math.min(1, up.f) * 100);
      const text = (up.next ? 'Continue Ch. ' : 'Resume Ch. ') + numTxt(up.num) + (pct ? ' · ' + pct + '%' : '');
      const href = `/manga/${encodeURIComponent(slug)}/${numTxt(up.num)}`;
      if (!btn) {
        btn = document.createElement('a'); btn.id = 'hdc-resume';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span></span>';
      }
      btn.className = first.className.split(/\s+/).filter((c) => !/^(hover:|focus|aria-)/.test(c)).join(' ');
      btn.title = up.src === 'atsu' ? 'Where you are on atsu' : up.next ? 'You finished the chapter before' : 'Where you stopped';
      if (btn.getAttribute('href') !== href) btn.setAttribute('href', href);
      btn.dataset.key = slug + '/' + numTxt(up.num);
      if (btn.lastChild.textContent !== text) btn.lastChild.textContent = text;
      if (btn.nextElementSibling !== first || btn.parentElement !== first.parentElement) first.parentElement.insertBefore(btn, first);
      home.btn = 1;
      if (!first.hasAttribute('data-hdc-dim')) first.setAttribute('data-hdc-dim', '');   // one blue button: ours
      // a place known from atsu only: opening it there needs the share
      if (up.src === 'atsu' && up.f > 0.02 && up.f < DONE) {
        const old = db.spot[btn.dataset.key];
        if (!old || old.ts < up.ts) { db.spot[btn.dataset.key] = { f: up.f, p: 0, o: 0, ts: up.ts, atsu: 1 }; save(); }
      }
    }
    home.sim = rows.size ? simPlace(slug, rows) : false;
    // the chapter list: read ones dimmed with a tick, started ones with their %
    if (!rows.size || !e) return;
    const want = [];
    for (const [n, row] of rows) {
      const done = e.done.has(n) || upDone(e.upto, n) || (e.best && e.best.num === n && e.best.f != null && e.best.f >= DONE);
      const part = !done && (e.part[n] != null ? e.part[n] : e.best && e.best.num === n ? e.best.f : null);
      const text = done ? '✓ Read' : part != null && part > 0.02 ? Math.round(part * 100) + '%' : (e.best && e.best.num === n ? 'Last opened' : '');
      const last = e.best && e.best.num === n;
      want.push([row, text, done, last]);
    }
    for (const [row, text, done, last] of want) {
      let mk = row.querySelector('.hdc-mark');
      if (!text) { if (mk) mk.remove(); row.removeAttribute('data-hdc-read'); row.removeAttribute('data-hdc-last'); continue; }
      const side = row.lastElementChild && row.lastElementChild.tagName !== 'A' ? row.lastElementChild : row;
      home.marks++;
      if (!mk) { mk = document.createElement('span'); mk.className = 'hdc-mark'; side.insertBefore(mk, side.firstChild); }
      if (mk.textContent !== text) mk.textContent = text;
      mk.classList.toggle('done', done);
      if (done) row.setAttribute('data-hdc-read', ''); else row.removeAttribute('data-hdc-read');
      if (last) row.setAttribute('data-hdc-last', ''); else row.removeAttribute('data-hdc-last');
    }
  }

  // ---------- series page: "Similar series" under the chapter list ----------
  // Asked only when you scroll near the end of the chapters (two small questions, remembered for a day): the series'
  // genres, then hiperdex's popular series with those genres; the closest by genres and content rating first.
  // Series on your list or that you read are left out, and so is another version of the same series.
  const SIM_KEY = 'hdc:sim', SIM_SHOW = 12, RATE = { safe: 0, suggestive: 1, erotica: 2, pornographic: 3 };
  const sim = { all: null, busy: {}, io: null, ioSlug: '' };
  function simCache(slug, val) {
    if (!sim.all) { try { sim.all = JSON.parse(localStorage.getItem(SIM_KEY) || '{}') || {}; } catch (e) { sim.all = {}; } }
    const all = sim.all;
    if (val === undefined) { const v = all[slug]; return v && Date.now() - v.at < DAY ? v : null; }
    all[slug] = val;
    const ks = Object.keys(all);
    if (ks.length > 40) ks.sort((a, b) => all[a].at - all[b].at).slice(0, ks.length - 30).forEach((k) => delete all[k]);
    try { localStorage.setItem(SIM_KEY, JSON.stringify(all)); } catch (e) { /* full */ }
  }
  async function simLoad(slug) {
    if (sim.busy[slug]) return;
    sim.busy[slug] = 1;
    try {
      const me = await api('series.bySlugWithGenres', { slug });
      const d = me.data;
      if (!d || !d.id) return;
      const g = (Array.isArray(d.genres) ? d.genres : []).map((x) => (x && x.name) || x).filter(Boolean).map(String);
      // popular series with those genres, up to one step "spicier" than this one; and the same again of its own kind
      // (manga / manhwa ...), so both kinds have a chance
      const rate = RATE[d.contentRating] != null ? RATE[d.contentRating] : 3;
      const cap = Object.keys(RATE)[Math.min(3, rate + 1)];
      const ask = (extra, limit, maxRating) => api('search.query', { q: '', sort: 'popular', filters: Object.assign({ genres: g.length ? g : undefined }, extra), limit, offset: 0, maxRating });
      let a = await ask({}, 40, cap);
      if (!a.data) a = await ask({}, 24, 'pornographic');
      const b = d.type ? await ask({ type: d.type }, 24, a.data ? cap : 'pornographic') : { data: null };
      const seen = new Set(), hits = [];
      for (const h of [...((a.data && a.data.hits) || []), ...((b.data && b.data.hits) || [])]) if (h && !seen.has(h.id)) { seen.add(h.id); hits.push(h); }
      const bare = (t) => norm(String(t || '').replace(/\s*[([][^)\]]*[)\]]\s*/g, ' '));
      const meBare = bare(d.title), mine = new Set(g);
      const list = hits.filter((h) => h && h.slug && String(h.id) !== String(d.id) && bare(h.title) !== meBare).map((h) => {
        const hg = (h.genres || []).map(String), both = hg.filter((x) => mine.has(x)).length;
        const jac = both / Math.max(1, new Set([...hg, ...g]).size);
        const s = jac - 0.3 * Math.abs((RATE[h.contentRating] != null ? RATE[h.contentRating] : 3) - rate) + (h.type === d.type ? 0.12 : 0) + 0.04 * Math.log10((+h.views || 0) + 1) / 7;
        return { slug: h.slug, title: h.title, cover: h.coverUrl, type: h.type, score: +h.score || 0, s };
      }).sort((a, b) => b.s - a.s).slice(0, 30);
      simCache(slug, { at: Date.now(), list });
      if (seriesSlug() === slug) simDraw(slug);
    } catch (e) { /* next visit */ } finally { delete sim.busy[slug]; }
  }
  function simDraw(slug) {
    const el = document.getElementById('hdc-sim');
    const c = simCache(slug);
    if (!el || !c) return;
    const by = reads();
    const pick = c.list.filter((x) => !(by[x.slug] && (by[x.slug].best || by[x.slug].status))).slice(0, SIM_SHOW);
    const html = pick.length ? `<h2>Similar series</h2><div class="hdc-simg">` + pick.map((x) => `<a class="hdc-card" href="/manga/${encodeURIComponent(x.slug)}">
        <div class="hdc-cv"><img src="${esc(x.cover || '')}" alt="" loading="lazy"></div><div class="hdc-t" title="${esc(x.title)}">${esc(x.title)}</div>
        <div class="hdc-s">${esc(String(x.type || '').replace(/^./, (m) => m.toUpperCase()))}${x.score ? ' · ★ ' + x.score.toFixed(1) : ''}</div></a>`).join('') + '</div>' : '';
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }
  function simPlace(slug, rows) {
    const firstRow = rows.values().next().value;
    const block = firstRow && firstRow.parentElement && firstRow.parentElement.parentElement;     // "Chapters (N)" + the list
    let el = document.getElementById('hdc-sim');
    if (!block || !block.parentElement) { return false; }
    if (!el || el.dataset.slug !== slug) {
      if (el) el.remove();
      el = document.createElement('section'); el.id = 'hdc-sim'; el.dataset.slug = slug;
    }
    if (block.nextElementSibling !== el) block.parentElement.insertBefore(el, block.nextElementSibling);
    if (simCache(slug)) simDraw(slug);
    else if (!sim.io || sim.ioSlug !== slug || sim.ioEl !== el) {
      if (sim.io) sim.io.disconnect();
      sim.io = new IntersectionObserver((en) => { if (en.some((x) => x.isIntersecting)) { sim.io.disconnect(); sim.io = null; simLoad(slug); } }, { rootMargin: '1500px 0px' });
      sim.ioSlug = slug; sim.ioEl = el;
      sim.io.observe(el);
    }
    return true;
  }

  function render() {
    const k = pageKind();
    if (k === 'home') { home.html = homeHtml(); placeHome(); }
    else if (k === 'series') placeSeries();
  }
  let renderTimer = 0;
  function renderSoon() { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = 0; render(); }, 120); }

  // called every second (only while the tab is shown) and once at start
  let pageWas = '';
  function onPage() {
    tbShow();
    const k = pageKind();
    if (k !== 'home') { const b = document.getElementById('hdc-home'); if (b) b.remove(); }
    if (k !== 'series') { for (const id of ['hdc-resume', 'hdc-sim']) { const b = document.getElementById(id); if (b) b.remove(); } if (sim.io) { sim.io.disconnect(); sim.io = null; } }
    if (!k) { pageWas = ''; return; }
    addCss();
    const here = location.pathname;
    if (here !== pageWas) {                               // just arrived: draw from what is known, then ask for news
      pageWas = here;
      home.ready = false; home.arrived = Date.now();
      if (k === 'home') home.html = homeHtml();
      render();
      refresh(k);
      return;
    }
    // hiperdex redraws parts of its pages: put ours back if it went missing (cheap checks only)
    if (k === 'home') {
      const b = document.getElementById('hdc-home');
      if (home.html && (!b || !b.isConnected || (b.parentElement && homeRef(b.parentElement) !== b))) placeHome();
      const ib = document.getElementById('hdc-imp');
      if ((IMP.prog || db.imp.last || !ib) && (!ib || !ib.isConnected || (ib.parentElement && ib.parentElement.firstElementChild !== ib))) impPaint();
    }
    else if ((!home.ready && Date.now() - home.arrived < 20000) || (home.btn && !document.getElementById('hdc-resume')) || (home.marks && !document.querySelector('.hdc-mark'))
      || (home.sim && !(document.getElementById('hdc-sim') || {}).isConnected)) placeSeries();
  }
  async function refresh(k) {
    try {
      const got = await Promise.all([loadLib(), loadAtsuCr()]);
      if (got.some(Boolean)) renderSoon();
      if (k === 'home') {
        impMaybe();
        if (await loadLatest()) renderSoon();
        queueSeries([...mySlugs()].sort((a, b) => ((db.chap[a] || {}).at || 0) - ((db.chap[b] || {}).at || 0)));
      } else {
        const sl = seriesSlug();
        if (sl && reads()[sl]) queueSeries([sl]);
      }
    } catch (e) { /* next visit */ }
  }
  window.addEventListener('storage', (e) => { if (e.key === KEY) { try { const d = JSON.parse(e.newValue || '{}'); if (d && d.spot) { Object.assign(db, d); renderSoon(); } } catch (x) { /* ignore */ } } });

  // ---------- import: your atsu.moe bookmarks and comix follows onto hiperdex ----------
  // Started from the home page (once by itself when you are signed in on hiperdex, later with "Import again").
  // Every series is looked up on hiperdex by its names; one that is there goes on your hiperdex list with the same
  // status (Reading, Plan to read, ...) and hiperdex's own "last chapter" is moved to where you are. Here, the
  // chapters you read elsewhere are marked read and the series shows in Continue Reading. A series is only ever
  // added once: one you remove from your hiperdex list afterwards is not put back. Nothing is written on atsu or
  // comix. comix's list comes from hdc:import:comix (taken from comix's Followed Titles page; comix's own data
  // cannot be read from here). One request at a time with short pauses: about 5 minutes for 400 series.
  db.upto = db.upto || {};      // slug -> {n, inc, ts, src}: read up to chapter n elsewhere (inc: n itself finished)
  db.imp = db.imp || {};        // {done:{key: slug|''}, added:{slug: ts}, tracked:{slug:{n,at}}, miss:[], last:{...}, auto}
  const IMP = { running: false, prog: null, fails: 0, JOB: 'hdc:import:job', CX: 'hdc:import:comix', POS: 'hdc:import:pos', LOCK: 'hdc:import:lock',
    beat() { try { localStorage.setItem(this.LOCK, String(Date.now())); } catch (e) { /* ignore */ } },     // "a tab is on it"
    busyElsewhere() { const t = +localStorage.getItem(this.LOCK) || 0; return !this.running && Date.now() - t < 30e3; } };
  const sleep = (t) => new Promise((r) => setTimeout(r, t));
  const ATSU_ST = { Reading: 'reading', Completed: 'completed', OnHold: 'paused', ReReading: 'rereading', Dropped: 'dropped', PlanToRead: 'want_to_read' };
  const upDone = (u, x) => !!u && (x < u.n - 1e-6 || (u.inc && x <= u.n + 1e-6));
  const further = (a, b) => !b || a.n > b.n + 1e-6 || (Math.abs(a.n - b.n) < 1e-6 && (a.inc && !b.inc || (a.f || 0) > (b.f || 0)));

  async function mut(name, input) {                          // a hiperdex change (same call its own buttons make)
    try {
      const r = await fetch('/api/trpc/' + name, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: input }) });
      return r.status;
    } catch (e) { return 0; }
  }

  // atsu: every bookmark with its names and where you are (Continue Reading, else the chapters you read there)
  async function impAtsu(say) {
    if (!canAtsu) return { list: [], err: '' };
    const b = await atsuReq('GET', '/api/user/bookmarkIds');
    if (signedOut(b)) return { list: [], err: 'atsu: signed out' };
    if (!b.json || !Array.isArray(b.json.bookmarks)) return { list: [], err: 'atsu not answering' };
    const bm = b.json.bookmarks.filter((x) => x && x.mangaId && ATSU_ST[x.status]);
    const docs = {};
    for (let i = 0; i < bm.length; i += 50) {
      say('Reading your atsu list… ' + Math.min(bm.length, i + 50) + ' / ' + bm.length);
      const q = new URLSearchParams({ q: '*', query_by: 'title', filter_by: 'id:[' + bm.slice(i, i + 50).map((x) => x.mangaId).join(',') + ']', per_page: '50' });
      const r = await atsuReq('GET', '/collections/manga/documents/search?' + q);
      for (const h of (r.json && r.json.hits) || []) if (h && h.document && h.document.id) docs[h.document.id] = h.document;
      await sleep(250);
    }
    const pos = {};
    for (let page = 0; page < 20; page++) {
      const r = await atsuReq('GET', `/api/infinite/continueReading?page=${page}&perPage=50`);
      const items = (r.json && r.json.items) || [];
      for (const x of items) {
        const c = x && x.continueReading;
        if (!c || !isFinite(+c.number)) continue;
        const f = +c.frac || 0;
        pos[x.id] = { n: +c.number, inc: f >= DONE, f, ts: ms(c.ts) };
      }
      if (items.length < 50) break;
      await sleep(250);
    }
    // places already read on an earlier try (a closed / reloaded tab) are kept for a day
    let kept = {};
    try { kept = JSON.parse(localStorage.getItem(IMP.POS) || '{}') || {}; } catch (e) { kept = {}; }
    if (!kept.at || Date.now() - kept.at > DAY) kept = { at: Date.now(), pos: {} };
    const started = bm.filter((x) => !pos[x.mangaId] && x.status !== 'PlanToRead');
    for (let i = 0; i < started.length; i++) {
      const id = started[i].mangaId;
      if (id in kept.pos) { if (kept.pos[id]) pos[id] = kept.pos[id]; continue; }
      say('Reading your places on atsu (one series at a time, atsu is fine)… ' + (i + 1) + ' / ' + started.length);
      IMP.beat();
      const r = await atsuReq('GET', '/api/manga/allChapters?mangaId=' + encodeURIComponent(id));
      if (r.status === 0 || r.status >= 500) { await sleep(3000); i--; if (++IMP.fails > 8) return { list: [], err: 'atsu not answering' }; continue; }
      let top = null, last = null;
      for (const c of (r.json && r.json.chapters) || []) {
        const p = c && c.progress;
        if (!p || !isFinite(+c.number)) continue;
        const f = +p.frac || (p.pages ? (+p.page + 1) / p.pages : 0), n = +c.number, t = ms(p.ts);
        if (f >= 0.9 && (!top || n > top.n)) top = { n, inc: true, f: 1, ts: t };
        if (f >= START_AT && (!last || n > last.n)) last = { n, inc: f >= DONE, f, ts: t };
      }
      const p = last && (!top || last.n > top.n) ? last : top;
      if (p) pos[id] = p;
      kept.pos[id] = p || 0;
      if (i % 10 === 9) try { localStorage.setItem(IMP.POS, JSON.stringify(kept)); } catch (e) { /* full */ }
      await sleep(700);                                     // gentle on atsu: under 1.5 requests a second
      while (document.hidden) { await sleep(2000); IMP.beat(); }   // tab in the background: waits
    }
    try { localStorage.setItem(IMP.POS, JSON.stringify(kept)); } catch (e) { /* full */ }
    const list = bm.map((x) => {
      const d = docs[x.mangaId] || {};
      if (!d.title || d.medium === 'Novel') return null;
      const names = [d.title, d.englishTitle, ...(Array.isArray(d.otherNames) ? d.otherNames : [])].filter(Boolean).map(String);
      return { key: 'a:' + x.mangaId, src: 'atsu', atsuId: x.mangaId, type: d.type || 'Manga', title: d.title, names: [...new Set(names)].slice(0, 12), status: ATSU_ST[x.status], pos: pos[x.mangaId] || null };
    }).filter(Boolean);
    return { list, err: '' };
  }
  // comix: [hid, status, last read chapter, [chapter, share, time] | null, AniList id, title, other names...]
  function impComix() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(IMP.CX) || '[]'); } catch (e) { rows = []; }
    return (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r) && r[0] && r[5]).map((r) => {
      const [hid, status, up, sp, al, ...names] = r;
      let pos = null;
      if (up != null && isFinite(+up) && +up < 5000) pos = { n: +up, inc: true, f: 1, ts: 0 };
      if (sp && isFinite(+sp[0])) { const s = { n: +sp[0], inc: +sp[1] >= DONE, f: +sp[1] || 0, ts: +sp[2] || 0 }; if (!pos || s.n >= pos.n - 1e-6) pos = s; else pos.ts = s.ts; }
      return { key: 'c:' + hid, src: 'comix', title: names[0], names: names.map(String), status: status || 'reading', pos, al };
    });
  }
  // one entry per series: the same story on both sites is joined (by name), the further place wins
  function impMerge(a, c) {
    const out = a.slice(), idx = new Map();
    for (const r of out) for (const n of r.names) { const k = norm(n); if (k) idx.set(k, r); }
    for (const r of c) {
      const twin = r.names.map((n) => idx.get(norm(n))).find(Boolean);
      if (!twin) { out.push(r); continue; }
      twin.keys = [twin.key, r.key];
      twin.names = [...new Set(twin.names.concat(r.names))].slice(0, 16);
      if (r.pos && further(r.pos, twin.pos)) { twin.pos = r.pos; twin.src2 = 'comix'; }
      if (twin.status === 'want_to_read' && r.status !== 'want_to_read') twin.status = r.status;
    }
    return out;
  }
  // the same series on hiperdex: a search result whose name (or one of its other names) is one of ours
  async function impFind(rec) {
    const want = new Set(rec.names.map(norm).filter(Boolean));
    const bare = (s) => norm(String(s).replace(/\s*[([][^)\]]*[)\]]\s*$/, ''));
    const want2 = new Set(rec.names.map(bare).filter((s) => s.length > 3));
    const qs = [...new Set(rec.names.filter((n) => /[a-z]/i.test(n)).map((n) => n.slice(0, 100)))].slice(0, 3);
    const namesOf = (h) => [h.title, ...(Array.isArray(h.alternativeTitles) ? h.alternativeTitles : [])];
    const longs = [...want].filter((s) => s.length >= 14);
    let close = null;                                       // the same long name spelt a little differently (Kuderella / Couderella)
    for (const q of qs) {
      const r = await api('search.query', { q, sort: 'relevance', filters: {}, limit: 8, offset: 0, maxRating: 'pornographic' });
      await sleep(200);
      if (r.status === 0 || r.status >= 500) return { retry: true };
      const hits = ((r.data && r.data.hits) || []).filter((h) => h && h.id && h.slug);
      const hit = hits.find((h) => want.has(norm(h.title))) || hits.find((h) => namesOf(h).some((n) => want.has(norm(n))))
        || hits.find((h) => namesOf(h).some((n) => want2.has(bare(n))));
      if (hit) return { hit };
      for (const h of hits) for (const n of namesOf(h)) {
        const s = norm(n);
        if (s.length < 14) continue;
        for (const w of longs) { const d = dice(s, w); if (d >= 0.88 && (!close || d > close.d)) close = { h, d }; }
      }
    }
    return close ? { hit: close.h } : {};
  }
  function dice(a, b) {                                     // how alike two names are by letter pairs (1 = the same)
    const pairs = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const p = s.slice(i, i + 2); m.set(p, (m.get(p) || 0) + 1); } return m; };
    const A = pairs(a), B = pairs(b);
    let both = 0;
    for (const [p, n] of A) both += Math.min(n, B.get(p) || 0);
    return (2 * both) / Math.max(1, a.length - 1 + b.length - 1);
  }
  async function impOne(rec, lib) {
    const keys = rec.keys || [rec.key];
    const knownSlug = keys.map((k) => db.imp.done[k]).find(Boolean);
    const first = !knownSlug;
    let h = null;
    if (knownSlug && db.meta[knownSlug] && db.meta[knownSlug].id) h = { id: db.meta[knownSlug].id, slug: knownSlug, title: db.meta[knownSlug].title, coverUrl: db.meta[knownSlug].cover, status: db.meta[knownSlug].st };
    else {
      const f = await impFind(rec);
      if (f.retry) return 'retry';
      if (!f.hit) { keys.forEach((k) => { db.imp.done[k] = ''; }); return 'miss'; }
      h = f.hit;
    }
    const slug = h.slug;
    db.meta[slug] = Object.assign(db.meta[slug] || {}, { id: h.id, title: h.title, cover: h.coverUrl || (db.meta[slug] || {}).cover, st: h.status });
    if (rec.atsuId && !(db.atsu[slug] && db.atsu[slug].id)) db.atsu[slug] = { id: rec.atsuId, type: rec.type || 'Manga', title: rec.title, groups: [] };
    const p = rec.pos;
    if (p) {
      const src = rec.src2 || rec.src;
      if (further(p, db.upto[slug])) db.upto[slug] = { n: p.n, inc: p.inc, ts: p.ts, src };
      const key = slug + '/' + numTxt(p.n);
      if (!p.inc && p.f > 0.02 && (!db.spot[key] || db.spot[key].ts < p.ts)) db.spot[key] = { f: p.f, p: 0, o: 0, ts: p.ts || 1, imp: src };
    }
    // your hiperdex list: added once; a series you removed later stays removed
    const mine = lib.get(h.id);
    let wrote = false;
    if (lib.ok && (mine || first)) {
      if (p) {
        const r = await api('series.chapters', { seriesId: h.id });
        const pub = Array.isArray(r.data) ? r.data.filter((c) => c && c.id && c.number != null && (!c.status || c.status === 'published') && !c.isDeleted) : [];
        if (pub.length) {
          const nums = [...new Set(pub.map((c) => +c.number))].sort((a, b) => a - b);
          db.chap[slug] = { at: Date.now(), nums: nums.slice(-600), latest: nums[nums.length - 1], latestAt: Math.max(...pub.map((c) => ms(c.createdAt))) };
          const ch = pub.filter((c) => +c.number <= p.n + 1e-6).sort((a, b) => +b.number - +a.number)[0];
          if (ch && (!mine || mine.last == null || mine.last < +ch.number)) {
            if (await mut('library.trackProgress', { seriesId: h.id, chapterId: ch.id, page: 0 }) === 200) {
              db.imp.tracked[slug] = { n: +ch.number, at: Date.now() }; wrote = true;
            }
            await sleep(150);
          }
        }
      }
      // your status there is kept, except "Want to read" (hiperdex sets that by itself when you open a chapter);
      // after moving the last chapter the status is written again, in case hiperdex changed it
      let st = null;
      if (!mine) st = rec.status;
      else if (mine.status === 'want_to_read' && rec.status !== 'want_to_read') st = rec.status;
      else if (wrote) st = mine.status;
      if (st) {
        if (await mut('library.upsert', { seriesId: h.id, status: st }) === 200 && !mine) { db.imp.added[slug] = Date.now(); lib.set(h.id, { status: st, last: null }); }
        await sleep(150);
      }
    }
    keys.forEach((k) => { db.imp.done[k] = slug; });
    return first ? 'ok' : 'skip';
  }
  async function impLib() {
    const lib = new Map();
    for (let page = 1; page <= 20; page++) {
      const r = await api('library.list', { page, limit: 50 });
      if (!r.data || !Array.isArray(r.data.items)) return { ok: page > 1, get: (id) => lib.get(id), set: (id, v) => lib.set(id, v) };
      for (const x of r.data.items) if (x && x.seriesId) lib.set(x.seriesId, { status: x.status, last: x.lastChapterNumber != null ? +x.lastChapterNumber : null });
      if (page >= (r.data.totalPages || 1)) break;
    }
    return { ok: true, get: (id) => lib.get(id), set: (id, v) => lib.set(id, v) };
  }
  async function runImport() {
    if (IMP.running || IMP.busyElsewhere()) return;
    IMP.running = true; IMP.fails = 0; IMP.beat();
    db.imp.done = db.imp.done || {}; db.imp.added = db.imp.added || {}; db.imp.tracked = db.imp.tracked || {};
    const say = (t) => { IMP.prog = { text: t }; impPaint(); };
    try {
      let job = null;
      try { job = JSON.parse(localStorage.getItem(IMP.JOB) || 'null'); } catch (e) { job = null; }
      if (!job || Date.now() - job.at > DAY) {
        say('Reading your atsu list…');
        const a = await impAtsu(say);
        const list = impMerge(a.list, impComix());
        job = { at: Date.now(), i: 0, list, err: a.err, n: { ok: 0, miss: 0 }, miss: [] };
        try { localStorage.setItem(IMP.JOB, JSON.stringify(job)); } catch (e) { /* too big: runs without resuming */ }
      }
      const lib = await impLib();
      let retries = 0;
      while (job.i < job.list.length) {
        const rec = job.list[job.i];
        IMP.prog = { i: job.i, total: job.list.length, ok: job.n.ok, miss: job.n.miss }; impPaint(); IMP.beat();
        const r = await impOne(rec, lib);
        if (r === 'retry') { if (++retries > 5) break; await sleep(5000); continue; }
        retries = 0;
        if (r === 'ok' || r === 'skip') job.n.ok++;
        if (r === 'miss') { job.n.miss++; job.miss.push(rec.title); }
        job.i++;
        if (job.i % 5 === 0 || job.i === job.list.length) { save(); try { localStorage.setItem(IMP.JOB, JSON.stringify(job)); } catch (e) { /* full */ } }
        if (job.i % 10 === 0) renderSoon();               // new rows appear in Continue Reading as it goes
      }
      if (job.i >= job.list.length) {
        db.imp.last = { at: Date.now(), total: job.list.length, ok: job.n.ok, miss: job.n.miss, err: job.err || '', signedIn: lib.ok };
        db.imp.miss = job.miss.slice(0, 400);
        localStorage.removeItem(IMP.JOB);
        localStorage.removeItem(IMP.POS);
        db.lib = null; home.lib = 0;                         // your list changed: ask again
        save();
        note(`Imported ${job.n.ok} series from atsu + comix` + (job.n.miss ? ` · ${job.n.miss} are not on hiperdex` : ''));
        refresh(pageKind());
      }
    } catch (e) { /* stopped: the next home visit carries on */ }
    IMP.running = false; IMP.prog = null; localStorage.removeItem(IMP.LOCK); impPaint(); renderSoon();
  }
  // its own small box above our rows, redrawn alone (the rows below are not touched while it counts)
  function impPaint() {
    const main = pageKind() === 'home' && homeMain();
    let el = document.getElementById('hdc-imp');
    const html = main ? impHtml() : '';
    if (!html) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('section'); el.id = 'hdc-imp'; el.addEventListener('click', onHomeClick); }
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    if (main.firstElementChild !== el) main.insertBefore(el, main.firstElementChild);
  }
  // by itself when signed in, until it has finished once (a closed / reloaded tab carries on next time);
  // never in two tabs at once
  function impMaybe() {
    if (IMP.running || IMP.busyElsewhere()) return;
    const pending = !!localStorage.getItem(IMP.JOB);
    // a phone: the computer has done the import already (your hiperdex list is on your account, so the phone has
    // it too). Running it again here would put back series you have since removed (what was added is noted per
    // browser), so a phone never starts it by itself
    if (PHONE && !pending) return;
    const ready = db.lib && !db.lib.out && Array.isArray(db.lib.items) && db.lib.items.length > 0;
    if (pending || (!db.imp.last && ready && (canAtsu || localStorage.getItem(IMP.CX)))) { db.imp.auto = db.imp.auto || Date.now(); save(); runImport(); }
  }
  // the strip on the home page: progress while it runs, the result after
  function impHtml() {
    const p = IMP.prog, l = db.imp.last;
    if (p) {
      const pct = p.total ? Math.round(p.i / p.total * 100) : 0;
      const t = p.text || `Bringing over your atsu + comix bookmarks… ${p.i} / ${p.total} · ${p.ok} added · ${p.miss} not on hiperdex`;
      return `<div class="hdc-imp"><span>${esc(t)}</span><div class="hdc-bar"><i style="width:${pct}%"></i></div></div>`;
    }
    if (l && !l.total && !l.err) return '';                  // nothing to bring over: no box
    if (l && !db.imp.hide) {
      return `<div class="hdc-imp"><span>Imported ${l.ok} series from atsu + comix${l.miss ? ` · <a href="#" data-hdc="miss">${l.miss} not on hiperdex</a>` : ''}${l.err ? ' · ' + esc(l.err) : ''}${l.signedIn ? '' : ' · sign in on hiperdex to put them on your list'}</span>`
        + `<span><button class="hdc-btn" data-hdc="imp">Import again</button> <button class="hdc-btn" data-hdc="imphide" title="Hide">✕</button></span>`
        + (home.showMiss ? `<div class="hdc-miss">${(db.imp.miss || []).map(esc).join(' · ')}</div>` : '') + '</div>';
    }
    if (!l && !db.imp.auto && !PHONE && (canAtsu || localStorage.getItem(IMP.CX))) return `<div class="hdc-imp"><span>Bring your atsu + comix bookmarks here (with the chapters you read)</span><button class="hdc-btn" data-hdc="imp">Import</button></div>`;
    return '';
  }

  // ---------- small note at the top (in the page, never a pop-up) ----------
  let noteEl = null, noteTimer = 0;
  function note(text) {
    if (!document.body) return;
    if (!noteEl) {
      noteEl = document.createElement('div'); noteEl.id = 'hdc-note';
      noteEl.style.cssText = 'position:fixed;left:50%;top:16px;transform:translate(-50%,-8px);z-index:2147483000;max-width:min(90vw,720px);'
        + 'padding:8px 14px;border-radius:12px;background:rgba(24,24,28,.92);color:#eee;font:13px/1.35 system-ui,sans-serif;'
        + 'box-shadow:0 4px 18px rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;'
        + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      document.body.appendChild(noteEl);
    }
    noteEl.textContent = text;
    noteEl.style.opacity = '1'; noteEl.style.transform = 'translate(-50%,0)';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { noteEl.style.opacity = '0'; noteEl.style.transform = 'translate(-50%,-8px)'; }, 3500);
  }
})();
