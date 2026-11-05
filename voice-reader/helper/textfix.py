"""Clean bubble text before it is spoken: split words the lettering ran together ("IFYOUFAIL" -> "IF YOU FAIL"),
mend hyphenation across lines ("bleed- ing" -> "bleeding"), and turn ALL-CAPS lettering into normal sentence case
(so the voice doesn't spell words out)."""
import functools, re
import wordninja

_lm = wordninja.DEFAULT_LANGUAGE_MODEL
KNOWN = set(_lm._wordcost)                                   # the splitter's own word list (lower case)
_costs = sorted(_lm._wordcost.values())
COMMON_COST = _costs[min(len(_costs) - 1, 30000)]           # the 30 000 commonest words: safe pieces to split into
CONTRACTION = re.compile(r"^([a-z]+'(?:ll|re|ve|m|s|t|d))([a-z]{2,})$")
SHORT = {'a', 'i', 'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'oh', 'ok',
         'on', 'or', 'so', 'to', 'up', 'us', 'we'}   # the only 1-2 letter pieces a split may make
KEEP = {'gonna', 'wanna', 'gotta', 'kinda', 'sorta', 'huh', 'hmm', 'mm', 'uh', 'um', 'eh', 'ah', 'oh', 'whoa', 'yeah', 'nah', 'okay', 'ok'}


def _known(w):
    return w in KNOWN or w in KEEP or len(w) <= 3


def _split_word(tok):
    """one token (may carry punctuation) -> the same with missing spaces put back"""
    m = re.match(r"^([^A-Za-z']*)([A-Za-z']+)([^A-Za-z']*)$", tok)
    if not m:
        return tok
    pre, core, post = m.groups()
    low = core.lower()
    if _known(low.replace("'", '')) or len(low) < 5:
        return tok
    c = CONTRACTION.match(low)
    if c:                                                    # YOU'LLBE -> YOU'LL BE
        head, rest = c.groups()
        parts = [core[:len(head)]] + _cased(core[len(head):], wordninja.split(rest))
        return pre + ' '.join(parts) + post
    if "'" in low:
        return tok
    parts = wordninja.split(low)
    common = lambda p: (p in SHORT) if len(p) <= 2 else (_lm._wordcost.get(p, 99) <= COMMON_COST or p in KEEP)
    if len(parts) < 2 or not all(common(p) for p in parts) or sum(len(p) == 1 for p in parts) > 1:
        return tok                                          # not a clean split: leave it
    return pre + ' '.join(_cased(core, parts)) + post


def _cased(orig, parts):
    out, i = [], 0
    for p in parts:
        out.append(orig[i:i + len(p)]); i += len(p)
    return out


def sentence_case(t):
    letters = re.sub(r'[^A-Za-z]', '', t)
    if not letters or sum(c.isupper() for c in letters) < 0.7 * len(letters):
        return t
    t = t.lower()
    t = re.sub(r"\bi\b", 'I', t)
    t = re.sub(r"\bi'(m|ll|ve|d)\b", lambda m: "I'" + m.group(1), t)
    return re.sub(r'(^|[.!?…]\s+|^\W+)([a-z])', lambda m: m.group(1) + m.group(2).upper(), t)


def clean(text):
    t = re.sub(r"\b(\w{1,2})- (?=\1)", r'\1-', text, flags=re.I)      # W- WHAT -> W-WHAT (a stutter)
    t = re.sub(r"(\w)- (?=(?:kun|chan|san|sama|senpai|sensei|tan)\b)", r'\1-', t, flags=re.I)   # AN- CHAN -> AN-CHAN
    t = re.sub(r'(\w)- (\w)', r'\1\2', t)                   # bleed- ing -> bleeding
    t = re.sub(r'\s+', ' ', t).strip()
    t = re.sub(r'([,!?;])(?=[A-Za-z])', r'\1 ', t)           # "CRAP,I'M" -> "CRAP, I'M"
    t = ' '.join(_split_word(w) for w in t.split(' '))
    t = re.sub(r'\b1\b(?=\s+[A-Za-z])', 'I', t)              # "1 DON'T" -> "I DON'T"
    return sentence_case(t)


if __name__ == '__main__':
    for s in ["THISPART IS WRONG.. AND THIS PART TOO", "CRAP,I'MNOT GONNAMAKEIT INTIMEFOR MIDTERMS!", "IFYOUFAIL; YOU'LLBE BANNED FROMCLUB ACTIVITIES,",
              "I'M GOING TOTHE RESTROOM.", "MY LIFE WILL FINALLYTURN AROUND!", "1 DON'T MIND, BUT...", "Wait, why are you bleed- ing?",
              "LURI, COULD YOU USE DRAGON FEAR ONCE THE KNIGHTS HAVE GATHERED?", "...SINCE IT CAN GET US THEREINJUSTAFEW HOURS,A JOURNEY THAT WOULDTAKE DAYS BY CARRIAGE.",
              "Oh yeah, Mai! My current boyfriend loves me so much!", "WH-WHERE DID THAT DRAGON SUDDENLY COME FROM?", "AM-M-MERE D-D-DRAGON..."]:
        print(f'{s}\n   -> {clean(s)}')


