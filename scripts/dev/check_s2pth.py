import torch, json

pth = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\v2Pro\s2Gv2Pro.pth"
data = torch.load(pth, map_location="cpu", weights_only=False)

# Print model config if available
if "config" in data:
    print("=== Model Config ===")
    config = data["config"]
    for k, v in config.items():
        if isinstance(v, dict):
            print(f"  {k}:")
            for k2, v2 in v.items():
                print(f"    {k2}: {v2}")
        else:
            print(f"  {k}: {v}")
elif "hps" in data:
    print("=== HPS ===")
    hps = data["hps"]
    for k, v in hps.items():
        if isinstance(v, dict):
            print(f"  {k}:")
            for k2, v2 in v.items():
                print(f"    {k2}: {v2}")
        else:
            print(f"  {k}: {v}")
else:
    print("Keys:", list(data.keys()))
    if "weight" in data:
        print("\n=== Weight shapes ===")
        for k, v in data["weight"].items():
            if hasattr(v, 'shape'):
                print(f"  {k}: {v.shape}")
