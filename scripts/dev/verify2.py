import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv_code'
env['PYTHONUNBUFFERED'] = '1'

with open(r'D:\Project\tts_broker_openai_compat\_verify2.py', 'w', encoding='utf-8') as f:
    f.write('import os, sys\n')
    f.write('print("PYTHONPATH:", os.environ.get("PYTHONPATH", "NOT SET")[:100])\n')
    f.write('import importlib.util\n')
    f.write('spec = importlib.util.find_spec("gsv_code")\n')
    f.write('print("find_spec:", spec)\n')
    f.write('from gsv_code import utils\n')
    f.write('print("import OK")\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_verify2.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:200])
