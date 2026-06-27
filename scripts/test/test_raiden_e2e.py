# -*- coding: utf-8 -*-
"""
端到端训练测试：Raiden 4种语言
"""
import subprocess, os, json, shutil, sys

sys.stdout.reconfigure(encoding='utf-8')

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-code"

# 使用短路径避免编码问题
base = os.path.join(r"D:\voices", "raiden")
work_base = os.path.join(r"D:\Project", "tts_broker_openai_compat", "test_raiden")

# 获取实际的语言目录名
lang_dirs = {}
for d in os.listdir(base):
    lang_path = os.path.join(base, d)
    if os.path.isdir(lang_path):
        files = [f for f in os.listdir(lang_path) if f.endswith('.mp3')]
        if files:
            lang_dirs[d] = len(files)

print(f"Found language dirs: {lang_dirs}")

# 映射语言名到配置
lang_config = {
    '中文': {'lang': 'zh', 'asr': 'funasr'},
    '日文': {'lang': 'ja', 'asr': 'faster-whisper'},
    '英文': {'lang': 'en', 'asr': 'faster-whisper'},
    '韩文': {'lang': 'ko', 'asr': 'faster-whisper'},
}

results = {}

for lang_name, cfg in lang_config.items():
    src_dir = os.path.join(base, lang_name)
    if not os.path.exists(src_dir):
        print(f"  SKIP: {lang_name} directory not found")
        continue

    work_dir = os.path.join(work_base, lang_name)
    assets_dir = os.path.join(r"D:\Project", "tts_broker_openai_compat", "assets", f"Raiden_{lang_name}")

    print(f"\n{'='*60}")
    print(f"  {lang_name} ({cfg['lang']})")
    print(f"{'='*60}")

    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)

    # Step 0: mp3 → wav
    print(f"\n--- Step 0: mp3 → wav ---")
    mp3_files = [f for f in os.listdir(src_dir) if f.endswith('.mp3')]
    wav_dir = os.path.join(work_dir, 'wav')
    os.makedirs(wav_dir, exist_ok=True)

    for f in mp3_files:
        mp3 = os.path.join(src_dir, f)
        wav_name = os.path.splitext(f)[0] + '.wav'
        wav = os.path.join(wav_dir, wav_name)
        cmd = [r"D:\AI\GPT-SoVITS-v2pro-20250604\runtime\ffmpeg.exe", '-y', '-i', mp3, '-ar', '16000', '-ac', '1', wav]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            print(f"  FAIL: {f}")

    wav_files = [f for f in os.listdir(wav_dir) if f.endswith('.wav')]
    print(f"  Converted: {len(wav_files)}/{len(mp3_files)}")

    if not wav_files:
        print("  ERROR: No wav files!")
        continue

    # Step 1: Slice
    print(f"\n--- Step 1: Slice ---")
    slicer = os.path.join(TOOLS, 'slicer2.py')
    slicer_out = os.path.join(work_dir, 'slicer_opt')
    os.makedirs(slicer_out, exist_ok=True)

    failed = 0
    for f in wav_files:
        src = os.path.join(wav_dir, f)
        cmd = [PYTHON, slicer, src, '--out', slicer_out, '--db_thresh', '-40',
               '--min_length', '3000', '--min_interval', '500', '--hop_size', '10', '--max_sil_kept', '500']
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            failed += 1

    sliced = [f for f in os.listdir(slicer_out) if f.endswith('.wav')]
    print(f"  Sliced: {len(sliced)} files, {failed} failures")

    if not sliced:
        print("  ERROR: No slices!")
        continue

    # Step 2: ASR
    print(f"\n--- Step 2: ASR ({cfg['asr']}, {cfg['lang']}) ---")
    if cfg['asr'] == 'funasr':
        asr_script = os.path.join(TOOLS, 'asr', 'funasr_asr.py')
        asr_args = ['-i', slicer_out, '-o', os.path.join(work_dir, 'asr_output'), '-l', cfg['lang']]
    else:
        asr_script = os.path.join(TOOLS, 'asr', 'fasterwhisper_asr.py')
        asr_args = ['-i', slicer_out, '-o', os.path.join(work_dir, 'asr_output'),
                     '-l', cfg['lang'], '-s', 'large-v3', '-p', 'float16']

    os.makedirs(os.path.join(work_dir, 'asr_output'), exist_ok=True)
    cmd = [PYTHON, asr_script] + asr_args
    print(f"  Running ASR (several minutes)...")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    print(f"  Exit: {r.returncode}")

    # Parse ASR output
    asr_out_dir = os.path.join(work_dir, 'asr_output')
    list_files = [f for f in os.listdir(asr_out_dir) if f.endswith('.list')]
    segments = []

    if list_files:
        with open(os.path.join(asr_out_dir, list_files[0]), 'r', encoding='utf-8') as fp:
            for i, line in enumerate(fp):
                line = line.strip()
                if not line:
                    continue
                parts = line.split('|')
                if len(parts) >= 4:
                    audio_file = os.path.basename(parts[0])
                    segments.append({
                        'index': i, 'scene': os.path.splitext(audio_file)[0],
                        'audio': audio_file, 'audio_path': f'slicer_opt/{audio_file}',
                        'text': parts[3], 'matched': True, 'duration': 0,
                    })

    if not segments:
        print("  WARN: No segments parsed, using filenames")
        for i, f in enumerate(sliced):
            segments.append({
                'index': i, 'scene': os.path.splitext(f)[0],
                'audio': f, 'audio_path': f'slicer_opt/{f}',
                'text': '', 'matched': True, 'duration': 0,
            })

    print(f"  Segments: {len(segments)}")
    for s in segments[:3]:
        print(f"    {s['audio']}: {s['text'][:60]}")

    # Save segments.json
    seg_data = {
        'voice': f'Raiden_{lang_name}', 'language': cfg['lang'],
        'asr_engine': cfg['asr'], 'source_file': 'slicer_opt/',
        'generated_at': '2026-06-19T00:00:00Z',
        'total': len(segments), 'matched': len(segments), 'segments': segments,
    }
    with open(os.path.join(work_dir, 'segments.json'), 'w', encoding='utf-8') as fp:
        json.dump(seg_data, fp, ensure_ascii=False, indent=2)

    # Step 3: Register
    print(f"\n--- Step 3: Register ---")
    if os.path.exists(assets_dir):
        shutil.rmtree(assets_dir)
    os.makedirs(assets_dir)

    shutil.copytree(slicer_out, os.path.join(assets_dir, 'slicer_opt'))
    shutil.copy2(os.path.join(work_dir, 'segments.json'), os.path.join(assets_dir, 'segments.json'))

    # Generate 2-name2text.txt
    name2text_path = os.path.join(work_dir, '2-name2text.txt')
    with open(name2text_path, 'w', encoding='utf-8') as fp:
        for s in segments:
            name = s['scene']
            text = s['text']
            lang_code = cfg['lang'].upper()
            spk_name = f"Raiden_{lang_name}"
            fp.write(f"{name}\t{spk_name}\t{lang_code}\t{text}\n")

    shutil.copy2(name2text_path, os.path.join(assets_dir, '2-name2text.txt'))

    meta = {
        'id': f'Raiden_{lang_name}', 'display_name': f'Raiden ({lang_name})',
        'language': cfg['lang'], 'created_at': '2026-06-19T00:00:00Z',
        'assets': {
            'slices': {'dir': 'slicer_opt/', 'file_count': len(sliced)},
            'checkpoints': {'gpt': [], 'sovits': []},
        },
        'segment_total': len(segments),
        'segment_matched': len(segments),
        'training': {'status': 'pending'},
    }
    with open(os.path.join(assets_dir, 'meta.json'), 'w', encoding='utf-8') as fp:
        json.dump(meta, fp, ensure_ascii=False, indent=2)

    results[lang_name] = {'sliced': len(sliced), 'segments': len(segments), 'failed': failed}
    print(f"  Done: {len(sliced)} slices, {len(segments)} segments")

# Summary
print(f"\n{'='*60}")
print("  ALL DONE!")
print(f"{'='*60}")
for lang, r in results.items():
    print(f"  {lang}: {r['sliced']} slices, {r['segments']} segments, {r['failed']} failures")
