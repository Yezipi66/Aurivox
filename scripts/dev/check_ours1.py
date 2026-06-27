import torch

# Our S1 model
pth = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\gsv-v2final\s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
print(f"Loading our S1 model...")
data = torch.load(pth, map_location="cpu", weights_only=True)

print("Keys:", list(data.keys()))
if "weight" in data:
    w = data["weight"]
    print("\n=== Key weight shapes ===")
    key_patterns = ["embedding", "predict", "EOS", "vocab"]
    for k in sorted(w.keys()):
        v = w[k]
        if hasattr(v, 'shape'):
            # Only print key layers
            if any(p in k.lower() for p in key_patterns):
                print(f"  {k}: {v.shape}")
    
    # Print all unique first dimensions (vocab sizes)
    print("\n=== Unique first dimensions ===")
    dims = set()
    for k, v in w.items():
        if hasattr(v, 'shape') and len(v.shape) >= 1:
            dims.add(v.shape[0])
    print(f"  {sorted(dims)}")
