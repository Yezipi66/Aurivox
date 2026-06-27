import subprocess, os, sys

PYTHON = "D:/Project/tts_broker_openai_compat/venv/Scripts/python.exe"
TOOLS = "D:/Project/tts_broker_openai_compat/lib/training/gsv-tools"

slicer_out = "D:/Project/tts_broker_openai_compat/test_raiden/日文/slicer_opt"
asr_out = "D:/Project/tts_broker_openai_compat/test_raiden/日文/asr_output"

sliced = [f for f in os.listdir(slicer_out) if f.endswith('.wav')]
print(f"Sliced: {len(sliced)}")

os.makedirs(asr_out, exist_ok=True)
asr_script = os.path.join(TOOLS, 'asr', 'fasterwhisper_asr.py')
asr_args = ['-i', slicer_out, '-o', asr_out, '-l', 'ja', '-s', 'large-v3', '-p', 'float16']

print("Running ASR...")
r = subprocess.run([PYTHON, asr_script] + asr_args, capture_output=True, text=True, timeout=900)
print(f"Exit: {r.returncode}")
if r.stdout:
    print(f"stdout: {r.stdout[-500:]}")
if r.stderr:
    print(f"stderr: {r.stderr[-500:]}")

# Check output
list_files = [f for f in os.listdir(asr_out) if f.endswith('.list')]
print(f"Output files: {list_files}")
if list_files:
    with open(os.path.join(asr_out, list_files[0]), 'r', encoding='utf-8') as fp:
        for i, line in enumerate(fp):
            if i >= 3: break
            parts = line.strip().split('|')
            if len(parts) >= 4:
                print(f"  {os.path.basename(parts[0])}: {parts[3][:60]}")
