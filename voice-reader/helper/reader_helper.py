"""Atsu Voice Reader helper: reads the speech bubbles of atsu.moe chapters aloud for the Atsu Voice Reader userscript.
Listens on 127.0.0.1:8795 only (this PC). This program itself is tiny; the work is done by two worker processes
(reader_worker.py): 'pages' (GPU, about 2.5 GB while reading) and 'voice' (GPU, about 0.5 GB; the processor
when there is no GPU). Each quits after 5 minutes without work, giving all its memory back, and is started again the
moment it is needed. Low priority.
A chapter is got ready as a whole: every page read, then every line spoken ahead of time (kept on disk, cache\voices),
the line being read right now always first.

  POST /chapter  {"mangaId", "chapterId", "title", "page"}   start (or carry on) getting that chapter ready
  GET  /progress?chapterId=..                                 how far: pages read, lines made, ready
  GET  /bubbles?chapterId=..&page=N                           the page's speech bubbles once ready
  GET  /speak?voice=F|M|FO|MO&text=...[&now=1][&mood=]      the line spoken, as a wav (now=1: wanted this moment;
                                                              FO / MO = "My voice" from voices\female / male)
  POST /prepare  {"mangaId", "group", "from", "own"} / {"mangaId", "stop": true}   get a manga ready from a chapter on, without the page
  GET  /prepared?mangaId=..                                   how far that is
  GET  /voices                                                which "My voice" voices exist (made with Voice Maker)
  GET  /health

Run with the vision environment: .venv_vision\\Scripts\\pythonw.exe reader_helper.py"""
import base64, hashlib, json, multiprocessing as mp, os, queue, re, subprocess, sys, threading, time, traceback, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
VERSION = 'v27'
LEAD_IN = 0.3                                # quiet before each line: Bluetooth headphones swallow the first moment
TAIL = 0.12                                  # and a short breath after it
PAGES_VERSION = 'v15'                          # the pages' cache (results of reading a page)
VOICE_SET = 'kokoro1|af_bella 1.03 +1.8|am_echo 1.02 +0.5'   # change with reader_worker.VOICES: lines made again
VOICE_MB = 8000                              # the spoken lines kept on disk (oldest go first)
PORT = int(os.environ.get('READER_PORT', '8795'))
IDLE = int(os.environ.get('READER_IDLE', '300'))
CACHE = os.path.join(HERE, 'cache')
VOICE_DIR = os.path.join(CACHE, 'voices')
LOG = os.path.join(HERE, 'reader_helper.log')
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'}


def log(*a):
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 2_000_000:
            os.replace(LOG, LOG + '.old')
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + ' '.join(str(x) for x in a) + '\n')
    except OSError:
        pass


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()


class Worker:
    """one worker process; started on the first job, gone again after IDLE seconds without one"""
    def __init__(self, kind):
        self.kind, self.proc, self.conn, self.lock = kind, None, None, threading.Lock()

    def alive(self):
        return bool(self.proc and self.proc.is_alive())

    def call(self, *job):
        with self.lock:
            for attempt in (1, 2):
                if not self.alive():
                    from reader_worker import run
                    a, b = mp.Pipe()
                    self.proc = mp.Process(target=run, args=(self.kind, b, IDLE), daemon=True)
                    self.proc.start(); self.conn = a
                    log(f'{self.kind} worker started (pid {self.proc.pid})')
                try:
                    self.conn.send(job)
                    status, res = self.conn.recv()
                    if status == 'ok':
                        return res
                    raise RuntimeError(res)
                except (EOFError, BrokenPipeError, ConnectionResetError, OSError):
                    self.proc = None                          # it had just quit for being idle: start it again
                    if attempt == 2:
                        raise


