"""Who says a bubble: woman or man (or unknown -> the female voice).
The bubble's outline is found around its text and its tail (the thin part an opening removes); the speaker is the
person / face the tail points at (CLIP judges the area it points at when nobody was found there), else forms of
address decide ("my lady" / "-chan" are said TO a woman, "my lord" / "-kun" TO a man), else the nearest figure.
Light: an anime face / person finder (small onnx models, processor) + CLIP ViT-B/32 (about 0.3 GB on the GPU).
Measured 31 / 36 test bubbles (86 %), see _dev_tools/test_speaker_v3.py."""
import json, math, os, re
import cv2, numpy as np
from PIL import Image

CLIP_ID = 'openai/clip-vit-base-patch32'
LABELS = ['an anime drawing of a girl', 'an anime drawing of a young woman', 'an anime drawing of a boy', 'an anime drawing of a man']
# forms of address: only when someone is being spoken TO - at the start or end of the line or set off by commas
# ("My lady, ...", "..., my lord.", "Aikawa-kun..."), never a mention like "my father's greed"
_W = r"my lady|milady|miss|ma'?am|madam|young lady|princess|big sister|sis|onee-?(?:san|chan|sama)?|mom|mother"
_M = r"my lord|sir|young master|master|big brother|bro|onii-?(?:san|chan|sama)?|dad|father"
_EDGE = r"(?:^|[,.!?…~]\s*|\.\.\.\s*)(?:{w})(?=\s*(?:[,.!?…~]|$))"
# Name-kun / Name-chan, also run together or misread by the text reader ("shunpeikun", "shlnpeikun")
TO_WOMAN = re.compile(_EDGE.format(w=_W) + r"|\b\w+[- ]chan\b|\b[a-z]{3,}chan\b", re.I)
TO_MAN = re.compile(_EDGE.format(w=_M) + r"|\b\w+[- ]kun\b|\b[a-z]{3,}kun\b", re.I)
_m = {}


def _load():
    if 'clip' not in _m:
        import torch
        from transformers import CLIPModel, CLIPProcessor
        dev = 'cuda' if torch.cuda.is_available() else 'cpu'
        dt = torch.float16 if dev == 'cuda' else torch.float32
        clip = CLIPModel.from_pretrained(CLIP_ID, torch_dtype=dt).to(dev).eval()
        proc = CLIPProcessor.from_pretrained(CLIP_ID)
        with torch.no_grad():
            tf = clip.get_text_features(**proc(text=LABELS, return_tensors='pt', padding=True).to(dev))
            tf = tf / tf.norm(dim=-1, keepdim=True)
        _m.update(clip=clip, proc=proc, tf=tf, dev=dev, dt=dt, torch=torch)
    return _m


def unload():
    if 'clip' in _m:
        torch = _m['torch']
        _m.clear()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def woman(crop):
    m = _load(); torch = m['torch']
    with torch.no_grad():
        f = m['clip'].get_image_features(**{k: v.to(m['dev'], m['dt']) for k, v in m['proc'](images=crop, return_tensors='pt').items()})
        f = f / f.norm(dim=-1, keepdim=True)
        p = (100 * f @ m['tf'].T).softmax(-1)[0].float().cpu().numpy()
    return float(p[0] + p[1])


def _flood(white, seed):
    mask = np.zeros((white.shape[0] + 2, white.shape[1] + 2), np.uint8)
    cv2.floodFill(white.copy(), mask, seed, 2, flags=4 | (255 << 8) | cv2.FLOODFILL_MASK_ONLY)
    return mask[1:-1, 1:-1] > 0


def _gutters(a):
    """the white between panels: white connected to the edge of the picture (none on pages with open white backgrounds)"""
    g = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY)
    n, lab = cv2.connectedComponents((g > 225).astype(np.uint8), connectivity=4)
    edge = set(lab[0, :].tolist()) | set(lab[-1, :].tolist()) | set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
    edge.discard(0)
    m = np.isin(lab, list(edge))
    return m if m.mean() < 0.4 else None


