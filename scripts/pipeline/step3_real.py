import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
n2t = os.path.join(work_dir, "2-name2text-0.txt")

env = os.environ.copy()
env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
env['PYTHONUNBUFFERED'] = '1'
env['inp_text'] = n2t
env['exp_name'] = 'Raiden_JA'
env['i_part'] = '0'
env['all_parts'] = '1'
env['opt_dir'] = work_dir
env['pretrained_s2G'] = os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth")
env['s2config_path'] = os.path.join(GSV_CODE, "configs", "s2.json")
env['is_half'] = 'True'
env['_CUDA_VISIBLE_DEVICES'] = '0'

sys.stdout.reconfigure(encoding='utf-8')
print("=== Step 3: Semantic ===", flush=True)

proc = subprocess.Popen(
    [PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "3-get-semantic.py")],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=env)

for line in proc.stdout:
    print(f"  {line}", end='', flush=True)

proc.wait()
print(f"\nExit: {proc.returncode}", flush=True)

if proc.returncode == 0:
    sem_file = os.path.join(work_dir, "6-name2semantic.tsv")
    sem_lines = 0
    if os.path.exists(sem_file):
        with open(sem_file, 'r', encoding='utf-8') as f:
            sem_lines = sum(1 for _ in f)
    print(f"6-name2semantic.tsv: {sem_lines} lines", flush=True)
