"""Downloads what the helper needs: the voices, the English text reader and the speaker finder's models."""
import os, shutil, time, urllib.request
os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
import torch  # noqa: F401  (the graphics card libraries for onnxruntime)
from huggingface_hub import hf_hub_download
HERE = os.path.dirname(os.path.abspath(__file__)); M = os.path.join(HERE, 'models'); os.makedirs(os.path.join(M, 'ocr_en'), exist_ok=True)


def retry(fn, what):
    for k in range(10):
        try:
            return fn()
        except Exception as e:
            print('retrying', what, type(e).__name__, flush=True); time.sleep(8)
    raise SystemExit('could not download ' + what)


BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'
for f in ('kokoro-v1.0.onnx', 'voices-v1.0.bin'):
    if not os.path.exists(os.path.join(M, f)):
        print('downloading', f, flush=True)
        retry(lambda: urllib.request.urlretrieve(BASE + f, os.path.join(M, f)), f)
for src, name in (('languages/english/rec.onnx', 'en_new.onnx'), ('languages/english/dict.txt', 'en_new_dict.txt')):
    shutil.copy2(retry(lambda: hf_hub_download('monkt/paddleocr-onnx', src), name), os.path.join(M, 'ocr_en', name))
print('speaker finder models', flush=True)
from PIL import Image
from transformers import CLIPModel, CLIPProcessor
retry(lambda: (CLIPModel.from_pretrained('openai/clip-vit-base-patch32'), CLIPProcessor.from_pretrained('openai/clip-vit-base-patch32')), 'CLIP')
from imgutils.detect import detect_faces, detect_person
blank = Image.new('RGB', (256, 256), 'white')
retry(lambda: (detect_faces(blank), detect_person(blank)), 'face finder')
print('models ready', flush=True)
