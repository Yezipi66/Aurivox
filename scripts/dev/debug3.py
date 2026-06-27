import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
PROJECT = r"D:\Project\tts_broker_openai_compat"

env = os.environ.copy()
env['PYTHONPATH'] = PROJECT + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv-code'
env['PYTHONUNBUFFERED'] = '1'

# Check if gsv_code is a namespace package or regular package
r = subprocess.run(
    [PYTHON, '-c',
     'import os; '
     'path = r"D:\\Project\\tts_broker_openai_compat\\lib\\training\\gsv-code"; '
     'print("dir exists:", os.path.isdir(path)); '
     'print("contents:", os.listdir(path)[:10]); '
     'init = os.path.join(path, "__init__.py"); '
     '__init__.py exists:", os.path.exists(init))'],
    capture_output=True, text=True, timeout=10, env=env
)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:200])

# Try: is there a gsv_code in venv site-packages?
r2 = subprocess.run(
    [PYTHON, '-c',
     'import os; '
     'sp = r"D:\\Project\\tts_broker_openai_compat\\venv\\Lib\\site-packages"; '
     'gsv = os.path.join(sp, "gsv_code"); '
     'print("gsv_code in site-packages:", os.path.exists(gsv)); '
     'if os.path.exists(gsv): print("contents:", os.listdir(gsv)[:5])'],
    capture_output=True, text=True, timeout=10, env=env
)
print(r2.stdout)
if r2.stderr: print("stderr:", r2.stderr[:200])
