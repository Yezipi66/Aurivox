import torch, os, sys
sys.path.insert(0, r'D:\Project\tts_broker_openai_compat\lib\training')
os.chdir(r'D:\Project\tts_broker_openai_compat\lib\training\gsv_code')

from gsv_code import utils
from gsv_code.module.data_utils import TextAudioSpeakerLoader, TextAudioSpeakerCollate

hps = utils.get_hparams(stage=2)
dataset = TextAudioSpeakerLoader(hps.data, version=hps.model.version)

# Get one sample
ssl, spec, wav, text = dataset[0]
print(f"ssl shape: {ssl.shape}")
print(f"spec shape: {spec.shape}")
print(f"wav shape: {wav.shape}")
print(f"text shape: {text.shape}")

# Get a batch
collate = TextAudioSpeakerCollate(version=hps.model.version)
batch = collate([dataset[i] for i in range(4)])
ssl_b, ssl_lengths, spec_b, spec_lengths, y_b, y_lengths, text_b, text_lengths = batch
print(f"\nBatch:")
print(f"ssl_b shape: {ssl_b.shape}")
print(f"spec_b shape: {spec_b.shape}")
print(f"y_b shape: {y_b.shape}")
print(f"text_b shape: {text_b.shape}")

# Check if spec_b is actually mel or wav
print(f"\nspec_b max: {spec_b.max():.4f}, min: {spec_b.min():.4f}")
print(f"y_b max: {y_b.max():.4f}, min: {y_b.min():.4f}")
print(f"spec_b size(0): {spec_b.size(0)}")
print(f"y_b size(0): {y_b.size(0)}")
