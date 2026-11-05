"""Speech bubble text from a manga / manhwa page: compact PaddleOCR (RapidOCR, processor, 2 threads).
Tall strips are read in overlapping slices; lines close together become one bubble; bubbles come in reading order.
The "upside down?" guess is off: it flips short lines in narrow manga bubbles ("You!!" -> "jnoy")."""
import os, re
import cv2
import numpy as np

SLICE, OVER = 1400, 240
_engine = None


def engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        import torch  # noqa: F401  (puts the CUDA 12 libraries in place for the GPU text reader)
        _engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1, det_use_cuda=True, cls_use_cuda=True, rec_use_cuda=True)
    return _engine


def unload():
    global _engine
    _engine = None


def read_page(img):
    W, H = img.size
    out, y = [], 0
    while y < H:
        part = np.array(img.crop((0, y, W, min(H, y + SLICE))))
        # an empty stretch (the black / white gaps between manhwa panels) has no text: skip it
        res = engine()(part, use_cls=False)[0] if part[::4, ::4].std() > 8 else None
        for box, text, score in res or []:
            if float(score) < 0.6:
                continue
            xs = [p[0] for p in box]; ys = [p[1] + y for p in box]
            b = [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))]
            if any(abs(b[1] - o['box'][1]) < 8 and abs(b[0] - o['box'][0]) < 14 for o in out):
                continue                                    # the same line seen again in the overlap
            out.append({'text': text, 'box': b})
        if y + SLICE >= H:
            break
        y += SLICE - OVER
    return reread(img, out)


_en = {}


def en_engine():
    """the English-only recognition model: far fewer misread letters in comic lettering (d read as o, u as l, words run
    together): lines with odd words 95 -> 36 of 253 (ocr_variants.py). Only reads lines the finder already found."""
    if 'e' not in _en:
        from rapidocr_onnxruntime import RapidOCR
        m = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'ocr_en')
        _en['e'] = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1, det_use_cuda=True, cls_use_cuda=True, rec_use_cuda=True,
                            rec_model_path=os.path.join(m, 'en_new.onnx'), rec_keys_path=os.path.join(m, 'en_new_dict.txt'))
    return _en['e']


def _odd_words(t):
    import textfix
    ws = re.findall(r"[A-Za-z][A-Za-z']*", t)
    return sum(1 for w in ws if len(w) > 1 and not textfix._common(w.lower()) and not textfix._common(re.sub(r"'s$", '', w.lower())))


def reread(img, lines):
    """every line read again by the English model; it is kept unless the first reading has fewer odd words"""
    try:
        eng = en_engine()
    except Exception:
        return lines
    W, H = img.size
    for ln in lines:
        x0, y0, x1, y1 = [int(v) for v in ln['box']]
        pad = max(2, int(0.12 * (y1 - y0)))
        crop = np.asarray(img.crop((max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad))))[:, :, ::-1]
        res = eng(crop, use_det=False, use_cls=False)[0]
        if not res:
            continue
        txt, sc = res[0][0].strip(), float(res[0][1])
        if txt and sc >= 0.5 and _odd_words(txt) <= _odd_words(ln['text']):
            ln['text'] = txt
    return lines


