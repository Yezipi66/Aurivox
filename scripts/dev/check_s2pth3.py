import torch

pth = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\v2Pro\s2Gv2Pro.pth"
data = torch.load(pth, map_location="cpu", weights_only=True)

print("Keys:", list(data.keys()))
if "weight" in data:
    w = data["weight"]
    # Print shapes of key layers to infer config
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
    
    # Also print all keys with "cond" or "gin"
    print("\nAll keys with 'cond' or 'gin':")
    for k, v in w.items():
        if "cond" in k or "gin" in k:
            print(f"  {k}: {v.shape}")