class CloneWorker:
    """Chatterbox in its own environment (.venv_voice): clone_worker.py, one JSON line per job; started on the first
    job, quits by itself after IDLE seconds without one"""
    kind = 'own'
    PY = os.path.join(HERE, '.venv_voice', 'Scripts', 'python.exe')

    def __init__(self):
        self.proc, self.conn, self.lock = None, None, threading.Lock()

    def alive(self):
        return bool(self.proc and self.proc.poll() is None)

    def start(self):
        from multiprocessing.connection import Listener
        key = os.urandom(16)
        lis = Listener(('127.0.0.1', 0), authkey=key)
        lis._listener._socket.settimeout(120)                 # it connects first thing (before its imports)
        env = {k: v for k, v in os.environ.items() if k not in ('PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV')}
        env.update(READER_IDLE=str(IDLE), HF_HUB_DISABLE_PROGRESS_BARS='1', HF_HUB_OFFLINE='1', TQDM_DISABLE='1')
        self.proc = subprocess.Popen([self.PY, '-X', 'utf8', os.path.join(HERE, 'clone_worker.py'), str(lis.address[1]), key.hex()],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=open(LOG + '.own', 'a'), cwd=HERE,
                                     env=env, creationflags=0x08000000)
        try:
            self.conn = lis.accept()
        finally:
            lis.close()
        log(f'own-voice worker started (pid {self.proc.pid})')

    def call(self, text, kind, mood=None):
        with self.lock:
            for attempt in (1, 2):
                if not self.alive() or not self.conn:
                    if not os.path.exists(self.PY):
                        raise RuntimeError('My voice is not set up (.venv_voice missing)')
                    self.start()
                try:
                    self.conn.send({'text': text, 'kind': kind, 'mood': mood})
                    r = self.conn.recv()
                    if not r['ok']:
                        raise RuntimeError(r['error'])
                    return r['wav']
                except (EOFError, BrokenPipeError, OSError):
                    self.conn = None
                    self.proc = None                          # it had just quit for being idle: start it again
                    if attempt == 2:
                        raise


pages_w, voice_w, own_w = Worker('pages'), Worker('voice'), CloneWorker()
OWN = {'FO': 'female', 'MO': 'male'}


def own_voice(code):
    """the clips list of a "My voice" voice (FO / MO), or None"""
    try:
        m = json.load(open(os.path.join(HERE, 'voices', OWN[code], 'voice.json'), encoding='utf-8'))
        return m if m.get('clips') else None
    except (OSError, ValueError, KeyError):
        return None


def own_sig(code):
    m = own_voice(code)
    return hashlib.sha1(json.dumps(m and ['t0.5-cfg0.7-ear1', m.get('engine', 'fast')] + [(c['file'], c['mood'], c['secs']) for c in m['clips']]).encode()).hexdigest()[:10]
urgent = [0]                                                 # lines wanted this moment, waiting for the voice
behind = threading.Lock()                                    # lines made ahead of time go one at a time, after any urgent one
made_lock = threading.Lock()


def voice_file(text, voice, mood=None):
    vs = f'own|{own_sig(voice)}|{mood or ""}' if voice in OWN else VOICE_SET
    import textfix
    return os.path.join(VOICE_DIR, hashlib.sha1(f'{vs}|{voice}|{textfix.for_voice(say_names(text))}'.encode('utf-8')).hexdigest() + '.wav')


def speak(text, voice, now=False, mood=None):
    if voice in OWN and not own_voice(voice):
        voice = voice[0]                                      # no clips (any more): the built-in voice
    text = say_names(text)
    f = voice_file(text, voice, mood)
    try:
        with open(f, 'rb') as fh:
            return fh.read()
    except OSError:
        pass
    def make():
        wav = own_w.call(text, OWN[voice], mood) if voice in OWN else voice_w.call(text, voice)
        os.makedirs(VOICE_DIR, exist_ok=True)
        tmp = f'{f}.{threading.get_ident()}.tmp'
        with open(tmp, 'wb') as fh:
            fh.write(wav)
        os.replace(tmp, f)
        return wav

    def saved():
        try:
            with open(f, 'rb') as fh:
                return fh.read()
        except OSError:
            return None

    if now:
        with made_lock:
            urgent[0] += 1
        try:
            return saved() or make()
        finally:
            with made_lock:
                urgent[0] -= 1
    with behind:                                             # ahead of time: one at a time, never before an urgent line
        while urgent[0] > 0:
            time.sleep(0.05)
        return saved() or make()                             # (it may have been made while this one waited)


def prune_voices():
    try:
        fs = [os.path.join(VOICE_DIR, n) for n in os.listdir(VOICE_DIR) if n.endswith('.wav')]
        fs = sorted(((os.path.getmtime(f), os.path.getsize(f), f) for f in fs))
        total = sum(sz for _, sz, _ in fs)
        for _, sz, f in fs:
            if total <= VOICE_MB * 2**20:
                break
            os.remove(f); total -= sz
    except OSError:
        pass


