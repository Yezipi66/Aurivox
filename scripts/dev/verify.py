import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
env = os.environ.copy()
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv_code'
env['PYTHONUNBUFFERED'] = '1'

with open(r'D:\Project\tts_broker_openai_compat\_verify.py', 'w', encoding='utf-8') as f:
    f.write('import sys\n')
    f.write('sys.path.insert(0, r"D:\\Project\\tts_broker_openai_compat\\lib\\training\\gsv_code")\n')
    f.write('from gsv_code.text.cleaner import clean_text\n')
    f.write('from gsv_code.feature_extractor import cnhubert\n')
    f.write('from gsv_code import utils\n')
    f.write('print("All imports OK!")\n')

r = subprocess.run([PYTHON, r'D:\Project\tts_broker_openai_compat\_verify.py'],
    capture_output=True, text=True, timeout=10, env=env)
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:200])
