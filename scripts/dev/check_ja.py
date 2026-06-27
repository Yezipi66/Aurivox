import os

# Check what's in the work dir
work_dir = "D:/Project/tts_broker_openai_compat/test_raiden/日文"
slicer_out = os.path.join(work_dir, 'slicer_opt')
asr_out = os.path.join(work_dir, 'asr_output')

print(f"slicer_opt exists: {os.path.exists(slicer_out)}")
if os.path.exists(slicer_out):
    sliced = [f for f in os.listdir(slicer_out) if f.endswith('.wav')]
    print(f"sliced count: {len(sliced)}")

print(f"asr_output exists: {os.path.exists(asr_out)}")
if os.path.exists(asr_out):
    print(f"asr_output: {os.listdir(asr_out)}")

# Check if the model exists
model = "D:/Project/tts_broker_openai_compat/lib/training/gsv-tools/asr/models/faster-whisper-large-v3/model.bin"
print(f"model.bin exists: {os.path.exists(model)}")
if os.path.exists(model):
    print(f"model.bin size: {os.path.getsize(model)/1024/1024:.0f} MB")