# ---------- chapters ----------
chapters = {}                 # chapterId -> {mangaId, title, pages, done: {i: result}}
work = queue.PriorityQueue()
queued = set()


def cache_path(cid):
    return os.path.join(CACHE, f'{cid}.json')


def load_chapter(mid, cid, title):
    if cid in chapters:
        return chapters[cid]
    done = {}
    try:
        c = json.load(open(cache_path(cid), encoding='utf-8'))
        if c.get('version') == PAGES_VERSION:
            done = {int(k): v for k, v in c['done'].items()}
    except (OSError, ValueError, KeyError):
        pass
    q = urllib.parse.quote
    rc = json.loads(get(f'https://atsu.moe/api/read/chapter?mangaId={q(mid)}&chapterId={q(cid)}'))['readChapter']
    names, kind = [title], ''
    try:                                                     # every name the manga goes by, to skip its title page
        mpg = json.loads(get(f'https://atsu.moe/api/manga/page?id={q(mid)}'))['mangaPage']
        names += [mpg.get('title') or '', mpg.get('englishTitle') or ''] + list(mpg.get('otherNames') or [])
        kind = (mpg.get('type') or '').lower()                # 'manga' / 'manwha' (sic) / 'manhua' ...
    except Exception:
        pass
    chapters[cid] = {'mangaId': mid, 'title': ' | '.join(n for n in names if n), 'pages': rc['pages'], 'done': done,
                     'start': 0, 'seen': time.time(), 'rtl': kind == 'manga', 'id': cid,
                     'number': rc.get('number'), 'group': rc.get('scanlationMangaId')}
    if done and kind == 'manga':
        threading.Thread(target=panels_for_chapter, args=(cid,), daemon=True).start()
    return chapters[cid]


def save_chapter(cid):
    os.makedirs(CACHE, exist_ok=True)
    tmp = cache_path(cid) + '.tmp'
    json.dump({'version': PAGES_VERSION, 'done': chapters[cid]['done']}, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False)
    os.replace(tmp, cache_path(cid))


def page_worker():
    while True:
        _, cid, i = work.get()
        queued.discard((cid, i))
        ch = chapters.get(cid)
        if not ch or i in ch['done'] or ch.get('halt'):
            continue
        try:
            img = ch['pages'][i]['image']
            url = 'https://cdn.atsu.moe' + img if img.startswith('/') else img
            res = pages_w.call(url, ch['title'], bool(ch.get('rtl')), ch.get('mangaId'))
            ch['done'][i] = {k: res[k] for k in ('w', 'h', 'bubbles')}
            save_chapter(cid)
            log(f'{cid} page {i + 1}: {len(res["bubbles"])} bubbles in {res["secs"]} s (text {res["text_secs"]} s)')
        except Exception:
            log('page failed', cid, i, traceback.format_exc(limit=3))


def chapter_names(ch):
    """the words of the chapter that aren't common words: its names, spelled as read most often"""
    import collections, textfix
    if ch.get('_names_at') == len(ch['done']):
        return ch['_names']
    n = collections.Counter()
    for r in ch['done'].values():
        for b in r['bubbles']:
            for w in re.findall(r"[A-Za-z]{4,}", b['text']):
                w = re.sub(r'(kun|chan|san|sama)$', '', w, flags=re.I).lower()
                if len(w) >= 4 and not textfix._common(w):
                    n[w] += 1
    ch['_names'], ch['_names_at'] = n, len(ch['done'])
    if ch.get('rtl') and textfix.SAY_NAMES:                  # Japanese names, sounded out for the voice
        for w in n:
            if w not in textfix.KNOWN and n[w] >= 1:
                sp = textfix.spell_name(w)
                if sp:
                    SAY_AS[w] = sp
    return n


SAY_AS = {}                                                  # 'shunpei' -> 'Shoonpay' (names met in manga chapters)


def say_names(text):
    if not SAY_AS:
        return text
    def one(m):
        w = m.group(0); low = w.lower()
        if low in SAY_AS:
            return SAY_AS[low]
        base = re.sub(r'(kun|chan|san|sama)$', '', low)
        return SAY_AS[base] + '-' + low[len(base):] if base in SAY_AS else w     # "shunpeikun" -> "Shoonpay-kun"
    return re.sub(r"[A-Za-z]{4,}", one, text)


