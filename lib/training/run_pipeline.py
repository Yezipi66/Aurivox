"""
Full E2E pipeline for one voice.
Paths are derived from __file__ so it's portable.

Usage:
  python lib/training/run_pipeline.py --voice Raiden_JA --lang ja --work-dir test_raiden/日文
"""
import subprocess, os, sys, json, argparse, shutil

# Derive paths from this file's location
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
GSV_CODE = os.path.join(PROJECT_DIR, "lib", "training", "gsv_code")
GSV_TOOLS = os.path.join(PROJECT_DIR, "lib", "training", "gsv-tools")
PYTHON = os.path.join(PROJECT_DIR, "venv", "Scripts", "python.exe")
FFMPEG = os.path.join("D:", "AI", "GPT-SoVITS-v2pro-20250604", "runtime", "ffmpeg.exe")
ASSETS = os.path.join(PROJECT_DIR, "assets")

MODELS = {
    "bert": os.path.join(GSV_TOOLS, "pretrained", "chinese-roberta-wwm-ext-large"),
    "cnhubert": os.path.join(GSV_TOOLS, "pretrained", "chinese-hubert-base"),
    "s2G": os.path.join(GSV_TOOLS, "pretrained", "v2Pro", "s2Gv2Pro.pth"),
    "s1": os.path.join(GSV_TOOLS, "pretrained", "gsv-v2final", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
}

def make_env(extra):
    """Build env with PYTHONPATH set to include gsv_code"""
    env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
    # Use forward slashes to avoid MSYS mangling
    env['PYTHONPATH'] = PROJECT_DIR.replace("\\", "/") + "/lib/training"
    env['PYTHONUNBUFFERED'] = '1'
    env.update(extra)
    return env

def run_step(desc, script, env_extra, timeout=600):
    print(f"\n=== {desc} ===", flush=True)
    env = make_env(env_extra)
    r = subprocess.run([PYTHON, script], capture_output=True, text=True, timeout=timeout, env=env)
    print(f"  Exit: {r.returncode}", flush=True)
    if r.stdout: print(f"  stdout: {r.stdout[-500:]}", flush=True)
    if r.stderr: print(f"  stderr: {r.stderr[-500:]}", flush=True)
    if r.returncode != 0:
        raise RuntimeError(f"Step failed: {desc}")
    return r

def run_pipeline(voice_name, lang, work_dir, gpt_epochs=20, sovits_epochs=100):
    os.makedirs(work_dir, exist_ok=True)
    name2text = os.path.join(work_dir, "2-name2text.txt")
    if not os.path.exists(name2text):
        raise FileNotFoundError(f"2-name2text.txt not found in {work_dir}")

    n2t = name2text
    wav_dir = os.path.join(work_dir, "wav")

    # Step 1: 1-get-text
    run_step("Step 1: BERT text features",
        os.path.join(GSV_CODE, "prepare_datasets", "1-get-text.py"),
        {"inp_text": n2t, "inp_wav_dir": wav_dir, "exp_name": voice_name,
         "i_part": "0", "all_parts": "1", "opt_dir": work_dir,
         "bert_pretrained_dir": MODELS["bert"], "is_half": "True",
         "_CUDA_VISIBLE_DEVICES": "0"})

    n2t_0 = os.path.join(work_dir, "2-name2text-0.txt")
    if os.path.exists(n2t_0):
        n2t = n2t_0

    # Step 2: 2-get-hubert-wav32k
    run_step("Step 2: CNHubert + wav32k",
        os.path.join(GSV_CODE, "prepare_datasets", "2-get-hubert-wav32k.py"),
        {"inp_text": n2t, "inp_wav_dir": wav_dir, "exp_name": voice_name,
         "i_part": "0", "all_parts": "1", "opt_dir": work_dir,
         "cnhubert_base_dir": MODELS["cnhubert"], "is_half": "True",
         "_CUDA_VISIBLE_DEVICES": "0"})

    # Step 3: 3-get-semantic
    run_step("Step 3: Semantic features",
        os.path.join(GSV_CODE, "prepare_datasets", "3-get-semantic.py"),
        {"inp_text": n2t, "exp_name": voice_name, "i_part": "0", "all_parts": "1",
         "opt_dir": work_dir, "pretrained_s2G": MODELS["s2G"],
         "s2config_path": os.path.join(GSV_CODE, "configs", "s2.json"),
         "is_half": "True", "_CUDA_VISIBLE_DEVICES": "0"})

    semantic_path = os.path.join(work_dir, "6-name2semantic.tsv")

    # Step 4: S1 Training
    s1_output = os.path.join(work_dir, "logs_s1", voice_name)
    os.makedirs(s1_output, exist_ok=True)

    import yaml
    s1_config = {
        "train": {
            "seed": 1234, "epochs": gpt_epochs, "batch_size": 8,
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

    run_step(f"Step 4: S1 Training ({gpt_epochs} epochs)",
        os.path.join(GSV_CODE, "s1_train.py"),
        {"CUDA_VISIBLE_DEVICES": "0"},
        timeout=86400)

    # Step 5: S2 Training
    s2_output = os.path.join(work_dir, "logs_s2", voice_name)
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
    s2_config["train"]["epochs"] = sovits_epochs
    s2_config["train"]["batch_size"] = 32
    s2_config["train"]["fp16_run"] = True
    if not os.path.exists(s2_config_backup):
        shutil.copy2(s2_config_path, s2_config_backup)
    with open(s2_config_path, 'w', encoding='utf-8') as f:
        json.dump(s2_config, f, indent=2)

    print(f"\n=== Step 5: S2 Training ({sovits_epochs} epochs) ===", flush=True)
    print(f"  cwd: {GSV_CODE}", flush=True)
    env5 = make_env({"CUDA_VISIBLE_DEVICES": "0"})
    r5 = subprocess.run([PYTHON, "s2_train.py"], capture_output=True, text=True, timeout=86400, env=env5, cwd=GSV_CODE)
    if os.path.exists(s2_config_backup):
        shutil.copy2(s2_config_backup, s2_config_path)
    print(f"  S2 exit: {r5.returncode}", flush=True)
    if r5.stdout: print(f"  stdout: {r5.stdout[-500:]}", flush=True)
    if r5.stderr: print(f"  stderr: {r5.stderr[-500:]}", flush=True)

    print(f"\n{'='*60}", flush=True)
    print("  Pipeline complete!", flush=True)
    print(f"  S1: {s1_output}", flush=True)
    print(f"  S2: {s2_output}", flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", required=True)
    parser.add_argument("--lang", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--gpt-epochs", type=int, default=20)
    parser.add_argument("--sovits-epochs", type=int, default=100)
    args = parser.parse_args()
    run_pipeline(args.voice, args.lang, args.work_dir, args.gpt_epochs, args.sovits_epochs)
