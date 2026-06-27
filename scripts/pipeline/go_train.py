import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\run_s1s2_v4.py"
log = r"D:\Project\tts_broker_openai_compat\s1s2_training.log"

env = os.environ.copy()
env['PYTHONUNBUFFERED'] = '1'
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat\lib\training'

with open(log, 'w', encoding='utf-8') as f:
    proc = subprocess.Popen([PYTHON, '-u', script], stdout=f, stderr=subprocess.STDOUT,
        text=True, bufsize=1, env=env)
    proc.wait()

print(f"Training exit: {proc.returncode}")
print(f"Log: {log}")
