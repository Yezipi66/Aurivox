import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
PROJECT = r"D:\Project\tts_broker_openai_compat"
GSV_CODE = os.path.join(PROJECT, "lib", "training", "gsv_code")
GSV_TOOLS = os.path.join(PROJECT, "lib", "training", "gsv-tools")

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
name2text = os.path.join(work_dir, "2-name2text.txt")
wav_dir = os.path.join(work_dir, "wav")

MODELS = {
    "bert": os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large"),
    "cnhubert": os.path.join(GSV_TOOLS, "pretrained", "chinese-hubert-base"),
    "s2G": os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth"),
    "s1": os.path.join(GSV_TOOLS, "pretrained", "gsv-v2final", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
}

env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
env['PYTHONUNBUFFERED'] = '1'

def run_step(desc, script, env_extra, timeout=600):
    print(f"\n=== {desc} ===", flush=True)
    e = {**env, **env_extra}
    r = subprocess.run([PYTHON, script], capture_output=True, text=True, timeout=timeout, env=e)
    print(f"  Exit: {r.returncode}", flush=True)
    if r.stdout: print(f"  stdout: {r.stdout[-300:]}", flush=True)
    if r.stderr: print(f"  stderr: {r.stderr[-300:]}", flush=True)
    if r.returncode != 0:
        raise RuntimeError(f"Step failed: {desc}")
    return r

# Step 1: BERT
run_step("Step 1: BERT text features",
    os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py"),
    {"inp_text": name2text, "inp_wav_dir": wav_dir, "exp_name": "Raiden_JA",
     "i_part": "0", "all_parts": "1", "opt_dir": work_dir,
     "bert_pretrained_dir": MODELS["bert"], "is_half": "True",
     "_CUDA_VISIBLE_DEVICES": "0"})

n2t_0 = os.path.join(work_dir, "2-name2text-0.txt")
n2t = n2t_0 if os.path.exists(n2t_0) else name2text

# Step 2: Hubert + wav32k
run_step("Step 2: CNHubert + wav32k",
    os.path.join(GSV_CODE, "prepare_datasets", "2-get-hubert-wav32k.py"),
    {"inp_text": n2t, "inp_wav_dir": wav_dir, "exp_name": "Raiden_JA",
     "i_part": "0", "all_parts": "1", "opt_dir": work_dir,
     "cnhubert_base_dir": MODELS["cnhubert"], "is_half": "True",
     "_CUDA_VISIBLE_DEVICES": "0"})

# Step 3: Semantic
run_step("Step 3: Semantic features",
    os.path.join(GSV_CODE, "prepare_datasets", "3-get-semantic.py"),
    {"inp_text": n2t, "exp_name": "Raiden_JA", "i_part": "0", "all_parts": "1",
     "opt_dir": work_dir, "pretrained_s2G": MODELS["s2G"],
     "s2config_path": os.path.join(GSV_CODE, "configs", "s2.json"),
     "is_half": "True", "_CUDA_VISIBLE_DEVICES": "0"})

semantic_path = os.path.join(work_dir, "6-name2semantic.tsv")

# Step 4: S1
import yaml, json, shutil

s1_output = os.path.join(work_dir, "logs_s1", "Raiden_JA")
os.makedirs(s1_output, exist_ok=True)

s1_config = {
    "train": {
        "seed": 1234, "epochs": 20, "batch_size": 8,
        "save_every_n_epoch": 1, "precision": "16-mixed", "gradient_clip": 1.0,
        "optimizer": {"lr": 0.01, "lr_init": 0.00001, "lr_end": 0.0001, "warmup_steps": 2000, "decay_steps": 40000},
        "data": {"max_eval_sample": 8, "max_sec": 54, "num_workers": 4, "pad_val": 1024},
        "model": {"vocab_size": 1025, "phoneme_vocab_size": 512, "embedding_dim": 512,
                  "hidden_dim": 512, "head": 16, "linear_units": 2048, "n_layer": 24,
                  "dropout": 0, "EOS": 1024, "random_bert": 0},
        "inference": {"top_k": 5},
    },
    "output_dir": s1_output,
    "pretrained_s1": MODELS["s1"],
    "train_semantic_path": semantic_path,
    "train_phoneme_path": n2t,
}
s1_config_path = os.path.join(work_dir, "s1_train_config.yaml")
with open(s1_config_path, 'w', encoding='utf-8') as f:
    yaml.dump(s1_config, f)

run_step("Step 4: S1 Training (20 epochs)",
    os.path.join(GSV_CODE, "s1_train.py"),
    {"CUDA_VISIBLE_DEVICES": "0"},
    timeout=86400)

# Step 5: S2
s2_output = os.path.join(work_dir, "logs_s2", "Raiden_JA")
exp_dir = os.path.join(s2_output, "44k")
os.makedirs(exp_dir, exist_ok=True)

for src_name in ["2-name2text.txt"]:
    src = os.path.join(work_dir, src_name)
    dst = os.path.join(exp_dir, src_name)
    if os.path.exists(src) and not os.path.exists(dst):
        shutil.copy2(src, dst)
for src_name in ["4-cnhubert", "5-wav32k"]:
    src = os.path.join(work_dir, src_name)
    dst = os.path.join(exp_dir, src_name)
    if os.path.exists(src) and not os.path.exists(dst):
        shutil.copytree(src, dst)

s2_config_path = os.path.join(GSV_CODE, "configs", "s2.json")
s2_config_backup = s2_config_path + ".bak"
with open(s2_config_path, 'r', encoding='utf-8') as f:
    s2_config = json.load(f)
s2_config["s2_ckpt_dir"] = s2_output
s2_config["train"]["epochs"] = 100
s2_config["train"]["batch_size"] = 32
s2_config["train"]["fp16_run"] = True
if not os.path.exists(s2_config_backup):
    shutil.copy2(s2_config_path, s2_config_backup)
with open(s2_config_path, 'w', encoding='utf-8') as f:
    json.dump(s2_config, f, indent=2)

print(f"\n=== Step 5: S2 Training (100 epochs) ===", flush=True)
print(f"  cwd: {GSV_CODE}", flush=True)
env5 = {**env, "CUDA_VISIBLE_DEVICES": "0"}
r5 = subprocess.run([PYTHON, "s2_train.py"], capture_output=True, text=True, timeout=86400, env=env5, cwd=GSV_CODE)
if os.path.exists(s2_config_backup):
    shutil.copy2(s2_config_backup, s2_config_path)
print(f"  S2 exit: {r5.returncode}", flush=True)
if r5.stdout: print(f"  stdout: {r5.stdout[-500:]}", flush=True)
if r5.stderr: print(f"  stderr: {r5.stderr[-500:]}", flush=True)

print(f"\n{'='*60}", flush=True)
print("  Pipeline complete!", flush=True)
