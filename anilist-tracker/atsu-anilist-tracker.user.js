// ==UserScript==
// @name         Atsu → AniList Sync
// @namespace    https://atsu.moe/
// @version      1.0.3
// @description  AniList tracker for the mobile Firefox browser on atsu.moe: a reading line along the bottom of the reader, and once you have read 85% of a chapter your AniList progress goes up (it shows in your AniList activity). Tap the line to update by hand, fix the match or change the settings.
// @author       YoruC
// @homepageURL  https://github.com/YoruCAnime/Atsumoe-stuff
// @updateURL    https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/anilist-tracker/atsu-anilist-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/anilist-tracker/atsu-anilist-tracker.user.js
// @match        https://atsu.moe/*
// @match        https://anilist.co/api/v2/oauth/pin*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      graphql.anilist.co
// ==/UserScript==

(function () {
  'use strict';

  /* ==================================================================== *
   *  What atsu.moe does (checked 2026-10-25):
   *
   *  - Reader address: /read/<mangaId>/<chapterId> (novels /novel/...). The
   *    site is a React app, so the next chapter opens without a page load.
   *  - The reader writes where you are into the address: #rs=f:0.4567 in
   *    long-strip mode (0 = top, 1 = the strip's end at the bottom of the
   *    screen), #rs=p:12 in page mode (0-based page), and c:1 once the
   *    comments under the chapter come into view.
   *  - /api/read/chapter?mangaId=&chapterId= -> readChapter {number, pages[]}
   *    /api/manga/page?id= -> mangaPage {title, englishTitle, otherNames,
   *    anilistId, malId, ...}, so most series match AniList exactly.
   *  - Its CSP only lets the page talk to its own hosts, so AniList is
   *    reached through GM_xmlhttpRequest (@connect graphql.anilist.co).
   *  - The reader buttons sit 8px above the bottom edge and fade out
   *    (opacity 0, pointer-events none) while you read; a small
   *    "7% · 112.5 / 112.7" label sits bottom-centre then.
   *  - atsu.moe has its own server-side "Sync my reading to AniList". Both
   *    can stay on: this script reads your AniList entry before it writes
   *    and skips chapters AniList already has.
   *
   *  AniList: graphql.anilist.co allows 30 requests a minute right now; a
   *  chapter costs 2 (read the entry, save it). Saving progress is what makes
   *  the "Read chapter N of ..." activity, same as on the site.
   * ==================================================================== */

  const VERSION = '1.0.3';
  const API = 'https://graphql.anilist.co';
  const PIN = 'https://anilist.co/api/v2/oauth/pin';
  const DEV = 'https://anilist.co/settings/developer';

  const DEFAULTS = {
    threshold: 85,   // % of a chapter read before AniList is updated
    auto: true,      // update by itself at the threshold
    addNew: true,    // add series that are not on the list yet (as Reading)
    finish: true     // last chapter of a finished series -> Completed
  };

  const xhr = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
    : (typeof GM === 'object' && GM && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;

  function gv(k, d) {
    try { const v = GM_getValue(k); return v === undefined || v === null ? d : v; } catch (e) { return d; }
  }
  function sv(k, v) { try { GM_setValue(k, v); } catch (e) { /* storage blocked */ } }

  function loadCfg() {
    const o = gv('cfg', {}) || {};
    const s = {};
    Object.keys(DEFAULTS).forEach(k => { s[k] = typeof o[k] === typeof DEFAULTS[k] ? o[k] : DEFAULTS[k]; });
    s.threshold = Math.min(100, Math.max(50, Math.round(s.threshold)));
    return s;
  }
  let cfg = loadCfg();
  const saveCfg = () => sv('cfg', cfg);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtNum = n => (n == null || !isFinite(n)) ? '?' : String(Math.round(n * 100) / 100);
  const chOf = c => Math.floor((c.number || 0) + 1e-6);

  function err(code, msg, wait) { const e = new Error(msg); e.code = code; if (wait) e.wait = wait; return e; }

  /* ------------------------------------------------------------------ */
  /*  AniList login                                                      */
  /* ------------------------------------------------------------------ */

  // AniList tokens are JWTs; the payload says when they stop working (a year).
  function tokenExp(t) {
    try {
      const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return p.exp ? p.exp * 1000 : 0;
    } catch (e) { return 0; }
  }
  function getToken() {
    const t = gv('token', '');
    if (!t) return '';
    const exp = tokenExp(t);
    return exp && exp < Date.now() ? '' : t;
  }
  function saveToken(t) {
    t = String(t || '').replace(/^Bearer\s+/i, '').trim();
    if (t.length < 30) return false;
    sv('token', t); sv('tokenBad', false); sv('viewer', null);
    return true;
  }
  const loginMsg = () => gv('tokenBad', false) ? 'AniList refused the saved login - connect again'
    : gv('token', '') && !getToken() ? 'Your AniList login ran out - connect again' : 'Connect your AniList account (one time)';

  function startConnect(clientId) {
    sv('clientId', clientId);
    sv('returnUrl', location.href);
    location.href = 'https://anilist.co/api/v2/oauth/authorize?client_id=' + encodeURIComponent(clientId) +
      '&response_type=token';
  }

  /* ------------------------------------------------------------------ */
  /*  AniList API                                                        */
  /* ------------------------------------------------------------------ */

  const MEDIA_FIELDS = 'id idMal siteUrl format status chapters countryOfOrigin ' +
    'title { userPreferred romaji english native } coverImage { medium }';
  const ENTRY_FIELDS = 'id status progress repeat startedAt { year month day } completedAt { year month day }';
  const Q_MEDIA = `query ($id: Int) { Media(id: $id, type: MANGA) { ${MEDIA_FIELDS} mediaListEntry { ${ENTRY_FIELDS} } } }`;
  const Q_MAL = 'query ($mal: Int) { Media(idMal: $mal, type: MANGA) { id } }';
  const Q_SEARCH = `query ($s: String) { Page(perPage: 12) { media(search: $s, type: MANGA, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} synonyms startDate { year } } } }`;
  const Q_VIEWER = 'query { Viewer { id name } }';
  const M_SAVE = 'mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $repeat: Int, ' +
    '$startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) { SaveMediaListEntry(mediaId: $mediaId, ' +
    'status: $status, progress: $progress, repeat: $repeat, startedAt: $startedAt, completedAt: $completedAt) ' +
    `{ ${ENTRY_FIELDS} } }`;
  const M_DEL = 'mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }';

  // Tampermonkey on Firefox does not always fill responseText; take whatever it gave
  function bodyText(r) {
    try { if (typeof r.responseText === 'string' && r.responseText) return r.responseText; } catch (e) { /* responseType set */ }
    try {
      if (typeof r.response === 'string') return r.response;
      if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
    } catch (e) { /* nothing readable */ }
    return '';
  }
  function errMsg(j) {
    if (!j) return '';
    if (j.errors && j.errors[0] && j.errors[0].message) return j.errors[0].message;
    if (j.error && j.error.messages && j.error.messages[0]) return String(j.error.messages[0]);
    return j.message || '';
  }

  function gql(query, variables, token) {
    return new Promise((resolve, reject) => {
      if (!xhr) return reject(err('api', 'Tampermonkey did not give this script GM_xmlhttpRequest'));
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      xhr({
        // anonymous: no anilist.co cookies - the API only needs the Bearer token
        method: 'POST', url: API, headers, timeout: 20000, anonymous: true,
        data: JSON.stringify({ query, variables: variables || {} }),
        onload: r => {
          const text = bodyText(r);
          let j = null;
          try { j = JSON.parse(text); } catch (e) { /* not JSON */ }
          const msg = errMsg(j);
          if (r.status === 200 && j && j.data && !j.errors) return resolve(j.data);
          const st = r.status;
          if ((st === 400 && /invalid token/i.test(msg)) || st === 401) return reject(err('token', loginMsg()));
          if (st === 404) return reject(err('notfound', msg || 'Not found on AniList'));
          if (st === 429) {
            const m = /retry-after:\s*(\d+)/i.exec(r.responseHeaders || '');
            return reject(err('rate', 'AniList asked to slow down', m ? +m[1] : 60));
          }
          if (st === 0 || st === 403 || st >= 500) return reject(err('down', msg ? 'AniList: ' + msg : 'AniList is not answering (' + st + ')'));
          const said = msg || (text ? text.replace(/\s+/g, ' ').slice(0, 140) : 'no reason given');
          reject(err('api', 'AniList error ' + st + ': ' + said));
        },
        onerror: () => reject(err('net', 'No connection to AniList')),
        ontimeout: () => reject(err('net', 'AniList did not answer'))
      });
    });
  }

  // One retry after a 429 (AniList says how long); a refused login is forgotten.
  async function api(query, variables, token) {
    for (let i = 0; ; i++) {
      try { return await gql(query, variables, token); } catch (e) {
        if (e.code === 'token' && token) { sv('token', ''); sv('tokenBad', true); }
        if (e.code === 'rate' && i === 0 && e.wait <= 65) { await sleep(e.wait * 1000 + 500); continue; }
        throw e;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  The OAuth pin page: AniList sends the browser here with the token  */
  /* ------------------------------------------------------------------ */

  if (location.hostname === 'anilist.co') {
    const m = /access_token=([^&]+)/.exec(location.hash || '');
    if (m && saveToken(decodeURIComponent(m[1]))) pinBanner();
    return;
  }

  function pinBanner() {
    const back = gv('returnUrl', '') || 'https://atsu.moe/';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:2147483647;max-width:520px;margin:0 auto;' +
      'background:#161a23;color:#e7ebf2;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:16px;' +
      'font:15px/1.45 system-ui,-apple-system,Roboto,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5)';
    box.innerHTML = '<div style="font-weight:700;font-size:16px;margin-bottom:4px">atsu.moe is connected to AniList</div>' +
      '<div class="who" style="color:#98a2b3">Checking your account...</div>' +
      '<a style="display:flex;align-items:center;justify-content:center;min-height:46px;margin-top:12px;border-radius:12px;' +
      'background:#3db4f2;color:#08131c;font-weight:700;text-decoration:none" href="' + esc(back) + '">Back to atsu.moe</a>';
    document.body.appendChild(box);
    const who = box.querySelector('.who');
    gql(Q_VIEWER, {}, getToken()).then(d => {
      sv('viewer', { id: d.Viewer.id, name: d.Viewer.name });
      who.textContent = 'Signed in as ' + d.Viewer.name + '. Chapters you read on atsu.moe now update your list.';
    }).catch(e => { who.textContent = 'Login saved. (Could not check the account just now: ' + e.message + ')'; });
    sv('returnUrl', '');
  }

  /* ------------------------------------------------------------------ */
  /*  atsu.moe data                                                      */
  /* ------------------------------------------------------------------ */

  async function atsu(path) {
    const r = await fetch(location.origin + path, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw err('atsu', 'atsu.moe answered ' + r.status);
    return r.json();
  }

  function prune(obj, keep) {
    const keys = Object.keys(obj);
    if (keys.length <= keep) return obj;
    keys.sort((a, b) => (obj[b].at || 0) - (obj[a].at || 0)).slice(keep).forEach(k => delete obj[k]);
    return obj;
  }

  async function getSeries(id) {
    const cache = gv('series', {}) || {};
    const c = cache[id];
    if (c && Date.now() - c.at < 3 * 86400000) return c;
    const j = await atsu('/api/manga/page?id=' + encodeURIComponent(id));
    const p = j.mangaPage || j;
    const s = {
      id, title: p.title || '', en: p.englishTitle || '', other: (p.otherNames || []).slice(0, 12),
      al: +p.anilistId || 0, mal: +p.malId || 0, medium: p.medium || '', at: Date.now()
    };
    cache[id] = s;
    sv('series', prune(cache, 150));
    return s;
  }

  async function getChapter(mangaId, chapterId) {
    let c = null;
    try {
      const j = await atsu('/api/read/chapter?mangaId=' + encodeURIComponent(mangaId) + '&chapterId=' + encodeURIComponent(chapterId));
      c = j.readChapter || j;
    } catch (e) { /* novels may use another endpoint: the title still has the number */ }
    let num = c && c.number != null ? +c.number : NaN;
    const title = (c && c.title) || '';
    if (!isFinite(num)) {
      const m = /chapter\s+([\d.]+)/i.exec(title) || /chapter\s+([\d.]+)/i.exec(document.title);
      if (m) num = +m[1];
    }
    if (!isFinite(num)) throw err('atsu', 'Could not read the chapter number');
    const imgs = c && c.pages ? c.pages.map(p => String(p.image || '')).filter(s => s.indexOf('/static/pages/') >= 0) : [];
    return {
      number: num, title: title || 'Chapter ' + fmtNum(num), pages: c && c.pages ? c.pages.length : 0,
      pageSet: imgs.length ? new Set(imgs.map(pagePath)) : null
    };
  }

  // "/static/pages/..." part of a picture address, without host or query
  function pagePath(s) {
    const k = s.indexOf('/static/pages/');
    return (k >= 0 ? s.slice(k) : s).split(/[?#]/)[0];
  }

  /* ------------------------------------------------------------------ */
  /*  Matching atsu series -> AniList                                    */
  /* ------------------------------------------------------------------ */

  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`]/g, '').replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, ' ').trim();

  function bestMatch(list, s) {
    const names = new Set([s.title, s.en].concat(s.other || []).map(norm).filter(Boolean));
    const novel = s.medium === 'Novel';
    for (const m of list) {
      if ((m.format === 'NOVEL') !== novel) continue;
      const al = [m.title.userPreferred, m.title.romaji, m.title.english, m.title.native].concat(m.synonyms || []);
      if (al.map(norm).some(n => n && names.has(n))) return m;
    }
    return null;
  }

  async function searchAl(text) {
    const d = await api(Q_SEARCH, { s: text }, '');
    return (d.Page && d.Page.media) || [];
  }

  // -> {id, how} | {off:true} | {none:true}
  async function resolveId(s) {
    const map = gv('map', {}) || {};
    const ov = map[s.id];
    if (ov === -1) return { off: true };
    if (ov > 0) return { id: ov, how: 'you' };
    if (s.al) return { id: s.al, how: 'atsu' };
    const found = (gv('found', {}) || {})[s.id];
    if (found && found.id) return { id: found.id, how: 'title search' };
    let id = 0, how = '';
    if (s.mal) {
      try { const d = await api(Q_MAL, { mal: s.mal }, ''); if (d.Media) { id = d.Media.id; how = 'MyAnimeList id'; } } catch (e) {
        if (e.code !== 'notfound') throw e;
      }
    }
    if (!id) {
      const b = bestMatch(await searchAl(s.title || s.en), s);
      if (b) { id = b.id; how = 'title search'; }
    }
    if (!id) return { none: true };
    const f = gv('found', {}) || {};
    f[s.id] = { id, at: Date.now() };
    sv('found', prune(f, 300));
    return { id, how };
  }

  /* ------------------------------------------------------------------ */
  /*  What to write to AniList                                           */
  /* ------------------------------------------------------------------ */

  const STATUS = { CURRENT: 'Reading', PLANNING: 'Planning', COMPLETED: 'Completed', DROPPED: 'Dropped', PAUSED: 'Paused', REPEATING: 'Re-reading' };
  const hasDate = d => !!(d && d.year);
  function today() { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }; }

  // c = {number, media, entry}; mode 'auto' (threshold) or 'manual' (button);
  // force 'set' = write this chapter even if AniList is further.
  // -> {vars, label, done} or {skip, already?, lower?, manual?}
  function makePlan(c, mode, force) {
    const n = chOf(c);
    const m = c.media, e = c.entry || null;
    if (!(n >= 1)) return { skip: 'Chapter ' + fmtNum(c.number) + ' does not count on AniList' };
    const total = m.chapters || 0;
    const last = cfg.finish && total > 0 && n >= total && m.status === 'FINISHED';
    const t = today();
    const st = e && e.status, pr = (e && e.progress) || 0;
    const v = { mediaId: m.id };

    if (force === 'set') {
      v.progress = n;
      if (!e) { v.status = 'CURRENT'; v.startedAt = t; } else if (st !== 'CURRENT' && st !== 'REPEATING') v.status = 'CURRENT';
      return { vars: v, label: 'Set AniList to ch ' + n, done: 'set to ch ' + n };
    }
    if (!e) {
      if (mode === 'auto' && !cfg.addNew) return { skip: 'Not on your AniList list (adding new series is off)', manual: true };
      v.status = last ? 'COMPLETED' : 'CURRENT'; v.progress = n; v.startedAt = t;
      if (last) v.completedAt = t;
      return { vars: v, label: 'Add to AniList at ch ' + n, done: last ? 'added as Completed' : 'added to Reading at ch ' + n };
    }
    if (st === 'COMPLETED') {
      if (mode === 'auto') return { skip: 'Completed on your AniList', manual: true };
      v.status = 'REPEATING'; v.progress = n;
      return { vars: v, label: 'Start re-reading at ch ' + n, done: 're-reading at ch ' + n };
    }
    if (st === 'CURRENT' || st === 'REPEATING') {
      if (n <= pr) return { skip: 'AniList already has ch ' + pr, already: true, lower: n < pr };
      v.progress = n;
      if (last) {
        v.status = 'COMPLETED';
        if (st === 'REPEATING') v.repeat = (e.repeat || 0) + 1; else if (!hasDate(e.completedAt)) v.completedAt = t;
      }
      return { vars: v, label: 'Update AniList to ch ' + n, done: last ? 'ch ' + n + ', completed' : 'ch ' + pr + ' → ' + n };
    }
    // PLANNING / PAUSED / DROPPED
    if (n <= pr && mode === 'auto') return { skip: STATUS[st] + ' on AniList at ch ' + pr, manual: true };
    v.status = last ? 'COMPLETED' : 'CURRENT'; v.progress = Math.max(n, pr);
    if (!hasDate(e.startedAt)) v.startedAt = t;
    if (last && !hasDate(e.completedAt)) v.completedAt = t;
    return {
      vars: v, label: 'Move to Reading at ch ' + v.progress,
      done: STATUS[st] + ' → ' + (last ? 'Completed' : 'Reading') + ', ch ' + v.progress
    };
  }

  /* ------------------------------------------------------------------ */
  /*  The chapter on screen                                              */
  /* ------------------------------------------------------------------ */

  let cur = null;     // {key, kind, mangaId, chapterId, number, pages, series, alId, media, entry, peak, ...}
  let seq = 0;        // bumps on every chapter change; drops answers for a chapter we left

  function parsePath() {
    const m = /^\/(read|novel)\/([^/]+)\/([^/?#]+)/.exec(location.pathname);
    return m ? { kind: m[1], mangaId: decodeURIComponent(m[2]), chapterId: decodeURIComponent(m[3]), key: m[2] + '/' + m[3] } : null;
  }

  function openChapter(p) {
    const my = ++seq;
    cur = Object.assign({}, p, {
      openedAt: Date.now(), staleHash: location.hash, pct: 0, peak: 0, number: null, pages: 0,
      series: null, alId: 0, how: '', media: null, entry: undefined, entryAt: 0,
      synced: false, busy: false, autoTried: false, state: 'load', note: 'Loading the chapter...'
    });
    render();
    const c = cur;
    Promise.all([getChapter(p.mangaId, p.chapterId), getSeries(p.mangaId)]).then(([ch, s]) => {
      if (my !== seq) return;
      Object.assign(c, { number: ch.number, chTitle: ch.title, pages: ch.pages, pageSet: ch.pageSet, series: s });
      return matchAndLoad(c);
    }).catch(e => { if (my === seq) setState(c, 'err', e.message); });
  }

  async function matchAndLoad(c) {
    setState(c, 'load', 'Finding it on AniList...');
    const r = await resolveId(c.series);
    if (r.off) return setState(c, 'off', 'You turned tracking off for this series');
    if (r.none) return setState(c, 'warn', 'No AniList match found - tap to pick it', 'match');
    c.alId = r.id; c.how = r.how;
    await loadEntry(c);
  }

  async function loadEntry(c) {
    let tok = getToken(), d;
    c.loginErr = '';
    try { d = await api(Q_MEDIA, { id: c.alId }, tok); } catch (e) {
      if (!tok || (e.code !== 'token' && e.code !== 'api')) throw e;
      // ask again without the login: if that works, the login is what AniList refuses
      d = await api(Q_MEDIA, { id: c.alId }, '');
      if (e.code === 'api') c.loginErr = e.message;
      tok = '';
    }
    c.media = d.Media;
    c.entry = tok ? (d.Media.mediaListEntry || null) : undefined;
    c.entryAt = Date.now();
    if (tok && !gv('viewer', null)) {
      api(Q_VIEWER, {}, tok).then(v => { sv('viewer', { id: v.Viewer.id, name: v.Viewer.name }); if (sheetOpen) renderSheet(); }).catch(() => {});
    }
    refreshPlan(c);
  }

  function refreshPlan(c) {
    if (c.busy) return;
    if (!c.media) return;
    if (c.synced) return setState(c, 'ok', 'AniList has ch ' + chOf(c));
    if (c.loginErr && getToken()) {
      return setState(c, 'warn', 'AniList did not accept your login (' + c.loginErr + '). Tap Connect AniList to log in again.', 'connect');
    }
    if (!getToken()) {
      return setState(c, 'warn', loginMsg() + (queued(c) ? ' - this chapter is saved for later' : ''), 'connect');
    }
    const plan = makePlan(c, 'auto');
    if (plan.skip) return setState(c, plan.already ? 'ok' : 'idle', plan.skip);
    if (queued(c)) return setState(c, 'warn', 'Saved for later: ' + plan.label.replace(/^\w/, x => x.toLowerCase()), 'queued');
    if (c.autoTried) return setState(c, 'ready', 'Not sent this time - tap Update to send it');
    setState(c, 'ready', cfg.auto ? plan.label + ' at ' + cfg.threshold + '% read' : 'Automatic updates are off - tap to update');
  }

  function setState(c, state, note, why) {
    c.state = state; c.note = note; c.why = why || '';
    if (c === cur) render();
  }

  /* --- how far into the chapter ------------------------------------- */

  function hashRs() {
    const o = {};
    const m = /rs=([^&]*)/.exec(location.hash || '');
    if (m) m[1].split(';').forEach(kv => { const i = kv.indexOf(':'); if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1); });
    return o;
  }

  // This chapter's page pictures. atsu files them in several layouts (/static/pages/<chapterId>/...,
  // /static/pages/<mangaId>/<chapterId>/N.webp, /static/pages/<uuid>/<uuid>...), so they are matched
  // against the chapter's own page list from atsu's API; the chapter id in the address is the fallback.
  function pageImgs(c) {
    const out = [];
    for (const i of document.querySelectorAll('img[src*="/static/pages/"]')) {
      const s = i.getAttribute('src') || '';
      if (c.pageSet ? c.pageSet.has(pagePath(s)) : s.indexOf('/' + c.chapterId + '/') >= 0) out.push(i);
    }
    return out;
  }

  // long strip from the page pictures: same scale as atsu's f (0 top, 1 end)
  function stripFrac(imgs) {
    if (!imgs.length) return null;
    const a = imgs[0].getBoundingClientRect(), b = imgs[imgs.length - 1].getBoundingClientRect();
    const h = b.bottom - a.top, vh = window.innerHeight;
    if (h <= vh * 1.3) return null;   // page mode or a tiny chapter
    return -a.top / (h - vh);
  }

  function scrollFrac() {
    const se = document.scrollingElement || document.documentElement;
    const max = se.scrollHeight - window.innerHeight;
    return max > 0 ? se.scrollTop / max : 0;
  }

  // atsu's own position (the #rs= hash) first; it does not depend on how the pictures are filed
  function measure(c) {
    if (Date.now() - c.openedAt < 1200 || c.number == null) return 0;
    if (c.kind === 'novel') return clamp(scrollFrac());
    // a hash left over from the chapter before means nothing until it changes
    const rs = location.hash === c.staleHash ? {} : hashRs();
    let v = 0, paged = false;
    if (rs.f != null && isFinite(+rs.f)) v = +rs.f;
    if (rs.p != null && isFinite(+rs.p) && c.pages > 0) { v = Math.max(v, (+rs.p + 1) / c.pages); paged = true; }
    if (rs.c === '1') v = 1;
    if (!paged) { const d = stripFrac(pageImgs(c)); if (d != null) v = Math.max(v, d); }
    return clamp(v);
  }
  const clamp = v => Math.min(1, Math.max(0, v || 0));

  /* --- saving -------------------------------------------------------- */

  async function doSync(c, mode, force) {
    if (c.busy) return;
    c.busy = true;
    setState(c, 'busy', 'Updating AniList...');
    try {
      const tok = getToken();
      if (!tok) throw err('token', loginMsg());
      if (mode !== 'auto' || !c.entryAt || Date.now() - c.entryAt > 3 * 60000) {
        const d = await api(Q_MEDIA, { id: c.alId }, tok);
        c.media = d.Media; c.entry = d.Media.mediaListEntry || null; c.entryAt = Date.now();
      }
      const plan = makePlan(c, mode, force);
      if (plan.skip) {
        c.busy = false;
        if (plan.already) { c.synced = true; dropPending(c.alId, chOf(c)); }
        return setState(c, plan.already ? 'ok' : 'idle', plan.skip);
      }
      const before = c.entry ? JSON.parse(JSON.stringify(c.entry)) : null;
      const d = await api(M_SAVE, plan.vars, tok);
      c.entry = d.SaveMediaListEntry;
      c.entryAt = Date.now();
      c.synced = true; c.busy = false;
      dropPending(c.alId, chOf(c));
      const title = titleOf(c);
      sv('undo', { mediaId: c.alId, before, afterId: c.entry.id, changed: Object.keys(plan.vars), title, at: Date.now() });
      setState(c, 'ok', 'AniList: ' + plan.done);
      toast('<b>' + esc(title) + '</b><br>' + esc(plan.done), true);
    } catch (e) {
      c.busy = false;
      if (e.code === 'net' || e.code === 'down' || e.code === 'rate' || e.code === 'token') {
        addPending(c);
        setState(c, 'warn', e.message + ' - ch ' + chOf(c) + ' is saved and goes up later', e.code === 'token' ? 'connect' : 'queued');
        if (mode === 'auto') toast(esc(e.message) + '<br>Chapter ' + chOf(c) + ' is saved and will sync later.');
      } else {
        setState(c, 'err', e.message);
      }
    }
  }

  async function undo() {
    const u = gv('undo', null);
    if (!u) return;
    sv('undo', null);
    hideToast();
    const tok = getToken();
    try {
      let after = null;
      if (!u.before) await api(M_DEL, { id: u.afterId }, tok);
      else {
        const v = { mediaId: u.mediaId, status: u.before.status, progress: u.before.progress || 0 };
        if (u.changed.indexOf('repeat') >= 0) v.repeat = u.before.repeat || 0;
        ['startedAt', 'completedAt'].forEach(k => {
          if (u.changed.indexOf(k) >= 0) v[k] = u.before[k] || { year: null, month: null, day: null };
        });
        after = (await api(M_SAVE, v, tok)).SaveMediaListEntry;
      }
      if (cur && cur.alId === u.mediaId) {
        cur.entry = after; cur.entryAt = Date.now(); cur.synced = false; cur.autoTried = true;
        refreshPlan(cur);
      }
      toast('Undone: ' + esc(u.title) + ' is back as it was.');
    } catch (e) { toast('Undo did not work: ' + esc(e.message)); }
  }

  const titleOf = c => (c.media && c.media.title && c.media.title.userPreferred) || (c.series && c.series.title) || 'This series';

  /* --- chapters saved for later (offline, AniList down, not connected) */

  const pendingList = () => (gv('pending', []) || []).filter(p => Date.now() - p.at < 30 * 86400000);
  const queued = c => c.alId && pendingList().some(p => p.al === c.alId && p.n >= chOf(c));

  function addPending(c) {
    const n = chOf(c);
    if (!c.alId || !(n >= 1)) return;
    const list = pendingList();
    const old = list.find(p => p.al === c.alId);
    if (old) { if (old.n >= n) return; old.n = n; old.at = Date.now(); } else list.push({ al: c.alId, n, title: titleOf(c), at: Date.now() });
    sv('pending', list.slice(-30));
  }
  function dropPending(al, n) { sv('pending', pendingList().filter(p => !(p.al === al && p.n <= n))); }

  let flushing = false;
  async function flushPending(byHand) {
    const tok = getToken();
    const list = pendingList();
    if (flushing || !tok || !list.length) return;
    flushing = true;
    let ok = 0, stop = '';
    for (const p of list.slice(0, 8)) {
      try {
        const d = await api(Q_MEDIA, { id: p.al }, tok);
        const plan = makePlan({ number: p.n, media: d.Media, entry: d.Media.mediaListEntry || null }, 'auto');
        if (!plan.skip) { await api(M_SAVE, plan.vars, tok); ok++; }
        dropPending(p.al, p.n);
      } catch (e) {
        if (['net', 'down', 'rate', 'token'].indexOf(e.code) >= 0) { stop = e.message; break; }
        dropPending(p.al, p.n);
      }
    }
    flushing = false;
    if (ok) toast('Synced ' + ok + ' saved chapter' + (ok > 1 ? 's' : '') + ' to AniList.');
    else if (byHand && stop) toast('Still waiting: ' + esc(stop));
    if (cur && cur.media && !cur.busy) loadEntry(cur).catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /*  Screen: the line, the sheet, toasts                                */
  /* ------------------------------------------------------------------ */

  const COLORS = { load: '#7d8aa3', ready: '#3db4f2', busy: '#3db4f2', ok: '#5fd27a', idle: '#8b93a3', off: '#6b7280', warn: '#f5b041', err: '#ff6b6b' };

  const CSS = `
:host{all:initial}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[hidden]{display:none!important}
.bar{position:fixed;left:0;right:0;bottom:0;height:calc(16px + env(safe-area-inset-bottom,0px));color:var(--c);cursor:pointer;touch-action:manipulation}
.bar.quiet{pointer-events:none}
.track{position:absolute;left:0;right:0;bottom:env(safe-area-inset-bottom,0px);height:4px;background:rgba(140,140,150,.30)}
.peak,.fill{position:absolute;left:0;top:0;bottom:0;width:0;background:currentColor}
.peak{opacity:.35}
.fill{transition:width .12s linear}
.tick{position:absolute;top:-3px;width:2px;height:10px;margin-left:-1px;border-radius:1px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.4)}
.pill{position:absolute;left:8px;bottom:calc(10px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:6px;max-width:calc(50vw - 74px);
 padding:5px 9px 5px 7px;border:1px solid rgba(255,255,255,.13);border-radius:11px;background:rgba(12,14,20,.82);color:#eef2f8;
 font:600 11px/1.15 system-ui,-apple-system,Roboto,sans-serif;white-space:nowrap;transition:opacity .35s}
.pill .txt{overflow:hidden;text-overflow:ellipsis}
.pill .dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--c)}
.pill.dim{opacity:.72}
.quiet .pill{opacity:0}
.busy .dot{animation:pulse 1s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;visibility:hidden;transition:opacity .2s,visibility .2s;touch-action:none}
.sheet{position:fixed;left:0;right:0;bottom:0;margin:0 auto;max-width:520px;max-height:84vh;overflow-y:auto;overscroll-behavior:contain;
 background:#161a23;color:#e7ebf2;border-radius:18px 18px 0 0;padding:10px 16px calc(18px + env(safe-area-inset-bottom,0px));
 font:14px/1.45 system-ui,-apple-system,Roboto,sans-serif;transform:translateY(105%);visibility:hidden;
 transition:transform .22s ease,visibility .22s;box-shadow:0 -12px 40px rgba(0,0,0,.5)}
.open .scrim{opacity:1;visibility:visible}
.open .sheet{transform:none;visibility:visible}
.grip{width:40px;height:4px;border-radius:2px;background:rgba(255,255,255,.2);margin:0 auto 14px}
.head{display:flex;gap:12px;align-items:center}
.cover{flex:none;width:52px;height:74px;border-radius:7px;object-fit:cover;background:#232a3a}
.t1{font-weight:700;font-size:15.5px;line-height:1.3;color:#f3f6fa;text-decoration:none;display:block}
.muted{color:#98a2b3;font-size:12.5px}
.grow{flex:1;min-width:0}
.link{background:none;border:0;padding:0;color:#3db4f2;font:600 12.5px system-ui,sans-serif;cursor:pointer}
.info{margin:14px 0 4px;border-top:1px solid rgba(255,255,255,.07)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.07)}
.row .k{color:#98a2b3}
.row .v{text-align:right;font-weight:600}
.note{margin:10px 0 0;padding:9px 11px;border-radius:10px;background:rgba(255,255,255,.05);border-left:3px solid var(--c);font-size:13px}
.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:46px;margin-top:10px;border:0;border-radius:12px;
 background:#3db4f2;color:#08131c;font:700 15px system-ui,-apple-system,Roboto,sans-serif;cursor:pointer;text-decoration:none;text-align:center;padding:0 12px}
.btn.sec{background:rgba(255,255,255,.08);color:#e7ebf2}
.btn.ok{background:#5fd27a}
.btn[disabled]{opacity:.55;cursor:default}
.two{display:flex;gap:8px}.two .btn{flex:1}
h3{margin:18px 0 4px;font:700 12px system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#98a2b3}
label.sw{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.07);cursor:pointer}
label.sw input{appearance:none;-webkit-appearance:none;flex:none;width:44px;height:26px;border-radius:13px;background:#3a4252;position:relative;transition:background .15s;margin:0}
label.sw input::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s}
label.sw input:checked{background:#3db4f2}
label.sw input:checked::after{transform:translateX(18px)}
input[type=range]{width:100%;accent-color:#3db4f2;margin:8px 0 2px}
input.text{width:100%;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#0f1218;color:#e7ebf2;font:15px system-ui,sans-serif}
.res{display:flex;gap:10px;align-items:center;width:100%;padding:8px;margin-top:6px;border:1px solid rgba(255,255,255,.07);border-radius:10px;background:rgba(255,255,255,.03);color:inherit;text-align:left;font:inherit;cursor:pointer}
.res img{flex:none;width:38px;height:54px;border-radius:5px;object-fit:cover;background:#232a3a}
.res.on{border-color:#3db4f2}
ol{margin:8px 0 0;padding-left:20px}ol li{margin:6px 0}
code{background:#0f1218;border-radius:6px;padding:2px 6px;font-size:12.5px;word-break:break-all}
.foot{margin-top:16px;text-align:center;color:#6b7383;font-size:11.5px}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(58px + env(safe-area-inset-bottom,0px));width:max-content;max-width:calc(100vw - 32px);
 display:flex;align-items:center;gap:12px;padding:10px 12px 10px 14px;border-radius:12px;background:#1d2330;color:#eef2f8;border:1px solid rgba(255,255,255,.1);
 font:13.5px/1.35 system-ui,-apple-system,Roboto,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45)}
.toast .btn{width:auto;min-height:34px;margin:0;padding:0 12px;font-size:13px;flex:none}
`;

  let host = null, root = null, el = {};
  let view = 'main', sheetOpen = false, lastPillText = '', dimTimer = 0, searchRes = null, searchText = '';

  function ensureUi() {
    const parent = (document.fullscreenElement && document.fullscreenElement !== document.documentElement)
      ? document.fullscreenElement : document.body;
    if (host) { if (host.parentNode !== parent) parent.appendChild(host); return; }
    host = document.createElement('atsu-anilist-sync');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + CSS + '</style>' +
      '<div class="bar" hidden><div class="track"><div class="peak"></div><div class="fill"></div><div class="tick"></div></div>' +
      '<div class="pill"><span class="dot"></span><span class="txt"></span></div></div>' +
      '<div class="wrap"><div class="scrim"></div><div class="sheet" role="dialog" aria-label="AniList sync"></div></div>' +
      '<div class="toast" hidden></div>';
    ['bar', 'peak', 'fill', 'tick', 'pill', 'wrap', 'scrim', 'sheet', 'toast'].forEach(k => { el[k] = root.querySelector('.' + k); });
    el.txt = el.pill.querySelector('.txt');
    // keep taps and keys inside our panel away from the reader
    ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'wheel']
      .forEach(t => host.addEventListener(t, e => e.stopPropagation(), { passive: true }));
    el.bar.addEventListener('click', () => openSheet());
    el.scrim.addEventListener('click', closeSheet);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    root.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.classList.contains('q')) runSearch(e.target.value);
      if (e.key === 'Escape') closeSheet();
    });
    parent.appendChild(host);
  }

  function pillText(c, pct) {
    const n = chOf(c);
    const pr = c.entry ? c.entry.progress || 0 : 0;
    switch (c.state) {
      case 'load': return pct + '%';
      case 'busy': return 'AL…';
      case 'ok': return '✓ AL ' + (c.entry ? c.entry.progress : n);
      case 'ready': return pct + '% · AL ' + (c.entry ? pr + '→' + n : '+' + n);
      case 'idle': return pct + '% · ' + (c.entry && c.entry.status === 'COMPLETED' ? 'AL done' : 'AL —');
      case 'off': return pct + '% · AL off';
      case 'warn': return c.why === 'connect' ? '! Connect AL' : c.why === 'match' ? '! Pick match' : '⏳ AL ' + n;
      default: return '! AL error';
    }
  }

  function render() {
    ensureUi();
    const c = cur;
    el.bar.hidden = !c;
    if (c) {
      const color = COLORS[c.state] || COLORS.load;
      el.bar.style.setProperty('--c', color);
      el.bar.classList.toggle('busy', c.state === 'busy');
      el.fill.style.width = (c.pct * 100).toFixed(2) + '%';
      el.peak.style.width = (c.peak * 100).toFixed(2) + '%';
      el.tick.style.left = cfg.threshold + '%';
      el.tick.hidden = c.synced || c.state === 'off';
      const t = pillText(c, Math.round(c.pct * 100));
      if (t !== lastPillText) {
        el.txt.textContent = t; lastPillText = t;
        el.pill.classList.remove('dim');
        clearTimeout(dimTimer);
        dimTimer = setTimeout(() => el.pill.classList.add('dim'), 2500);
      }
    }
    if (sheetOpen && view === 'main') renderSheet();
  }

  // atsu's own floating buttons (bottom row) win while they are showing;
  // buttons in the page itself (comments etc.) scrolling past do not count
  function floating(b) {
    for (let p = b, i = 0; p && p !== document.body && i < 8; p = p.parentElement, i++) {
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }
  function quietCheck() {
    if (!el.bar || el.bar.hidden) return;
    let up = false;
    const y = window.innerHeight - 18;
    for (const x of [22, 60, window.innerWidth / 2]) {
      for (const e of document.elementsFromPoint(x, y)) {
        if (e === host) continue;
        const b = e.closest && e.closest('button,a,[role=button]');
        if (!b) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 260 && r.height < 90 && +getComputedStyle(b).opacity > 0.3 && floating(b)) { up = true; break; }
      }
      if (up) break;
    }
    el.bar.classList.toggle('quiet', up && !sheetOpen);
  }

  /* --- the sheet ------------------------------------------------------ */

  function openSheet(v) {
    ensureUi();
    view = v || (cur && cur.why === 'connect' ? 'connect' : cur && cur.why === 'match' ? 'match' : 'main');
    sheetOpen = true;
    renderSheet();
    el.wrap.classList.add('open');
    el.bar.classList.remove('quiet');
    if (view === 'match' && !searchRes && cur && cur.series) runSearch(cur.series.title);
  }
  function closeSheet() { sheetOpen = false; el.wrap.classList.remove('open'); }

  function renderSheet() {
    const html = view === 'connect' ? connectView() : view === 'match' ? matchView() : mainView();
    el.sheet.innerHTML = '<div class="grip"></div>' + html + '<div class="foot">Atsu → AniList Sync ' + VERSION + '</div>';
  }

  function mainView() {
    const c = cur;
    let h = '';
    if (!c) {
      h += '<div class="t1">Open a chapter to track it</div><div class="muted">The line shows up at the bottom of the reader.</div>';
    } else {
      const m = c.media;
      const color = COLORS[c.state] || COLORS.load;
      h += '<div class="head">';
      h += m && m.coverImage ? '<img class="cover" src="' + esc(m.coverImage.medium) + '" alt="">' : '<div class="cover"></div>';
      h += '<div class="grow">';
      if (m) {
        h += '<a class="t1" href="' + esc(m.siteUrl) + '" target="_blank" rel="noopener">' + esc(titleOf(c)) + '</a>';
        h += '<div class="muted">' + esc([kindOf(m), m.chapters ? m.chapters + ' chapters' : 'ongoing', 'matched by ' + c.how]
          .filter(Boolean).join(' · ')) + '</div>';
      } else {
        h += '<div class="t1">' + esc(c.series ? c.series.title : 'Loading...') + '</div>';
        h += '<div class="muted">' + (c.alId ? 'Loading AniList...' : 'Not matched to AniList yet') + '</div>';
      }
      if (c.series) h += '<button class="link" data-act="match">' + (c.alId ? 'Change match' : 'Pick the AniList entry') + '</button>';
      h += '</div></div>';

      const e = c.entry;
      h += '<div class="info">';
      h += '<div class="row"><span class="k">Reading</span><span class="v">' + esc(c.chTitle || 'Chapter ' + fmtNum(c.number)) +
        ' · ' + Math.round(c.peak * 100) + '%</span></div>';
      h += '<div class="row"><span class="k">Your AniList</span><span class="v">' +
        (e === undefined ? (c.loginErr ? 'login not accepted' : getToken() ? '...' : 'not connected') : e === null ? 'not on your list'
          : esc(STATUS[e.status] || e.status) + ' · ch ' + (e.progress || 0) + (m && m.chapters ? ' / ' + m.chapters : '')) + '</span></div>';
      h += '</div>';
      h += '<div class="note" style="--c:' + color + '">' + esc(c.note || '') + '</div>';
      h += mainButtons(c);
    }
    const pend = pendingList();
    if (pend.length) {
      h += '<h3>Saved for later</h3><div class="muted">' + pend.map(p => esc(p.title) + ' ch ' + p.n).join('<br>') + '</div>';
      if (getToken()) h += '<button class="btn sec" data-act="flush">Sync these now</button>';
    }
    h += '<h3>Settings</h3>';
    h += '<div class="row" style="display:block"><div style="display:flex;justify-content:space-between"><span>Update at</span><b class="thr">' +
      cfg.threshold + '% read</b></div><input type="range" min="50" max="100" step="5" value="' + cfg.threshold + '" data-set="threshold"></div>';
    h += sw('auto', 'Update AniList by itself');
    h += sw('addNew', 'Add series that are not on my list');
    h += sw('finish', 'Mark Completed at the last chapter');
    h += '<h3>AniList account</h3>';
    const who = gv('viewer', null);
    if (getToken()) {
      h += '<div class="row"><span>' + (who ? 'Signed in as <b>' + esc(who.name) + '</b>' : 'Connected') + '</span>' +
        '<button class="link" data-act="logout">Disconnect</button></div>';
    } else {
      h += '<div class="muted">' + esc(loginMsg()) + '.</div><button class="btn" data-act="connect">Connect AniList</button>';
    }
    return h;
  }

  // AniList calls manhwa / manhua "MANGA" and keeps the country apart
  function kindOf(m) {
    if (m.format === 'MANGA') return { KR: 'Manhwa', CN: 'Manhua', TW: 'Manhua' }[m.countryOfOrigin] || 'Manga';
    return m.format ? m.format.replace('_', ' ').toLowerCase().replace(/^\w/, x => x.toUpperCase()) : '';
  }

  function sw(k, label) {
    return '<label class="sw"><span>' + label + '</span><input type="checkbox" data-set="' + k + '"' + (cfg[k] ? ' checked' : '') + '></label>';
  }

  function mainButtons(c) {
    if (!c.media) {
      return c.series && !c.alId && c.state !== 'off' ? '<button class="btn" data-act="match">Pick the AniList entry</button>' : '';
    }
    if (!getToken() || c.loginErr) return '<button class="btn" data-act="connect">Connect AniList</button>';
    if (c.busy) return '<button class="btn" disabled>Updating...</button>';
    const u = gv('undo', null);
    const canUndo = u && u.mediaId === c.alId && Date.now() - u.at < 15 * 60000;
    if (c.synced && canUndo) {
      return '<div class="two"><button class="btn ok" disabled>✓ Updated</button><button class="btn sec" data-act="undo">Undo</button></div>';
    }
    const plan = makePlan(c, 'manual');
    let h = '';
    if (plan.skip) {
      h += '<button class="btn ok" disabled>' + esc(plan.skip) + '</button>';
      if (plan.lower) h += '<button class="btn sec" data-act="set">Set AniList to ch ' + chOf(c) + ' anyway</button>';
    } else {
      h += '<button class="btn" data-act="sync">' + esc(plan.label) + '</button>';
    }
    return h;
  }

  function matchView() {
    const s = cur && cur.series;
    if (!s) { view = 'main'; return mainView(); }
    let h = '<div class="t1">Which AniList entry is this?</div><div class="muted">' + esc(s.title) + ' on atsu.moe</div>';
    h += '<div class="two" style="margin-top:10px"><input class="text q" type="search" value="' + esc(searchText || s.title) +
      '" placeholder="Search AniList" enterkeyhint="search"><button class="btn" style="width:auto;margin:0;flex:none" data-act="search">Search</button></div>';
    if (searchRes === 'busy') h += '<div class="muted" style="margin-top:10px">Searching...</div>';
    else if (typeof searchRes === 'string') h += '<div class="note" style="--c:#ff6b6b">' + esc(searchRes) + '</div>';
    else if (searchRes) {
      if (!searchRes.length) h += '<div class="muted" style="margin-top:10px">Nothing found - try another name.</div>';
      searchRes.forEach(m => {
        h += '<button class="res' + (cur.alId === m.id ? ' on' : '') + '" data-act="pick" data-id="' + m.id + '">' +
          '<img src="' + esc(m.coverImage && m.coverImage.medium) + '" alt=""><span class="grow"><b>' + esc(m.title.userPreferred) + '</b><br>' +
          '<span class="muted">' + esc([kindOf(m), m.startDate && m.startDate.year, m.chapters ? m.chapters + ' ch' : ''].filter(Boolean).join(' · ')) +
          '</span></span></button>';
      });
    }
    if (s.al) h += '<button class="btn sec" data-act="atsumatch">Use atsu.moe\'s own match</button>';
    h += '<div class="two"><button class="btn sec" data-act="notrack">Don\'t track this series</button><button class="btn sec" data-act="back">Back</button></div>';
    return h;
  }

  function connectView() {
    const id = gv('clientId', '');
    let h = '<div class="t1">Connect AniList</div><div class="muted">One time - the login lasts a year.</div>';
    if (cur && cur.why === 'connect' && cur.note) h += '<div class="note" style="--c:' + COLORS.warn + '">' + esc(cur.note) + '</div>';
    h += '<ol><li>Open <a class="link" href="' + DEV + '" target="_blank" rel="noopener">AniList developer settings</a> and tap <b>Create New Client</b>.</li>' +
      '<li>Name: anything (for example <code>atsu sync</code>).<br>Redirect URL: <code>' + PIN + '</code> ' +
      '<button class="link" data-act="copy">Copy</button></li>' +
      '<li>Save, then copy the <b>Client ID</b> (a number) into this box:</li></ol>';
    h += '<input class="text cid" inputmode="numeric" placeholder="Client ID" value="' + esc(id) + '">';
    h += '<button class="btn" data-act="go">Connect</button>';
    h += '<div class="muted" style="margin-top:10px">AniList asks you to approve, then shows a "Back to atsu.moe" button. ' +
      'If it shows only a long token instead, copy it and paste it below.</div>';
    h += '<h3>Or paste a token</h3><input class="text tok" placeholder="AniList access token">' +
      '<button class="btn sec" data-act="savetok">Save token</button>';
    h += '<button class="btn sec" data-act="back">Back</button>';
    return h;
  }

  async function runSearch(text) {
    searchText = text;
    searchRes = 'busy'; renderSheet();
    try { searchRes = await searchAl(text); } catch (e) { searchRes = e.message; }
    if (sheetOpen && view === 'match') renderSheet();
  }

  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, c = cur;
    switch (act) {
      case 'sync': if (c) doSync(c, 'manual').then(renderSheet); break;
      case 'set': if (c) doSync(c, 'manual', 'set').then(renderSheet); break;
      case 'undo': undo().then(renderSheet); break;
      case 'match': view = 'match'; searchRes = null; searchText = ''; renderSheet(); if (c && c.series) runSearch(c.series.title); return;
      case 'search': runSearch(root.querySelector('.q').value); return;
      case 'pick': setMatch(+b.dataset.id); return;
      case 'atsumatch': setMatch(0); return;
      case 'notrack': setMatch(-1); return;
      case 'back': view = 'main'; break;
      case 'connect': view = 'connect'; break;
      case 'copy': copyText(PIN, b); return;
      case 'go': {
        const v = root.querySelector('.cid').value.trim();
        if (/^\d+$/.test(v)) startConnect(v); else toast('The Client ID is the number AniList shows for your client.');
        return;
      }
      case 'savetok':
        if (saveToken(root.querySelector('.tok').value)) {
          toast('Token saved.'); view = 'main';
          if (c && c.media) loadEntry(c).catch(() => {});
          flushPending(true);
        } else toast('That does not look like an AniList token.');
        break;
      case 'logout': sv('token', ''); sv('viewer', null); if (c && c.media) { c.entry = undefined; refreshPlan(c); } break;
      case 'flush': flushPending(true); break;
    }
    renderSheet();
  }

  function setMatch(id) {
    const c = cur;
    if (!c || !c.series) return;
    const map = gv('map', {}) || {};
    if (id) map[c.series.id] = id; else delete map[c.series.id];
    sv('map', map);
    const f = gv('found', {}) || {};
    delete f[c.series.id]; sv('found', f);
    Object.assign(c, { alId: 0, media: null, entry: undefined, synced: false, autoTried: false });
    view = 'main'; searchRes = null;
    matchAndLoad(c).catch(e => setState(c, 'err', e.message));
    renderSheet();
  }

  function onChange(e) {
    const k = e.target.dataset && e.target.dataset.set;
    if (!k) return;
    if (k === 'threshold') cfg.threshold = +e.target.value; else cfg[k] = !!e.target.checked;
    saveCfg();
    if (cur && cur.media) refreshPlan(cur); else render();
  }
  function onInput(e) {
    if (e.target.dataset && e.target.dataset.set === 'threshold') {
      const t = root.querySelector('.thr');
      if (t) t.textContent = e.target.value + '% read';
    }
  }

  function copyText(t, btn) {
    const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => toast(esc(t)));
    else toast(esc(t));
  }

  let toastTimer = 0;
  function toast(html, withUndo) {
    ensureUi();
    el.toast.innerHTML = '<span>' + html + '</span>' + (withUndo ? '<button class="btn sec">Undo</button>' : '');
    el.toast.hidden = false;
    if (withUndo) el.toast.querySelector('button').addEventListener('click', () => undo().then(() => { if (sheetOpen) renderSheet(); }));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, withUndo ? 7000 : 4500);
  }
  function hideToast() { if (el.toast) el.toast.hidden = true; }

  /* ------------------------------------------------------------------ */
  /*  Main loop                                                          */
  /* ------------------------------------------------------------------ */

  function tick() {
    if (document.hidden) return;
    const p = parsePath();
    if (!p) { if (cur) { cur = null; seq++; render(); } return; }
    if (!cur || cur.key !== p.key) openChapter(p);
    const c = cur;
    const v = measure(c);
    if (Math.abs(v - c.pct) > 0.001 || v > c.peak) {
      c.pct = v; c.peak = Math.max(c.peak, v);
      render();
    }
    if (cfg.auto && !c.autoTried && !c.synced && !c.busy && c.media && c.peak * 100 + 1e-9 >= cfg.threshold) {
      c.autoTried = true;
      if (getToken()) doSync(c, 'auto');
      else { addPending(c); refreshPlan(c); }
    }
    ensureUi();
    quietCheck();
  }

  ensureUi();
  setInterval(tick, 400);
  window.addEventListener('scroll', () => { if (cur) requestAnimationFrame(tick); }, { passive: true });
  window.addEventListener('hashchange', tick);
  document.addEventListener('fullscreenchange', () => { ensureUi(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flushPending(false); });
  window.addEventListener('online', () => flushPending(false));
  setInterval(() => flushPending(false), 2 * 60000);
  setTimeout(() => flushPending(false), 3000);
  tick();

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('AniList sync: open panel', () => openSheet('main'));
    GM_registerMenuCommand('AniList sync: send saved chapters now', () => flushPending(true));
  }
})();