# ---------- letters the text reader mixes up in comic lettering ----------
# Some fonts' "u" comes out as "l" or "o" ("wolld", "colldn't", "blt", "olt", "suspiciols", "yolrnew"), "m" as "rn".
# A word that is not a common word is mended when swapping those letters gives a common word (or common words).
SWAPS = [('l', 'u'), ('o', 'u'), ('i', 'l'), ('rn', 'm'), ('ii', 'u'), ('0', 'o'), ('1', 'l'), ('vv', 'w')]
CONTRACTIONS = {"couldn't", "wouldn't", "shouldn't", "don't", "doesn't", "didn't", "can't", "won't", "isn't", "aren't", "wasn't",
                "weren't", "haven't", "hasn't", "hadn't", "mustn't", "you're", "you'll", "you've", "you'd", "i'm", "i'll", "i've", "i'd",
                "we're", "we'll", "we've", "we'd", "they're", "they'll", "they've", "they'd", "he's", "he'll", "he'd", "she's", "she'll",
                "she'd", "it's", "it'll", "that's", "there's", "here's", "what's", "who's", "where's", "how's", "let's", "y'all", "ain't"}
TOP_COST = _costs[min(len(_costs) - 1, 60000)]               # the 60 000 commonest words


def _common(w):
    return w in CONTRACTIONS or w in KEEP or (w in SHORT if len(w) <= 2 else _lm._wordcost.get(w, 99) <= (TOP_COST if len(w) > 3 else _costs[8000]))


def _variants(w, depth=2):
    out, frontier = set(), {w}
    for _ in range(depth):
        nxt = set()
        for v in frontier:
            for a, b in SWAPS:
                i = v.find(a)
                while i >= 0:
                    nxt.add(v[:i] + b + v[i + len(a):]); i = v.find(a, i + 1)
        out |= nxt; frontier = nxt
    return out


def _mend(tok):
    m = re.match(r"^([^A-Za-z0-9']*)([A-Za-z0-9']+)([^A-Za-z0-9']*)$", tok)
    if not m:
        return tok
    pre, core, post = m.groups()
    low = core.lower()
    if len(low) < 3 or _common(low) or not re.search(r'[a-z]', low):
        return tok
    if low[0] == 'i' and low[1:] in CONTRACTIONS:             # "Idon't" -> "I don't"
        return pre + 'I ' + core[1:] + post
    best = None
    for v in _variants(low):
        if _common(v):
            cost = 0 if v in CONTRACTIONS else _lm._wordcost.get(v, 9)
            if best is None or cost < best[0]:
                best = (cost, v)
    if best is None:                                         # "yolrnew" -> "your new"
        for v in [low] + sorted(_variants(low)):
            if "'" in v:
                continue
            parts = wordninja.split(v)
            if 2 <= len(parts) <= 3 and all(_common(x) and len(x) > 1 or x in ('a', 'i') for x in parts) and ''.join(parts) == v:
                best = (0, ' '.join(parts)); break
    if best is None:
        return tok
    fixed = best[1]
    if core[:1].isupper():
        fixed = fixed[:1].upper() + fixed[1:]
    if core.isupper() and len(core) > 1:
        fixed = fixed.upper()
    return pre + fixed + post


SOUNDS = {'lh': 'uh', 'lhh': 'uhh', 'lm': 'um', 'lmm': 'umm', 'hlh': 'huh', 'hlm': 'hum', 'hlnn': 'hunn'}   # short misread sounds


def _sound(tok):
    m = re.match(r"^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$", tok)
    if not m or m.group(2).lower() not in SOUNDS:
        return tok
    w = SOUNDS[m.group(2).lower()]
    return m.group(1) + (w.upper() if m.group(2).isupper() else w.capitalize() if m.group(2)[0].isupper() else w) + m.group(3)


HONORIFIC = re.compile(r"\b([A-Z][a-z]{2,})(kun|chan|san|sama|senpai|sensei|tan)\b")


def fix_letters(text):
    t = ' '.join(_sound(_mend(w)) for w in text.split(' '))
    # "Shunpeikun" -> "Shunpei-kun" (said as a name + honorific) when the whole is not a word
    return HONORIFIC.sub(lambda m: m.group(0) if _common(m.group(0).lower()) else m.group(1) + '-' + m.group(2), t)


# ---------- what's left after the English model ----------
_SWAPS2 = [('h', 'u')]                                       # "ushally"
_DIGITS = {'0': 'o', '1': 'l', '3': 'e', '4': 'y', '5': 's', '6': 's', '8': 'b'}


