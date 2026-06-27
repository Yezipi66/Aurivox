import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv-code'
env['PYTHONUNBUFFERED'] = '1'

with open(r'D:\Project\tts_broker_openai_compat\_check2.py', 'w', encoding='utf-8') as f:
    f.write('import sys, os\n')
    f.write('path = r"D:\\Project\\tts_broker_openai_compat\\lib\\training\\gsv_code"\n')
    f.write('print("Checking path:", path)\n')
    f.write('print("Is dir:", os.path.isdir(path))\n')
    f.write('print("Contents:", sorted(os.listdir(path))[:15])\n')
    f.write('init_path = os.path.join(path, "__init__.py")\n')
    f.write('print("Init exists:", os.path.exists(init_path))\n')
    f.write('with open(init_path, "r", encoding="utf-8") as fp:\n')
    f.write('    print("Init content:", repr(fp.read()[:100]))\n')
    f.write('# Check if there is a .pth file blocking\n')
    f.write('import site\n')
    f.write('print("site packages:", site.getsitepackages())\n')
    f.write('print("user site:", site.getusersitepackages())\n')
    f.write('# Try importlib.util.find_spec\n')
    f.write('import importlib.util\n')
    f.write('spec = importlib.util.find_spec("gsv_code")\n')
    f.write('print("find_spec:", spec)\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_check2.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:300])
