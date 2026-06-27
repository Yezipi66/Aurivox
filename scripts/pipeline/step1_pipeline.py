import subprocess, os, sys, shutil

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
name2text = os.path.join(work_dir, "2-name2text.txt")

MODELS = {
    "bert": os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large"),
    "cnhubert": os.path.join(GSV_TOOLS, "pretrained", "chinese-hubert-base"),
    "s2G": os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth"),
    "s1": os.path.join(GSV_TOOLS, "pretrained", "gsv-v2final", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
}

# Clean old outputs
for item in ["2-name2text-0.txt", "3-bert", "4-cnhubert", "5-wav32k", "6-name2semantic.tsv", "7-sv_cn", "logs_s1", "logs_s2"]:
    p = os.path.join(work_dir, item)
    if os.path.exists(p):
        if os.path.isdir(p): shutil.rmtree(p)
        else: os.remove(p)

sys.stdout.reconfigure(encoding='utf-8')

# Step 1: BERT
print("=== Step 1: BERT ===", flush=True)
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

proc = subprocess.Popen([PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py")],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=env)

for line in proc.stdout:
    print(f"  {line}", end='', flush=True)

proc.wait()
print(f"\n  Exit: {proc.returncode}", flush=True)

if proc.returncode != 0:
    print("FAILED at Step 1!")
    sys.exit(1)

# Check output
n2t_0 = os.path.join(work_dir, "2-name2text-0.txt")
n2t = n2t_0 if os.path.exists(n2t_0) else name2text
bert_dir = os.path.join(work_dir, "3-bert")
bert_files = len(os.listdir(bert_dir)) if os.path.exists(bert_dir) else 0
print(f"  2-name2text-0.txt: {os.path.exists(n2t_0)}, 3-bert/: {bert_files} files", flush=True)

print("\nStep 1 DONE!", flush=True)
