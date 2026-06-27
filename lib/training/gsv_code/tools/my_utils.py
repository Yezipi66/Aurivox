import os
import librosa
import numpy as np

def clean_path(path_str):
    if path_str.endswith(("/", "\\")):
        return clean_path(path_str[:-1])
    return path_str.replace("/", os.sep).replace("\\", os.sep).strip(" '\n\"\u202a")

def load_audio(file, sr):
    file = clean_path(file)
    # libsndfile (librosa/soundfile) detects WAV by file header, not extension,
    # so this also handles the extension-less files written to 5-wav32k.
    try:
        audio, _ = librosa.load(file, sr=sr)
        return audio
    except Exception as e_lib:
        # Fallback to ffmpeg only for containers libsndfile can't decode.
        try:
            import subprocess
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = tmp.name
            subprocess.run(
                ["ffmpeg", "-y", "-i", file, "-ar", str(sr), "-ac", "1", tmp_path],
                capture_output=True,
            )
            audio, _ = librosa.load(tmp_path, sr=sr)
            os.remove(tmp_path)
            return audio
        except Exception as e_ff:
            print(f"Error loading {file}: librosa={e_lib}; ffmpeg={e_ff}")
            return None
