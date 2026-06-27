import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\step1_run2.py"

env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat\lib\training'
env['PYTHONUNBUFFERED'] = '1'

log = r"D:\Project\tts_broker_openai_compat\step1.log"

with open(log, 'w', encoding='utf-8') as f:
    proc = subprocess.Popen([PYTHON, '-u', script], stdout=f, stderr=subprocess.STDOUT,
        text=True, env=env)
    proc.wait()

with open(log, 'r', encoding='utf-8') as f:
    print(f.read())

print(f"EXIT: {proc.returncode}")
