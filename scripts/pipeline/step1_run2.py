import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
name2text = os.path.join(work_dir, "2-name2text.txt")
bert_model = os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large")

env = os.environ.copy()
env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
env['PYTHONUNBUFFERED'] = '1'
env['inp_text'] = name2text
env['inp_wav_dir'] = os.path.join(work_dir, "wav")
env['exp_name'] = 'Raiden_JA'
env['i_part'] = '0'
env['all_parts'] = '1'
env['opt_dir'] = work_dir
env['bert_pretrained_dir'] = bert_model
env['is_half'] = 'True'
env['_CUDA_VISIBLE_DEVICES'] = '0'

sys.stdout.reconfigure(encoding='utf-8')
print(f"Step 1: BERT text features")
print(f"  Input: {name2text}")
print(f"  BERT model: {bert_model}")
print(f"  BERT exists: {os.path.exists(bert_model)}")

proc = subprocess.Popen(
    [PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py")],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=env)

lines = []
for line in proc.stdout:
    line = line.rstrip()
    lines.append(line)
    print(f"  {line}", flush=True)

proc.wait()
print(f"\n  Exit: {proc.returncode}", flush=True)

# Check outputs
n2t_0 = os.path.join(work_dir, "2-name2text-0.txt")
bert_dir = os.path.join(work_dir, "3-bert")
print(f"  2-name2text-0.txt: {os.path.exists(n2t_0)}")
print(f"  3-bert/: {len(os.listdir(bert_dir)) if os.path.exists(bert_dir) else 0} files")

if proc.returncode != 0:
    print("FAILED!")
else:
    print("Step 1 DONE!")
