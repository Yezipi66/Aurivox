import torch

ckpt_path = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\v2Pro\s2Gv2Pro.pth"
ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)

# Check gin_channels related weights
for k, v in ckpt["weight"].items():
    if "gin" in k.lower() or "ge" in k.lower() or "512" in str(v.shape):
        print(f"  {k}: {v.shape}")