def _crosses(gut, a, b):
    """does the straight line a -> b leave the panel?"""
    if gut is None:
        return False
    n = int(max(abs(a[0] - b[0]), abs(a[1] - b[1])) / 2) + 2
    for k in range(3, n):
        x, y = int(a[0] + (b[0] - a[0]) * k / n), int(a[1] + (b[1] - a[1]) * k / n)
        if 0 <= y < gut.shape[0] and 0 <= x < gut.shape[1] and gut[y, x]:
            return True
    return False


def bubble_and_tail(a, rb):
    """the bubble's outline around its text, traced as it is drawn (no smoothing: that erases thin manga outlines and the
    trace leaks out), and its tail: the part an opening removes. -> (centre, tip, direction) or (centre, None, None)"""
    g = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY)
    white = (g > 190).astype(np.uint8)
    x0, y0, x1, y1 = [int(v) for v in rb]
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    ys, xs = np.nonzero(white[max(0, y0):min(a.shape[0], y1), max(0, x0):min(a.shape[1], x1)])
    if not len(xs):
        return None, None, None
    k = int(np.argmin((xs + max(0, x0) - cx) ** 2 + (ys + max(0, y0) - cy) ** 2))
    seed = (int(xs[k] + max(0, x0)), int(ys[k] + max(0, y0)))
    region = None
    for w in (white, cv2.erode(white, np.ones((3, 3), np.uint8))):   # a broken outline: thicker lines close it
        if not w[seed[1], seed[0]]:
            continue
        r = _flood(w, seed)
        rows, cols = np.nonzero(r)
        leaks = r.sum() > 0.3 * r.size or rows.min() == 0 or cols.min() == 0 or rows.max() == r.shape[0] - 1 or cols.max() == r.shape[1] - 1
        if not leaks and r.sum() >= 300:
            region = r.astype(np.uint8); break
    if region is None:
        return None, None, None
    cnts, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    region = cv2.drawContours(np.zeros_like(region), cnts, -1, 1, -1)   # the letters' holes filled
    bx, by, bw, bh = cv2.boundingRect(region)
    ksize = max(9, int(0.4 * min(bw, bh))) | 1
    body = cv2.morphologyEx(region, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksize, ksize)))
    if not body.any():
        return (bx + bw / 2, by + bh / 2), None, None
    ys, xs = np.nonzero(body); centre = (float(xs.mean()), float(ys.mean()))
    fat = cv2.dilate(body, np.ones((3, 3), np.uint8))
    rest = cv2.subtract(region, fat)
    dist = cv2.distanceTransform(1 - body, cv2.DIST_L2, 5)
    n, lab, st, _ = cv2.connectedComponentsWithStats(rest)
    best = None
    for c in range(1, n):
        if st[c, cv2.CC_STAT_AREA] < 10:
            continue
        ys, xs = np.nonzero(lab == c)
        d = dist[ys, xs]; t = int(d.argmax()); reach = float(d[t])
        base = d <= d.min() + 2
        bwidth = max(xs[base].max() - xs[base].min(), ys[base].max() - ys[base].min()) + 1
        at_edge = xs[t] <= 3 or ys[t] <= 3 or xs[t] >= a.shape[1] - 4 or ys[t] >= a.shape[0] - 4
        if not at_edge and reach >= max(6, 0.07 * min(bw, bh)) and bwidth <= 1.6 * reach + 4 and (best is None or reach > best[0]):
            best = (reach, (int(xs[t]), int(ys[t])), (float(xs[base].mean()), float(ys[base].mean())))
    if not best:
        return centre, None, None
    _, tip, bas = best
    dx, dy = tip[0] - bas[0], tip[1] - bas[1]
    ox, oy = tip[0] - centre[0], tip[1] - centre[1]
    L1, L2 = math.hypot(dx, dy) or 1, math.hypot(ox, oy) or 1
    vx, vy = dx / L1 + ox / L2, dy / L1 + oy / L2                     # the way the tail runs, and away from the bubble's middle
    L = math.hypot(vx, vy) or 1
    return centre, tip, (vx / L, vy / L)


def _g(w, hi=0.6, lo=0.4):
    return 'F' if w > hi else 'M' if w < lo else 'U'


