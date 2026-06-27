import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
PROJECT = r"D:\Project\tts_broker_openai_compat"
script = os.path.join(PROJECT, "run_ja_full.py")
log = os.path.join(PROJECT, "ja_pipeline.log")

sys.stdout.reconfigure(encoding='utf-8')
print("Starting full pipeline for Japanese...")

# Set PYTHONPATH so gsv_code can be found
env = os.environ.copy()
env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
env['PYTHONUNBUFFERED'] = '1'

with open(log, 'w', encoding='utf-8') as f:
    proc = subprocess.Popen(
        [PYTHON, script],
        stdout=f,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    proc.wait()

print(f"Exit: {proc.returncode}")
print(f"Log: {log}")
