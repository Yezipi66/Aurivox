import os, json

seg_path = r"D:\Project\tts_broker_openai_compat\test_raiden\日文\segments.json"
print(f"seg_path exists: {os.path.exists(seg_path)}")

with open(seg_path, 'r', encoding='utf-8') as f:
    seg_data = json.load(f)

print(f"total segments: {seg_data['total']}")
print(f"first segment: {seg_data['segments'][0]}")

n2t_path = r"D:\Project\tts_broker_openai_compat\test_raiden\日文\2-name2text.txt"
with open(n2t_path, 'w', encoding='utf-8') as f:
    for s in seg_data['segments']:
        name = s['scene']
        text = s['text']
        spk_name = 'Raiden_JA'
        lang = 'JA'
        line = name + '|' + spk_name + '|' + lang + '|' + text + '\n'
        f.write(line)

# Verify
with open(n2t_path, 'r', encoding='utf-8') as f:
    line = f.readline()
print(f"Written first line: {repr(line.strip())}")
parts = line.strip().split('|')
print(f"Parts count: {len(parts)}")
print(f"Part 0: {parts[0]}")
print(f"Part 3: {parts[3][:50]}")
