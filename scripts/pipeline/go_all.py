import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\run_all_steps.py"
log = r"D:\Project\tts_broker_openai_compat\pipeline_all.log"

env = os.environ.copy()
env['PYTHONUNBUFFERED'] = '1'
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat\lib\training'

with open(log, 'w', encoding='utf-8') as f:
    proc = subprocess.Popen([PYTHON, '-u', script], stdout=f, stderr=subprocess.STDOUT,
        text=True, bufsize=1, env=env)
    proc.wait()

print(f"Exit: {proc.returncode}")
print(f"Log: {log}")
