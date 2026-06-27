import torch, os, sys
sys.path.insert(0, r'D:\Project\tts_broker_openai_compat\lib\training')
os.chdir(r'D:\Project\tts_broker_openai_compat\lib\training\gsv_code')

from gsv_code import utils
from gsv_code.module.data_utils import TextAudioSpeakerLoader, TextAudioSpeakerCollate

hps = utils.get_hparams(stage=2)

# Check spec shape from dataset
dataset = TextAudioSpeakerLoader(hps.data, version=hps.model.version)
sample = dataset[0]
ssl, spec, wav, text = sample
print(f"spec shape: {spec.shape}")  # Should be [1025, T]
print(f"wav shape: {wav.shape}")    # Should be [1, T]

# Check model's ref_enc in_dim
from gsv_code.module.models import SynthesizerTrn
net_g = SynthesizerTrn(
    hps.data.filter_length // 2 + 1,
    hps.train.segment_size // hps.data.hop_length,
    n_speakers=hps.data.n_speakers,
    **hps.model,
)

print(f"spec_channels: {net_g.spec_channels}")
print(f"ref_enc in_dim: {net_g.ref_enc.in_dim}")

# Check what y[:, :704] gives
print(f"\ny (spec) shape: {spec.shape}")
print(f"y[:, :704] shape: {spec[:, :704].shape}")
print(f"y[:, :704] transpose shape: {spec[:, :704].transpose(1, 2).shape}")
print(f"Expected in_dim: {net_g.ref_enc.in_dim}")
print(f"Actual last dim after transpose: {spec[:, :704].transpose(1, 2).shape[-1]}")
