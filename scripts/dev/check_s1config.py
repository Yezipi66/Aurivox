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

# Check what keys are needed from the original s1longer.yaml
import subprocess as sp
r = sp.run([PYTHON, '-c', '''
import yaml
with open(r"D:\\Project\\tts_broker_openai_compat\\lib\\training\\gsv_code\\configs\\s1longer.yaml") as f:
    config = yaml.safe_load(f)
print("=== s1longer.yaml structure ===")
for k, v in config.items():
    if isinstance(v, dict):
        print(f"  {k}:")
        for k2, v2 in v.items():
            print(f"    {k2}: {v2}")
    else:
        print(f"  {k}: {v}")
'''], capture_output=True, text=True, timeout=10)
print(r.stdout)
if r.stderr:
    print("STDERR:", r.stderr[:500])
