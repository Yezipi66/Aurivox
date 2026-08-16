import os

gsv = r'D:\Project\tts_broker_openai_compat\gsv-tools'
for root, dirs, files in os.walk(gsv):
    for f in files:
        full = os.path.join(root, f)
        sz = os.path.getsize(full)
        rel = os.path.relpath(full, gsv)
        if sz > 100 * 1024:
            print(f'{sz/1024/1024:.1f} MB  {rel}')
