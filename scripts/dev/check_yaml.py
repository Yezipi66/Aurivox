import yaml

path = r"D:\Project\tts_broker_openai_compat\test_raiden\日文\s1_config.yaml"
with open(path, 'r', encoding='utf-8') as f:
    config = yaml.full_load(f)

print("Top-level keys:", list(config.keys()))
print("train keys:", list(config["train"].keys()))
print("model keys:", list(config["model"].keys()) if "model" in config else "NO model KEY")
print("config['model']['hidden_dim']:", config["model"]["hidden_dim"] if "model" in config else "N/A")
