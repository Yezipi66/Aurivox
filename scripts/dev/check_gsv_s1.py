import torch

# Check GPT-SoVITS S1 model
pth = r"D:\AI\GPT-SoVITS-v2pro-20250604\GPT_SoVITS\pretrained_models\s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"
print(f"Loading {pth}...")
data = torch.load(pth, map_location="cpu", weights_only=True)

print("Keys:", list(data.keys()))
if "weight" in data:
    w = data["weight"]
    # Print key shapes
    for k in sorted(w.keys()):
        v = w[k]
        if hasattr(v, 'shape'):
            print(f"  {k}: {v.shape}")
