import subprocess, os, sys, shutil

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
n2t = os.path.join(work_dir, "2-name2text-0.txt")

MODELS = {
    "cnhubert": os.path.join(GSV_TOOLS, "pretrained", "chinese-hubert-base"),
    "s2G": os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth"),
    "s1": os.path.join(GSV_TOOLS, "pretrained", "gsv-v2final", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
}

sys.stdout.reconfigure(encoding='utf-8')

def make_env(extra):
    env = os.environ.copy()
    env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
    env['PYTHONUNBUFFERED'] = '1'
    env.update(extra)
    return env

def run_step(desc, script, env_extra, timeout=600):
    print(f"\n=== {desc} ===", flush=True)
    proc = subprocess.Popen([PYTHON, script],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, env=make_env(env_extra))
    for line in proc.stdout:
        print(f"  {line}", end='', flush=True)
    proc.wait()
    print(f"  Exit: {proc.returncode}", flush=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Failed: {desc}")
    return proc.returncode

# Step 2: Hubert + wav32k
run_step("Step 2: Hubert+wav32k", os.path.join(GSV_CODE, "prepare_datasets", "2-get-hubert-wav32k.py"),
    {"inp_text": n2t, "inp_wav_dir": os.path.join(work_dir, "wav"), "exp_name": "Raiden_JA",
     "i_part": "0", "all_parts": "1", "opt_dir": work_dir,
     "cnhubert_base_dir": MODELS["cnhubert"], "is_half": "True", "_CUDA_VISIBLE_DEVICES": "0"})

hubert_dir = os.path.join(work_dir, "4-cnhubert")
wav32k_dir = os.path.join(work_dir, "5-wav32k")
hubert_files = len(os.listdir(hubert_dir)) if os.path.exists(hubert_dir) else 0
wav32k_files = len(os.listdir(wav32k_dir)) if os.path.exists(wav32k_dir) else 0
print(f"\n  4-cnhubert/: {hubert_files} files, 5-wav32k/: {wav32k_files} files")

if hubert_files == 0 or wav32k_files == 0:
    print("  WARNING: Step 2 output missing!")
    sys.exit(1)

# Step 3: Semantic
run_step("Step 3: Semantic", os.path.join(GSV_CODE, "prepare_datasets", "3-get-semantic.py"),
    {"inp_text": n2t, "exp_name": "Raiden_JA", "i_part": "0", "all_parts": "1",
     "opt_dir": work_dir, "pretrained_s2G": MODELS["s2G"],
     "s2config_path": os.path.join(GSV_CODE, "configs", "s2.json"),
     "is_half": "True", "_CUDA_VISIBLE_DEVICES": "0"})

semantic = os.path.join(work_dir, "6-name2semantic.tsv")
sv_dir = os.path.join(work_dir, "7-sv_cn")
sv_files = len(os.listdir(sv_dir)) if os.path.exists(sv_dir) else 0
print(f"\n  6-name2semantic.tsv: {os.path.exists(semantic)}, 7-sv_cn/: {sv_files} files")

# Step 4: S1 Training
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
s1_config_path = os.path.join(work_dir, "s1_config.yaml")
with open(s1_config_path, 'w') as f: yaml.dump(s1_config, f)

run_step("Step 4: S1 Train (20 epochs)", os.path.join(GSV_CODE, "s1_train.py"),
    {"CUDA_VISIBLE_DEVICES": "0"}, timeout=86400)

# Step 5: S2 Training
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

print(f"\n=== Step 5: S2 Train (100 epochs, cwd={GSV_CODE}) ===", flush=True)
proc5 = subprocess.Popen([PYTHON, "s2_train.py"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=make_env({"CUDA_VISIBLE_DEVICES": "0"}), cwd=GSV_CODE)
for line in proc5.stdout:
    print(f"  {line}", end='', flush=True)
proc5.wait()
if os.path.exists(s2_bak): shutil.copy2(s2_bak, s2_cfg)
print(f"  Exit: {proc5.returncode}", flush=True)

print(f"\n{'='*60}\n  Pipeline complete!\n  S1: {s1_output}\n  S2: {s2_output}", flush=True)