def mend_names(ch, text):
    """'shlnpei-kun' -> 'Shunpei-kun' when 'shunpei' is in the chapter (l / o for u, the misreads of this kind of lettering)"""
    import textfix
    names = chapter_names(ch)

    def fix(m):
        w = m.group(0); low = w.lower()
        if textfix._common(low) or names.get(low, 0) > 1:
            return w
        for v in textfix._variants(low, 1):
            if names.get(v, 0) >= 1 and names[v] >= names.get(low, 0):
                return v.capitalize()
        return w
    return re.sub(r"[A-Za-z]{4,}", fix, text)


def ordered(ch, i):
    """a page's bubbles in reading order: panel by panel (manga: panels.py); in a panel top to bottom, and bubbles side by side
    (their heights overlap) right to left in manga, left to right otherwise"""
    bs = [said_to_her(ch, dict(b, text=mend_names(ch, b['text']))) for b in ch['done'][i]['bubbles']]
    if not ch.get('rtl'):
        return one_speaker(bs)
    out = []
    for n in sorted({b.get('panel', 0) for b in bs}):
        rows, cur, bottom = [], [], None
        for b in sorted((b for b in bs if b.get('panel', 0) == n), key=lambda b: b['box'][1]):
            y0, y1 = b['box'][1], b['box'][3]
            if cur and y0 < bottom - 0.3 * (y1 - y0):        # starts before the row ends: the same row
                cur.append(b); bottom = max(bottom, y1)
            else:
                if cur:
                    rows.append(cur)
                cur, bottom = [b], y1
        if cur:
            rows.append(cur)
        out += [b for r in rows for b in sorted(r, key=lambda b: -(b['box'][0] + b['box'][2]))]
    return one_speaker(out)


def add_panels(ch, i):
    """a page read before the reader knew panels gets them now (no reading again: its picture and a moment)"""
    r = ch['done'].get(i)
    if not r or not ch.get('rtl') or len(r['bubbles']) < 2 or all('panel' in b for b in r['bubbles']):
        return False
    import io, numpy as np, panels
    from PIL import Image
    img = ch['pages'][i]['image']
    im = Image.open(io.BytesIO(get('https://cdn.atsu.moe' + img if img.startswith('/') else img))).convert('L')
    s = im.width / r['w']
    for b, n in zip(r['bubbles'], panels.order(np.array(im), [[v * s for v in b['box']] for b in r['bubbles']])):
        b['panel'] = n
    return True


def panels_for_chapter(cid):
    ch = chapters.get(cid)
    if not ch:
        return
    changed = False
    for i in sorted(ch['done']):
        try:
            changed = add_panels(ch, i) or changed
        except Exception:
            log('panels failed', cid, i, traceback.format_exc(limit=2))
    if changed and cid in chapters:
        save_chapter(cid)


OPENER = re.compile(r"^\W*(when|if|because|though|even though|although|since|while|after|before)\b", re.I)   # only words that open an unfinished clause


def runs_on(text):
    """does this bubble stop in the middle of a sentence, so the next bubble is the same person going on?"""
    t = text.strip()
    if not t:
        return False
    if t[-1] == ',' or t[-1].isalnum():                      # "I couldn't help but think" / "knowing those two,"
        return True
    return t.endswith(('...', '…')) and bool(OPENER.match(t))  # "When I heard that rumor..."


def clue(b):
    w = b.get('why', '')
    return 3 if w == 'tail -> face' else 2 if w == 'form of address' else 1.5 if w.startswith('tail') else 1 if b.get('guess') in ('F', 'M') else 0


