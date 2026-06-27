import subprocess, os, json, shutil, sys

PYTHON = "D:/Project/tts_broker_openai_compat/venv/Scripts/python.exe"
TOOLS = "D:/Project/tts_broker_openai_compat/lib/training/gsv-tools"
FFMPEG = "D:/AI/GPT-SoVITS-v2pro-20250604/runtime/ffmpeg.exe"
ASSETS = "D:/Project/tts_broker_openai_compat/assets"
base = "D:/voices/raiden"
work_base = "D:/Project/tts_broker_openai_compat/test_raiden"

def run_full(lang_name, lang_code):
    src_dir = os.path.join(base, lang_name)
    work_dir = os.path.join(work_base, lang_name)
    wav_dir = os.path.join(work_dir, 'wav')
    slicer_out = os.path.join(work_dir, 'slicer_opt')
    asr_out = os.path.join(work_dir, 'asr_output')

    if os.path.exists(work_dir): shutil.rmtree(work_dir)
    os.makedirs(wav_dir, exist_ok=True)
    os.makedirs(slicer_out, exist_ok=True)

    # mp3 -> wav
    mp3_files = [f for f in os.listdir(src_dir) if f.endswith('.mp3')]
    print(f"  Converting {len(mp3_files)} mp3...")
    for f in mp3_files:
        mp3 = os.path.join(src_dir, f)
        wav = os.path.join(wav_dir, os.path.splitext(f)[0] + '.wav')
        subprocess.run([FFMPEG, '-y', '-i', mp3, '-ar', '16000', '-ac', '1', wav],
                      capture_output=True, timeout=30)
    wav_files = [f for f in os.listdir(wav_dir) if f.endswith('.wav')]
    print(f"  Wav: {len(wav_files)}")

    # Slice
    print(f"  Slicing...")
    slicer = os.path.join(TOOLS, 'slicer2.py')
    for f in wav_files:
        src = os.path.join(wav_dir, f)
        subprocess.run([PYTHON, slicer, src, '--out', slicer_out, '--db_thresh', '-40',
                      '--min_length', '3000', '--min_interval', '500', '--hop_size', '10',
                      '--max_sil_kept', '500'], capture_output=True, text=True, timeout=120)
    sliced = [f for f in os.listdir(slicer_out) if f.endswith('.wav')]
    print(f"  Sliced: {len(sliced)}")

    # ASR
    print(f"  ASR ({lang_code})...")
    os.makedirs(asr_out, exist_ok=True)
    asr_script = os.path.join(TOOLS, 'asr', 'fasterwhisper_asr.py')
    asr_args = ['-i', slicer_out, '-o', asr_out, '-l', lang_code, '-s', 'large-v3', '-p', 'float16']
    r = subprocess.run([PYTHON, asr_script] + asr_args, capture_output=True, text=True, timeout=900)
    print(f"  ASR exit: {r.returncode}")

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

    print(f"  Segments: {len(segments)}")
    for s in segments[:3]:
        print(f"    {s['audio']}: {s['text'][:60]}")

    # Register
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
    print(f"  -> {assets_dir}")

print("=== 英文 (en) ===")
run_full('英文', 'en')
print("\n=== 韩文 (ko) ===")
run_full('韩文', 'ko')
print("\nAll done!")
