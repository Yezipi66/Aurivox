import os, shutil, json

PROJECT = r"D:\Project\tts_broker_openai_compat"
work_dir = os.path.join(PROJECT, "test_raiden", "日文")
GSV_CODE = os.path.join(PROJECT, "lib", "training", "gsv_code")
GSV_TOOLS = os.path.join(PROJECT, "lib", "training", "gsv-tools")

# S2 output directory
s2_output = os.path.join(work_dir, "logs_s2", "Raiden_JA")
exp_dir = os.path.join(s2_output, "44k")
os.makedirs(exp_dir, exist_ok=True)

# Copy required files to 44k directory
# 1. 2-name2text.txt (from S1 output)
src_n2t = os.path.join(work_dir, "2-name2text-0.txt")
dst_n2t = os.path.join(exp_dir, "2-name2text.txt")
if os.path.exists(src_n2t) and not os.path.exists(dst_n2t):
    shutil.copy2(src_n2t, dst_n2t)
    print(f"Copied: 2-name2text.txt")

# 2. 4-cnhubert directory
src_hubert = os.path.join(work_dir, "4-cnhubert")
dst_hubert = os.path.join(exp_dir, "4-cnhubert")
if os.path.exists(src_hubert) and not os.path.exists(dst_hubert):
    shutil.copytree(src_hubert, dst_hubert)
    print(f"Copied: 4-cnhubert/")

# 3. 5-wav32k directory
src_wav32k = os.path.join(work_dir, "5-wav32k")
dst_wav32k = os.path.join(exp_dir, "5-wav32k")
if os.path.exists(src_wav32k) and not os.path.exists(dst_wav32k):
    shutil.copytree(src_wav32k, dst_wav32k)
    print(f"Copied: 5-wav32k/")

# Update s2.json
s2_config_path = os.path.join(GSV_CODE, "configs", "s2.json")
with open(s2_config_path, 'r', encoding='utf-8') as f:
    s2_config = json.load(f)

s2_config["s2_ckpt_dir"] = s2_output
s2_config["train"]["epochs"] = 10  # Start with 10 epochs for testing
s2_config["train"]["batch_size"] = 32
s2_config["train"]["fp16_run"] = True
s2_config["train"]["gpu_numbers"] = "0"

# Backup original
s2_backup = s2_config_path + ".orig"
if not os.path.exists(s2_backup):
    shutil.copy2(s2_config_path, s2_backup)
    print("Backed up s2.json")

with open(s2_config_path, 'w', encoding='utf-8') as f:
    json.dump(s2_config, f, indent=2, ensure_ascii=False)
print(f"Updated s2.json: s2_ckpt_dir={s2_output}")

# Verify 44k directory
print(f"\n44k directory contents:")
for item in os.listdir(exp_dir):
    path = os.path.join(exp_dir, item)
    if os.path.isdir(path):
        count = sum(1 for _, _, files in os.walk(path) for _ in files)
        print(f"  {item}/: {count} files")
    else:
        size = os.path.getsize(path)
        print(f"  {item}: {size/1024:.1f} KB")
