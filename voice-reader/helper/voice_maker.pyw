"""Voice Maker for the Atsu Voice Reader: make "My voice" (female and male) from short recorded clips.
Record (the Record button shows the line to read) or add 5-6 clips of 10-15 s per voice, each in another mood (calm, happy, excited, angry, sad, soft, teasing). They are
cleaned (mono, hiss and rumble taken out, silences trimmed, even loudness, at most 15 s) and kept in voices\\female /
voices\\male. The reader picks the clip whose mood fits each bubble. Only use voices you have permission to use.  Start: "Voice Maker.bat" (or pythonw voice_maker.pyw)."""
import json, os, re, shutil, subprocess, sys, tempfile, threading, time, urllib.parse, urllib.request, wave, winsound
import tkinter as tk
from tkinter import filedialog, ttk

HERE = os.path.dirname(os.path.abspath(__file__))
VOICES = os.path.join(HERE, 'voices')
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); from ffmpeg_path import FFMPEG
HELPER = 'http://127.0.0.1:8795'
MOODS = ['calm', 'happy', 'excited', 'angry', 'sad', 'soft', 'teasing']
WORDS = {'calm': ('calm', 'normal', 'neutral', 'plain'), 'happy': ('happy', 'cheer', 'smile', 'laugh', 'joy'),
         'excited': ('excit', 'hype', 'energ', 'loud'), 'angry': ('angry', 'anger', 'mad', 'shout', 'yell', 'rage'),
         'sad': ('sad', 'cry', 'upset', 'down'), 'soft': ('soft', 'whisper', 'quiet', 'shy', 'gentle'),
         'teasing': ('teas', 'flirt', 'smug', 'playful')}
TRY = {'calm': "I think we should head back before it gets dark.", 'happy': "Really? You'd do that for me? That makes me so happy!",
       'excited': "Look, look! The fireworks are starting! Hurry up!", 'angry': "Shut up! I told you never to come back here!",
       'sad': "...I guess it doesn't matter anymore. Nobody's coming.", 'soft': "Hey... thank you. For staying with me tonight.",
       'teasing': "Oh? Is that a blush I see? How cute~"}
FLAGS = 0x08000000                                           # no console window
# the recording sheet: one line per mood, 10-15 s read in character
SHEET = {'female': {
    'calm': "I think we should head back soon. It's getting dark, and the last train leaves at nine. We can always come back tomorrow, okay?",
    'happy': "Really? You made this for me? Thank you! I love it so much. I'm going to keep it forever, I promise!",
    'excited': "Look, look! The fireworks are starting! Come on, hurry up, we're going to miss the best part! Wow, did you see that one?",
    'angry': "Don't you dare walk away from me! You said you'd be there, and you lied! I'm done waiting for you, do you hear me?",
    'sad': "...It's okay. I knew you wouldn't come. I just... I really wanted to see you one more time, that's all.",
    'soft': "Hey... thank you. For staying with me tonight. I don't think I could have slept alone, not after today.",
    'teasing': "Oh? Your face is all red. Don't tell me you were worried about me~ Hmm? You were, weren't you? How cute."},
  'male': {
    'calm': "Stay close and keep your voice down. The guards change shifts in five minutes. When they do, we move. Not before.",
    'happy': "Ha! I can't believe it actually worked! You were amazing back there. Come on, dinner's on me tonight.",
    'excited': "There it is! The gate's open! Go, go, go, this is our only chance! Don't look back, just run!",
    'angry': "Enough! I'm sick of your excuses! You put everyone in danger, and you don't even care! Get out of my sight!",
    'sad': "...I should have been there. If I'd been a little faster, she'd still be here. I'm sorry. I'm so sorry.",
    'soft': "Hey. It's alright now. I'm here. Get some sleep, I'll keep watch until morning. Nobody's getting past me.",
    'teasing': "Heh. Scared of a little thunder? Don't worry, I won't tell anyone. Well... maybe just a few people."}}


