import subprocess
r = subprocess.run([r'D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe', '-c', 
    'import soundfile; import torchaudio; print("OK")'], 
    capture_output=True, text=True, timeout=10)
print(r.stdout)
if r.stderr: print(r.stderr[:200])
