import shutil, os

src = r"D:\Project\tts_broker_openai_compat\assets\Raiden_日文\2-name2text.txt"
dst_dir = r"D:\Project\tts_broker_openai_compat\test_raiden\日文"
os.makedirs(dst_dir, exist_ok=True)
shutil.copy2(src, os.path.join(dst_dir, "2-name2text.txt"))
print(f"Copied: {src} -> {dst_dir}")
