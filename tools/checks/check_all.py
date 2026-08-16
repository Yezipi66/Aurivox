import os

src = r'D:\Project\tts_broker_openai_compat'
all_files = []
for root, dirs, files in os.walk(src):
    for f in files:
        full = os.path.join(root, f)
        try:
            sz = os.path.getsize(full)
            rel = os.path.relpath(full, src)
            all_files.append((sz, rel))
        except:
            pass

all_files.sort(reverse=True)
for sz, rel in all_files[:30]:
    print(f'{sz/1024/1024:.1f} MB  {rel}')
