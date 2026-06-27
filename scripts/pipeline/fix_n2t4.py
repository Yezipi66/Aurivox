import os, json

# segments.json is in assets, not test_raiden
seg_path = r"D:\Project\tts_broker_openai_compat\assets\Raiden_日文\segments.json"
print(f"seg_path: {seg_path}")
print(f"exists: {os.path.exists(seg_path)}")

with open(seg_path, 'r', encoding='utf-8') as f:
    seg_data = json.load(f)

print(f"total: {seg_data['total']}")
print(f"first: {seg_data['segments'][0]['audio']}: {seg_data['segments'][0]['text'][:50]}")

n2t_path = r"D:\Project\tts_broker_openai_compat\test_raiden\日文\2-name2text.txt"
with open(n2t_path, 'w', encoding='utf-8') as f:
    for s in seg_data['segments']:
        name = s['audio'].replace('.wav', '')  # Remove .wav extension
        text = s['text']
        spk_name = 'Raiden_JA'
        lang = 'JA'
        line = name + '|' + spk_name + '|' + lang + '|' + text + '\n'
        f.write(line)

# Verify
with open(n2t_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()
print(f"\nWritten: {len(lines)} lines")
for line in lines[:3]:
    parts = line.strip().split('|')
    print(f"  {parts[0]} | {parts[3][:50]}")
