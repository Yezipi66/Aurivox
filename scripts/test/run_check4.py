import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv-code'
env['PYTHONUNBUFFERED'] = '1'

with open(r'D:\Project\tts_broker_openai_compat\_check4.py', 'w', encoding='utf-8') as f:
    f.write('import sys, os\n')
    f.write('# Try manually adding the path and importing\n')
    f.write('sys.path.insert(0, r"D:\\Project\\tts_broker_openai_compat\\lib\\training\\gsv-code")\n')
    f.write('print("After insert, sys.path has gsv-code:", any("gsv-code" in p for p in sys.path))\n')
    f.write('import importlib\n')
    f.write('try:\n')
    f.write('    m = importlib.import_module("gsv_code")\n')
    f.write('    print("import OK:", m.__file__)\n')
    f.write('except Exception as e:\n')
    f.write('    print("import FAIL:", e)\n')
    f.write('# Check if there is a conflicting gsv_code somewhere\n')
    f.write('for p in sys.path:\n')
    f.write('    gsv_path = os.path.join(p, "gsv_code")\n')
    f.write('    if os.path.exists(gsv_path):\n')
    f.write('        print("Found gsv_code at:", gsv_path, "contents:", os.listdir(gsv_path)[:5])\n')
    f.write('    gsv_dash = os.path.join(p, "gsv-code")\n')
    f.write('    if os.path.exists(gsv_dash):\n')
    f.write('        print("Found gsv-code at:", gsv_dash, "contents:", os.listdir(gsv_dash)[:5])\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_check4.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:300])
