"""The helper's two workers, each its own process, each quitting after IDLE seconds without work (so every bit of
memory, GPU included, is given back; the helper starts it again when needed):
  'pages'  reads a page: speech bubbles, cleaned text, who says each (GPU: text reader, face / person finder, CLIP)
  'voice'  speaks a line with the chosen voice (processor only, never touches the GPU)"""
import io, os, subprocess, sys, time, traceback, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'}
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); from ffmpeg_path import FFMPEG
# the voices picked from the samples: F4 (Bella, a touch brighter) and M5 (Echo)
VOICES = {'F': ('af_bella', 1.03, 1.8), 'M': ('am_echo', 1.02, 0.5)}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()


def page_job(url, title, manga=True, series=None):
    from PIL import Image
    import ocr, speaker, textfix
    img = Image.open(io.BytesIO(get(url))).convert('RGB')
    t0 = time.time()
    found = ocr.bubbles(ocr.second_look(img, ocr.read_page(img)))
    t1 = time.time()
    figs = speaker.figures(img) if found else []
    if os.environ.get('READER_CAST') == '1':                 # off: no gain measured on the labelled pages (57 / 62 with and without)
        try:                                                 # the series' cast: a bad angle doesn't flip someone
            cast = speaker.Cast(os.path.join(HERE, 'cache', 'series', f'{series}.cast.json') if series else None)
            figs = [(kd, B, cast.judge(img.crop([int(v) for v in B]), w)) for kd, B, w in figs]
            cast.save()
        except Exception:
            traceback.print_exc()
    out = []
    for b in found:
        if not ocr.is_speech(b['text'], title):
            continue
        text = textfix.clean(b['text'])
        if not ocr.is_speech(text, title):
            continue
        try:
            g, why = speaker.who(img, b['box'], text, figs, tails=manga)
        except Exception as e:                               # never lose a bubble over the speaker guess
            g, why = 'U', f'error {e}'
        out.append({'text': text, 'box': [round(v, 1) for v in b['box']], 'voice': 'M' if g == 'M' else 'F', 'guess': g, 'why': why})
    # joined bubbles are one speaker: they all take the guess with the strongest clue
    try:
        rank = lambda o: 3 if o['why'].startswith('tail') else 2 if o['why'] == 'form of address' else 1 if o['guess'] in 'FM' else 0
        groups = speaker.joined_groups(img, [o['box'] for o in out])
        for gid in set(gr for gr in groups if gr > 0):
            members = [o for o, gr in zip(out, groups) if gr == gid]
            if len(members) > 1:
                best = max(members, key=lambda o: (rank(o), len(o['text'])))   # clues tie: the bubble with the most text
                for o in members:
                    if o is not best and o['guess'] != best['guess'] and rank(best) >= rank(o):
                        o.update(guess=best['guess'], voice=best['voice'], why=f"joined to a bubble ({best['why']})")
    except Exception as e:
        out = [dict(o, why=o['why'] + f' (join check failed: {e})') for o in out]
    return {'w': img.width, 'h': img.height, 'bubbles': out, 'secs': round(time.time() - t0, 1), 'text_secs': round(t1 - t0, 1)}


_tts = {}


def voice_job(text, voice):
    import soundfile as sf
    if 'k' not in _tts:
        import onnxruntime as ort
        from kokoro_onnx import Kokoro
        so = ort.SessionOptions(); so.intra_op_num_threads = 2; so.inter_op_num_threads = 1
        # the full model on the GPU: 0.2-0.4 s a line (10x faster than speech; the processor managed 2x, and much less
        # when the PC is busy); the processor when there is no GPU
        prov = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if 'CUDAExecutionProvider' in ort.get_available_providers() else ['CPUExecutionProvider']
        sess = ort.InferenceSession(os.path.join(HERE, 'models', 'kokoro-v1.0.onnx'), so, providers=prov)
        _tts['device'] = sess.get_providers()[0]
        _tts['k'] = Kokoro.from_session(sess, os.path.join(HERE, 'models', 'voices-v1.0.bin'))
    import textfix
    name, speed, semi = VOICES.get(voice, VOICES['F'])
    audio, rate = _tts['k'].create(textfix.for_voice(text), voice=name, speed=speed, lang='en-us')
    raw = io.BytesIO(); sf.write(raw, audio, rate, format='WAV'); raw = raw.getvalue()
    f = 2 ** (semi / 12)
    af = (f'asetrate={rate}*{f:.5f},aresample={rate},atempo={1 / f:.5f},' if semi else '') + 'loudnorm=I=-16:TP=-1.5'
    out = subprocess.run([FFMPEG, '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-af', af, '-ar', '24000', '-f', 'wav', 'pipe:1'],
                         input=raw, capture_output=True, creationflags=0x08000000).stdout   # no console window
    return out or raw


def run(kind, conn, idle):
    """worker main loop: answer jobs from the helper; quit after `idle` seconds without one"""
    sys.path.insert(0, HERE)
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    os.environ.setdefault('TRANSFORMERS_VERBOSITY', 'error')
    import psutil
    psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    if kind == 'pages':
        import torch                                         # first: the CUDA 12 libraries for onnxruntime-gpu
        torch.set_num_threads(2)
    else:                                                    # the voice: the same CUDA 12 libraries, without loading torch
        try:
            import importlib.util
            lib = os.path.join(os.path.dirname(importlib.util.find_spec('torch').origin), 'lib')
            os.add_dll_directory(lib); os.environ['PATH'] = lib + os.pathsep + os.environ.get('PATH', '')
        except Exception:
            pass
    while conn.poll(idle):
        try:
            job = conn.recv()
        except EOFError:
            return
        try:
            res = page_job(*job) if kind == 'pages' else voice_job(*job)
            conn.send(('ok', res))
        except Exception:
            conn.send(('error', traceback.format_exc(limit=4)))
    conn.close()                                             # idle: quit, giving every bit of memory back
