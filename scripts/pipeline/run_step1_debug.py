import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
name2text = os.path.join(work_dir, "2-name2text.txt")

# Delete empty outputs
for f in ["2-name2text-0.txt"]:
    p = os.path.join(work_dir, f)
    if os.path.exists(p):
        os.remove(p)
        print(f"Deleted: {p}")

bert_dir = os.path.join(work_dir, "3-bert")
if os.path.exists(bert_dir):
    import shutil
    shutil.rmtree(bert_dir)
    print(f"Deleted: {bert_dir}")

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

print(f"Input file: {name2text}")
print(f"Input exists: {os.path.exists(name2text)}")
print(f"Bert model: {MODELS['bert']}")
print(f"Bert exists: {os.path.exists(MODELS['bert'])}")
print(f"\nRunning 1-get-text.py...")

r = subprocess.run([PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py")],
    capture_output=False,  # Don't capture - let output flow through
    timeout=300, env=env)
print(f"\nExit: {r.returncode}")
