import torch

pth = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\gsv-v2final\s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
data = torch.load(pth, map_location="cpu", weights_only=True)

print("Keys:", list(data.keys()))
if "weight" in data:
    w = data["weight"]
    print("\n=== All weight shapes ===")
    for k, v in sorted(w.items()):
        if hasattr(v, 'shape'):
            print(f"  {k}: {v.shape}")
