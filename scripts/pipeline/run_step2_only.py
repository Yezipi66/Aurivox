import subprocess, os, sys, shutil

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")
# Use original 2-name2text.txt (| separator) instead of 2-name2text-0.txt (tab separator)
name2text = os.path.join(work_dir, "2-name2text.txt")

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

# Step 2: Hubert + wav32k (use original 2-name2text.txt with | separator)
run_step("Step 2: Hubert+wav32k", os.path.join(GSV_CODE, "prepare_datasets", "2-get-hubert-wav32k.py"),
    {"inp_text": name2text, "inp_wav_dir": os.path.join(work_dir, "wav"), "exp_name": "Raiden_JA",
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

print("\nStep 2 DONE!", flush=True)
