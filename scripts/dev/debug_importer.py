import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv_code'
env['PYTHONUNBUFFERED'] = '1'

with open(r'D:\Project\tts_broker_openai_compat\_debug_importer.py', 'w', encoding='utf-8') as f:
    f.write('import sys, os\n')
    f.write('target = r"D:\\Project\\tts_broker_openai_compat\\lib\\training\\gsv_code"\n')
    f.write('print("target in sys.path:", target in sys.path)\n')
    f.write('print("target exists:", os.path.exists(target))\n')
    f.write('print("target isdir:", os.path.isdir(target))\n')
    f.write('# Check path_hooks\n')
    f.write('import importlib.machinery\n')
    f.write('for hook in sys.path_hooks:\n')
    f.write('    print("path_hook:", hook)\n')
    f.write('    try:\n')
    f.write('        finder = hook(target)\n')
    f.write('        print("  finder:", finder)\n')
    f.write('    except Exception as e:\n')
    f.write('        print("  error:", e)\n')
    f.write('# Check FileFinder\n')
    f.write('ff = importlib.machinery.FileFinder(target)\n')
    f.write('print("FileFinder:", ff)\n')
    f.write('print("files:", list(ff.iter_modules())[:5])\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_debug_importer.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:300])
