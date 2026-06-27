import os, json

# Temporarily set epochs to 1 for testing
s2_config_path = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code\configs\s2.json"
with open(s2_config_path, 'r', encoding='utf-8') as f:
    cfg = json.load(f)

cfg["train"]["epochs"] = 1
with open(s2_config_path, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print("Set epochs=1 for testing")