def figures(page):
    """every person / face on the page, found once (on a smaller copy, in overlapping windows), each judged woman / man
    once: [(kind, box on the page, woman score)]"""
    from imgutils.detect import detect_faces, detect_person
    W, H = page.size
    s = min(1.0, 560 / W)
    small = page.resize((max(1, int(W * s)), max(1, int(H * s))), Image.LANCZOS) if s < 1 else page
    found = []
    win, step = 900, 700
    y = 0
    while True:
        part = small.crop((0, y, small.width, min(small.height, y + win)))
        a = np.asarray(part.convert('L'))
        if a.std() > 6:                                      # nothing drawn here: skip
            for kind, fn in (('person', detect_person), ('face', detect_faces)):
                for bb, _, sc in fn(part):
                    if sc <= 0.35:
                        continue
                    B = [bb[0] / s, (bb[1] + y) / s, bb[2] / s, (bb[3] + y) / s]
                    if any(k == kind and _iou(B, o) > 0.5 for k, o, _ in found):
                        continue
                    found.append((kind, B, None))
        if y + win >= small.height:
            break
        y += step
    out = []
    for kind, B, _ in found:
        pad = 0.15 * (B[2] - B[0])
        out.append((kind, B, woman(page.crop((max(0, B[0] - pad), max(0, B[1] - pad), min(W, B[2] + pad), min(H, B[3] + pad))))))
    return out


def _iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / max(1e-6, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def who(page, box, text, figs=None, tails=None):
    """page: PIL image of the whole page; box: the bubble's text box on it; figs: figures(page) (found once per page).
    -> ('F' | 'M' | 'U', why)"""
    if figs is None:
        figs = figures(page)
    W, H = page.size
    x0, y0, x1, y1 = box
    ctx = max(500, W * 0.7)
    top, bot = max(0, y0 - ctx), min(H, y1 + ctx)
    img = page.crop((0, int(top), W, int(bot)))
    s = min(1.0, 1200 / img.width, 1600 / img.height)
    if s < 1:
        img = img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)
    rb = [x0 * s, (y0 - top) * s, x1 * s, (y1 - top) * s]
    a = np.asarray(img)
    # the page's people that reach into this window (cut to it), in the window's (smaller) coordinates
    scored = [(kind, [B[0] * s, (max(B[1], top) - top) * s, B[2] * s, (min(B[3], bot) - top) * s], w) for kind, B, w in figs
              if B[3] > top + 20 and B[1] < bot - 20]
    if tails is None:
        tails = os.environ.get('SPEAKER_TAILS', '1') == '1'
    centre, tip, way = bubble_and_tail(a, rb)
    if not tails:                                            # manhwa: bubbles rarely point, the closest person decides
        tip = None
    bx, by = centre if centre else ((rb[0] + rb[2]) / 2, (rb[1] + rb[3]) / 2)
    if tip:
        reach = 0.75 * img.width
        hits = []
        gut = _gutters(a)
        for kind, b, w in scored:
            fx, fy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            if kind == 'person':                                 # a body: its upper part is what a tail aims at
                fy = b[1] + 0.3 * (b[3] - b[1])
            if _crosses(gut, tip, (fx, fy)):                     # a tail stays in its own panel
                continue
            if kind == 'face' and b[0] - 8 <= tip[0] <= b[2] + 8 and b[1] - 8 <= tip[1] <= b[3] + 8:
                hits.append((-20, kind, w))                   # the tip is on their face
                continue
            qx, qy = fx - tip[0], fy - tip[1]
            along = qx * way[0] + qy * way[1]
            if along < -0.1 * (b[3] - b[1]) or along > reach:
                continue
            side = abs(qx * way[1] - qy * way[0])
            if kind == 'face':
                if side <= 0.5 * max(b[2] - b[0], b[3] - b[1]) + 0.12 * max(along, 0) + 6:     # the tail's line passes through it
                    hits.append((max(along, 0) - 15, kind, w))
            elif side <= 0.3 * (b[2] - b[0]) + 6 and along <= 0.35 * reach and along > 0:
                hits.append((along + 40, kind, w))             # a body seen from behind: only close, and after any face
        if hits:
            _, kind, w = min(hits, key=lambda h: h[0])
            return _g(w), f'tail -> {kind}'
    to_w, to_m = bool(TO_WOMAN.search(text)), bool(TO_MAN.search(text))
    if to_w != to_m:
        return ('M' if to_w else 'F'), 'form of address'
    if scored:
        kind, b, w = min(scored, key=lambda f: math.hypot((f[1][0] + f[1][2]) / 2 - bx, (f[1][1] + f[1][3]) / 2 - by) * (0.8 if (f[1][1] + f[1][3]) / 2 > by else 1))
        return _g(w), f'nearest {kind}'
    return 'U', 'nobody found'