def mics():
    """the PC's microphones (ffmpeg's DirectShow list)"""
    r = subprocess.run([FFMPEG, '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', creationflags=FLAGS)
    return re.findall(r'"([^"]+)" \(audio\)', r.stderr)
ENGINES = {'fast': 'Fast (keeps up with reading)', 'expressive': 'Expressive (slower, more feeling)'}
BG, CARD, FG, DIM, VIO, PINK, BLUE = '#17151c', '#221f2b', '#ece6f8', '#9d94b3', '#8b5cf6', '#e0679f', '#5b9bf0'


def guess_mood(name, taken):
    low = name.lower()
    for m, ws in WORDS.items():
        if any(w in low for w in ws):
            return m
    return next((m for m in MOODS if m not in taken), 'calm')


def wav_secs(path):
    try:
        with wave.open(path) as w:
            return w.getnframes() / w.getframerate()
    except Exception:
        return 0.0


def clean(src, dst):
    """mono 24 kHz; rumble + hiss out; long silences shortened, ends trimmed; even loudness; at most 15 s"""
    af = ('highpass=f=70,afftdn=nf=-28,'
          'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.1:'
          'stop_periods=-1:stop_threshold=-42dB:stop_duration=0.5:stop_silence=0.3,'
          'loudnorm=I=-20:TP=-2,adelay=250,apad=pad_dur=0.3')
    r = subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '24000', '-af', af, '-t', '15.5',
                        '-c:a', 'pcm_s16le', dst], capture_output=True, text=True, creationflags=FLAGS)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-300:] or 'ffmpeg failed')


