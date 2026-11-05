// ==UserScript==
// @name         Atsu Voice Reader
// @namespace    https://github.com/YoruCAnime/Anime-site-scripts
// @version      0.6.3
// @description  Reads atsu.moe's speech bubbles aloud in natural voices (a woman's voice for female characters, a man's for male ones; the female voice when unsure). Sound effects, titles and credits are skipped. The whole chapter is got ready ahead (a thin bar on the Voice button shows how far). Works with atsu's own auto-scroll (K) or your own scrolling: auto-scroll pauses while a bubble is read, then carries on. V = on / off (off at first), B = the other voice for the line just read; the violet button = volume, speed, auto-scroll pausing and "My voice" (made with Voice Maker from your own clips). Needs the Atsu Voice Reader helper running on this PC.
// @author       YoruCAnime
// @updateURL    https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/voice-reader/atsu-voice-reader.user.js
// @downloadURL  https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/voice-reader/atsu-voice-reader.user.js
// @match        https://atsu.moe/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const HELPER = 'http://127.0.0.1:8795';
  const LINE = 0.62;            // a bubble is read once its middle comes up to this far down the screen
  const AHEAD = 3;              // lines made ready before they are needed

  let on = !!GM_getValue('on', false);
  let chap = null;              // {mangaId, chapterId, pages: [{image, ...}], bubbles: {page: [...]}, asked: Set}
  let queue = [];               // every bubble of the chapter in reading order: {page, i, text, box, voice}
  let pos = 0;                  // the next bubble to read
  let speaking = null;          // {b, audio}
  let lastRead = null;
  const audio = new Map();      // key -> Promise<blob url>
  const flips = JSON.parse(GM_getValue('flips', '{}'));   // "chapter:page:i" -> 'F' | 'M'
  const S = Object.assign({ volume: 0.9, rate: 1, pauseAuto: true, ownF: true, ownM: true, rest: true }, JSON.parse(GM_getValue('settings', '{}')));
  const code = (v) => v + (S['own' + v] ? 'O' : '');   // F / M = the built-in voices, FO / MO = "My voice"
  const saveS = () => GM_setValue('settings', JSON.stringify(S));
  let prog = null;              // how far the helper has got this chapter ready: {pages, pagesDone, lines, linesDone, ready}
  let blocked = false;          // the browser wants a click before it lets a page play sound

  // ---------- the helper ----------
  function call(method, path, body, type) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method, url: HELPER + path, timeout: 60000, responseType: type || 'json',
      headers: body ? { 'Content-Type': 'application/json' } : {}, data: body ? JSON.stringify(body) : undefined,
      onload: (r) => (r.status >= 200 && r.status < 300 ? res(r.response) : rej(new Error('helper ' + r.status))),
      onerror: () => rej(new Error('helper not running')), ontimeout: () => rej(new Error('helper timed out')),
    }));
  }
  let helperDown = 0;
  function helperProblem(e) {
    if (Date.now() - helperDown > 60000) toast("The voice reader's helper isn't running on this PC");
    helperDown = Date.now();
    console.debug('[voice reader]', e);
  }

  // ---------- this chapter ----------
  const ids = () => { const m = /^\/read\/([^/]+)\/([^/#?]+)/.exec(location.pathname); return m ? { mangaId: m[1], chapterId: m[2] } : null; };
  const pageImgs = () => [...document.querySelectorAll('img[src*="/static/pages/"]')];

  async function startChapter() {
    const id = ids();
    if (!id) return;
    chap = { ...id, pages: null, bubbles: {}, asked: new Set() };
    queue = []; pos = 0; stopSpeaking(); audio.clear(); prog = null; wasReady = false;
    try {
      const r = await fetch(`/api/read/chapter?mangaId=${encodeURIComponent(id.mangaId)}&chapterId=${encodeURIComponent(id.chapterId)}`);
      const j = await r.json();
      if (!chap || chap.chapterId !== id.chapterId) return;
      chap.pages = j.readChapter.pages;
      chap.title = document.title.replace(/\s+-\s+(Chapter|Episode).*$/i, '');
      await postChapter();
    } catch (e) { helperProblem(e); }
  }

  const postChapter = () => call('POST', '/chapter', { mangaId: chap.mangaId, chapterId: chap.chapterId, title: chap.title || '', page: currentPage(), own: { F: S.ownF, M: S.ownM }, rest: S.rest });
  let progT = 0, placeT = 0, wasReady = false;
  async function pollProgress() {
    if (!chap || !chap.pages || Date.now() - progT < (prog && prog.ready && prog.chapterId === chap.chapterId ? 20000 : 1500)) return;
    progT = Date.now();
    const c = chap;
    if (prog && !prog.ready && Date.now() - placeT > 8000) {     // tell the helper where you are: it makes the lines near you first
      placeT = Date.now();
      postChapter().catch(() => {});
    }
    try {
      const r = await call('GET', `/progress?chapterId=${encodeURIComponent(c.chapterId)}`);
      if (chap !== c) return;
      prog = { ...r, chapterId: c.chapterId };
      if (prog.ready && !wasReady) toast('Voices ready for this chapter');
      wasReady = prog.ready;
    } catch (e) {
      if (/404/.test(String(e && e.message))) postChapter().catch(() => {});   // the helper was restarted: ask again
    }
  }

  // the page images on screen, by page number (matched by file name)
  function imgFor(i) {
    const p = chap && chap.pages && chap.pages[i];
    if (!p) return null;
    const file = p.image.split('/').pop();
    return pageImgs().find((im) => im.src.includes(file)) || null;
  }
  function currentPage() {
    if (!chap || !chap.pages) return 0;
    let best = 0;
    chap.pages.forEach((p, i) => { const im = imgFor(i); if (im && im.getBoundingClientRect().top < innerHeight * LINE) best = i; });
    return best;
  }

  async function loadBubbles(i, cur) {
    if (!chap || chap.bubbles[i] || chap.asked.has(i)) return;
    chap.asked.add(i);
    try {
      const r = await call('GET', `/bubbles?chapterId=${encodeURIComponent(chap.chapterId)}&page=${i}`);
      if (r.state === 'ready') {
        chap.bubbles[i] = r;
        const add = r.bubbles.map((b, k) => ({ page: i, i: k, text: b.text, box: b.box, w: r.w, voice: flips[`${chap.chapterId}:${i}:${b.text}`] || b.voice }));
        const at = queue[pos];                                // keep the place: bubbles of an earlier page arriving late
        queue = queue.concat(add).sort((a, b) => a.page - b.page || a.i - b.i);   // must not send it back
        pos = at ? queue.indexOf(at) : (pos >= queue.length - add.length ? queue.length - add.length : pos);
        if (at == null && i < cur) pos = queue.findIndex((b) => b.page > i) >= 0 ? queue.findIndex((b) => b.page > i) : queue.length;
      } else {
        setTimeout(() => chap && chap.asked.delete(i), 1500);   // still being read: ask again soon
      }
    } catch (e) { chap.asked.delete(i); helperProblem(e); }
  }

  // where a bubble is on screen now
  function rect(b) {
    const im = imgFor(b.page);
    if (!im) return null;
    const r = im.getBoundingClientRect(), s = r.width / b.w;
    return { left: r.left + b.box[0] * s, top: r.top + b.box[1] * s, right: r.left + b.box[2] * s, bottom: r.top + b.box[3] * s };
  }

  // ---------- voices ----------
  const key = (b) => `${code(b.voice)}|${b.text}`;
  function line(b, now) {
    const k = key(b);
    if (!audio.has(k)) {
      audio.set(k, call('GET', `/speak?voice=${code(b.voice)}&text=${encodeURIComponent(b.text)}${now ? '&now=1' : ''}`, null, 'blob').then((blob) => URL.createObjectURL(blob)));
      audio.get(k).catch(() => audio.delete(k));
    }
    return audio.get(k);
  }
  async function speak(b) {
    stopSpeaking();
    const me = { b, audio: null };
    speaking = me; lastRead = b;
    highlight(b);
    pauseAuto();
    const now = line(b, true);                                 // this line first...
    if (prog && prog.ready) for (let j = 0; j < AHEAD; j++) if (queue[pos + j]) line(queue[pos + j]);   // ...then the next ones (pos is already past b; while the chapter is being got ready the helper makes them)
    try {
      const url = await now;
      if (speaking !== me) return;
      const a = new Audio(url);
      a.volume = S.volume; a.playbackRate = S.rate; a.preservesPitch = true;
      me.audio = a;
      a.onended = a.onerror = () => { if (speaking === me) { speaking = null; highlight(null); } };
      await a.play();
    } catch (e) {
      if (speaking === me) { speaking = null; highlight(null); }
      if (e && e.name === 'NotAllowedError') {                 // no click on the page yet: read it again after one
        blocked = true;
        const k = queue.indexOf(b); if (k >= 0) pos = k;
        resumeAuto();
        toast('Click the page once so the voice is allowed to play');
      } else helperProblem(e);
    }
  }
  let keep = null;
  function keepAwake(want) {
    try {
      if (want) {
        if (!keep) {
          keep = new AudioContext();
          const src = keep.createConstantSource(), g = keep.createGain();
          g.gain.value = 0.0001;                              // far below hearing: only keeps the line open
          src.connect(g).connect(keep.destination); src.start();
        }
        if (keep.state === 'suspended') keep.resume().catch(() => {});
      } else if (keep) { keep.close().catch(() => {}); keep = null; }
    } catch (e) {}
  }
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, (e) => { if (e.isTrusted && on) keepAwake(true); }, true);
  function stopSpeaking() {
    if (speaking && speaking.audio) { speaking.audio.pause(); }
    speaking = null; highlight(null);
  }

  // ---------- atsu's own auto-scroll (K, or its play button bottom left) ----------
  // its button says which: "Pause auto scroll" while it runs, "Start auto scroll" while it is stopped. Only that button
  // is pressed, and only to stop the scrolling for a line and start it again after one: it is never started otherwise.
  const autoBtn = (word) => document.querySelector(`button[aria-label="${word} auto scroll"]`);
  const autoRunning = () => !!autoBtn('Pause');
  let pausedByUs = false;
  function pauseAuto() {
    const b = S.pauseAuto && !pausedByUs && autoBtn('Pause');
    if (b) { b.click(); pausedByUs = true; }
  }
  function resumeAuto() {
    if (!pausedByUs) return;
    pausedByUs = false;
    const b = autoBtn('Start');
    if (b) b.click();
  }
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, (e) => { if (e.isTrusted) blocked = false; }, true);
  // K while a line holds the scrolling: you want it stopped (it looks as if it runs), so it stays stopped - atsu
  // would have started it again
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted || !pausedByUs || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || (e.key !== 'k' && e.key !== 'K')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    pausedByUs = false;
    toast('Auto-scroll stopped');
  }, true);

  // ---------- the loop ----------
  function tick() {
    if (!on || !ids()) return;
    if (!chap || chap.chapterId !== ids().chapterId) { startChapter(); return; }
    if (!chap.pages) return;
    pollProgress();
    if (pausedByUs && autoRunning()) pausedByUs = false;      // you started it again yourself (K / its button)
    const cur = currentPage();
    for (let i = cur; i <= cur + 2 && i < chap.pages.length; i++) loadBubbles(i, cur);
    if (speaking) { highlight(speaking.b); return; }
    if (blocked) return;
    // skip what has already gone up off the screen, but not the panel we come back up to: the right column was read down
    // to its end, and the left column's first bubble has just left the top
    const cameBack = (x, r) => lastRead && lastRead.page === x.page && x.box[3] < lastRead.box[1] && r && r.bottom > -innerHeight * 1.2;
    while (pos < queue.length) {
      const r = rect(queue[pos]);
      if (r && r.bottom < 0 && !cameBack(queue[pos], r)) pos++; else break;
    }
    const b = queue[pos];
    const r = b && rect(b);
    const after = queue[pos + 1];
    const goesBackUp = b && after && after.page === b.page && after.box[3] < b.box[1];   // the next line is higher up: don't let that one leave the screen
    // the coming lines get made before they reach the reading line, so they start at once
    if (prog && prog.ready) for (let j = 0; j < AHEAD; j++) {
      const n = queue[pos + j], nr = n && rect(n);
      if (nr && nr.top < innerHeight * 2.5) line(n);
    }
    if (b && r && (cameBack(b, r) || (r.bottom > 0 && ((r.top + r.bottom) / 2 <= innerHeight * LINE || (goesBackUp && r.bottom <= innerHeight * 0.96))))) {
      pos++; speak(b);
    } else if (pausedByUs) {
      resumeAuto();                                           // nothing to read just here: let it scroll on
    }
  }
  setInterval(tick, 250);
  // what it is doing, for checking (open the console: avrState())
  window.avrState = () => ({ on, chapter: chap && chap.chapterId, pages: chap && chap.pages && chap.pages.length,
    loaded: chap ? Object.keys(chap.bubbles) : [], asked: chap ? [...chap.asked] : [], queued: queue.length, pos,
    speaking: speaking && speaking.b.text, last: lastRead && { text: lastRead.text, voice: lastRead.voice }, autoRunning: autoRunning(), pausedByUs, blocked, prog, settings: S, current: chap && chap.pages ? currentPage() : null });

  // ---------- highlight, pill, note ----------
  let hl = null;
  function highlight(b) {
    if (!hl) { hl = document.createElement('div'); hl.id = 'avr-hl'; document.body.appendChild(hl); }
    const r = b && rect(b);
    if (!r) { hl.style.display = 'none'; return; }
    Object.assign(hl.style, { display: 'block', left: `${r.left - 10}px`, top: `${r.top - 8}px`, width: `${r.right - r.left + 20}px`, height: `${r.bottom - r.top + 16}px` });
    hl.dataset.voice = b.voice;
  }
  const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props || {}); e.append(...kids); return e; };
  let box = null, pill = null, label = null, bar = null, panel = null, icon = null, iconOn = null;
  const SVG = 'http://www.w3.org/2000/svg';
  function drawIcon(onNow) {                                    // a speaker, with sound waves when on and a cross when off
    if (iconOn === onNow) return;
    iconOn = onNow; icon.replaceChildren();
    const path = (d, fill) => { const e = document.createElementNS(SVG, 'path'); e.setAttribute('d', d);
      e.setAttribute('fill', fill ? 'currentColor' : 'none'); e.setAttribute('stroke', 'currentColor'); e.setAttribute('stroke-width', fill ? '0' : '2');
      e.setAttribute('stroke-linecap', 'round'); icon.appendChild(e); };
    path('M3 9.5v5h4l5 4v-13l-5 4z', true);
    if (onNow) { path('M15.5 9a4 4 0 0 1 0 6'); path('M18 6.5a7.5 7.5 0 0 1 0 11'); } else { path('M16 9.5l5 5'); path('M21 9.5l-5 5'); }
  }
  function build() {
    const gear = el('button', { id: 'avr-gear', type: 'button', title: 'Voice reader settings', textContent: '⚙' });
    label = el('span', { id: 'avr-label' }); bar = el('i', { id: 'avr-bar' });
    icon = document.createElementNS(SVG, 'svg'); icon.setAttribute('viewBox', '0 0 24 24');
    pill = el('button', { id: 'avr-pill', type: 'button' }, icon, label, bar);
    pill.addEventListener('click', toggle);
    const val = {};
    const slider = (k, name, min, max, step, show) => {
      const v = el('b'); val[k] = () => { v.textContent = show(S[k]); };
      const r = el('input', { type: 'range', min, max, step, value: Math.round(S[k] * 100) });
      r.addEventListener('input', () => { S[k] = r.value / 100; val[k](); saveS(); if (speaking && speaking.audio) { speaking.audio.volume = S.volume; speaking.audio.playbackRate = S.rate; } });
      r.addEventListener('change', () => r.blur());
      val[k]();
      return el('label', {}, el('span', { textContent: name }), v, r);
    };
    // which voice: the built-in one, or "My voice" (Voice Maker)
    const pickers = {};
    const picker = (v, name, builtIn) => {
      const sel = el('select', {}, el('option', { value: '0', textContent: builtIn }), el('option', { value: '1', textContent: 'My voice' }));
      sel.value = S['own' + v] ? '1' : '0';
      sel.addEventListener('change', () => {
        S['own' + v] = sel.value === '1'; saveS(); sel.blur();
        audio.clear(); prog = null; wasReady = false;            // the chapter is got ready again in that voice
        if (chap && chap.pages) postChapter().catch(helperProblem);
      });
      pickers[v] = sel;
      return el('label', { className: 'avr-sel' }, el('span', { textContent: name }), sel);
    };
    const restChk = el('input', { type: 'checkbox', checked: S.rest });
    restChk.addEventListener('change', () => { S.rest = restChk.checked; saveS(); restChk.blur(); if (chap && chap.pages) postChapter().catch(helperProblem); });
    const chk = el('input', { type: 'checkbox', checked: S.pauseAuto });
    chk.addEventListener('change', () => { S.pauseAuto = chk.checked; saveS(); if (!S.pauseAuto) resumeAuto(); chk.blur(); });
    panel = el('div', { id: 'avr-panel', hidden: true },
      el('div', { className: 'avr-h', textContent: 'Voice reader' }),
      slider('volume', 'Volume', 0, 100, 1, (x) => `${Math.round(x * 100)}%`),
      slider('rate', 'Speed', 80, 150, 5, (x) => `${x.toFixed(2)}×`),
      picker('F', 'Female voice', 'Bella (F4)'),
      picker('M', 'Male voice', 'Echo (M5)'),
      el('label', { className: 'avr-chk' }, chk, el('span', { textContent: 'Pause auto-scroll while a line is read' })),
      el('label', { className: 'avr-chk' }, restChk, el('span', { textContent: 'Get the rest of this manga ready ahead' })),
      el('div', { className: 'avr-keys', textContent: 'V on / off  ·  B other voice for the last line' }));
    gear.addEventListener('click', () => {
      panel.hidden = !panel.hidden; box.classList.toggle('avr-open', !panel.hidden);
      if (!panel.hidden) call('GET', '/voices').then((r) => {    // "My voice" only where Voice Maker has clips
        for (const v of ['F', 'M']) {
          const o = pickers[v].options[1], have = r && r[v];
          o.disabled = !have; o.textContent = have ? `My voice (${have.clips} clip${have.clips === 1 ? "" : "s"})` : 'My voice (none yet: Voice Maker)';
        }
      }).catch(() => {});
    });
    document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !box.contains(e.target)) { panel.hidden = true; box.classList.remove('avr-open'); } }, true);
    box = el('div', { id: 'avr-box' }, panel, gear, pill);
    document.body.appendChild(box);
  }
  function drawPill() {
    if (!ids()) { if (box) box.style.display = 'none'; return; }
    if (!box) build();
    box.style.display = '';
    const p = on && prog && chap && prog.chapterId === chap.chapterId ? prog : null;
    let text = on ? 'Voice on (V)' : 'Voice off (V)', frac = null;
    if (on && chap && chap.pages && !(p && p.ready)) {
      const pf = p ? p.pagesDone / Math.max(1, p.pages) : 0, lf = p && p.lines ? p.linesDone / p.lines : 0;
      frac = 0.1 * pf + 0.9 * pf * lf;                          // pages read (quick), then their lines spoken (most of the time)
      text = p && p.lines && pf >= 1 ? `Getting ready ${Math.floor(frac * 100)}% · ${p.linesDone}/${p.lines}` : `Getting ready ${Math.floor(frac * 100)}%`;
    } else if (p && p.ready) text = S.rest && p.restTotal ? `Voice ready · rest ${p.restDone}/${p.restTotal}` : 'Voice ready (V)';
    label.textContent = text;
    pill.title = p ? `${p.pagesDone} / ${p.pages} pages read, ${p.linesDone} / ${p.lines} lines made` : '';
    bar.style.width = frac == null ? '0' : `${Math.max(3, frac * 100)}%`;
    pill.classList.toggle('avr-on', on);
    drawIcon(on);
  }
  let note = null, noteT = 0;
  function toast(text) {
    if (!note) { note = document.createElement('div'); note.id = 'avr-note'; document.body.appendChild(note); }
    note.textContent = text; note.classList.add('avr-show');
    clearTimeout(noteT); noteT = setTimeout(() => note.classList.remove('avr-show'), 4000);
  }

  // ---------- keys: V on / off, B the other voice ----------
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  function toggle() {
    on = !on; GM_setValue('on', on);
    keepAwake(on);
    if (!on) { stopSpeaking(); resumeAuto(); }
    else if (chap && chap.pages) {                            // start from what is on screen now
      pos = queue.findIndex((b) => { const r = rect(b); return r && r.bottom > 0; });
      if (pos < 0) pos = queue.length;
    }
    drawPill();
    toast(on ? 'Voice reader on' : 'Voice reader off');
  }
  function flip() {
    const b = lastRead;
    if (!b || !chap) return;
    b.voice = b.voice === 'F' ? 'M' : 'F';
    flips[`${chap.chapterId}:${b.page}:${b.text}`] = b.voice; GM_setValue('flips', JSON.stringify(flips));
    toast(b.voice === 'F' ? "Female voice for this line" : "Male voice for this line");
    speak(b);
  }
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || !ids()) return;
    if (e.key === 'v' || e.key === 'V') { e.preventDefault(); e.stopImmediatePropagation(); toggle(); }
    else if ((e.key === 'b' || e.key === 'B') && on) { e.preventDefault(); e.stopImmediatePropagation(); flip(); }
  }, true);
  setInterval(drawPill, 500);
  drawPill();
  if (on) keepAwake(true);                                  // opens fully on the first click / key press


  // ---------- the manga's info page: get its voices ready, chapter by chapter ----------
  const infoId = () => { const m = /^\/manga\/([^/#?]+)/.exec(location.pathname); return m ? m[1] : null; };
  let prep = null;              // {id, groups: [{id, name, chapters, start}], box, ...}

  function startOf(chapters) {
    // the chapter being read, else the one after the last tick, else the first
    const sorted = [...chapters].sort((a, b) => a.number - b.number);
    const done = sorted.filter((c) => c.progress && c.progress.frac >= 0.9);
    const last = done.length ? done[done.length - 1].number : -1;
    const next = sorted.find((c) => c.number > last);
    return next ? next.number : null;                            // null: all of it is read
  }
  async function loadPrep(id) {
    const [a, m] = await Promise.all([fetch(`/api/manga/allChapters?mangaId=${id}`).then((r) => r.json()), fetch(`/api/manga/page?id=${id}`).then((r) => r.json())]);
    const names = {}; for (const s of (m.mangaPage && m.mangaPage.scanlators) || []) names[s.id] = s.name;
    const by = {}; for (const c of a.chapters || []) (by[c.scanlationMangaId] = by[c.scanlationMangaId] || []).push(c);
    const groups = Object.entries(by).map(([gid, chapters]) => ({ id: gid, name: names[gid] || 'Group', chapters, start: startOf(chapters),
      read: chapters.filter((c) => c.progress).reduce((t, c) => Math.max(t, c.progress.ts || 0), 0) }));
    // the group you've been reading, else the one with the most chapters
    groups.sort((x, y) => y.read - x.read || y.chapters.length - x.chapters.length);
    return groups;
  }
  function timeLeft(secs) {
    if (secs < 60) return 'Less than a minute left';
    const min = Math.ceil(secs / 60);
    if (min < 60) return `About ${min} min left`;
    return `About ${Math.floor(min / 60)} h ${min % 60} min left`;
  }
  function drawPrep() {
    const id = infoId();
    if (!id) { if (prep) { prep.box.remove(); prep = null; } return; }
    if (prep && prep.id !== id) { prep.box.remove(); prep = null; }
    if (prep) return;
    const label = el('span', { textContent: 'Voices' }), bar = el('i', { id: 'avr-bar' });
    const btn = el('button', { id: 'avr-pill', type: 'button' }, label, bar);
    const group = el('select'), from = el('select');
    const go = el('button', { type: 'button', className: 'avr-go', textContent: 'Get voices ready' });
    const info = el('div', { className: 'avr-keys', textContent: '' });
    const fill = el('i'), track = el('div', { className: 'avr-track', hidden: true }, fill);
    const now = el('div', { className: 'avr-now', hidden: true });
    const panel = el('div', { id: 'avr-panel', hidden: true }, el('div', { className: 'avr-h', textContent: 'Get this manga ready' }),
      el('label', { className: 'avr-sel' }, el('span', { textContent: 'Group' }), group),
      el('label', { className: 'avr-sel' }, el('span', { textContent: 'From' }), from), go, track, now, info);
    const box = el('div', { id: 'avr-box' }, panel, btn);
    document.body.appendChild(box);
    prep = { id, box };
    const me = prep;
    btn.addEventListener('click', () => { panel.hidden = !panel.hidden; box.classList.toggle('avr-open', !panel.hidden); });
    document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !box.contains(e.target)) { panel.hidden = true; box.classList.remove('avr-open'); } }, true);
    const cur = () => me.groups.find((g) => g.id === group.value);
    const fillFrom = (start) => {
      const g = cur(); from.replaceChildren();
      for (const c of [...g.chapters].sort((a, b) => a.number - b.number)) from.append(el('option', { value: c.number, textContent: `Chapter ${c.number}${c.progress && c.progress.frac >= 0.9 ? ' ✓' : ''}` }));
      const s = start != null ? start : g.start;
      if (s != null) from.value = s;
      const left = g.chapters.filter((c) => c.number >= Number(from.value)).length;
      go.textContent = `Get ${left} chapter${left === 1 ? '' : 's'} ready`;
    };
    group.addEventListener('change', () => { fillFrom(); group.blur(); });
    from.addEventListener('change', () => { fillFrom(Number(from.value)); from.blur(); });
    let running = false;
    go.addEventListener('click', async () => {
      try {
        if (running) await call('POST', '/prepare', { mangaId: id, stop: true });
        else await call('POST', '/prepare', { mangaId: id, group: group.value, from: Number(from.value), own: { F: S.ownF, M: S.ownM } });
        poll();
      } catch (e) { helperProblem(e); }
    });
    const poll = async () => {
      if (prep !== me) return;
      try {
        const r = await call('GET', `/prepared?mangaId=${id}`);
        running = r.running;
        if (r.total) {
          const pct = r.percent != null ? r.percent : 100 * r.done / r.total;
          label.textContent = r.done >= r.total ? 'Voices ready' : r.running ? `Voices ${Math.floor(pct)}%` : `Voices ${r.done}/${r.total}`;
          bar.style.width = r.running ? `${Math.max(3, pct)}%` : '0';
          track.hidden = now.hidden = !r.running;
          fill.style.width = `${Math.max(1, pct)}%`;
          now.textContent = !r.running || r.number == null ? 'Starting...'
            : r.pagesDone < r.pages ? `Chapter ${r.number}: reading pages ${r.pagesDone} of ${r.pages}`
              : `Chapter ${r.number}: voices ${r.linesDone} of ${r.lines} lines`;
          if (r.running) now.textContent += `\n${r.etaSecs == null ? 'Working out the time left...' : timeLeft(r.etaSecs)}`;
          info.textContent = r.running ? `${r.done} of ${r.total} chapters ready. Keeps going if you close this tab.` : (r.done >= r.total ? 'All ready. Finished chapters are deleted as you read on.' : `${r.done} of ${r.total} chapters ready. Stopped.`);
          btn.classList.toggle('avr-on', r.running || r.done >= r.total);
        }
        if (running) go.textContent = 'Stop'; else if (me.groups) fillFrom(Number(from.value));
      } catch (e) { /* the helper isn't running: the button says so when pressed */ }
      setTimeout(poll, running ? 2000 : 15000);
    };
    loadPrep(id).then((groups) => {
      if (prep !== me) return;
      me.groups = groups;
      for (const g of groups) group.append(el('option', { value: g.id, textContent: `${g.name} (${g.chapters.length})` }));
      fillFrom();
      poll();
    }).catch(() => { info.textContent = "Couldn't read this manga's chapters."; });
  }
  setInterval(drawPrep, 800);

  const css = document.createElement('style');
  css.textContent = `
    #avr-hl { position: fixed; z-index: 30; pointer-events: none; border-radius: 14px; display: none;
      box-shadow: 0 0 0 3px rgba(244, 114, 182, .75), 0 0 22px rgba(244, 114, 182, .45); transition: all .15s ease; }
    #avr-hl[data-voice="M"] { box-shadow: 0 0 0 3px rgba(96, 165, 250, .8), 0 0 22px rgba(96, 165, 250, .45); }
    #avr-box { position: fixed; right: 128px; bottom: 48px; z-index: 40; display: flex; align-items: center; gap: 6px;
      font: 500 12px system-ui, sans-serif; }
    #avr-pill { position: relative; overflow: hidden; height: 30px; min-width: 30px; border: 0; border-radius: 15px; padding: 0 7px;
      display: flex; align-items: center; gap: 0; font: inherit; color: #b9bdc5; background: rgba(22, 22, 28, .5);
      backdrop-filter: blur(4px); cursor: pointer; opacity: .5; white-space: nowrap; transition: opacity .2s, background .2s; }
    #avr-pill svg { width: 16px; height: 16px; flex: none; }
    #avr-pill.avr-on { color: #f4a3c8; opacity: .7; }
    #avr-label { max-width: 0; overflow: hidden; transition: max-width .25s ease, margin .25s ease; }
    #avr-box:hover #avr-label, #avr-box.avr-open #avr-label { max-width: 240px; margin-left: 6px; }
    #avr-box:hover #avr-pill, #avr-box.avr-open #avr-pill { opacity: .95; background: rgba(22, 22, 28, .82); }
    #avr-bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: rgba(244, 163, 200, .85);
      transition: width .5s ease; }
    #avr-gear { width: 26px; height: 26px; border: 0; border-radius: 50%; padding: 0; display: grid; place-items: center;
      background: rgba(110, 72, 190, .6); color: #fff; font-size: 14px; line-height: 1; cursor: pointer; opacity: 0;
      transition: opacity .2s; }
    .avr-track { height: 6px; margin-top: 10px; border-radius: 3px; background: rgba(167,139,250,.18); overflow: hidden; }
    .avr-track i { display: block; height: 100%; width: 1%; border-radius: 3px; background: #a78bfa; transition: width .6s ease; }
    .avr-now { margin-top: 6px; font-size: 12px; line-height: 1.45; color: #d8ccff; white-space: pre-line; }
    .avr-track[hidden], .avr-now[hidden] { display: none; }
    #avr-box:hover #avr-gear, #avr-box.avr-open #avr-gear, #avr-gear:focus-visible { opacity: .85; }
    #avr-gear:hover { opacity: 1; }
    #avr-panel { position: absolute; right: 0; bottom: calc(100% + 8px); width: 250px; padding: 12px 14px; border-radius: 14px;
      background: rgba(40, 28, 64, .97); color: #ece6f8; border: 1px solid rgba(167, 139, 250, .35);
      box-shadow: 0 8px 30px rgba(0, 0, 0, .45); }
    #avr-panel[hidden] { display: none; }
    #avr-panel .avr-h { font-weight: 700; color: #c4b5fd; margin-bottom: 4px; }
    #avr-panel label { display: block; margin: 10px 0 0; cursor: pointer; }
    #avr-panel label b { float: right; font-weight: 600; color: #c4b5fd; }
    #avr-panel input[type=range] { display: block; width: 100%; margin: 4px 0 0; accent-color: #a78bfa; }
    #avr-panel .avr-chk { display: flex; gap: 8px; align-items: center; }
    #avr-panel .avr-go { display: block; width: 100%; margin-top: 12px; padding: 7px 10px; border: 0; border-radius: 9px; font: inherit; font-weight: 600;
      color: #fff; background: rgba(124, 77, 210, .9); cursor: pointer; }
    #avr-panel .avr-go:hover { background: rgba(139, 92, 246, 1); }
    #avr-panel .avr-sel { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    #avr-panel select { background: #2c2140; color: #ece6f8; border: 1px solid rgba(167, 139, 250, .4); border-radius: 8px;
      padding: 3px 6px; font: inherit; max-width: 150px; }
    #avr-panel .avr-chk input { accent-color: #a78bfa; margin: 0; }
    #avr-panel .avr-keys { margin-top: 10px; font-size: 12px; opacity: .65; }
    #avr-note { position: fixed; left: 50%; top: 16px; transform: translate(-50%, -8px); z-index: 2147483000; padding: 8px 14px;
      border-radius: 10px; background: rgba(20, 22, 26, .92); color: #eef0f2; font: 13px system-ui, sans-serif;
      opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; }
    #avr-note.avr-show { opacity: 1; transform: translate(-50%, 0); }
  `;
  document.head.appendChild(css);
})();
