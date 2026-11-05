"""The panels of a manga page, as far as the reading order needs them: the page is cut along its gutters (the white, or on
dark pages the black, between panels), straight or slanted, whole rows first and then columns, right column first. Only cuts
that part two bubbles matter. A page with no clear gutters stays one panel, and its bubbles keep the row order."""
import numpy as np
import cv2

WIDTH = 600           # worked out at this width
SLANT = 0.14          # how far a gutter may lean, as a share of its length
COVER = 0.96          # how much of a cut must run along the gutter (bubbles that lie over a gutter count as gutter)


def gutter_mask(gray):
    """the page's gutters: white joined to the page's edge, or black on a page whose edge is mostly black"""
    edge = np.concatenate([gray[0, :], gray[-1, :], gray[:, 0], gray[:, -1]])
    dark = (edge < 60).mean() > 0.6
    m = (gray < 50 if dark else gray > 225).astype(np.uint8)
    n, lab = cv2.connectedComponents(m, connectivity=4)
    keep = set(lab[0, :].tolist()) | set(lab[-1, :].tolist()) | set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
    keep.discard(0)
    out = np.isin(lab, list(keep))
    return out if 0.005 < out.mean() < 0.45 else None


def _best_cut(mask, region, boxes, horizontal):
    """the straight line through the region that follows the gutter and parts the bubbles (a, b, x0, x1, y0, y1) or None. For a
    row cut a, b are y at the region's left and right; for a column cut x at its top and bottom."""
    ys, xs = np.nonzero(region)
    if not len(xs):
        return None
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    span = (x1 - x0) if horizontal else (y1 - y0)
    if span < 20:
        return None
    H, W = mask.shape
    limit = (H if horizontal else W) - 1
    lean_max = int(SLANT * span)
    t = np.linspace(0, 1, span // 2 + 1)
    along = ((x0 + t * (x1 - x0)) if horizontal else (y0 + t * (y1 - y0))).round().astype(int)[None, :]
    mx, my = np.array([(b[0] + b[2]) / 2 for b in boxes]), np.array([(b[1] + b[3]) / 2 for b in boxes])
    best = None
    for lean in sorted(range(-lean_max, lean_max + 1, 2), key=abs):
        # only lines with a bubble's middle on both sides
        at = (my - lean * (mx - x0) / max(1, x1 - x0)) if horizontal else (mx - lean * (my - y0) / max(1, y1 - y0))
        starts = np.arange(int(np.ceil(at.min())), int(np.floor(at.max())) + 1)
        if not len(starts):
            continue
        line = starts[:, None] + t[None, :] * lean
        score = None
        for off in (0, 1):                                       # a gutter has some width: not a chance white crack
            q = (line + off).round().astype(int).clip(0, limit)
            inside = region[q, along] if horizontal else region[along, q]
            g = mask[q, along] if horizontal else mask[along, q]
            count = inside.sum(1)
            cov = (g & inside).sum(1) / np.maximum(count, 1)
            cov[count < 0.5 * t.size] = 0
            score = cov if score is None else np.minimum(score, cov)
        k = int(np.argmax(score)); sc = float(score[k])
        if sc >= COVER and (best is None or sc > best[0] + 1e-6):
            sides = [_side(box, int(starts[k]), int(starts[k]) + lean, x0, x1, y0, y1, horizontal) for box in boxes]
            if any(sides) and not all(sides):
                best = (sc, int(starts[k]), int(starts[k]) + lean)
        if best is not None and best[0] > 0.995:                 # clean: no need to try leaning lines further
            break
    return None if best is None else (best[1], best[2], x0, x1, y0, y1)


def _bubble_shapes(small, boxes):
    """the bubbles themselves: their white around the text, with the outline"""
    H, W = small.shape
    white = (small > 200).astype(np.uint8)
    # the letters go inside the white: close them over
    n, lab, st, _ = cv2.connectedComponentsWithStats(cv2.morphologyEx(white, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)), connectivity=4)
    out = np.zeros_like(white, bool)
    for x0, y0, x1, y1 in boxes:
        a, b, c, d = max(0, int(x0)), max(0, int(y0)), min(W, int(x1) + 1), min(H, int(y1) + 1)
        out[max(0, b - 4):d + 4, max(0, a - 4):c + 4] = True
        ids, counts = np.unique(lab[b:d, a:c], return_counts=True)
        for k, cnt in zip(ids, counts):
            if k == 0 or cnt < 0.3 * (c - a) * (d - b):
                continue
            if st[k, cv2.CC_STAT_WIDTH] * st[k, cv2.CC_STAT_HEIGHT] <= 6 * max(1, (c - a) * (d - b)):   # not an open white panel
                out |= lab == k
    return cv2.dilate(out.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)


def _side(box, a, b, x0, x1, y0, y1, horizontal):
    """True = the bubble's middle is below (row cut) / right of (column cut) the line"""
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    if horizontal:
        return cy > a + (b - a) * (cx - x0) / max(1, x1 - x0)
    return cx > a + (b - a) * (cy - y0) / max(1, y1 - y0)


def _split(mask, region, boxes, idx, out, rtl):
    if len(idx) < 2:
        out.append(list(idx))
        return
    sub = [boxes[i] for i in idx]
    for horizontal in (True, False):                             # whole rows first, then columns
        cut = _best_cut(mask, region, sub, horizontal)
        if cut is None:
            continue
        a, b, x0, x1, y0, y1 = cut
        H, W = mask.shape
        yy, xx = np.mgrid[0:H, 0:W]
        if horizontal:
            after = yy > a + (b - a) * (xx - x0) / max(1, x1 - x0)
        else:
            after = xx > a + (b - a) * (yy - y0) / max(1, y1 - y0)
        hi = [i for i in idx if _side(boxes[i], a, b, x0, x1, y0, y1, horizontal)]
        lo = [i for i in idx if i not in hi]
        first, second = (lo, hi) if horizontal or not rtl else (hi, lo)   # top before bottom; right before left in manga
        fr, sr = (region & ~after, region & after) if first is lo else (region & after, region & ~after)
        _split(mask, fr, boxes, first, out, rtl)
        _split(mask, sr, boxes, second, out, rtl)
        return
    out.append(list(idx))


def order(gray, boxes, rtl=True):
    """gray = the page as a 2-D array, boxes = the bubbles' [x0, y0, x1, y1] on it. -> each bubble's panel number, in reading
    order (all 0 when the page has no clear gutters)"""
    if len(boxes) < 2 or gray.shape[0] > 3 * gray.shape[1]:      # a long strip page has no such panels
        return [0] * len(boxes)
    s = WIDTH / gray.shape[1]
    small = cv2.resize(gray, (WIDTH, max(1, int(gray.shape[0] * s))), interpolation=cv2.INTER_AREA)
    mask = gutter_mask(small)
    if mask is None:
        return [0] * len(boxes)
    sb = [[v * s for v in b] for b in boxes]
    m = mask | _bubble_shapes(small, sb)                         # a bubble lying over a gutter doesn't close it
    leaves = []
    _split(m, np.ones_like(m, bool), sb, list(range(len(sb))), leaves, rtl)
    res = [0] * len(boxes)
    for n, leaf in enumerate(leaves):
        for i in leaf:
            res[i] = n
    return res