class Voice:
    def __init__(self, kind):
        self.kind = kind                                      # 'female' | 'male'
        self.dir = os.path.join(VOICES, kind)
        self.meta_path = os.path.join(self.dir, 'voice.json')
        try:
            self.meta = json.load(open(self.meta_path, encoding='utf-8'))
        except (OSError, ValueError):
            self.meta = {'clips': []}
        self.meta['clips'] = [c for c in self.meta['clips'] if os.path.exists(os.path.join(self.dir, c['file']))]

    def save(self):
        os.makedirs(self.dir, exist_ok=True)
        self.meta['updated'] = time.time()
        tmp = self.meta_path + '.tmp'
        json.dump(self.meta, open(tmp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
        os.replace(tmp, self.meta_path)

    def add(self, src, mood=None):
        os.makedirs(os.path.join(self.dir, 'originals'), exist_ok=True)
        n = 1 + max([int(c['file'][4:7]) for c in self.meta['clips']] or [0])
        name = f'clip{n:03d}.wav'
        shutil.copy2(src, os.path.join(self.dir, 'originals', f'clip{n:03d}{os.path.splitext(src)[1].lower()}'))
        clean(src, os.path.join(self.dir, name))
        secs = wav_secs(os.path.join(self.dir, name))
        c = {'file': name, 'mood': mood or guess_mood(os.path.basename(src), [x['mood'] for x in self.meta['clips']]),
             'secs': round(secs, 1), 'from': os.path.basename(src)}
        self.meta['clips'].append(c); self.save()
        return c

    def remove(self, c):
        self.meta['clips'].remove(c)
        for p in (os.path.join(self.dir, c['file']),):
            try:
                os.remove(p)
            except OSError:
                pass
        self.save()

    def summary(self):
        cs = self.meta['clips']
        if not cs:
            return 'No clips yet: add 5-6 clips of 10-15 s, each in another mood.', DIM
        total = sum(c['secs'] for c in cs)
        short = [c for c in cs if c['secs'] < 6]
        moods = sorted(set(c['mood'] for c in cs), key=MOODS.index)
        msg = f'{len(cs)} clip{"s" if len(cs) > 1 else ""}, {total:.0f} s  ·  moods: {", ".join(moods)}'
        if short:
            return msg + f'\n{len(short)} clip(s) under 6 s: a little short for the voice to come through.', '#f0b45b'
        if len(cs) < 3:
            return msg + '\nReady to use. More moods = livelier reading.', FG
        return msg + '\nReady: choose "My voice" in the reader\'s violet settings.', '#7ee0a8'


class Column:
    def __init__(self, app, parent, kind, title, colour):
        self.app, self.v = app, Voice(kind)
        self.frame = tk.Frame(parent, bg=CARD, padx=14, pady=12)
        tk.Label(self.frame, text=title, bg=CARD, fg=colour, font=('Segoe UI Semibold', 13)).pack(anchor='w')
        bar = tk.Frame(self.frame, bg=CARD); bar.pack(fill='x', pady=(8, 6))
        self.rec_btn = self.btn(bar, '● Record', self.record); self.rec_btn.config(bg='#c2416b', activebackground='#a8325a')
        self.rec_btn.pack(side='left')
        self.btn(bar, 'Add clips…', self.add_clips).pack(side='left', padx=6)
        self.rec = None
        self.engine = tk.StringVar(value=ENGINES.get(self.v.meta.get('engine', 'fast')))
        ttk.Combobox(bar, textvariable=self.engine, values=list(ENGINES.values()), width=30, state='readonly').pack(side='right')
        self.engine.trace_add('write', lambda *_: (self.v.meta.update(engine=next(k for k, v in ENGINES.items() if v == self.engine.get())),
                                                   self.v.save(), self.app.status('Style saved: the reader makes its lines again in it.')))
        rm = tk.Frame(self.frame, bg=CARD); rm.pack(fill='x')
        tk.Label(rm, text='Mood to record:', bg=CARD, fg=DIM, font=('Segoe UI', 9)).pack(side='left')
        self.rec_mood = tk.StringVar(value=next((m for m in MOODS if m not in [c['mood'] for c in self.v.meta['clips']]), 'calm'))
        ttk.Combobox(rm, textvariable=self.rec_mood, values=MOODS, width=9, state='readonly').pack(side='left', padx=6)
        self.line = tk.Label(self.frame, bg='#2a2635', fg=FG, justify='left', wraplength=360, font=('Segoe UI', 10, 'italic'), padx=8, pady=6)
        self.line.pack(fill='x', pady=(6, 4))
        self.rec_mood.trace_add('write', lambda *_: self.show_line())
        self.show_line()
        self.list = tk.Frame(self.frame, bg=CARD); self.list.pack(fill='both', expand=True)
        self.info = tk.Label(self.frame, bg=CARD, fg=DIM, justify='left', wraplength=360, font=('Segoe UI', 9))
        self.info.pack(anchor='w', pady=(8, 6))
        tr = tk.Frame(self.frame, bg=CARD); tr.pack(fill='x')
        self.mood = tk.StringVar(value='calm')
        ttk.Combobox(tr, textvariable=self.mood, values=MOODS, width=9, state='readonly').pack(side='left')
        self.say_btn = self.btn(tr, 'Say it', self.try_it); self.say_btn.pack(side='left', padx=6)
        self.text = tk.Entry(self.frame, bg='#2c2838', fg=FG, insertbackground=FG, relief='flat', font=('Segoe UI', 10))
        self.text.pack(fill='x', pady=(6, 0), ipady=4)
        self.text.insert(0, TRY['calm'])
        self.mood.trace_add('write', lambda *_: (self.text.delete(0, 'end'), self.text.insert(0, TRY[self.mood.get()])))
        self.draw()

    def btn(self, parent, text, cmd):
        return tk.Button(parent, text=text, command=cmd, bg=VIO, fg='white', activebackground='#7c4ddb', activeforeground='white',
                         relief='flat', padx=10, pady=3, font=('Segoe UI', 9, 'bold'), cursor='hand2')

    def draw(self):
        for w in self.list.winfo_children():
            w.destroy()
        for c in self.v.meta['clips']:
            row = tk.Frame(self.list, bg='#2a2635', padx=8, pady=4); row.pack(fill='x', pady=2)
            tk.Button(row, text='▶', command=lambda c=c: self.app.play(os.path.join(self.v.dir, c['file'])), bg='#2a2635', fg=FG,
                      relief='flat', cursor='hand2', width=2).pack(side='left')
            tk.Label(row, text=f"{c['secs']:4.1f} s", bg='#2a2635', fg=FG if c['secs'] >= 6 else '#f0b45b', width=6,
                     font=('Consolas', 9)).pack(side='left')
            mv = tk.StringVar(value=c['mood'])
            cb = ttk.Combobox(row, textvariable=mv, values=MOODS, width=9, state='readonly'); cb.pack(side='left', padx=4)
            mv.trace_add('write', lambda *_, c=c, mv=mv: (c.update(mood=mv.get()), self.v.save(), self.draw()))
            tk.Label(row, text=c['from'][:26], bg='#2a2635', fg=DIM, font=('Segoe UI', 8)).pack(side='left', padx=4)
            tk.Button(row, text='✕', command=lambda c=c: (self.v.remove(c), self.draw()), bg='#2a2635', fg=DIM, relief='flat',
                      cursor='hand2').pack(side='right')
        msg, col = self.v.summary()
        self.info.config(text=msg, fg=col)

    def show_line(self):
        self.line.config(text='Read: "' + SHEET[self.v.kind][self.rec_mood.get()] + '"')

    def record(self):
        if self.rec:                                          # stop
            return self.stop_rec()
        mic = self.app.mic.get()
        if not mic:
            return self.app.status('No microphone found.')
        path = os.path.join(tempfile.gettempdir(), f'voice_maker_{self.v.kind}.wav')
        self.rec = {'path': path, 't': time.time(), 'mood': self.rec_mood.get(),
                    'p': subprocess.Popen([FFMPEG, '-y', '-loglevel', 'error', '-f', 'dshow', '-i', f'audio={mic}', '-ac', '1', '-ar', '48000',
                                           '-t', '17', path], stdin=subprocess.PIPE, creationflags=FLAGS)}
        self.rec_btn.config(text='■ Stop (0 s)')
        self.app.status(f'Recording the {self.rec["mood"]} line… read it in character, then press Stop (it stops by itself at 17 s).')
        self.tick_rec()

    def tick_rec(self):
        if not self.rec:
            return
        if self.rec['p'].poll() is not None:                  # stopped by itself
            return self.stop_rec()
        self.rec_btn.config(text=f'■ Stop ({time.time() - self.rec["t"]:.0f} s)')
        self.app.root.after(250, self.tick_rec)

    def stop_rec(self):
        r, self.rec = self.rec, None
        self.rec_btn.config(text='● Record')
        p = r['p']
        if p.poll() is None:
            try:
                p.stdin.write(b'q'); p.stdin.flush()
            except OSError:
                pass
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        if not os.path.exists(r['path']) or os.path.getsize(r['path']) < 10000:
            return self.app.status('Nothing was recorded: check the microphone at the top.')
        self.app.status('Cleaning the recording…')

        def work():
            try:
                c = self.v.add(r['path'], r['mood'])
                nxt = next((m for m in MOODS if m not in [x['mood'] for x in self.v.meta['clips']]), r['mood'])
                self.app.root.after(0, lambda: (self.draw(), self.rec_mood.set(nxt),
                                                self.app.status(f"Saved the {c['mood']} clip ({c['secs']} s). Press ▶ to hear it.")))
            except Exception as e:
                self.app.root.after(0, lambda: self.app.status(f'Could not save it: {e}'))
        threading.Thread(target=work, daemon=True).start()

    def add_clips(self):
        fs = filedialog.askopenfilenames(parent=self.app.root, title=f'Clips for the {self.v.kind} voice',
                                         filetypes=[('Audio', '*.wav *.mp3 *.m4a *.ogg *.opus *.flac *.aac *.wma *.webm *.mp4'), ('All files', '*.*')])
        if not fs:
            return
        self.app.status(f'Cleaning {len(fs)} clip(s)…')

        def work():
            bad = []
            for f in fs:
                try:
                    self.v.add(f)
                except Exception as e:
                    bad.append(f'{os.path.basename(f)}: {e}')
            self.app.root.after(0, lambda: (self.draw(), self.app.status('; '.join(bad)[:200] if bad else f'Added {len(fs) - len(bad)} clip(s).')))
        threading.Thread(target=work, daemon=True).start()

    def try_it(self):
        if not self.v.meta['clips']:
            return self.app.status('Add some clips first.')
        text, mood = self.text.get().strip(), self.mood.get()
        if not text:
            return
        self.say_btn.config(state='disabled', text='Making…'); self.app.status('Making the line (the first one takes about half a minute)…')

        def work():
            try:
                q = urllib.parse.urlencode({'voice': 'FO' if self.v.kind == 'female' else 'MO', 'text': text, 'mood': mood, 'now': '1'})
                t = time.time()
                wav = urllib.request.urlopen(f'{HELPER}/speak?{q}', timeout=300).read()
                p = os.path.join(VOICES, f'_try_{self.v.kind}.wav'); open(p, 'wb').write(wav)
                self.app.root.after(0, lambda: (self.app.play(p), self.app.status(f'Made in {time.time() - t:.1f} s.')))
            except Exception as e:
                msg = "The reader's helper isn't running" if 'refused' in str(e).lower() or 'urlopen' in str(e).lower() else str(e)[:160]
                self.app.root.after(0, lambda: self.app.status(msg))
            finally:
                self.app.root.after(0, lambda: self.say_btn.config(state='normal', text='Say it'))
        threading.Thread(target=work, daemon=True).start()


class App:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title('Voice Maker - Atsu Voice Reader')
        self.root.configure(bg=BG)
        self.root.geometry(os.environ.get('VM_GEOMETRY', '860x680'))
        st = ttk.Style(self.root); st.theme_use('clam')
        st.configure('TCombobox', fieldbackground='#2c2838', background='#2c2838', foreground=FG, arrowcolor=FG)
        st.map('TCombobox', fieldbackground=[('readonly', '#2c2838')], foreground=[('readonly', FG)],
               selectbackground=[('readonly', '#2c2838')], selectforeground=[('readonly', FG)])
        self.root.option_add('*TCombobox*Listbox.background', '#2c2838'); self.root.option_add('*TCombobox*Listbox.foreground', FG)
        self.root.option_add('*TCombobox*Listbox.selectBackground', VIO)
        tk.Label(self.root, text='Voice Maker', bg=BG, fg='#c4b5fd', font=('Segoe UI Semibold', 16)).pack(anchor='w', padx=16, pady=(12, 0))
        tk.Label(self.root, bg=BG, fg=DIM, justify='left', font=('Segoe UI', 9),
                 text='5-6 clips of 10-15 s per voice, each in another mood, read in character. Quiet room, same mic.\n'
                      'Only use voices you have permission to use. Everything stays on this PC.').pack(anchor='w', padx=16)
        mrow = tk.Frame(self.root, bg=BG); mrow.pack(fill='x', padx=16, pady=(8, 0))
        tk.Label(mrow, text='Microphone:', bg=BG, fg=DIM, font=('Segoe UI', 9)).pack(side='left')
        found = mics()
        self.mic = tk.StringVar(value=found[0] if found else '')
        ttk.Combobox(mrow, textvariable=self.mic, values=found, width=48, state='readonly').pack(side='left', padx=6)
        cols = tk.Frame(self.root, bg=BG); cols.pack(fill='both', expand=True, padx=12, pady=10)
        self.cols = [Column(self, cols, 'female', 'Female voice', PINK), Column(self, cols, 'male', 'Male voice', BLUE)]
        for c in self.cols:
            c.frame.pack(side='left', fill='both', expand=True, padx=4)
        self.bar = tk.Label(self.root, text='', bg=BG, fg=DIM, anchor='w', font=('Segoe UI', 9)); self.bar.pack(fill='x', padx=16, pady=(0, 10))

    def status(self, t):
        self.bar.config(text=t)

    def play(self, path):
        try:
            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
        except RuntimeError as e:
            self.status(f'Could not play: {e}')


if __name__ == '__main__':
    App().root.mainloop()
