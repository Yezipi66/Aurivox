import torch

ckpt_path = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\gsv-v2final\s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
w = ckpt["weight"]

# Check all embedding shapes
for k, v in w.items():
    if "embedding" in k or "proj" in k:
        print(f"{k}: {v.shape}")

# Check config in checkpoint
if "config" in ckpt:
    print("\nCheckpoint config:")
    cfg = ckpt["config"]
    if isinstance(cfg, dict):
        for k, v in cfg.items():
            if "vocab" in k.lower() or "size" in k.lower() or "dim" in k.lower():
                print(f"  {k}: {v}")
