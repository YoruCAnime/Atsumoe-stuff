@echo off
rem Optional: speak in a voice made from your own short clips (about 8 GB). Needs "1 - Setup" done first.
cd /d "%~dp0"
py -3.11 -m venv .venv_voice || (echo Python 3.11 not found. & pause & exit /b 1)
set P=.venv_voice\Scripts\python.exe
%P% -m pip install --upgrade pip
%P% -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124 || goto bad
%P% -m pip install -r requirements-voice.txt || goto bad
%P% -m pip install --no-deps chatterbox-tts==0.1.7 || goto bad
%P% -c "from huggingface_hub import snapshot_download as d; d('ResembleAI/chatterbox-turbo'); d('ResembleAI/chatterbox'); import whisper; whisper.load_model('base.en', device='cpu')" || goto bad
echo.
echo Done. Open "Voice Maker.bat", add your clips, then choose My voice in the reader's settings.
pause
exit /b 0
:bad
echo Something failed: see the messages above.
pause
exit /b 1
