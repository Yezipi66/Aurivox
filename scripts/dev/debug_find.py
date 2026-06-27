import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv_code'
env['PYTHONUNBUFFERED'] = '1'

with open(r'D:\Project\tts_broker_openai_compat\_debug_find.py', 'w', encoding='utf-8') as f:
    f.write('import sys, os\n')
    f.write('import importlib.machinery\n')
    f.write('target = r"D:\\Project\\tts_broker_openai_compat\\lib\\training\\gsv_code"\n')
    f.write('ff = importlib.machinery.FileFinder(target)\n')
    f.write('# Try to find the module spec\n')
    f.write('spec = ff.find_spec("gsv_code")\n')
    f.write('print("find_spec via FileFinder:", spec)\n')
    f.write('# Try find_module\n')
    f.write('try:\n')
    f.write('    loader = ff.find_module("gsv_code")\n')
    f.write('    print("find_module:", loader)\n')
    f.write('except Exception as e:\n')
    f.write('    print("find_module error:", e)\n')
    f.write('# List all files in the directory\n')
    f.write('print("files in gsv_code:", sorted(os.listdir(target)))\n')
    f.write('# Check __init__.py\n')
    f.write('init = os.path.join(target, "__init__.py")\n')
    f.write('print("init.py exists:", os.path.exists(init))\n')
    f.write('with open(init, "r", encoding="utf-8") as fp:\n')
    f.write('    content = fp.read()\n')
    f.write('    print("init.py content:", repr(content[:200]))\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_debug_find.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:300])
