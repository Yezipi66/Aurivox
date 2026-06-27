import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\step4_real.py"
log = r"D:\Project\tts_broker_openai_compat\s1_8epoch.log"

# Use CREATE_NEW_CONSOLE so Python has its own console (no buffering)
env = os.environ.copy()
env['PYTHONUNBUFFERED'] = '1'

# Use subprocess with CREATE_NEW_CONSOLE flag
proc = subprocess.Popen(
    [PYTHON, '-u', script],
    stdout=open(log, 'w', encoding='utf-8'),
    stderr=subprocess.STDOUT,
    text=True,
    env=env,
    creationflags=subprocess.CREATE_NEW_CONSOLE,
)

print(f"PID: {proc.pid}")
print(f"Log: {log}")
print("Training started in background...")
