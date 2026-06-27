import subprocess, sys, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\run_ja_asr.py"

sys.stdout.reconfigure(encoding='utf-8')
print("Running Japanese ASR...")

# Use Popen for real-time output
proc = subprocess.Popen([PYTHON, script], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       text=True, bufsize=1, env={**os.environ, 'PYTHONUNBUFFERED': '1'})
for line in proc.stdout:
    print(line, end='')
proc.wait()
print(f"\nExit: {proc.returncode}")
