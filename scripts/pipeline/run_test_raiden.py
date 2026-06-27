import subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')

# 直接用 subprocess 运行，不用 cmd 包装
PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
script = r"D:\Project\tts_broker_openai_compat\test_raiden_e2e.py"

print(f"Running: {PYTHON} {script}")
print("This will take 10-30 minutes (4 languages x ASR)...\n")

r = subprocess.run(
    [PYTHON, script],
    timeout=3600,
    env={**__import__('os').environ, 'PYTHONUNBUFFERED': '1'}
)

print(f"\nExit: {r.returncode}")
