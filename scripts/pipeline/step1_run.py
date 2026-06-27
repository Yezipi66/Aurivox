import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
name2text = os.path.join(work_dir, "2-name2text.txt")

MODELS = {
    "bert": os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large"),
}

env = os.environ.copy()
env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
env['PYTHONUNBUFFERED'] = '1'
env['inp_text'] = name2text
env['inp_wav_dir'] = os.path.join(work_dir, "wav")
env['exp_name'] = 'Raiden_JA'
env['i_part'] = '0'
env['all_parts'] = '1'
env['opt_dir'] = work_dir
env['bert_pretrained_dir'] = MODELS["bert"]
env['is_half'] = 'True'
env['_CUDA_VISIBLE_DEVICES'] = '0'

sys.stdout.reconfigure(encoding='utf-8')
print("Running Step 1: BERT text features...")

r = subprocess.run([PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py")],
    capture_output=True, text=True, timeout=300, env=env)
print(f"Exit: {r.returncode}")
print(f"stdout: {r.stdout[-500:]}")
if r.stderr: print(f"stderr: {r.stderr[-500:]}")

# Check output
n2t_0 = os.path.join(work_dir, "2-name2text-0.txt")
bert_dir = os.path.join(work_dir, "3-bert")
print(f"\n2-name2text-0.txt exists: {os.path.exists(n2t_0)}")
if os.path.exists(n2t_0):
    with open(n2t_0, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    print(f"  Lines: {len(lines)}")
print(f"3-bert/ files: {len(os.listdir(bert_dir)) if os.path.exists(bert_dir) else 0}")
