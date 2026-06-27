import torch, os, sys
sys.path.insert(0, r'D:\Project\tts_broker_openai_compat\lib\training')
os.chdir(r'D:\Project\tts_broker_openai_compat\lib\training\gsv_code')

from gsv_code import utils
from gsv_code.module.data_utils import TextAudioSpeakerLoader, TextAudioSpeakerCollate
from gsv_code.module import commons

hps = utils.get_hparams(stage=2)
print(f"exp_dir: {hps.data.exp_dir}")
print(f"version: {hps.model.version}")

# Test data loading
dataset = TextAudioSpeakerLoader(hps.data, version=hps.model.version)
print(f"Dataset size: {len(dataset)}")

# Test collate
collate = TextAudioSpeakerCollate(version=hps.model.version)
batch = collate([dataset[i] for i in range(min(4, len(dataset)))])
ssl_b, ssl_lengths, spec_b, spec_lengths, y, y_lengths, text_b, text_lengths = batch
print(f"Batch: ssl={ssl_b.shape}, spec={spec_b.shape}, y={y.shape}, text={text_b.shape}")

# Test model
from gsv_code.module.models import SynthesizerTrn
net_g = SynthesizerTrn(
    hps.data.filter_length // 2 + 1,
    hps.train.segment_size // hps.data.hop_length,
    n_speakers=hps.data.n_speakers,
    **hps.model,
).cuda(0)

print(f"Model device: {next(net_g.parameters()).device}")

# Move batch to GPU
ssl_b = ssl_b.cuda(0)
spec_b = spec_b.cuda(0)
y = y.cuda(0)
text_b = text_b.cuda(0)
ssl_lengths = ssl_lengths.cuda(0)
spec_lengths = spec_lengths.cuda(0)
y_lengths = y_lengths.cuda(0)
text_lengths = text_lengths.cuda(0)

# Test ref_enc
y_mask = torch.unsqueeze(commons.sequence_mask(y_lengths, y.size(2)), 1).to(y.dtype)
print(f"y_mask device: {y_mask.device}")
print(f"y[:, :704] device: {y[:, :704].device}")

try:
    ge = net_g.ref_enc(y[:, :704] * y_mask, y_mask)
    print(f"ref_enc OK: {ge.shape}, device={ge.device}")
except Exception as e:
    print(f"ref_enc ERROR: {e}")
    import traceback
    traceback.print_exc()

# Test full forward
try:
    with torch.no_grad():
        out = net_g(ssl_b, y, y_lengths, text_b, text_lengths)
    print(f"Full forward OK!")
except Exception as e:
    print(f"Full forward ERROR: {e}")
    import traceback
    traceback.print_exc()
