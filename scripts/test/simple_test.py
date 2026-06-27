import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat;D:\Project\tts_broker_openai_compat\lib\training\gsv-code'

r = subprocess.run(
    [PYTHON, '-c', 'import sys; print([p for p in sys.path if "tts_broker" in p or "gsv_code" in p])'],
    capture_output=True, text=True, timeout=10, env=env
)
print("sys.path:", r.stdout)
