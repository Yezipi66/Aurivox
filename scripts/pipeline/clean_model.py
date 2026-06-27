import os, shutil

# 清理不完整的下载
model_dir = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\asr\models\faster-whisper-large-v3"
if os.path.exists(model_dir):
    shutil.rmtree(model_dir)
    print(f"Cleaned: {model_dir}")
else:
    print("Not found")
