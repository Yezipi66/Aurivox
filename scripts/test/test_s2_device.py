import torch, os, sys
sys.path.insert(0, r'D:\Project\tts_broker_openai_compat\lib\training')
os.chdir(r'D:\Project\tts_broker_openai_compat\lib\training\gsv_code')

from gsv_code import utils
from gsv_code.module.models import SynthesizerTrn

hps = utils.get_hparams(stage=2)

net_g = SynthesizerTrn(
    hps.data.filter_length // 2 + 1,
    hps.train.segment_size // hps.data.hop_length,
    n_speakers=hps.data.n_speakers,
    **hps.model,
).cuda(0)

print("Model device:", next(net_g.parameters()).device)
print("ref_enc device:", next(net_g.ref_enc.parameters()).device)

ckpt_path = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\v2Pro\s2Gv2Pro.pth"
ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
print("Pretrained weight device:", ckpt['weight']['ref_enc.spectral.0.fc.weight'].device)

result = net_g.load_state_dict(ckpt["weight"], strict=False)
print("Missing keys:", len(result.missing_keys))
print("Unexpected keys:", len(result.unexpected_keys))

# Check ref_enc parameter devices
cpu_params = []
gpu_params = []
for name, param in net_g.ref_enc.named_parameters():
    if 'spectral.0' in name:
        print("  ", name, "device:", param.device)
    if param.device.type == 'cpu':
        cpu_params.append(name)
    else:
        gpu_params.append(name)

print("CPU params count:", len(cpu_params))
print("GPU params count:", len(gpu_params))
