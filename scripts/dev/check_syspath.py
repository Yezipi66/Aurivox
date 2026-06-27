import os, sys

env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
env['PYTHONPATH'] = r'D:\Project\tts_broker_openai_compat' + os.pathsep + r'D:\Project\tts_broker_openai_compat\lib\training\gsv-code'
env['PYTHONUNBUFFERED'] = '1'

import subprocess
r = subprocess.run(
    [r'D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe', '-c',
     'import sys; print("\\n".join(sys.path))'],
    capture_output=True, text=True, timeout=10, env=env
)
print("Child Python sys.path:")
print(r.stdout)
