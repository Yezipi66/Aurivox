import subprocess, os, sys

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
PROJECT = r"D:\Project\tts_broker_openai_compat"
GSV_CODE = os.path.join(PROJECT, "lib", "training", "gsv_code")
GSV_TOOLS = os.path.join(PROJECT, "lib", "training", "gsv-tools")

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
name2text = os.path.join(work_dir, "2-name2text.txt")

MODELS = {
    "bert": os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large"),
    "cnhubert": os.path.join(GSV_TOOLS, "pretrained", "chinese-hubert-base"),
    "s2G": os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth"),
    "s1": os.path.join(GSV_TOOLS, "pretrained", "gsv-v2final", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
}

# Clean old outputs
import shutil
for item in ["2-name2text-0.txt", "3-bert", "4-cnhubert", "5-wav32k", "6-name2semantic.tsv", "7-sv_cn", "logs_s1", "logs_s2"]:
    p = os.path.join(work_dir, item)
    if os.path.exists(p):
        if os.path.isdir(p): shutil.rmtree(p)
        else: os.remove(p)

def make_env(extra):
    env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
    env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
    env['PYTHONUNBUFFERED'] = '1'
    env.update(extra)
    return env

def run_step(desc, script, env_extra, timeout=600):
    print(f"\n=== {desc} ===", flush=True)
    r = subprocess.run([PYTHON, script], capture_output=True, text=True, timeout=timeout, env=make_env(env_extra))
    print(f"  Exit: {r.returncode}", flush=True)
    if r.stdout: print(f"  stdout: {r.stdout[-300:]}", flush=True)
    if r.stderr: print(f"  stderr: {r.stderr[-300:]}", flush=True)
    if r.returncode != 0: raise RuntimeError(f"Failed: {desc}")
    return r

# Step 1
run_step("Step 1: BERT", os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py"),
    {"inp_text": name2text, "inp_wav_dir": os.path.join(work_dir, "wav"), "exp_name": "Raiden_JA",
     "i_part": "0", "all_parts": "1", "opt_dir": work_dir,
     "bert_pretrained_dir": MODELS["bert"], "is_half": "True", "_CUDA_VISIBLE_DEVICES": "0"})

n2t = os.path.join(work_dir, "2-name2text-0.txt")
if not os.path.exists(n2t): n2t = name2text

# Step 2
run_step("Step 2: Hubert+wav32k", os.path.join(GSV_CODE, "prepare_datasets", "2-get-hubert-wav32k.py"),
    {"inp_text": n2t, "inp_wav_dir": os.path.join(work_dir, "wav"), "exp_name": "Raiden_JA",
     "i_part": "0", "all_parts": "1", "opt_dir": work_dir,
     "cnhubert_base_dir": MODELS["cnhubert"], "is_half": "True", "_CUDA_VISIBLE_DEVICES": "0"})

# Step 3
run_step("Step 3: Semantic", os.path.join(GSV_CODE, "prepare_datasets", "3-get-semantic.py"),
    {"inp_text": n2t, "exp_name": "Raiden_JA", "i_part": "0", "all_parts": "1",
     "opt_dir": work_dir, "pretrained_s2G": MODELS["s2G"],
     "s2config_path": os.path.join(GSV_CODE, "configs", "s2.json"),
     "is_half": "True", "_CUDA_VISIBLE_DEVICES": "0"})

semantic = os.path.join(work_dir, "6-name2semantic.tsv")

# Step 4
import yaml, json
s1_output = os.path.join(work_dir, "logs_s1", "Raiden_JA")
os.makedirs(s1_output, exist_ok=True)
s1_config = {
    "train": {"seed": 1234, "epochs": 20, "batch_size": 8, "save_every_n_epoch": 1,
              "precision": "16-mixed", "gradient_clip": 1.0,
              "optimizer": {"lr": 0.01, "lr_init": 0.00001, "lr_end": 0.0001, "warmup_steps": 2000, "decay_steps": 40000},
              "data": {"max_eval_sample": 8, "max_sec": 54, "num_workers": 4, "pad_val": 1024},
              "model": {"vocab_size": 1025, "phoneme_vocab_size": 512, "embedding_dim": 512,
                        "hidden_dim": 512, "head": 16, "linear_units": 2048, "n_layer": 24,
                        "dropout": 0, "EOS": 1024, "random_bert": 0},
              "inference": {"top_k": 5}},
    "output_dir": s1_output, "pretrained_s1": MODELS["s1"],
    "train_semantic_path": semantic, "train_phoneme_path": n2t}
with open(os.path.join(work_dir, "s1_config.yaml"), 'w') as f: yaml.dump(s1_config, f)

run_step("Step 4: S1 Train", os.path.join(GSV_CODE, "s1_train.py"),
    {"CUDA_VISIBLE_DEVICES": "0"}, timeout=86400)

# Step 5
s2_output = os.path.join(work_dir, "logs_s2", "Raiden_JA")
exp_dir = os.path.join(s2_output, "44k")
os.makedirs(exp_dir, exist_ok=True)
for s in ["2-name2text.txt"]:
    src = os.path.join(work_dir, s)
    if os.path.exists(src) and not os.path.exists(os.path.join(exp_dir, s)):
        shutil.copy2(src, os.path.join(exp_dir, s))
for s in ["4-cnhubert", "5-wav32k"]:
    src = os.path.join(work_dir, s)
    dst = os.path.join(exp_dir, s)
    if os.path.exists(src) and not os.path.exists(dst): shutil.copytree(src, dst)

s2_cfg = os.path.join(GSV_CODE, "configs", "s2.json")
s2_bak = s2_cfg + ".bak"
with open(s2_cfg, 'r') as f: sc = json.load(f)
sc["s2_ckpt_dir"] = s2_output
sc["train"]["epochs"] = 100
sc["train"]["batch_size"] = 32
sc["train"]["fp16_run"] = True
if not os.path.exists(s2_bak): shutil.copy2(s2_cfg, s2_bak)
with open(s2_cfg, 'w') as f: json.dump(sc, f, indent=2)

print(f"\n=== Step 5: S2 Train (cwd={GSV_CODE}) ===", flush=True)
r5 = subprocess.run([PYTHON, "s2_train.py"], capture_output=True, text=True, timeout=86400,
    env=make_env({"CUDA_VISIBLE_DEVICES": "0"}), cwd=GSV_CODE)
if os.path.exists(s2_bak): shutil.copy2(s2_bak, s2_cfg)
print(f"  Exit: {r5.returncode}", flush=True)
if r5.stdout: print(f"  stdout: {r5.stdout[-500:]}", flush=True)
if r5.stderr: print(f"  stderr: {r5.stderr[-500:]}", flush=True)

print(f"\n{'='*60}\n  DONE!\n  S1: {s1_output}\n  S2: {s2_output}", flush=True)
