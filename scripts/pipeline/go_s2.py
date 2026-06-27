import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\s2_train_test.py"
log = r"D:\Project\tts_broker_openai_compat\s2_train.log"

env = os.environ.copy()
env['PYTHONUNBUFFERED'] = '1'

with open(log, 'w', encoding='utf-8') as f:
    proc = subprocess.Popen([PYTHON, '-u', script], stdout=f, stderr=subprocess.STDOUT,
        text=True, env=env)
    proc.wait()

print(f"Exit: {proc.returncode}")
