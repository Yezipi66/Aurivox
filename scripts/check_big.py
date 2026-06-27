import os

src = r'D:\Project\tts_broker_openai_compat'
exclude_dirs = {
    'venv', 'node_modules', '.git', '__pycache__',
    'logs_s1', 'logs_s2', 'ckpt',
    'assets', '.staging', 'GPT_SoVITS',
    'gsv-tools/pretrained', 'gsv-tools/models', 'gsv-tools/uvr5_weights',
    'gsv-tools/asr/models', 'gsv-tools/asr/faster-whisper-large-v3',
    'gsv-tools/asr/faster-whisper-large-v3-turbo',
}
exclude_exts = {'.pyc', '.pth', '.pt', '.onnx', '.zip', '.model', '.ckpt', '.safetensors', '.bin'}

big = []
for root, dirs, files in os.walk(src):
    dirs[:] = [d for d in dirs if d not in exclude_dirs]
    for f in files:
        full = os.path.join(root, f)
        ext = os.path.splitext(f)[1].lower()
        if ext in exclude_exts:
            continue
        rel = os.path.relpath(full, src)
        parts = rel.replace('\\', '/').split('/')
        if any(p in exclude_dirs for p in parts):
            continue
        try:
            sz = os.path.getsize(full)
            if sz > 500 * 1024:
                big.append((sz, rel))
        except:
            pass

big.sort(reverse=True)
for sz, rel in big[:20]:
    print(f'{sz/1024/1024:.1f} MB  {rel}')
