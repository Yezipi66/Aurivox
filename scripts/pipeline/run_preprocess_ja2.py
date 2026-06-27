import subprocess, os, sys

PYTHON = "D:/Project/tts_broker_openai_compat/venv/Scripts/python.exe"
GSV_CODE = "D:/Project/tts_broker_openai_compat/lib/training/gsv-code"
GSV_TOOLS = "D:/Project/tts_broker_openai_compat/lib/training/gsv-tools"
PROJECT = "D:/Project/tts_broker_openai_compat"

work_dir = "D:/Project/tts_broker_openai_compat/test_raiden/日文"
name2text = os.path.join(work_dir, "2-name2text.txt")

MODELS = {
    "bert": os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large"),
    "cnhubert": os.path.join(GSV_TOOLS, "pretrained", "chinese-hubert-base"),
    "s2G": os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth"),
}

env_base = {
    **os.environ,
    "PYTHONUNBUFFERED": "1",
    "PYTHONPATH": PROJECT + ";" + GSV_CODE,
}

# Step 1: 1-get-text
print("=== Step 1: BERT text features ===")
env1 = {
    **env_base,
    "inp_text": name2text,
    "inp_wav_dir": "",
    "exp_name": "Raiden_JA",
    "i_part": "0",
    "all_parts": "1",
    "opt_dir": work_dir,
    "bert_pretrained_dir": MODELS["bert"],
    "is_half": "True",
    "_CUDA_VISIBLE_DEVICES": "0",
}
r = subprocess.run([PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py")],
    capture_output=True, text=True, timeout=600, env=env1)
print(f"  Exit: {r.returncode}")
if r.stdout: print(f"  stdout: {r.stdout[-300:]}")
if r.stderr: print(f"  stderr: {r.stderr[-300:]}")

bert_dir = os.path.join(work_dir, "3-bert")
n2t_path = os.path.join(work_dir, "2-name2text-0.txt")
print(f"  3-bert/: {len(os.listdir(bert_dir)) if os.path.exists(bert_dir) else 0} files")
print(f"  2-name2text-0.txt: {os.path.exists(n2t_path)}")

# Step 2: 2-get-hubert-wav32k
print("\n=== Step 2: CNHubert + wav32k ===")
wav_dir = os.path.join(work_dir, "wav")
env2 = {
    **env_base,
    "inp_text": n2t_path if os.path.exists(n2t_path) else name2text,
    "inp_wav_dir": wav_dir,
    "exp_name": "Raiden_JA",
    "i_part": "0",
    "all_parts": "1",
    "opt_dir": work_dir,
    "cnhubert_base_dir": MODELS["cnhubert"],
    "is_half": "True",
    "_CUDA_VISIBLE_DEVICES": "0",
}
r = subprocess.run([PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "2-get-hubert-wav32k.py")],
    capture_output=True, text=True, timeout=600, env=env2)
print(f"  Exit: {r.returncode}")
if r.stdout: print(f"  stdout: {r.stdout[-300:]}")
if r.stderr: print(f"  stderr: {r.stderr[-300:]}")

hubert_dir = os.path.join(work_dir, "4-cnhubert")
wav32k_dir = os.path.join(work_dir, "5-wav32k")
print(f"  4-cnhubert/: {len(os.listdir(hubert_dir)) if os.path.exists(hubert_dir) else 0} files")
print(f"  5-wav32k/: {len(os.listdir(wav32k_dir)) if os.path.exists(wav32k_dir) else 0} files")

# Step 3: 3-get-semantic
print("\n=== Step 3: Semantic features ===")
env3 = {
    **env_base,
    "inp_text": n2t_path if os.path.exists(n2t_path) else name2text,
    "exp_name": "Raiden_JA",
    "i_part": "0",
    "all_parts": "1",
    "opt_dir": work_dir,
    "pretrained_s2G": MODELS["s2G"],
    "s2config_path": os.path.join(GSV_CODE, "configs", "s2.json"),
    "is_half": "True",
    "_CUDA_VISIBLE_DEVICES": "0",
}
r = subprocess.run([PYTHON, os.path.join(GSV_CODE, "prepare_datasets", "3-get-semantic.py")],
    capture_output=True, text=True, timeout=600, env=env3)
print(f"  Exit: {r.returncode}")
if r.stdout: print(f"  stdout: {r.stdout[-300:]}")
if r.stderr: print(f"  stderr: {r.stderr[-300:]}")

semantic_path = os.path.join(work_dir, "6-name2semantic.tsv")
print(f"  6-name2semantic.tsv: {os.path.exists(semantic_path)}")
if os.path.exists(semantic_path):
    with open(semantic_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    print(f"  Semantic lines: {len(lines)}")

print("\nDone!")
