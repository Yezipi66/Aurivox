import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
# Use original 2-name2text.txt (| separator) not 2-name2text-0.txt (tab separator)
n2t = os.path.join(work_dir, "2-name2text.txt")
wav_dir = os.path.join(work_dir, "wav")

env = os.environ.copy()
env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
env['PYTHONUNBUFFERED'] = '1'
env['inp_text'] = n2t
env['inp_wav_dir'] = wav_dir
env['exp_name'] = 'Raiden_JA'
env['i_part'] = '0'
env['all_parts'] = '1'
env['opt_dir'] = work_dir
env['cnhubert_base_dir'] = os.path.join(GSV_TOOLS, "pretrained", "chinese-hubert-base")
env['is_half'] = 'True'
env['_CUDA_VISIBLE_DEVICES'] = '0'

sys.stdout.reconfigure(encoding='utf-8')
print(f"Step 2: CNHubert + wav32k")
print(f"  Input: {n2t}")
print(f"  Wav: {wav_dir}")

proc = subprocess.Popen(
    [PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "2-get-hubert-wav32k.py")],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=env)

for line in proc.stdout:
    print(f"  {line}", end='', flush=True)

proc.wait()
print(f"\n  Exit: {proc.returncode}", flush=True)

hubert_dir = os.path.join(work_dir, "4-cnhubert")
wav32k_dir = os.path.join(work_dir, "5-wav32k")
hubert_files = len([f for f in os.listdir(hubert_dir) if f.endswith('.pt')]) if os.path.exists(hubert_dir) else 0
wav32k_files = len([f for f in os.listdir(wav32k_dir) if f.endswith('.wav')]) if os.path.exists(wav32k_dir) else 0
print(f"  4-cnhubert/: {hubert_files} .pt files")
print(f"  5-wav32k/: {wav32k_files} .wav files")

if proc.returncode != 0:
    print("FAILED!")
else:
    print("Step 2 DONE!")
