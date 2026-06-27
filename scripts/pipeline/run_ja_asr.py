import subprocess, os, json, shutil, sys

PYTHON = "D:/Project/tts_broker_openai_compat/venv/Scripts/python.exe"
TOOLS = "D:/Project/tts_broker_openai_compat/lib/training/gsv-tools"
ASSETS = "D:/Project/tts_broker_openai_compat/assets"

work_dir = "D:/Project/tts_broker_openai_compat/test_raiden/日文"
slicer_out = os.path.join(work_dir, 'slicer_opt')
asr_out = os.path.join(work_dir, 'asr_output')

# Check if slicer output exists
sliced = [f for f in os.listdir(slicer_out) if f.endswith('.wav')]
print(f"Sliced files: {len(sliced)}")

# Run ASR
print("Running ASR (faster-whisper, ja)...")
os.makedirs(asr_out, exist_ok=True)
asr_script = os.path.join(TOOLS, 'asr', 'fasterwhisper_asr.py')
asr_args = ['-i', slicer_out, '-o', asr_out, '-l', 'ja', '-s', 'large-v3', '-p', 'float16']
r = subprocess.run([PYTHON, asr_script] + asr_args, capture_output=True, text=True, timeout=900)
print(f"ASR exit: {r.returncode}")

# Parse
list_files = [f for f in os.listdir(asr_out) if f.endswith('.list')]
segments = []
if list_files:
    with open(os.path.join(asr_out, list_files[0]), 'r', encoding='utf-8') as fp:
        for i, line in enumerate(fp):
            line = line.strip()
            if not line: continue
            parts = line.split('|')
            if len(parts) >= 4:
                audio_file = os.path.basename(parts[0])
                segments.append({
                    'index': i, 'scene': os.path.splitext(audio_file)[0],
                    'audio': audio_file, 'audio_path': f'slicer_opt/{audio_file}',
                    'text': parts[3], 'matched': True, 'duration': 0,
                })
if not segments:
    for i, f in enumerate(sliced):
        segments.append({
            'index': i, 'scene': os.path.splitext(f)[0],
            'audio': f, 'audio_path': f'slicer_opt/{f}',
            'text': '', 'matched': True, 'duration': 0,
        })
print(f"Segments: {len(segments)}")
for s in segments[:5]:
    print(f"  {s['audio']}: {s['text'][:80]}")

# Register
assets_dir = os.path.join(ASSETS, "Raiden_日文")
if os.path.exists(assets_dir): shutil.rmtree(assets_dir)
os.makedirs(assets_dir)
shutil.copytree(slicer_out, os.path.join(assets_dir, 'slicer_opt'))
seg_data = {
    'voice': 'Raiden_日文', 'language': 'ja',
    'asr_engine': 'faster-whisper', 'source_file': 'slicer_opt/',
    'total': len(segments), 'matched': len(segments), 'segments': segments,
}
with open(os.path.join(assets_dir, 'segments.json'), 'w', encoding='utf-8') as fp:
    json.dump(seg_data, fp, ensure_ascii=False, indent=2)
n2t = os.path.join(assets_dir, '2-name2text.txt')
with open(n2t, 'w', encoding='utf-8') as fp:
    for s in segments:
        fp.write(f"{s['scene']}\tRaiden_日文\tJA\t{s['text']}\n")
print(f"Done! -> {assets_dir}")
