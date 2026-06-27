import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv-code'
env['PYTHONUNBUFFERED'] = '1'

# Check directory structure
r = subprocess.run(
    [PYTHON, r'D:\Project\tts_broker_openai_compat\debug3.py'],
    capture_output=True, text=True, timeout=10, env=env
)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:200])
