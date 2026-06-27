import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
name2text = os.path.join(work_dir, "2-name2text.txt")

env = os.environ.copy()
env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
env['PYTHONUNBUFFERED'] = '1'
env['inp_text'] = name2text
env['inp_wav_dir'] = os.path.join(work_dir, "wav")
env['exp_name'] = 'Raiden_JA'
env['i_part'] = '0'
env['all_parts'] = '1'
env['opt_dir'] = work_dir
env['bert_pretrained_dir'] = os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large")
env['is_half'] = 'True'
env['_CUDA_VISIBLE_DEVICES'] = '0'

sys.stdout.reconfigure(encoding='utf-8')
print("=== Step 1: BERT ===", flush=True)

proc = subprocess.Popen(
    [PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py")],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=env)

for line in proc.stdout:
    print(f"  {line}", end='', flush=True)

proc.wait()
print(f"\nExit: {proc.returncode}", flush=True)

if proc.returncode == 0:
    n2t_0 = os.path.join(work_dir, "2-name2text-0.txt")
    bert_dir = os.path.join(work_dir, "3-bert")
    n2t_lines = 0
    if os.path.exists(n2t_0):
        with open(n2t_0, 'r', encoding='utf-8') as f:
            n2t_lines = sum(1 for _ in f)
    bert_files = len(os.listdir(bert_dir)) if os.path.exists(bert_dir) else 0
    print(f"2-name2text-0.txt: {n2t_lines} lines", flush=True)
    print(f"3-bert/: {bert_files} files", flush=True)
