import torch

# Check s2Gv3.pth from GPT-SoVITS project
pth = r"D:\AI\GPT-SoVITS-v2pro-20250604\GPT_SoVITS\pretrained_models\s2Gv3.pth"
print(f"Loading {pth}...")
data = torch.load(pth, map_location="cpu", weights_only=True)
print("Keys:", list(data.keys()))
if "weight" in data:
    w = data["weight"]
    key_layers = [
        "dec.cond.weight",
        "enc_q.enc.cond_layer.weight_v",
        "flow.flows.0.enc.cond_layer.weight_v",
        "ref_enc.fc.fc.weight",
        "ref_enc.fc.fc.bias",
    ]
    for k in key_layers:
        if k in w:
            print(f"  {k}: {w[k].shape}")
