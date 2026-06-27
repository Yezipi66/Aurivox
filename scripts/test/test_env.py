import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\debug_path.py"

env = {**os.environ, 'PYTHONPATH': r'D:\Project\tts_broker_openai_compat;D:\Project\tts_broker_openai_compat\lib\training\gsv-code'}

r = subprocess.run([PYTHON, script], capture_output=True, text=True, timeout=10, env=env)
print("STDOUT:", r.stdout)
print("STDERR:", r.stderr[:200])
