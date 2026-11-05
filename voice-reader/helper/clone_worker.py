"""The "My voice" worker: Chatterbox speaking in the voice of the clips in voices\\female or voices\\male, started from
the clip whose mood fits the line. Two engines (voice.json 'engine'): 'fast' = Chatterbox Turbo (2-3 s a line on the
RTX 4060, the clip's mood carries over) and 'expressive' = Chatterbox (5-8 s a line, plus its emotion strength). Run by the reader's helper with .venv_voice\\Scripts\\python.exe PORT AUTHKEY; jobs come over a local
connection (multiprocessing.connection), answers go back as {"ok": True, "wav": bytes} / {"ok": False, "error"}.
(Not stdin: a read waiting on a pipe froze the imports on Windows.) Quits after READER_IDLE seconds without a job
(GPU memory goes back). Low priority."""
import io, json, os, subprocess, sys, traceback
from multiprocessing.connection import Client

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); from ffmpeg_path import FFMPEG
IDLE = int(os.environ.get('READER_IDLE', '300'))


def main():
    import psutil
    psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    conn = Client(('127.0.0.1', int(sys.argv[1])), authkey=bytes.fromhex(sys.argv[2]))
    import torch, numpy as np, soundfile as sf
    import mood as moods, textfix
    torch.set_num_threads(2)
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    loaded = {}                                              # one engine at a time: {'name', 'model'}

    def engine(name):
        if loaded.get('name') != name:
            loaded.clear(); conds.clear()
            if dev == 'cuda':
                torch.cuda.empty_cache()
            if name == 'expressive':
                from chatterbox.tts import ChatterboxTTS as M
            else:
                from chatterbox.tts_turbo import ChatterboxTurboTTS as M
            loaded.update(name=name, model=M.from_pretrained(device=dev))
        return loaded['model']
    conds = {}                                               # (engine, clip path, mtime, strength) -> prepared conditionals
    ear = {}

    def score(audio, sr, want):
        """listen back (Whisper base.en): how much of the line can be heard, 0..1. Names aren't judged: only common words"""
        import re, whisper
        from difflib import SequenceMatcher
        if 'm' not in ear:
            ear['m'] = whisper.load_model('base.en', device=dev)
        a16 = np.interp(np.arange(0, len(audio), sr / 16000), np.arange(len(audio)), audio).astype(np.float32)
        heard = ear['m'].transcribe(np.pad(a16, (8000, 8000)), language='en', fp16=dev == 'cuda', condition_on_previous_text=False)['text']
        ws = lambda t: re.findall(r"[a-z0-9']+", t.lower().replace('-', ' '))
        w, h = ws(want), ws(heard)
        w = [x for x in w if textfix._common(x) or len(w) <= 2]
        if not w:
            return 1.0, heard
        if len(w) <= 2:                                      # a word or two: compare the letters ("Well." / "Ahaha...")
            return SequenceMatcher(None, ''.join(w), ''.join(h)).ratio(), heard
        return sum(x.size for x in SequenceMatcher(None, w, h).get_matching_blocks()) / len(w), heard
    while True:
        try:
            if not conn.poll(IDLE):
                return                                       # idle: quit
            job = conn.recv()
        except (EOFError, OSError):
            return                                           # the helper is gone
        try:
            vdir = os.path.join(HERE, 'voices', job['kind'])
            meta = json.load(open(os.path.join(vdir, 'voice.json'), encoding='utf-8'))
            clips, name = meta['clips'], meta.get('engine', 'fast')
            model = engine(name)
            m = job.get('mood') or moods.mood_of(job['text'])
            clip = moods.pick_clip(clips, m)
            if not clip:
                raise RuntimeError('no clips for this voice yet')
            ex, cfg = moods.STRENGTH.get(m, moods.STRENGTH['calm'])
            path = os.path.join(vdir, clip['file'])
            if name != 'expressive':
                ex = 0.5                                     # Turbo has no strength: the clip's own mood carries over
            key = (name, path, os.path.getmtime(path), ex)
            if key not in conds:
                model.prepare_conditionals(path, exaggeration=ex)
                if len(conds) > 12:
                    conds.clear()
                conds[key] = model.conds
            model.conds = conds[key]
            spoken = textfix.for_voice(job['text'])
            words = len(spoken.split())
            # up to three takes; the first the ear is happy with, else the best. Very short lines also try a trailing "..."
            takes = [(spoken, moods.TEMPERATURE), (spoken, moods.TEMPERATURE + 0.15), (spoken.rstrip('.,!?… ') + '...' if words <= 2 else spoken, moods.TEMPERATURE - 0.1)]
            best = None
            for k, (say, temp) in enumerate(takes):
                with torch.inference_mode():
                    if name == 'expressive':
                        wav = model.generate(say, exaggeration=ex, cfg_weight=cfg, temperature=temp)
                    else:
                        wav = model.generate(say, temperature=max(0.5, temp + 0.3))
                a = wav.squeeze(0).float().cpu().numpy()
                try:
                    sc, heard = score(a, model.sr, spoken)
                except Exception:
                    sc, heard = 1.0, ''                          # no ear: keep the take
                if best is None or sc > best[0]:
                    best = (sc, a, k, heard)
                if sc >= (0.72 if words <= 2 else 0.85):
                    break
            sc, a, k, heard = best
            print(f'take {k + 1}/{len(takes)} score {sc:.2f} {spoken[:50]!r} heard {heard.strip()[:50]!r}', file=sys.stderr, flush=True)
            raw = io.BytesIO(); sf.write(raw, a, model.sr, format='WAV')
            res = subprocess.run([FFMPEG, '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-af', 'loudnorm=I=-16:TP=-1.5',
                                  '-ar', '24000', '-f', 'wav', 'pipe:1'], input=raw.getvalue(), capture_output=True,
                                 creationflags=0x08000000).stdout or raw.getvalue()
            conn.send({'ok': True, 'wav': res, 'mood': m, 'clip': clip['file']})
        except Exception:
            conn.send({'ok': False, 'error': traceback.format_exc(limit=3)})


if __name__ == '__main__':
    main()
