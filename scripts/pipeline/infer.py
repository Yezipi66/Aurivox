"""
推理脚本：S1 (GPT) + S2 (SoVITS) 串联推理
用法: python infer.py --text "你好世界" --ref ref.wav --s1_ckpt xxx.ckpt --s2_ckpt xxx.pth --output out.wav
"""
import torch, sys, os, argparse, json

# 确保 gsv_code 在 PYTHONPATH
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib', 'training'))

import numpy as np
import soundfile as sf
from gsv_code.text import cleaned_text_to_sequence
from gsv_code.models import SynthesizerTrn
from module import commons

# S1 相关
from gsv_code.AR.models.t2s_lightning_module import Text2SemanticLightningModule
from gsv_code.AR.utils.io import load_yaml_config

# 音频处理
import librosa

def load_s1_model(ckpt_path, device='cuda'):
    """加载 S1 (GPT) 模型"""
    # 从 checkpoint 加载
    ckpt = torch.load(ckpt_path, map_location='cpu')
    hparams = ckpt['hyper_parameters']
    
    # 创建模型
    model = Text2SemanticLightningModule(hparams, "")
    model.load_state_dict(ckpt['state_dict'])
    model = model.to(device)
    model.eval()
    return model, hparams


def load_s2_model(ckpt_path, s2_config_path, device='cuda'):
    """加载 S2 (SoVITS) 模型"""
    with open(s2_config_path, 'r') as f:
        hps = json.load(f)
    
    from gsv_code.utils import HParams
    hps = HParams(**hps)
    
    net_g = SynthesizerTrn(
        hps.data.filter_length // 2 + 1,
        hps.train.segment_size // hps.data.hop_length,
        n_speakers=hps.data.n_speakers,
        **hps.model,
    ).to(device)
    
    ckpt = torch.load(ckpt_path, map_location='cpu', weights_only=False)
    if 'weight' in ckpt:
        state_dict = ckpt['weight']
    else:
        state_dict = ckpt
    net_g.load_state_dict(state_dict, strict=False)
    net_g.eval()
    return net_g, hps


def s1_infer(model, text, bert_feature, prompt_semantic, hparams, device='cuda'):
    """S1 推理：文本 → semantic tokens"""
    text_str = text
    
    # 文本转 phoneme sequence
    text_norm = torch.LongTensor(cleaned_text_to_sequence(text_str)).to(device)
    text_len = torch.LongTensor([text_norm.size(0)]).to(device)
    
    # prompt
    if prompt_semantic is not None:
        prompt = prompt_semantic.to(device)
    else:
        prompt = torch.zeros(1, 0, dtype=torch.long, device=device)
    
    # bert feature
    if bert_feature is not None:
        bert = bert_feature.to(device)
    else:
        bert = torch.zeros(1, 10, 512, device=device)  # placeholder
    
    with torch.no_grad():
        pred_semantic = model.model.infer(
            text_norm.unsqueeze(0),
            text_len,
            prompt,
            bert.unsqueeze(0),
            top_k=hparams.get('inference', {}).get('top_k', 5),
        )
    return pred_semantic


def s2_infer(net_g, ssl, y, y_lengths, text, text_lengths, device='cuda'):
    """S2 推理：semantic tokens + 参考音频 → 音频"""
    ssl = ssl.to(device)
    y = y.to(device)
    y_lengths = y_lengths.to(device)
    text = text.to(device)
    text_lengths = text_lengths.to(device)
    
    with torch.no_grad():
        audio = net_g.infer(ssl, y, y_lengths, text, text_lengths)[0]
    return audio


def main():
    parser = argparse.ArgumentParser(description='TTS Inference')
    parser.add_argument('--text', type=str, required=True, help='Input text')
    parser.add_argument('--ref', type=str, required=True, help='Reference audio file')
    parser.add_argument('--s1_ckpt', type=str, required=True, help='S1 checkpoint path')
    parser.add_argument('--s2_ckpt', type=str, required=True, help='S2 checkpoint path')
    parser.add_argument('--s2_config', type=str, default=None, help='S2 config path')
    parser.add_argument('--output', type=str, default='output.wav', help='Output audio')
    parser.add_argument('--device', type=str, default='cuda', help='Device')
    args = parser.parse_args()
    
    # Default S2 config
    if args.s2_config is None:
        args.s2_config = os.path.join(os.path.dirname(__file__), 'lib', 'training', 'gsv_code', 'configs', 's2.json')
    
    device = torch.device(args.device if torch.cuda.is_available() else 'cpu')
    print(f"Device: {device}")
    
    # Load S2 model
    print(f"Loading S2 from {args.s2_ckpt}...")
    net_g, hps = load_s2_model(args.s2_ckpt, args.s2_config, device)
    print("S2 loaded.")
    
    # Load reference audio
    ref_audio, sr = librosa.load(args.ref, sr=hps.data.sampling_rate)
    ref_audio = torch.FloatTensor(ref_audio).unsqueeze(0).to(device)
    ref_lengths = torch.LongTensor([ref_audio.size(1)]).to(device)
    
    # TODO: 需要 SSL 特征提取 + 文本特征提取
    # 这里先写一个简化版本
    
    print(f"Text: {args.text}")
    print("Inference not yet fully implemented - need SSL feature extraction")


if __name__ == '__main__':
    main()
