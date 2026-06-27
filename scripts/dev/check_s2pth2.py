import torch

pth = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\v2Pro\s2Gv2Pro.pth"
# Only load the config, not the full weights
data = torch.load(pth, map_location="cpu", weights_only=True)

print("Keys:", list(data.keys()))
if "config" in data:
    config = data["config"]
    print("\n=== Config ===")
    for k, v in config.items():
        if isinstance(v, (str, int, float, bool)):
            print(f"  {k}: {v}")
        elif isinstance(v, dict):
            print(f"  {k}:")
            for k2, v2 in v.items():
                if isinstance(v2, (str, int, float, bool)):
                    print(f"    {k2}: {v2}")
                else:
                    print(f"    {k2}: {type(v2).__name__}")
