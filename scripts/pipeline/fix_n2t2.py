import os, json

seg_path = r"D:\Project\tts_broker_openai_compat\test_raiden\日文\segments.json"
with open(seg_path, 'r', encoding='utf-8') as f:
    seg_data = json.load(f)

n2t_path = r"D:\Project\tts_broker_openai_compat\test_raiden\日文\2-name2text.txt"
with open(n2t_path, 'w', encoding='utf-8') as f:
    for s in seg_data['segments']:
        name = s['scene']
        text = s['text']
        spk_name = 'Raiden_JA'
        lang = 'JA'
        f.write(f"{name}|{spk_name}|{lang}|{text}\n")

# Verify
with open(n2t_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()
print(f"Lines: {len(lines)}")
for line in lines[:3]:
    parts = line.strip().split('|')
    print(f"  parts={len(parts)}: {parts[0]} | {parts[3][:40]}")
