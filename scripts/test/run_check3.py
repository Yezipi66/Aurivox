import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv-code'
env['PYTHONUNBUFFERED'] = '1'

with open(r'D:\Project\tts_broker_openai_compat\_check3.py', 'w', encoding='utf-8') as f:
    f.write('import sys, os\n')
    f.write('print("sys.path with gsv:")\n')
    f.write('for p in sys.path:\n')
    f.write('    if "gsv" in p.lower():\n')
    f.write('        print(" ", repr(p), "-> exists:", os.path.isdir(p))\n')
    f.write('import importlib.util\n')
    f.write('spec1 = importlib.util.find_spec("gsv_code")\n')
    f.write('print("find_spec(gsv_code):", spec1)\n')
    f.write('spec2 = importlib.util.find_spec("gsv-code")\n')
    f.write('print("find_spec(gsv-code):", spec2)\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_check3.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:200])