def series_names(ch):
    """names learned from the bubbles, kept per series: X-kun = a boy, X-chan = a girl, X-san counted ("Shunpei-kun" read in one
    chapter is known in the next). -> (boys, girls, called -san)"""
    if ch.get('_nm_at') == len(ch['done']):
        return ch['_nm']
    here = {'kun': {}, 'chan': {}, 'san': {}}
    for r in ch['done'].values():
        for b in r['bubbles']:
            for h in here:
                for m in re.findall(rf"\b([A-Za-z]{{3,}})[- ]?{h}\b" if h != 'san' else r"\b([A-Za-z]{2,})[- ]san\b", b['text'], re.I):
                    here[h][m.lower()] = here[h].get(m.lower(), 0) + 1
    data = {}
    path = os.path.join(CACHE, 'series', f"{ch.get('mangaId')}.names.json") if ch.get('mangaId') else None
    if path:
        try:
            data = json.load(open(path, encoding='utf-8'))
        except (OSError, ValueError):
            data = {}
        data[ch.get('id', '?')] = here
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f'{path}.{threading.get_ident()}.tmp'
        json.dump(data, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False); os.replace(tmp, path)
    else:
        data = {'?': here}
    total = {'kun': {}, 'chan': {}, 'san': {}}
    for chap in data.values():
        for h in total:
            for n, c in chap.get(h, {}).items():
                total[h][n] = total[h].get(n, 0) + c
    ch['_nm'] = (set(total['kun']), set(total['chan']) - set(total['kun']), total['san'])
    ch['_nm_at'] = len(ch['done'])
    return ch['_nm']


def san_names(ch):
    """names called X-san in a chapter that also has a boy called Y-kun, X never being -kun, seen at least twice: in these
    stories that is the girl he talks to, so a line saying "Chihara-san" comes from him. Manga only."""
    if not ch.get('rtl'):
        return set()
    kun, chan, san = series_names(ch)
    return {n for n, c in san.items() if c >= 2 and n not in kun} if kun else set()


def said_to_her(ch, b):
    names = san_names(ch)
    if re.search(r"[- ]?kun\b", b['text'], re.I):
        return b
    if b.get('why', '').startswith('tail'):
        return b
    if any(re.search(rf"\b{re.escape(n)}[- ]san\b", b['text'], re.I) for n in names):
        return dict(b, voice='M', guess='M', why='form of address')
    boys, girls, _ = series_names(ch)
    edge = lambda n: re.search(rf"(^|[.!?,…~]\s*|\.\.\s*)\W*{re.escape(n)}(\W*$|\s*[.!?,…~])", b['text'], re.I)     # "Shunpei?" / "..., Shunpei."
    if any(edge(n) for n in boys):
        return dict(b, voice='F', guess='F', why='form of address')
    if any(edge(n) for n in girls | names):
        return dict(b, voice='M', guess='M', why='form of address')
    return b


def one_speaker(bs):
    """a sentence split over bubbles has one speaker: the bubble with the strongest clue decides for the whole run"""
    out, k = [], 0
    while k < len(bs):
        j = k
        while j + 1 < len(bs) and runs_on(bs[j]['text']):
            j += 1
        run = bs[k:j + 1]
        if len(run) > 1:
            top = max(clue(b) for b in run)
            votes = [b['voice'] for b in run if clue(b) == top]
            voice = max(set(votes), key=lambda v: (votes.count(v), v == votes[0]))
            run = [dict(b, voice=voice) for b in run]
        out += run
        k = j + 1
    return out


def lead_in(wav):
    """the wav with LEAD_IN seconds of quiet in front"""
    try:
        import io, numpy as np, soundfile as sf
        a, r = sf.read(io.BytesIO(wav), dtype='int16')
        loud = np.abs(a) > 0.03 * max(1, int(np.abs(a).max()))
        if loud.any():                                        # trim the quiet at both ends, keeping a little of it
            first, last = int(np.argmax(loud)), len(a) - int(np.argmax(loud[::-1]))
            a = a[max(0, first - int(r * 0.03)):min(len(a), last + int(r * 0.09))]
        a = a.astype(np.float32)
        fade_in, fade_out = min(len(a), int(r * 0.012)), min(len(a), int(r * 0.07))
        a[:fade_in] *= np.linspace(0, 1, fade_in)
        a[-fade_out:] *= np.linspace(1, 0, fade_out) ** 1.5    # a soft end instead of a cut
        a = np.concatenate([np.zeros(int(r * LEAD_IN), np.float32), a, np.zeros(int(r * TAIL), np.float32)]).astype(np.int16)
        out = io.BytesIO(); sf.write(out, a, r, format='WAV', subtype='PCM_16')
        return out.getvalue()
    except Exception:
        return wav


