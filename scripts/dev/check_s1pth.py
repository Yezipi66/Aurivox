import torch

pth = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\gsv-v2final\s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
data = torch.load(pth, map_location="cpu", weights_only=True)

print("Keys:", list(data.keys()))
if "weight" in data:
    w = data["weight"]
    # Find vocab-related keys
    for k, v in w.items():
        if "vocab" in k.lower() or "embedding" in k.lower() or "word" in k.lower():
            print(f"  {k}: {v.shape}")
elif "state_dict" in data:
    sd = data["state_dict"]
    for k, v in sd.items():
        if "vocab" in k.lower() or "embedding" in k.lower() or "word" in k.lower():
            print(f"  {k}: {v.shape}")
