import subprocess, sys, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
GSV_TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
PROJECT = r"D:\Project\tts_broker_openai_compat"

work_dir = os.path.join(PROJECT, "test_raiden", "日文")

MODELS = {
    "s1": os.path.join(GSV_TOOLS, "pretrained", "gsv-v2final", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
}

s1_output = os.path.join(work_dir, "logs_s1", "Raiden_JA")

import yaml
s1_config = {
    "train": {
        "seed": 1234, "epochs": 3, "batch_size": 8,
        "save_every_n_epoch": 1, "precision": "16-mixed", "gradient_clip": 1.0,
        "inference": {"top_k": 5},
        "if_save_latest": True, "if_save_every_weights": True,
        "half_weights_save_dir": os.path.join(s1_output, "ckpt"),
        "exp_name": "Raiden_JA",
    },
    "optimizer": {"lr": 0.01, "lr_init": 0.00001, "lr_end": 0.0001, "warmup_steps": 2000, "decay_steps": 40000},
    "data": {"max_eval_sample": 8, "max_sec": 54, "num_workers": 4, "pad_val": 1024},
    "model": {
        "vocab_size": 1025, "phoneme_vocab_size": 732,
        "embedding_dim": 512, "hidden_dim": 512,
        "head": 16, "linear_units": 2048, "n_layer": 24,
        "dropout": 0, "EOS": 1024, "random_bert": 0,
    },
    "output_dir": s1_output,
    "pretrained_s1": MODELS["s1"],
    "train_semantic_path": os.path.join(work_dir, "6-name2semantic-0.tsv"),
    "train_phoneme_path": os.path.join(work_dir, "2-name2text-0.txt"),
}

s1_config_path = os.path.join(work_dir, "s1_config.yaml")
with open(s1_config_path, 'w', encoding='utf-8') as f:
    yaml.dump(s1_config, f, default_flow_style=False)

env = os.environ.copy()
env['PYTHONPATH'] = os.path.join(PROJECT, "lib", "training")
env['PYTHONUNBUFFERED'] = '1'
env['CUDA_VISIBLE_DEVICES'] = '0'

sys.stdout.reconfigure(encoding='utf-8')
print("=== S1: 3 epochs ===", flush=True)

proc = subprocess.Popen(
    [PYTHON, os.path.join(GSV_CODE, "s1_train.py"), "--config_file", s1_config_path],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1, env=env)

for line in proc.stdout:
    if any(k in line for k in ['Epoch', 'Exit', 'checkpoint', 'Error', 'Traceback']):
        print(f"  {line}", end='', flush=True)

proc.wait()
print(f"\nExit: {proc.returncode}", flush=True)

ckpt_dir = os.path.join(s1_output, "ckpt")
if os.path.exists(ckpt_dir):
    ckpts = os.listdir(ckpt_dir)
    print(f"Checkpoints: {len(ckpts)}")
    for c in sorted(ckpts):
        size = os.path.getsize(os.path.join(ckpt_dir, c))
        print(f"  {c}: {size/1024/1024:.1f} MB")
