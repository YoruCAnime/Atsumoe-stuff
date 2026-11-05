@echo off
rem Sets up the voice reader's helper in this folder (about 6 GB). Needs Python 3.11 and an NVIDIA graphics card.
cd /d "%~dp0"
py -3.11 -m venv .venv_vision || (echo Python 3.11 not found: install it from python.org first. & pause & exit /b 1)
set P=.venv_vision\Scripts\python.exe
%P% -m pip install --upgrade pip
%P% -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121 || goto bad
%P% -m pip install -r requirements.txt || goto bad
rem The face finder asks for numpy below 2, the voice engine for 2 or newer: both run fine on this one.
%P% -m pip install --no-deps kokoro-onnx==0.6.1 numpy==2.4.6 || goto bad
%P% -m pip uninstall -y onnxruntime
%P% -m pip install --force-reinstall --no-deps onnxruntime-gpu==1.23.2 || goto bad
%P% -X utf8 setup_models.py || goto bad
echo.
echo Done. Next: "2 - Install helper" below, then install the userscript.
pause
exit /b 0
:bad
echo Something failed: see the messages above.
pause
exit /b 1