def lines(ch):
    """the chapter's lines in the order they get made: from the page being read on, then the ones before it"""
    n, st = len(ch['pages']), ch.get('start', 0)
    order = list(range(st, n)) + list(range(0, st))
    own = ch.get('own') or {}
    return [(b['text'], b['voice'] + ('O' if own.get(b['voice']) and own_voice(b['voice'] + 'O') else ''))
            for i in order if i in ch['done'] for b in ordered(ch, i)]


def progress(ch):
    ls = lines(ch)
    made = sum(1 for t, v in ls if os.path.exists(voice_file(t, v)))
    pages = len(ch['pages'])
    return {'pages': pages, 'pagesDone': len(ch['done']), 'lines': len(ls), 'linesDone': made,
            'ready': len(ch['done']) >= pages and made >= len(ls)}


def voice_maker():
    """speaks every line of the chapters open now before they are reached (the newest chapter first); steps aside
    whenever a line is wanted this moment"""
    n = 0
    while True:
        job = None
        for cid, ch in sorted(chapters.items(), key=lambda kv: -kv[1].get('seen', 0)):
            if time.time() - ch.get('seen', 0) > 1800 or ch.get('halt'):   # not read for half an hour, or stopped: leave it
                continue
            for t, v in lines(ch):
                if not os.path.exists(voice_file(t, v)):
                    job = (t, v); break
            if job:
                break
        if not job:
            time.sleep(1.0); continue
        while urgent[0] > 0:
            time.sleep(0.05)
        try:
            speak(*job)
            n += 1
            if n % 50 == 0:
                prune_voices()
        except Exception:
            log('line failed', job[0][:60], traceback.format_exc(limit=3))
            time.sleep(5)


def want(cid, start, later=0):
    """read pages from `start` on first, then the ones before it (later: chapters got ready ahead wait behind)"""
    ch = chapters[cid]
    ch['halt'] = False
    ch['start'], ch['seen'] = start, time.time()
    for i in range(len(ch['pages'])):
        if i in ch['done'] or (cid, i) in queued:
            continue
        queued.add((cid, i))
        work.put((later + ((i - start) if i >= start else 1000 + (start - i)), cid, i))


# ---------- the rest of the manga, ahead of time ----------
series = {}                   # mangaId -> {current, order: [(number, chapterId)], seen, own, on}
AWAY = 1800                   # no word from the page for this long (tab closed, reader off): stop; it carries on next time


def chapter_order(mid, ch):
    """the manga's chapters in order, from the same scanlation group as the one being read"""
    all_ = json.loads(get(f'https://atsu.moe/api/manga/allChapters?mangaId={urllib.parse.quote(mid)}'))['chapters']
    same = [c for c in all_ if c.get('scanlationMangaId') == ch.get('group')] or all_
    seen, out = set(), []
    for c in sorted(same, key=lambda c: (c.get('number') or 0, c.get('index') or 0)):
        if c.get('number') not in seen:
            seen.add(c.get('number')); out.append((c.get('number') or 0, c['id']))
    return out


def is_ready(ch):
    return len(ch['done']) >= len(ch['pages']) and progress(ch)['ready']


def rest_of(s):
    """the chapters after the one being read: (those ready, how many)"""
    cur = chapters.get(s['current'])
    if not cur:
        return 0, 0
    after = [cid for n, cid in s['order'] if n > (cur.get('number') or 0)]
    return sum(1 for cid in after if cid in s['ready']), len(after)


def forget_finished(mid, s):
    """chapters before the one being read are finished: their spoken lines and read pages go (lines the coming chapters share stay)"""
    cur = chapters.get(s['current'])
    if not cur or os.environ.get('READER_KEEP'):             # READER_KEEP: a test copy, deleting nothing of what you read
        return
    before = [cid for n, cid in s['order'] if n < (cur.get('number') or 0) and (cid in chapters or os.path.exists(cache_path(cid)))]
    if not before:
        return
    keep = set()
    for c in chapters.values():
        if c.get('mangaId') == mid and (c.get('number') or 0) >= (cur.get('number') or 0):
            keep |= {voice_file(t, v) for t, v in lines(c)}
    gone = 0
    for cid in before:
        try:
            ch = load_chapter(mid, cid, '')
            ch['own'] = s['own']
            for t, v in lines(ch):
                f = voice_file(t, v)
                if f not in keep and os.path.exists(f):
                    os.remove(f); gone += 1
            chapters.pop(cid, None); s['ready'].discard(cid)
            if os.path.exists(cache_path(cid)):
                os.remove(cache_path(cid))
        except Exception:
            log('forget failed', cid, traceback.format_exc(limit=2))
    log(f'{mid}: {len(before)} finished chapter(s) forgotten, {gone} spoken lines deleted')


