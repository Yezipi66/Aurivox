import shutil, os

base = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
for root, dirs, files in os.walk(base):
    if "__pycache__" in dirs:
        p = os.path.join(root, "__pycache__")
        shutil.rmtree(p)
        print(f"Removed: {p}")

print("Done!")
