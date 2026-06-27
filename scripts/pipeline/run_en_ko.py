import subprocess, os, json, shutil, sys

PYTHON = "D:/Project/tts_broker_openai_compat/venv/Scripts/python.exe"
TOOLS = "D:/Project/tts_broker_openai_compat/lib/training/gsv-tools"
FFMPEG = "D:/AI/GPT-SoVITS-v2pro-20250604/runtime/ffmpeg.exe"
ASSETS = "D:/Project/tts_broker_openai_compat/assets"
base = "D:/voices/raiden"
work_base = "D:/Project/tts_broker_openai_compat/test_raiden"

def register_lang(lang_name, lang_code):
    work_dir = os.path.join(work_base, lang_name)
    slicer_out = os.path.join(work_dir, 'slicer_opt')
    asr_out = os.path.join(work_dir, 'asr_output')

    # Parse ASR
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
        sliced = [f for f in os.listdir(slicer_out) if f.endswith('.wav')]
        for i, f in enumerate(sliced):
            segments.append({
                'index': i, 'scene': os.path.splitext(f)[0],
                'audio': f, 'audio_path': f'slicer_opt/{f}',
                'text': '', 'matched': True, 'duration': 0,
            })

    assets_dir = os.path.join(ASSETS, f"Raiden_{lang_name}")
    if os.path.exists(assets_dir): shutil.rmtree(assets_dir)
    os.makedirs(assets_dir)
    shutil.copytree(slicer_out, os.path.join(assets_dir, 'slicer_opt'))
    seg_data = {
        'voice': f'Raiden_{lang_name}', 'language': lang_code,
        'asr_engine': 'faster-whisper', 'source_file': 'slicer_opt/',
        'total': len(segments), 'matched': len(segments), 'segments': segments,
    }
    with open(os.path.join(assets_dir, 'segments.json'), 'w', encoding='utf-8') as fp:
        json.dump(seg_data, fp, ensure_ascii=False, indent=2)
    n2t = os.path.join(assets_dir, '2-name2text.txt')
    with open(n2t, 'w', encoding='utf-8') as fp:
        for s in segments:
            fp.write(f"{s['scene']}\tRaiden_{lang_name}\t{lang_code.upper()}\t{s['text']}\n")
    print(f"  {lang_name}: {len(segments)} segments -> {assets_dir}")

def run_asr_only(lang_name, lang_code):
    work_dir = os.path.join(work_base, lang_name)
    slicer_out = os.path.join(work_dir, 'slicer_opt')
    asr_out = os.path.join(work_dir, 'asr_output')

    if not os.path.exists(slicer_out) or not os.listdir(slicer_out):
        print(f"  {lang_name}: No slices, skipping")
        return

    sliced = [f for f in os.listdir(slicer_out) if f.endswith('.wav')]
    print(f"  {lang_name}: {len(sliced)} slices, running ASR...")

    os.makedirs(asr_out, exist_ok=True)
    asr_script = os.path.join(TOOLS, 'asr', 'fasterwhisper_asr.py')
    asr_args = ['-i', slicer_out, '-o', asr_out, '-l', lang_code, '-s', 'large-v3', '-p', 'float16']
    r = subprocess.run([PYTHON, asr_script] + asr_args, capture_output=True, text=True, timeout=900)
    print(f"  ASR exit: {r.returncode}")
    register_lang(lang_name, lang_code)

# Register 日文 (already done)
print("=== Registering 日文 ===")
register_lang('日文', 'ja')

# Run 英文
print("\n=== 英文 (en) ===")
run_asr_only('英文', 'en')

# Run 韩文
print("\n=== 韩文 (ko) ===")
run_asr_only('韩文', 'ko')

print("\nAll done!")