def prepared(mid):
    s = series.get(mid)
    if not s or not s.get('order'):
        return {'running': bool(s and s.get('pinned')), 'done': 0, 'total': 0}
    cur = chapters.get(s.get('current'))
    floor = cur.get('number') or 0 if cur else s.get('from', 0)
    want_ = [(n, cid) for n, cid in s['order'] if n >= floor]
    done = sum(1 for _, c in want_ if c in s['ready'])
    res = {'running': bool(s.get('pinned')), 'done': done, 'total': len(want_), 'group': s.get('group'), 'from': s.get('from'), 'percent': 100 * done / max(1, len(want_))}
    if s.get('pinned'):                                      # the chapter being worked on: how far it has got
        for n, cid in want_:
            ch = chapters.get(cid)
            if cid not in s['ready'] and ch:
                p = progress(ch)
                read = p['pagesDone'] / max(1, p['pages'])
                part = 0.2 * read + 0.8 * read * p['linesDone'] / max(1, p['lines'])   # reading the pages is the short part
                res.update(number=n, pages=p['pages'], pagesDone=p['pagesDone'], lines=p['lines'], linesDone=p['linesDone'],
                           percent=100 * (done + part) / max(1, len(want_)))
                break
        # time left: at the speed of the last ten minutes (the first moment is left out: lines made earlier count at once)
        now = time.time()
        marks = s.setdefault('marks', [])
        if not marks or now - marks[-1][0] >= 5:
            marks.append((now, res['percent']))
        marks[:] = [m for m in marks if now - m[0] <= 600 and m[1] <= res['percent']]
        if marks and now - marks[0][0] >= 45 and res['percent'] > marks[0][1]:
            res['etaSecs'] = round((100 - res['percent']) * (now - marks[0][0]) / (res['percent'] - marks[0][1]))
    else:
        s.pop('marks', None)
    return res


def follow(mid, cid, own, on):
    """the page is reading this chapter"""
    s = series.setdefault(mid, {'order': [], 'ready': set(), 'at': 0})
    moved = s.get('current') != cid
    s.update(current=cid, seen=time.time(), own=own, on=on)
    if moved or time.time() - s['at'] > 600:
        def work():
            try:
                s['order'] = chapter_order(mid, chapters[cid]); s['at'] = time.time()
                if on:
                    forget_finished(mid, s)
            except Exception:
                log('chapter list failed', mid, traceback.format_exc(limit=2))
        threading.Thread(target=work, daemon=True).start()


def planner():
    """one chapter at a time, in order, once the one being read is ready"""
    while True:
        time.sleep(3)
        for mid, s in list(series.items()):
            try:
                cur = chapters.get(s.get('current'))
                here = time.time() - s.get('seen', 0) <= AWAY
                if not s.get('on') or not s['order'] or not (s.get('pinned') or (cur and here)):
                    continue
                if cur and here and not is_ready(cur):
                    continue                                 # the chapter being read comes first
                if cur:
                    s['ready'].add(cur['id'])
                floor = cur.get('number') or 0 if cur else s.get('from', 0)
                for n, cid in s['order']:
                    if n < floor or (cur and n == floor) or cid in s['ready']:
                        continue
                    ch = chapters.get(cid) or load_chapter(mid, cid, '')
                    ch['own'] = s['own']; ch['seen'] = time.time() - 1; ch['halt'] = False      # just behind the one being read
                    if is_ready(ch):
                        s['ready'].add(cid); log(f'{mid}: chapter {n} ready ahead')
                        continue
                    if not any(q[0] == cid for q in queued):
                        want(cid, 0, later=100000)
                    break
                else:
                    if s.get('pinned'):
                        s['pinned'] = False; log(f'{mid}: every chapter asked for is ready')
            except Exception:
                log('planner', mid, traceback.format_exc(limit=2)); time.sleep(20)


