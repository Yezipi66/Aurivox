import os, re

base = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-code"

for root, dirs, files in os.walk(base):
    for f in files:
        if f.endswith('.py'):
            path = os.path.join(root, f)
            with open(path, 'r', encoding='utf-8') as fp:
                content = fp.read()
            
            new_content = re.sub(r'from text\.', 'from gsv_code.text.', content)
            
            if new_content != content:
                with open(path, 'w', encoding='utf-8') as fp:
                    fp.write(new_content)
                rel = path.replace(base + '\\', '')
                print(f"Fixed: {rel}")

print("Done!")
