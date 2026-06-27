import os, tarfile

src = r'D:\Project\tts_broker_openai_compat'
dst = r'C:\Users\MECHREVO X10 Pro\Desktop\_check.tar.gz'

include_exts = {
    '.py', '.js', '.jsx', '.ts', '.tsx',
    '.json', '.yaml', '.yml',
    '.md', '.txt', '.html', '.css', '.scss',
    '.env', '.sh', '.cmd', '.bat',
    '.gitignore', '.dockerignore',
}
exclude_dirs = {
    'venv', 'node_modules', '.git', '__pycache__',
    'logs_s1', 'logs_s2', 'ckpt',
    'assets', '.staging', 'GPT_SoVITS',
    'gsv-tools/pretrained', 'gsv-tools/models', 'gsv-tools/uvr5_weights',
    'gsv-tools/asr/models', 'gsv-tools/asr/faster-whisper-large-v3',
    'gsv-tools/asr/faster-whisper-large-v3-turbo',
}
exclude_exts = {'.pyc', '.pth', '.pt', '.onnx', '.zip', '.model', '.ckpt', '.safetensors', '.bin'}
exclude_files = {'openai.env', '.env.local'}

def should_include(relpath):
    parts = relpath.replace('\\', '/').split('/')
    for p in parts:
        if p in exclude_dirs:
            return False
    ext = os.path.splitext(relpath)[1].lower()
    if ext in exclude_exts:
        return False
    basename = parts[-1]
    if basename in exclude_files:
        return False
    if ext in include_exts:
        return True
    if '.' not in basename:
        return True
    return False

problems = []
count = 0
size = 0
with tarfile.open(dst, 'w:gz') as tar:
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        rel_root = os.path.relpath(root, src)
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.join(rel_root, f) if rel_root != '.' else f
            if not should_include(rel):
                continue
            tar.add(full, arcname=rel)
            count += 1
            try:
                sz = os.path.getsize(full)
                size += sz
                if sz > 500 * 1024:
                    problems.append((sz, rel))
            except:
                pass

print(f'Total: {count} files, {size/1024/1024:.1f} MB')
print(f'\nFiles > 500KB:')
problems.sort(reverse=True)
for sz, rel in problems:
    print(f'  {sz/1024/1024:.1f} MB  {rel}')

# Also check: is web/ included?
print(f'\nweb/ files in archive:')
with tarfile.open(dst, 'r:gz') as tar:
    for m in tar.getmembers():
        if m.name.startswith('web/'):
            print(f'  {m.size:>8}  {m.name}')