def second_look(img, lines):
    """the text finder misses a lone big letter on its own line ("I" over "WOULD HATE THAT."): look at the small space
    above each block of text and add an "I" / "A" found there"""
    a = np.asarray(img.convert('L')); W, H = img.size
    extra = []
    for ln in lines:
        x0, y0, x1, y1 = ln['box']; h = y1 - y0
        if h < 12 or y0 < h:
            continue
        if any(o is not ln and o['box'][3] > y0 - 1.5 * h and o['box'][1] < y0 and min(o['box'][2], x1) > max(o['box'][0], x0) for o in lines):
            continue                                         # a line above it already
        cx = (x0 + x1) / 2
        bx0, bx1, by0, by1 = int(max(0, cx - 1.1 * h)), int(min(W, cx + 1.1 * h)), int(max(0, y0 - 1.25 * h)), int(y0 - 0.03 * h)
        crop = a[by0:by1, bx0:bx1]
        if crop.size == 0:
            continue
        ink = (crop < 110).astype(np.uint8)
        if (crop > 200).mean() < 0.45:                       # not on a white bubble
            continue
        n, _, st, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
        shapes = [st[k] for k in range(1, n) if st[k][0] > 0 and st[k][1] > 0 and st[k][0] + st[k][2] < crop.shape[1]
                  and st[k][1] + st[k][3] < crop.shape[0] and st[k][3] >= 0.5 * h]   # whole shapes, as tall as a letter or more
        if len(shapes) != 1:
            continue
        sx, sy, sw, sh = [int(v) for v in shapes[0][:4]]
        xs, ys = np.array([sx, sx + sw - 1]), np.array([sy, sy + sh - 1])
        pad = int(0.3 * h)
        box = [bx0 + xs.min() - pad, by0 + ys.min() - pad, bx0 + xs.max() + pad, by0 + ys.max() + pad]
        box = [max(0, box[0]), max(0, box[1]), min(W, box[2]), min(H, box[3])]
        part = np.asarray(img.convert('RGB').crop((bx0, by0, bx1, by1)))[:, :, ::-1]   # the wider view reads better than a tight crop
        res = engine()(part, use_det=False, use_cls=False)[0]
        txt, sc = (res[0][0], float(res[0][1])) if res else ('', 0.0)
        if txt.strip() in ('I', 'l', '|', '1', 'i', 'A', 'J', 'T', ']', '[', '/') and (xs.max() - xs.min()) < 0.8 * h:
            letter = 'A' if txt.strip() == 'A' else 'I'
            extra.append({'text': letter, 'box': [float(v) for v in box], 'score': sc})
    return lines + extra


def _columns(ls):
    """lines of one bubble in reading order: two columns (no line crosses the gap between them, and they stand side by side)
    are read whole, right one first"""
    if len(ls) < 3:
        return sorted(ls, key=lambda l: -l['box'][2]) if len(ls) == 2 and min(ls[0]['box'][3], ls[1]['box'][3]) - max(ls[0]['box'][1], ls[1]['box'][1]) > 0 and (ls[0]['box'][0] >= ls[1]['box'][2] or ls[1]['box'][0] >= ls[0]['box'][2]) else ls
    xs = sorted(ls, key=lambda l: l['box'][0])
    reach = xs[0]['box'][2]
    for k in range(1, len(xs)):
        if xs[k]['box'][0] >= reach:                         # a gap no line crosses
            left, right = xs[:k], xs[k:]
            top = lambda c: min(l['box'][1] for l in c); bot = lambda c: max(l['box'][3] for l in c)
            if min(bot(left), bot(right)) - max(top(left), top(right)) > 0:
                key = lambda l: (l['box'][1] + l['box'][3]) / 2
                return sorted(right, key=key) + sorted(left, key=key)
        reach = max(reach, xs[k]['box'][2])
    return ls


def bubbles(lines):
    lines = sorted(lines, key=lambda l: (l['box'][1], l['box'][0]))
    groups = []
    for ln in lines:
        x0, y0, x1, y1 = ln['box']; h = y1 - y0
        for g in groups:
            gx0, gy0, gx1, gy1 = g['box']
            if -0.3 * h <= y0 - gy1 < 1.0 * max(h, g['lh']) and min(x1, gx1) - max(x0, gx0) > -0.3 * h:
                g['lines'].append(ln); g['box'] = [min(gx0, x0), gy0, max(gx1, x1), max(gy1, y1)]; break
        else:
            groups.append({'lines': [ln], 'box': [x0, y0, x1, y1], 'lh': h})
    # a stray word or two beside a bubble's text (a centred line further left / right, e.g. "BEING") belongs to it
    merged = True
    while merged:
        merged = False
        for g in sorted(groups, key=lambda g: sum(len(l['text'].split()) for l in g['lines'])):
            if sum(len(l['text'].split()) for l in g['lines']) > 2:
                continue
            x0, y0, x1, y1 = g['box']; h = g['lh']
            best = None
            for o in groups:
                if o is g:
                    continue
                ox0, oy0, ox1, oy1 = o['box']
                vgap = max(oy0 - y1, y0 - oy1)                 # < 0: the heights overlap
                hgap = max(ox0 - x1, x0 - ox1)
                if vgap < 0.6 * h and hgap < 1.2 * h and (vgap < 0 or hgap < 0):
                    dist = max(vgap, 0) + max(hgap, 0)
                    if best is None or dist < best[0]:
                        best = (dist, o)
            if best:
                o = best[1]
                o['lines'] += g['lines']; o['box'] = [min(o['box'][0], x0), min(o['box'][1], y0), max(o['box'][2], x1), max(o['box'][3], y1)]
                groups.remove(g); merged = True; break
    for g in groups:
        g['lines'].sort(key=lambda l: ((l['box'][1] + l['box'][3]) / 2, l['box'][0]))
        g['lines'] = _columns(g['lines'])
        g['text'] = ' '.join(l['text'] for l in g['lines'])
    groups.sort(key=lambda g: (round(g['box'][1] / 60), g['box'][0]))
    return [{'text': g['text'], 'box': g['box']} for g in groups]


