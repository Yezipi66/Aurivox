import subprocess, os, sys

# Test: does uv Python respect PYTHONPATH at all?
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat'
env['PYTHONUNBUFFERED'] = '1'

r = subprocess.run(
    [r'D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe', '-c',
     'import os; print("PYTHONPATH:", os.environ.get("PYTHONPATH", "NOT SET")); import sys; print("sys.path has project:", any("tts_broker" in p for p in sys.path))'],
    capture_output=True, text=True, timeout=10, env=env
)
print("Test 1 - PYTHONPATH via env:")
print(r.stdout)

# Test 2: use -c to add to sys.path
r2 = subprocess.run(
    [r'D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe', '-c',
     'import sys; sys.path.insert(0, r"D:\Project\tts_broker_openai_compat"); sys.path.insert(0, r"D:\Project\tts_broker_openai_compat\lib\training\gsv-code"); from gsv_code.text.cleaner import clean_text; print("OK!")'],
    capture_output=True, text=True, timeout=10
)
print("\nTest 2 - sys.path.insert in -c:")
print(r2.stdout)
if r2.stderr: print(r2.stderr[:200])
