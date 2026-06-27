import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
# Put the PARENT directory in PYTHONPATH, not the package directory itself
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat\lib\training'
env['PYTHONUNBUFFERED'] = '1'

with open(r'D:\Project\tts_broker_openai_compat\_verify_final.py', 'w', encoding='utf-8') as f:
    f.write('import sys, os\n')
    f.write('import importlib.util\n')
    f.write('spec = importlib.util.find_spec("gsv_code")\n')
    f.write('print("find_spec:", spec)\n')
    f.write('from gsv_code import utils\n')
    f.write('print("import OK!")\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_verify_final.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:200])
