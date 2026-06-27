import subprocess, sys, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\test_raiden_e2e.py"
output_log = r"D:\Project\tts_broker_openai_compat\test_raiden.log"

with open(output_log, 'w', encoding='utf-8') as log_file:
    proc = subprocess.Popen(
        [PYTHON, script],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env={**os.environ, 'PYTHONUNBUFFERED': '1'},
    )
    proc.wait()

print(f"Exit: {proc.returncode}")
print(f"Log written to: {output_log}")
