import os, json

# Read segments.json
seg_path = r"D:\Project\tts_broker_openai_compat\test_raiden\日文\segments.json"
with open(seg_path, 'r', encoding='utf-8') as f:
    seg_data = json.load(f)

# Write 2-name2text.txt with | separator (GPT-SoVITS format)
n2t_path = r"D:\Project\tts_broker_openai_compat\test_raiden\日文\2-name2text.txt"
with open(n2t_path, 'w', encoding='utf-8') as f:
    for s in seg_data['segments']:
        name = s['scene']
        text = s['text']
        spk_name = 'Raiden_JA'
        lang = 'JA'
        f.write(f"{name}|{spk_name}|{lang}|{text}\n")

print(f"Written: {len(seg_data['segments'])} lines")
