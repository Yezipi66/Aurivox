import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
s2_output = os.path.join(work_dir, "logs_s2", "Raiden_JA")

env = os.environ.copy()
env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
env['PYTHONUNBUFFERED'] = '1'

sys.stdout.reconfigure(encoding='utf-8')
print("=== Step 5: S2 Training (10 epochs) ===", flush=True)
print(f"cwd: {GSV_CODE}")
print(f"Output: {s2_output}")

# Run s2_train.py from gsv_code directory (it uses relative paths)
proc = subprocess.Popen(
    [PYTHON, "s2_train.py"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=env,
    cwd=GSV_CODE,
)

for line in proc.stdout:
    if any(k in line for k in ['Epoch', 'step', 'loss', 'Error', 'Traceback', 'G_', 'D_', 'Saving']):
        print(f"  {line}", end='', flush=True)

proc.wait()
print(f"\nExit: {proc.returncode}", flush=True)

# Check for saved models
if os.path.exists(s2_output):
    models = [f for f in os.listdir(s2_output) if f.endswith('.pth')]
    print(f"Saved models: {models}")
