import torch

ckpt_path = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\v2Pro\s2Gv2Pro.pth"
ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)

# Find enc_q and ref_enc weights
for k, v in ckpt["weight"].items():
    if "enc_q" in k or "ref_enc" in k:
        print(f"  {k}: {v.shape}")