def tidy(t):
    t = re.sub(r"\b(\w)-{1,3} ?(?=\1)", r'\1-', t, flags=re.I)                  # W-- what -> W-what
    t = re.sub(r"\bami\b", 'am I', t)                                            # why ami always
    t = re.sub(r"\bAmi\b(?= (?:to|supposed|always|really|just|so|going|not|the)\b)", 'Am I', t)
    t = re.sub(r"\b0o\b", 'do', t)                                               # supposed to 0o
    t = re.sub(r"\b(\d+)o\b", r'\g<1>0', t)                                      # 5o chapters
    t = re.sub(r"\b([A-Za-z]{2,})(\d)\b", lambda m: m.group(1) + _DIGITS.get(m.group(2), m.group(2)) if _common((m.group(1) + _DIGITS.get(m.group(2), '')).lower()) else m.group(0), t)   # safet4
    # a word broken in two: "toge ther"
    def join(m):
        a, b = m.group(1), m.group(2)
        return a + b if not (_common(a.lower()) and _common(b.lower())) and _common((a + b).lower()) else m.group(0)
    t = re.sub(r"\b([A-Za-z]{2,}) ([A-Za-z]{2,})\b", join, t)
    # "ushally" -> "usually"
    def mend2(m):
        w = m.group(0); low = w.lower()
        if len(low) < 4 or _common(low):
            return w
        for a, b in _SWAPS2:
            i = low.find(a)
            while i >= 0:
                v = low[:i] + b + low[i + 1:]
                if _common(v) and _lm._wordcost.get(v, 99) <= _costs[20000]:
                    return v.capitalize() if w[0].isupper() else v
                i = low.find(a, i + 1)
        return w
    return re.sub(r"[A-Za-z]{4,}", mend2, t)


# ---------- Japanese names, spelled the way they should sound ----------
# The voice reads "Shunpei" as an English word ("shouldn't pay"). Sounded out it gets it: "Shoon-pay" + "kun"
# (the user's pick by ear, name_pick.html no. 3, in the Fast setting).
_ROMAJI = re.compile(r"(kk|tt|pp|ss)?(ky|gy|sy|ny|hy|by|py|my|ry|sh|ch|ts|[kgsztdnhbpmyrwfj])?(ai|ei|oi|ou|oo|uu|ii|aa|ee|a|i|u|e|o)(n(?![aiueoy]))?")
_SOUND = {'ai': 'eye', 'ei': 'ay', 'oi': 'oy', 'ou': 'oh', 'oo': 'oh', 'uu': 'oo', 'ii': 'ee', 'aa': 'ah', 'ee': 'eh', 'a': 'ah', 'i': 'ee', 'u': 'oo', 'e': 'eh', 'o': 'oh'}


def spell_name(word):
    """'Shunpei' -> 'Shoonpay', or None when it is not a Japanese-looking name"""
    low = word.lower(); i = 0; parts = []
    while i < len(low):
        m = _ROMAJI.match(low, i)
        if not m or m.end() == i:
            return None
        dbl, cons, vow, n = m.groups()
        parts.append((cons or '') + _SOUND[vow] + (n or ''))
        i = m.end()
    if len(parts) < 2:
        return None
    joined = '-'.join(parts)                                 # the user's pick by ear: "Shoon-pay"
    return joined.capitalize()


SAY_NAMES = True
HONORIFICS = [(re.compile(r"-kun\b", re.I), ' kun')]        # as in the sample the user picked; the others stay as they are


def say_honorifics(t):
    for rx, s in HONORIFICS:
        t = rx.sub(s, t)
    return t


# words the voice model can say the wrong way: "To think I'd live to see the day" came out like "livestream"
_LIVE_VERB = re.compile(r"\b((?:I|you|we|they|he|she|it)'(?:d|ll)|will|would|could|can|cannot|can't|must|should|might|may|"
                        r"never|still|to|and|or|just|always|really|actually|wanna|gonna|I|we|they|you)(\s+)live\b(?!\s*(?:stream|show|broadcast|music|wire|feed|action))",
                        re.I)


@functools.lru_cache(maxsize=8192)
def for_voice(text):
    """the text as it should be SPOKEN (the shown text stays as it is)"""
    text = tidy(fix_letters(text))
    if SAY_NAMES:
        text = say_honorifics(text)
    text = re.sub(r"\bi\b(?!')", 'I', text); text = re.sub(r"\bi'(m|ll|ve|d)\b", lambda m: "I'" + m.group(1), text)
    text = re.sub(r"\b([Aa]) b(?:ol|ou)t (that|it|this|you|him|her|them|the|what|how|me|us)\b", lambda m: ('About ' if m.group(1) == 'A' else 'about ') + m.group(2), text)   # "a bolt that" -> "about that"
    text = re.sub(r'[＃#]+', '', text.replace('！', '!').replace('？', '?')).strip()   # stray marks the reader picked up
    return _LIVE_VERB.sub(lambda m: m.group(1) + m.group(2) + ('Liv' if m.group(0).rstrip()[-4] == 'L' else 'liv'), text)
