import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv_code'
env['PYTHONUNBUFFERED'] = '1'

with open(r'D:\Project\tts_broker_openai_compat\_debug_site.py', 'w', encoding='utf-8') as f:
    f.write('import sys, os, site\n')
    f.write('print("sys.prefix:", sys.prefix)\n')
    f.write('print("sys.base_prefix:", sys.base_prefix)\n')
    f.write('print("sys.executable:", sys.executable)\n')
    f.write('print("site.ENABLE_USER_SITE:", site.ENABLE_USER_SITE)\n')
    f.write('print("site packages:", site.getsitepackages())\n')
    f.write('print("user site:", site.getusersitepackages())\n')
    f.write('print("sys.path:")\n')
    f.write('for p in sys.path:\n')
    f.write('    print("  ", repr(p))\n')
    f.write('# Check if usercustomize.py exists\n')
    f.write('import importlib\n')
    f.write('for p in sys.path:\n')
    f.write('    candidate = os.path.join(p, "usercustomize.py")\n')
    f.write('    if os.path.exists(candidate):\n')
    f.write('        print("Found usercustomize.py:", candidate)\n')
    f.write('    candidate2 = os.path.join(p, "sitecustomize.py")\n')
    f.write('    if os.path.exists(candidate2):\n')
    f.write('        print("Found sitecustomize.py:", candidate2)\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_debug_site.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:200])
