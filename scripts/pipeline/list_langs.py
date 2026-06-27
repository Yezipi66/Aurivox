import subprocess, os, json, shutil, sys

# Fix MSYS path mangling: use forward slashes internally
# MSYS converts D:\ to /d/ which Python on Windows handles fine
PYTHON = "D:/Project/tts_broker_openai_compat/venv/Scripts/python.exe"
TOOLS = "D:/Project/tts_broker_openai_compat/lib/training/gsv-tools"
FFMPEG = "D:/AI/GPT-SoVITS-v2pro-20250604/runtime/ffmpeg.exe"

base = "D:/voices/raiden"
work_base = "D:/Project/tts_broker_openai_compat/test_raiden"

# List language dirs
for d in sorted(os.listdir(base)):
    path = os.path.join(base, d)
    if os.path.isdir(path):
        files = [f for f in os.listdir(path) if f.endswith('.mp3')]
        print(f"  {d}: {len(files)} mp3 files")
