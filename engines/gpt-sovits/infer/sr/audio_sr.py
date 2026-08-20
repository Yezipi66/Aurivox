from __future__ import absolute_import, division, print_function, unicode_literals
import sys
import os

AP_BWE_main_dir_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "AP_BWE_main")
sys.path.append(AP_BWE_main_dir_path)
import json
import torch
import torchaudio.functional as aF
# from attrdict import AttrDict####will be bug in py3.10

from datasets1.dataset import amp_pha_stft, amp_pha_istft
from models.model import APNet_BWE_Model


class AP_BWE:
    def __init__(self, device, DictToAttrRecursive, checkpoint_file=None):
        if checkpoint_file == None:
            # 权重已迁至 models/sr/ap-bwe/24kto48k/，不再与代码同放。
            # SR_CKPT_DIR 由 lib/paths.js 下发；兜底上溯找 package.json。
            _sr_dir = os.environ.get("SR_CKPT_DIR")
            if not _sr_dir:
                _d = os.path.dirname(os.path.abspath(__file__))
                while not os.path.isfile(os.path.join(_d, "package.json")):
                    _parent = os.path.dirname(_d)
                    if _parent == _d:
                        raise RuntimeError("project root (package.json) not found")
                    _d = _parent
                _sr_dir = os.path.join(_d, "models", "sr", "ap-bwe", "24kto48k")
            checkpoint_file = os.path.join(_sr_dir, "g_24kto48k.zip")
            if os.path.exists(checkpoint_file) == False:
                raise FileNotFoundError(
                    "audio super-resolution weight not found: %s "
                    "(set SR_CKPT_DIR to override)" % checkpoint_file
                )
        config_file = os.path.join(os.path.split(checkpoint_file)[0], "config.json")
        with open(config_file) as f:
            data = f.read()
        json_config = json.loads(data)
        # h = AttrDict(json_config)
        h = DictToAttrRecursive(json_config)
        model = APNet_BWE_Model(h).to(device)
        state_dict = torch.load(checkpoint_file, map_location="cpu", weights_only=False)
        model.load_state_dict(state_dict["generator"])
        model.eval()
        self.device = device
        self.model = model
        self.h = h

    def to(self, *arg, **kwargs):
        self.model.to(*arg, **kwargs)
        self.device = self.model.conv_pre_mag.weight.device
        return self

    def __call__(self, audio, orig_sampling_rate):
        with torch.no_grad():
            # audio, orig_sampling_rate = torchaudio.load(inp_path)
            # audio = audio.to(self.device)
            audio = aF.resample(audio, orig_freq=orig_sampling_rate, new_freq=self.h.hr_sampling_rate)
            amp_nb, pha_nb, com_nb = amp_pha_stft(audio, self.h.n_fft, self.h.hop_size, self.h.win_size)
            amp_wb_g, pha_wb_g, com_wb_g = self.model(amp_nb, pha_nb)
            audio_hr_g = amp_pha_istft(amp_wb_g, pha_wb_g, self.h.n_fft, self.h.hop_size, self.h.win_size)
            # sf.write(opt_path, audio_hr_g.squeeze().cpu().numpy(), self.h.hr_sampling_rate, 'PCM_16')
            return audio_hr_g.squeeze().cpu().numpy(), self.h.hr_sampling_rate
