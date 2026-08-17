import sys
import os
import torch

# Resolve SV pretrained checkpoint robustly:
# 1) honor SV_CKPT_PATH env override if set
# 2) otherwise locate it relative to this file inside the project tree
# 兜底一路上溯找 package.json 定位项目根，不数目录层数（引擎契约 C7）。
# 迁此之前这里写的是 ../training/gsv-tools/...，自 r9 起即为死路径，
# 而 SV_CKPT_PATH 从未有人设置，因此 v2Pro 的说话人向量一直取不到。
def _project_root():
    d = os.path.dirname(os.path.abspath(__file__))
    while not os.path.isfile(os.path.join(d, "package.json")):
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError("project root (package.json) not found above " + __file__)
        d = parent
    return d


_DEFAULT_SV_PATH = os.path.join(
    _project_root(), "models", "tts", "gpt-sovits", "sv",
    "pretrained_eres2netv2w24s4ep4.ckpt",
)
sv_path = os.environ.get("SV_CKPT_PATH", _DEFAULT_SV_PATH)
if not os.path.exists(sv_path):
    raise FileNotFoundError(
        "speaker-verification weight not found: %s (set SV_CKPT_PATH to override)" % sv_path
    )

# ERes2NetV2 / kaldi are vendored flat in vendor/tts/gpt-sovits/infer (already on sys.path)
from ERes2NetV2 import ERes2NetV2
import kaldi as Kaldi


class SV:
    def __init__(self, device, is_half):
        if not os.path.exists(sv_path):
            raise FileNotFoundError(
                f"SV pretrained checkpoint not found: {sv_path}\n"
                f"Place 'pretrained_eres2netv2w24s4ep4.ckpt' there, "
                f"or set the SV_CKPT_PATH environment variable to its location."
            )
        pretrained_state = torch.load(sv_path, map_location="cpu", weights_only=False)
        embedding_model = ERes2NetV2(baseWidth=24, scale=4, expansion=4)
        embedding_model.load_state_dict(pretrained_state)
        embedding_model.eval()
        self.embedding_model = embedding_model
        if is_half == False:
            self.embedding_model = self.embedding_model.to(device)
        else:
            self.embedding_model = self.embedding_model.half().to(device)
        self.is_half = is_half

    def compute_embedding3(self, wav):
        with torch.no_grad():
            if self.is_half == True:
                wav = wav.half()
            feat = torch.stack(
                [Kaldi.fbank(wav0.unsqueeze(0), num_mel_bins=80, sample_frequency=16000, dither=0) for wav0 in wav]
            )
            sv_emb = self.embedding_model.forward3(feat)
        return sv_emb