# ---------- the little web server ----------
class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path == '/health':
                return self._send(200, {'ok': True, 'version': VERSION, 'workers': {w.kind: w.alive() for w in (pages_w, voice_w, own_w)}})
            if u.path == '/prepared':
                return self._send(200, prepared(q.get('mangaId', '')))
            if u.path == '/voices':
                return self._send(200, {k[0]: (lambda m: m and {'clips': len(m['clips']), 'secs': round(sum(c['secs'] for c in m['clips']), 1),
                                                                 'moods': sorted(set(c['mood'] for c in m['clips']))})(own_voice(k)) for k in OWN})
            if u.path == '/progress':
                ch = chapters.get(q.get('chapterId', ''))
                if not ch:
                    return self._send(404, {'error': 'chapter not started'})
                ch['seen'] = time.time()
                s = series.get(ch.get('mangaId'))
                if s and s.get('current') == ch.get('id'):
                    s['seen'] = time.time()
                done, total = rest_of(s) if s else (0, 0)
                return self._send(200, {**progress(ch), 'restDone': done, 'restTotal': total})
            if u.path == '/bubbles':
                cid, i = q['chapterId'], int(q['page'])
                ch = chapters.get(cid)
                if not ch:
                    return self._send(404, {'error': 'chapter not started'})
                if i in ch['done']:
                    try:
                        if add_panels(ch, i):
                            save_chapter(cid)
                    except Exception:
                        log('panels failed', cid, i, traceback.format_exc(limit=2))
                    return self._send(200, {'state': 'ready', **ch['done'][i], 'bubbles': ordered(ch, i), 'rtl': bool(ch.get('rtl'))})
                if (cid, i) not in queued:
                    want(cid, i)
                return self._send(200, {'state': 'working'})
            if u.path == '/speak':
                text = q.get('text', '').strip()[:600]
                if not text:
                    return self._send(400, {'error': 'no text'})
                return self._send(200, lead_in(speak(text, q.get('voice', 'F'), q.get('now') == '1', q.get('mood') or None)), 'audio/wav')
            return self._send(404, {'error': 'unknown'})
        except Exception as e:
            log('GET failed', self.path[:120], traceback.format_exc(limit=3))
            return self._send(500, {'error': str(e)})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
            if u.path == '/prepare':
                mid = body['mangaId']
                s = series.setdefault(mid, {'order': [], 'ready': set(), 'at': 0})
                if body.get('stop'):
                    s.update(pinned=False, on=False)
                    for c in chapters.values():
                        if c.get('mangaId') == mid and c.get('id') != s.get('current'):
                            c['halt'] = True
                    return self._send(200, prepared(mid))
                s.update(pinned=True, on=True, current=None, own=body.get('own') or {}, group=body.get('group'), seen=time.time(), **{'from': float(body.get('from') or 0)})
                s['order'] = chapter_order(mid, {'group': body.get('group')}); s['at'] = time.time()
                log(f"{mid}: getting ready from chapter {s['from']} on ({sum(1 for n, _ in s['order'] if n >= s['from'])} chapters)")
                return self._send(200, prepared(mid))
            if u.path == '/chapter':
                ch = load_chapter(body['mangaId'], body['chapterId'], body.get('title', ''))
                ch['own'] = body.get('own') or {}
                follow(body['mangaId'], body['chapterId'], ch['own'], body.get('rest', True))
                want(body['chapterId'], int(body.get('page', 0)))
                return self._send(200, {'pages': len(ch['pages']), 'ready': sorted(ch['done'])})
            return self._send(404, {'error': 'unknown'})
        except Exception as e:
            log('POST failed', self.path, traceback.format_exc(limit=3))
            return self._send(500, {'error': str(e)})

    def log_message(self, *a):
        pass


def main():
    try:
        srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
    except OSError:
        log('already running'); return                       # one copy only
    threading.Thread(target=page_worker, daemon=True).start()
    threading.Thread(target=voice_maker, daemon=True).start()
    threading.Thread(target=planner, daemon=True).start()
    log(f'started {VERSION} on 127.0.0.1:{PORT}')
    srv.serve_forever()


if __name__ == '__main__':
    mp.freeze_support()
    main()
