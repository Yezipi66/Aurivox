import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv-code'
env['PYTHONUNBUFFERED'] = '1'

# Write a temp script that checks sys.path and tries import
with open(r'D:\Project\tts_broker_openai_compat\_check.py', 'w', encoding='utf-8') as f:
    f.write('import sys\n')
    f.write('import os\n')
    f.write('print("PYTHONPATH:", os.environ.get("PYTHONPATH", "NOT SET"))\n')
    f.write('print("sys.path entries with tts_broker or gsv_code:")\n')
    f.write('for p in sys.path:\n')
    f.write('    if "tts_broker" in p or "gsv_code" in p:\n')
    f.write('        print(" ", p, "exists:", os.path.isdir(p))\n')
    f.write('import importlib\n')
    f.write('try:\n')
    f.write('    m = importlib.import_module("gsv_code")\n')
    f.write('    print("import gsv_code OK, file:", m.__file__)\n')
    f.write('except Exception as e:\n')
    f.write('    print("import gsv_code FAIL:", e)\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_check.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:300])
