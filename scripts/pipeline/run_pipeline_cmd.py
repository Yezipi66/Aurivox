import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\lib\training\run_pipeline.py"
log = r"D:\Project\tts_broker_openai_compat\pipeline_ja.log"

sys.stdout.reconfigure(encoding='utf-8')
cmd = [PYTHON, script, "--voice", "Raiden_JA", "--lang", "ja",
       "--work-dir", r"D:\Project\tts_broker_openai_compat\test_raiden\日文",
       "--gpt-epochs", "20", "--sovits-epochs", "100"]

print(f"Running pipeline...")
print(f"  log: {log}")

with open(log, 'w', encoding='utf-8') as f:
    proc = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT,
                           text=True, env={**os.environ, 'PYTHONUNBUFFERED': '1'})
    proc.wait()

print(f"Exit: {proc.returncode}")
