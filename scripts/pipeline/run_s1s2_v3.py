import subprocess, os, sys, shutil, json, yaml

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
name2text = os.path.join(work_dir, "2-name2text.txt")
semantic = os.path.join(work_dir, "6-name2semantic-0.tsv")

MODELS = {
    "s1": os.path.join(GSV_TOOLS, "pretrained", "gsv-v2final", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
    "s2G": os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth"),
}

sys.stdout.reconfigure(encoding='utf-8')

def make_env(extra):
    env = os.environ.copy()
    env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
    env['PYTHONUNBUFFERED'] = '1'
    env.update(extra)
    return env

# Step 4: S1 Training - use the original s1longer.yaml as base and override
s1_output = os.path.join(work_dir, "logs_s1", "Raiden_JA")
os.makedirs(s1_output, exist_ok=True)

# Load original config and add missing fields
s1_config_path = os.path.join(GSV_CODE, "configs", "s1longer.yaml")
with open(s1_config_path, 'r', encoding='utf-8') as f:
    s1_config = yaml.safe_load(f)

# Add missing fields needed by s1_train.py
s1_config["output_dir"] = s1_output
s1_config["pretrained_s1"] = MODELS["s1"]
s1_config["train_semantic_path"] = semantic
s1_config["train_phoneme_path"] = name2text
s1_config["model"]["vocab_size"] = 732
s1_config["model"]["EOS"] = 731
s1_config["train"]["if_save_latest"] = True
s1_config["train"]["if_save_every_weights"] = False
s1_config["train"]["half_weights_save_dir"] = os.path.join(s1_output, "half_weights")
s1_config["train"]["exp_name"] = "Raiden_JA"

s1_config_custom = os.path.join(work_dir, "s1_config.yaml")
with open(s1_config_custom, 'w', encoding='utf-8') as f:
    yaml.dump(s1_config, f)

print("=== Step 4: S1 Train (20 epochs) ===", flush=True)
print(f"  Config: {s1_config_custom}", flush=True)
print(f"  Output: {s1_output}", flush=True)

proc = subprocess.Popen(
    [PYTHON, '-u', os.path.join(GSV_CODE, "s1_train.py"), '-c', s1_config_custom],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=make_env({"CUDA_VISIBLE_DEVICES": "0"}))

for line in proc.stdout:
    print(f"  {line}", end='', flush=True)

proc.wait()
print(f"\n  S1 Exit: {proc.returncode}", flush=True)

if proc.returncode != 0:
    print("S1 Training FAILED!")
    sys.exit(1)

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
proc5 = subprocess.Popen([PYTHON, '-u', "s2_train.py"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=make_env({"CUDA_VISIBLE_DEVICES": "0"}), cwd=GSV_CODE)
for line in proc5.stdout:
    print(f"  {line}", end='', flush=True)
proc5.wait()
if os.path.exists(s2_bak): shutil.copy2(s2_bak, s2_cfg)
print(f"\n  S2 Exit: {proc5.returncode}", flush=True)

print(f"\n{'='*60}\n  Pipeline complete!\n  S1: {s1_output}\n  S2: {s2_output}", flush=True)
