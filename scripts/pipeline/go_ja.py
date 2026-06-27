import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\run_ja_full.py"
log = r"D:\Project\tts_broker_openai_compat\ja_pipeline.log"

sys.stdout.reconfigure(encoding='utf-8')
print("Starting full pipeline for Japanese...")
print(f"Log: {log}")

with open(log, 'w', encoding='utf-8') as f:
    proc = subprocess.Popen(
        [PYTHON, script],
        stdout=f,
        stderr=subprocess.STDOUT,
        text=True,
        env={**os.environ, 'PYTHONUNBUFFERED': '1'},
    )
    proc.wait()

print(f"Exit: {proc.returncode}")