# ---------- only speech is read ----------
CREDIT = re.compile(r'\b(latest|new|next) (volume|chapter|issue)\b|\bvol(ume)?\.? ?\d+\b.*\b(out|on sale|release\w*|available)\b|\bon sale\b'
                    r'|\b(art|story|script|translat\w*|proofread\w*|typeset\w*|clean\w*|redraw\w*|edit\w*)\b\s*(&|and|by|:)'
                    r'|\.(com|gg|net|org|io|ink|to|me|xyz|site|cc|top|club|fun)\b|discord|patreon|ko-?fi|scans?\b|join our|read (it )?(on|at)\b', re.I)
WATERMARK = re.compile(r'\b(toon|toons|manga|manhwa|comic|scan|scanlation|translations?)\b|^\W*(com|net|org|www)\W*$', re.I)
squash = lambda t: re.sub(r'[^a-z]', '', t.lower())


def is_speech(text, title=''):
    """title: the manga's names joined (atsu's title, English title, other names)"""
    t = text.strip()
    letters = re.findall(r'[A-Za-z]', t)
    if re.search(r'[\u3040-\u30ff\u4e00-\u9fff]', t):        # Japanese / Chinese letters: a title or sign, not an English line
        return False
    words = re.findall(r'[A-Za-z]+', t)
    if len(words) <= 2 and not re.search(r'[aeiouyAEIOUY]', t) and not re.search(r'[.?!]', t) and not re.fullmatch(r'\W*(h+m+|m+|s+h+|t+s+k+|p+s+t+|g+r+|b+r+)\W*', t, re.I):     # "Hz", "H z0"; not "Hmm"
        return False
    if len(re.findall(r'\b(pr|cl|qc|ts|tl|rp|rd|mtl)\b', t, re.I)) >= 2:      # a scanlation team's credits
        return False
    if re.match(r'\W*(chapter|episode|ep|ch)\.? ?\d+', t, re.I):        # the chapter's title
        return False
    marks = len(re.findall(r"[.,!?…~'\"\-—:;]", t))             # normal punctuation doesn't count against a line ("UH...", "...HMM?")
    if len(letters) < 2 or len(letters) < 0.6 * (len(t.replace(' ', '')) - marks):
        return False                                        # scraps of sound-effect art, other scripts
    if len(t.split()) <= 2 and t.upper() == t and not re.search(r'[.!?,~…]', t):
        return False                                        # STEP, DASH, SHAKE, name captions
    if title and len(squash(t)) >= 3 and not re.search(r'[.!…~]', t) and (
            squash(t) in squash(title) or _title_like(t, title)):
        return False                                        # the title page (also when read a bit wrong)
    if CREDIT.search(t) or CREDIT.search(re.sub(r'(?<=[a-z])(?=[A-Z&])|(?<=&)', ' ', t)):
        return False                                        # scanlator credits
    if (len(t.split()) <= 4 and (WATERMARK.search(t) or re.search(r'toon|scan', t, re.I))) or (len(t.split()) <= 6 and re.search(r'\b(?=\w*\d)(?=\w*[A-Za-z])\w{4,}\b', t)):
        return False                                        # "Nu via Toon.", "NuviaToon SH0010", "com", site names
    if re.fullmatch(r"\W*(admin|uploader|raws?|tl|pr|qc|ts|cleaners?|editors?|typesetters?|translators?|staff|credits)\W*", t, re.I):
        return False                                        # a credit word on its own
    if len(t.split()) == 1 and len(letters) <= 4 and t.lower() == t and not re.search(r'[.!?]', t):
        return False                                        # a lone scrap like "com"
    return True


def _title_like(t, title):
    """most of the words are words of one of the manga's names ("My ? Waited in the Wheat Fields")"""
    words = [w for w in re.findall(r'[a-z]+', t.lower()) if len(w) > 1]
    names = set(re.findall(r'[a-z]+', title.lower()))
    return len(words) >= 3 and sum(w in names for w in words) >= 0.75 * len(words)
