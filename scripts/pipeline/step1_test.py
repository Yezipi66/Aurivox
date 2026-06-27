import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = r"D:\Project\tts_broker_openai_compat\test_raiden\日文"
name2text = os.path.join(work_dir, "2-name2text.txt")

MODELS = {
    "bert": os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large"),
    "cnhubert": os.path.join(GSV_TOOLS, "pretrained", "chinese-hubert-base"),
    "s2G": os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth"),
}

# Build env ONCE
env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
env['PYTHONPATH'] = PROJECT + os.pathsep + GSV_CODE
env['PYTHONUNBUFFERED'] = '1'

print(f"PYTHONPATH: {env['PYTHONPATH']}")

# Step 1
print("\n=== Step 1: BERT ===")
env1 = {**env,
    "inp_text": name2text, "inp_wav_dir": "", "exp_name": "Raiden_JA",
    "i_part": "0", "all_parts": "1", "opt_dir": work_dir,
    "bert_pretrained_dir": MODELS["bert"], "is_half": "True",
    "_CUDA_VISIBLE_DEVICES": "0"}
r = subprocess.run([PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py")],
    capture_output=True, text=True, timeout=600, env=env1)
print(f"Exit: {r.returncode}")
if r.stdout: print(f"stdout: {r.stdout[-300:]}")
if r.stderr: print(f"stderr: {r.stderr[-300:]}")