def joined_groups(page, boxes):
    """bubbles drawn joined together (one outline around both) belong to one speaker: a group number per text box"""
    W, H = page.size
    s = min(1.0, 560 / W)
    small = page.resize((max(1, int(W * s)), max(1, int(H * s))), Image.BILINEAR) if s < 1 else page
    g = cv2.cvtColor(np.asarray(small.convert('RGB')), cv2.COLOR_RGB2GRAY)
    white = cv2.morphologyEx((g > 200).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    label = np.zeros(white.shape, np.int32)
    out, nxt = [], 1
    for (x0, y0, x1, y1) in boxes:
        bx0, by0, bx1, by1 = [int(v * s) for v in (x0, y0, x1, y1)]
        cx, cy = (bx0 + bx1) // 2, (by0 + by1) // 2
        seed = None
        for r in range(0, max(bx1 - bx0, by1 - by0) // 2 + 2, 2):        # a white pixel near the text's middle
            for x, y in ((cx + r, cy), (cx - r, cy), (cx, cy + r), (cx, cy - r)):
                if 0 <= x < white.shape[1] and 0 <= y < white.shape[0] and white[y, x]:
                    seed = (x, y); break
            if seed:
                break
        if seed is None:
            out.append(-len(out) - 1); continue                          # no bubble around it: on its own
        if label[seed[1], seed[0]]:
            out.append(int(label[seed[1], seed[0]])); continue           # inside a bubble already filled: the same one
        mask = np.zeros((white.shape[0] + 2, white.shape[1] + 2), np.uint8)
        area, _, _, rect = cv2.floodFill(white.copy(), mask, seed, 2, flags=4 | (255 << 8))
        if area > 0.25 * white.size:                                      # leaked into an open white page: on its own
            out.append(-len(out) - 1); continue
        region = mask[1:-1, 1:-1] > 0
        label[region & (label == 0)] = nxt
        out.append(nxt); nxt += 1
    return out


class Cast:
    """who looks like whom in a series (imgutils CCIP groups the figures): each character keeps a running girl / boy score, so one
    bad angle doesn't flip them. Kept per series in cache\series\<manga>.cast.json, so later chapters start out knowing them."""
    MAX_CHARS, EXAMPLES, SURE = 40, 8, 4

    def __init__(self, path=None):
        self.path, self.chars = path, []
        if path and os.path.exists(path):
            try:
                self.chars = [dict(c, f=[np.asarray(x, np.float32) for x in c['f']]) for c in json.load(open(path))]
            except (OSError, ValueError, KeyError):
                self.chars = []

    def judge(self, crop, w):
        """crop: the figure, w: its own girl score -> the score to use"""
        from imgutils.metrics import ccip_default_threshold, ccip_difference, ccip_extract_feature
        if min(crop.size) < 24:
            return w
        f = ccip_extract_feature(crop)
        best = None
        for c in self.chars:
            d = float(np.mean([ccip_difference(f, x) for x in c['f'][:self.EXAMPLES]]))
            if best is None or d < best[0]:
                best = (d, c)
        if best and best[0] < ccip_default_threshold():
            c = best[1]
            c['sum'] += w; c['n'] += 1
            if len(c['f']) < self.EXAMPLES:
                c['f'].append(f)
        else:
            c = {'sum': w, 'n': 1, 'f': [f]}
            self.chars.append(c)
            if len(self.chars) > self.MAX_CHARS:
                self.chars.sort(key=lambda x: -x['n']); self.chars.pop()
        mean = c['sum'] / c['n']
        return mean if c['n'] >= self.SURE and (mean > 0.72 or mean < 0.28) else w      # only when the character is clearly one or the other

    def save(self):
        if self.path:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + '.tmp'
            json.dump([dict(c, f=[[round(float(v), 4) for v in x] for x in c['f']]) for c in self.chars], open(tmp, 'w'))
            os.replace(tmp, self.path)
