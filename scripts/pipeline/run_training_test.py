# -*- coding: utf-8 -*-
import subprocess, os, json, shutil, sys

sys.stdout.reconfigure(encoding='utf-8')

GSV_ROOT = r"D:\AI\GPT-SoVITS-v2pro-20250604"
PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
TOOLS = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools"

voices = [
    {"name": "Papyrus", "dir": r"E:\MECHREVO X10 Pro\Downloads\Papyrus_cn", "lang": "zh"},
    {"name": "Shamare", "dir": r"E:\MECHREVO X10 Pro\Downloads\Shamare_ja", "lang": "ja"},
]

for voice in voices:
    name = voice["name"]
    src_dir = voice["dir"]
    lang = voice["lang"]
    work_dir = rf"D:\Project\tts_broker_openai_compat\test_pipeline\{name}"
    assets_dir = rf"D:\Project\tts_broker_openai_compat\assets\{name}"

    print(f"\n{'='*60}")
    print(f"  Training: {name} ({lang})")
    print(f"{'='*60}")

    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)

    # Step 2: Slice
    print(f"\n--- Step 2: Slice ---")
    slicer = os.path.join(TOOLS, "slicer2.py")
    slicer_out = os.path.join(work_dir, "slicer_opt")
    os.makedirs(slicer_out, exist_ok=True)

    files = [f for f in os.listdir(src_dir) if f.endswith('.wav')]
    print(f"Input: {len(files)} wav files")

    for f in files:
        src = os.path.join(src_dir, f)
        cmd = [PYTHON, slicer, src, "--out", slicer_out, "--db_thresh", "-40",
               "--min_length", "3000", "--min_interval", "500", "--hop_size", "10", "--max_sil_kept", "500"]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            print(f"  WARN {f}: {r.stderr[:100]}")

    sliced = [f for f in os.listdir(slicer_out) if f.endswith('.wav')]
    print(f"Sliced: {len(sliced)} files")

    # Step 3: ASR
    print(f"\n--- Step 3: ASR ({lang}) ---")
    if lang in ('zh', 'yue'):
        asr_script = os.path.join(GSV_ROOT, "tools", "asr", "funasr_asr.py")
        asr_args = ["-i", slicer_out, "-o", os.path.join(work_dir, "asr_output"), "-l", lang]
    else:
        asr_script = os.path.join(GSV_ROOT, "tools", "asr", "fasterwhisper_asr.py")
        asr_args = ["-i", slicer_out, "-o", os.path.join(work_dir, "asr_output"), "-l", lang, "-s", "large-v3", "-p", "float16"]

    os.makedirs(os.path.join(work_dir, "asr_output"), exist_ok=True)
    cmd = [PYTHON, asr_script] + asr_args
    print(f"Running ASR...")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900, cwd=GSV_ROOT)
    print(f"ASR exit: {r.returncode}")

    # Parse
    asr_out_dir = os.path.join(work_dir, "asr_output")
    list_files = [f for f in os.listdir(asr_out_dir) if f.endswith('.list')]
    segments = []

    if list_files:
        with open(os.path.join(asr_out_dir, list_files[0]), "r", encoding="utf-8") as fp:
            for i, line in enumerate(fp):
                line = line.strip()
                if not line:
                    continue
                parts = line.split("|")
                if len(parts) >= 4:
                    audio_file = os.path.basename(parts[0])
                    segments.append({
                        "index": i, "scene": os.path.splitext(audio_file)[0],
                        "audio": audio_file, "audio_path": f"slicer_opt/{audio_file}",
                        "text": parts[3], "matched": True, "duration": 0,
                    })

    if not segments:
        for i, f in enumerate(sliced):
            segments.append({
                "index": i, "scene": os.path.splitext(f)[0],
                "audio": f, "audio_path": f"slicer_opt/{f}",
                "text": "", "matched": True, "duration": 0,
            })

    print(f"ASR result: {len(segments)} segments")
    for s in segments[:3]:
        print(f"  {s['audio']}: {s['text'][:60]}")

    # Save segments.json
    engine = "funasr" if lang in ('zh', 'yue') else "faster-whisper"
    seg_data = {
        "voice": name, "language": lang, "asr_engine": engine,
        "source_file": "slicer_opt/", "generated_at": "2026-06-19T00:00:00Z",
        "total": len(segments), "matched": len(segments), "segments": segments,
    }
    with open(os.path.join(work_dir, "segments.json"), "w", encoding="utf-8") as fp:
        json.dump(seg_data, fp, ensure_ascii=False, indent=2)

    # Register to assets/
    print(f"\n--- Step 4: Register ---")
    if os.path.exists(assets_dir):
        shutil.rmtree(assets_dir)
    os.makedirs(assets_dir)

    shutil.copytree(os.path.join(work_dir, "slicer_opt"), os.path.join(assets_dir, "slicer_opt"))
    shutil.copy2(os.path.join(work_dir, "segments.json"), os.path.join(assets_dir, "segments.json"))

    meta = {
        "id": name, "display_name": name, "language": lang,
        "created_at": "2026-06-19T00:00:00Z",
        "assets": {
            "slices": {"dir": "slicer_opt/", "file_count": len(sliced)},
            "checkpoints": {"gpt": [], "sovits": []},
        },
        "segment_total": len(segments),
        "segment_matched": len(segments),
        "training": {"status": "pending"},
    }
    with open(os.path.join(assets_dir, "meta.json"), "w", encoding="utf-8") as fp:
        json.dump(meta, fp, ensure_ascii=False, indent=2)

    print(f"Done! {name}: {len(sliced)} slices, {len(segments)} segments")

print(f"\n{'='*60}")
print("  ALL DONE!")
print(f"{'='*60}")
