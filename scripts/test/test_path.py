import subprocess, os, sys

# Add gsv_code to sys.path BEFORE importing anything else
sys.path.insert(0, "D:/Project/tts_broker_openai_compat")
sys.path.insert(0, "D:/Project/tts_broker_openai_compat/lib/training/gsv-code")

# Now test that gsv_code is importable
from gsv_code.text.cleaner import clean_text
from gsv_code.feature_extractor import cnhubert
from gsv_code import utils
print("gsv_code imports OK!")

PYTHON = "D:/Project/tts_broker_openai_compat/venv/Scripts/python.exe"
GSV_CODE = "D:/Project/tts_broker_openai_compat/lib/training/gsv-code"
GSV_TOOLS = "D:/Project/tts_broker_openai_compat/lib/training/gsv-tools"

work_dir = "D:/Project/tts_broker_openai_compat/test_raiden/日文"
name2text = os.path.join(work_dir, "2-name2text.txt")

MODELS = {
    "bert": os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large"),
    "cnhubert": os.path.join(GSV_TOOLS, "pretrained", "chinese-hubert-base"),
    "s2G": os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth"),
}

def run_step(desc, script, env_extra):
    print(f"\n=== {desc} ===")
    env = {**os.environ, 'PYTHONUNBUFFERED': '1', **env_extra}
    r = subprocess.run([PYTHON, script], capture_output=True, text=True, timeout=600, env=env)
    print(f"  Exit: {r.returncode}")
    if r.stdout: print(f"  stdout: {r.stdout[-300:]}")
    if r.stderr: print(f"  stderr: {r.stderr[-300:]}")
    return r

# Step 1: 1-get-text (needs BERT)
run_step("Step 1: BERT text features",
    os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py"),
    {"inp_text": name2text, "inp_wav_dir": "", "exp_name": "Raiden_JA",
     "i_part": "0", "all_parts": "1", "opt_dir": work_dir,
     "bert_pretrained_dir": MODELS["bert"], "is_half": "True",
     "_CUDA_VISIBLE_DEVICES": "0"})

n2t_path = os.path.join(work_dir, "2-name2text-0.txt")
bert_dir = os.path.join(work_dir, "3-bert")
print(f"  3-bert/: {len(os.listdir(bert_dir)) if os.path.exists(bert_dir) else 0} files")
