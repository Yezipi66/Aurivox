import subprocess, sys, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\lib\training\run_pipeline.py"

sys.stdout.reconfigure(encoding='utf-8')
print("Running full pipeline for 日文 (Japanese)...")
print("This will take ~30-60 minutes total.\n")

proc = subprocess.Popen(
    [PYTHON, script, "--voice", "Raiden_JA", "--lang", "ja", "--work-dir", "D:/Project/tts_broker_openai_compat/test_raiden/日文",
     "--gpt-epochs", "20", "--sovits-epochs", "100"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1,
    env={**os.environ, 'PYTHONUNBUFFERED': '1'}
)

for line in proc.stdout:
    print(line, end='')

proc.wait()
print(f"\n\nPipeline exit: {proc.returncode}")
