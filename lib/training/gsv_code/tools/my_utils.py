import os
import soundfile as sf
import numpy as np

def clean_path(path_str):
    if path_str.endswith(("/", "\\")):
        return clean_path(path_str[:-1])
    return path_str.replace("/", os.sep).replace("\\", os.sep).strip(" '\n\"\u202a")

def load_audio(file, sr):
    file = clean_path(file)
    try:
        audio, orig_sr = sf.read(file, dtype="float32")
        if orig_sr != sr:
            from scipy.signal import resample
            num_samples = int(len(audio) * sr / orig_sr)
            audio = resample(audio, num_samples)
        return audio
    except Exception as e:
        print(f"Error loading {file}: {e}")
        return None
