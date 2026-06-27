import subprocess, sys, os

sys.stdout.reconfigure(encoding='utf-8')

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\test_raiden_e2e.py"

proc = subprocess.Popen(
    [PYTHON, script],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    env={**os.environ, 'PYTHONUNBUFFERED': '1'},
    bufsize=1
)

for line in proc.stdout:
    print(line, end='')

proc.wait()
print(f"\nExit: {proc.returncode}")
