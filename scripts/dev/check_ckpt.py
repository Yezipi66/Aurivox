import torch

ckpt_path = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\gsv-v2final\s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)

print("Checkpoint keys:", list(ckpt.keys()) if isinstance(ckpt, dict) else "not a dict")
if isinstance(ckpt, dict):
    if "weight" in ckpt:
        w = ckpt["weight"]
        print("Weight keys:", list(w.keys())[:10])
        if "model.ar_text_embedding.word_embeddings.weight" in w:
            print("word_embeddings.weight shape:", w["model.ar_text_embedding.word_embeddings.weight"].shape)
    elif "state_dict" in ckpt:
        sd = ckpt["state_dict"]
        for k, v in sd.items():
            if "word_embeddings" in k:
                print(f"{k}: {v.shape}")
