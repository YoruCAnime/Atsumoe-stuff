"""Where ffmpeg is: READER_FFMPEG, or a path in ffmpeg.txt next to this file, or on the PATH."""
import os, shutil
_txt = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ffmpeg.txt')
FFMPEG = os.environ.get('READER_FFMPEG') or (open(_txt, encoding='utf-8').read().strip() if os.path.exists(_txt) else '') or shutil.which('ffmpeg') or 'ffmpeg'
