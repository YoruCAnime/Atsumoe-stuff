"""The mood of a speech bubble, guessed from its words and marks, for "My voice" (Chatterbox): which recorded clip to
start from and how much feeling to put in. Plain Python (used by the helper and the voice worker)."""
import re

# mood -> (emotion strength for Chatterbox 0.25..1, cfg weight: lower = freer pacing for strong feeling)
# (cfg kept at 0.45-0.5: lower let the accent drift away from the recording - measured with accent_eval.py in _dev_tools)
STRENGTH = {'calm': (0.45, 0.7), 'soft': (0.4, 0.7), 'sad': (0.45, 0.7), 'happy': (0.5, 0.7), 'teasing': (0.5, 0.7),
            'excited': (0.6, 0.65), 'angry': (0.65, 0.65)}
TEMPERATURE = 0.5                                            # with cfg 0.7: words right 95.9 %, against 91.1 % at 0.8 / 0.5 (pron_eval.py)
# when the voice has no clip of that mood: the nearest ones it may have
NEAR = {'angry': ['excited', 'calm'], 'excited': ['happy', 'angry', 'calm'], 'happy': ['teasing', 'excited', 'calm'],
        'teasing': ['happy', 'calm'], 'sad': ['soft', 'calm'], 'soft': ['sad', 'calm'], 'calm': ['soft', 'happy']}

_ANGRY = re.compile(r"\b(shut up|how dare|damn|dammit|bastard|idiot|get out|go away|stop it|i'll kill|you'll pay|enough|leave me alone|bitch|hate you)\b", re.I)
_SAD = re.compile(r"\b(sorry|i'm sorry|forgive|miss you|alone|goodbye|no one|nobody|can't go on|it hurts|i failed|my fault)\b", re.I)
_HAPPY = re.compile(r"\b(thank you|thanks|yay|great|wonderful|i'm so happy|happy|love it|amazing|awesome|ha ?ha|hehe|ahaha)\b", re.I)
_TEASE = re.compile(r"(~|\bheh\b|\bhmm+\b|\bfufu|\boh\?|\bis that so\b|\bcute\b|\bblush)", re.I)
_SOFT = re.compile(r"\b(please|thank you|it's okay|it's alright|don't worry|good night|i see|um+|uh+)\b", re.I)


def mood_of(text):
    t = text.strip()
    bangs = t.count('!')
    if _ANGRY.search(t) and bangs:
        return 'angry'
    if _TEASE.search(t):
        return 'teasing'
    if bangs >= 2 or '?!' in t or '!?' in t:
        return 'excited'
    if _HAPPY.search(t):
        return 'happy'
    if bangs:
        return 'angry' if _ANGRY.search(t) else 'excited'
    if _SAD.search(t) or (t.startswith(('...', '…')) and t.endswith(('...', '…', '.'))):
        return 'sad'
    if _SOFT.search(t) or t.endswith(('...', '…')):
        return 'soft'
    return 'calm'


def pick_clip(clips, mood):
    """clips: [{'file', 'mood', ...}] -> the clip to start from"""
    for m in [mood] + NEAR.get(mood, []):
        for c in clips:
            if c['mood'] == m:
                return c
    return clips[0] if clips else None
