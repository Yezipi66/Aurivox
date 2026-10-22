"""检查训练产出的 GPT 权重能否被推理侧直接加载。

推理侧加载权重（engines/gpt-sovits/infer/TTS.py 的 init_t2s_weights）要求顶层
同时有 config 与 weight 两个键，缺一个就报错；发布出去的权重还带 info。
脚本读出每个候选文件的顶层键，逐个给出结论。

候选文件取自两处：assets/<角色>/models/gpt-sovits/gpt/ 与
assets/<角色>/gpt_checkpoints/，文件名要含 -e<N>.ckpt（训练产出的权重）。

结论只打印到 stdout，退出码不随结论变化；一个候选文件都没找到时退出码为 1。

用法：venv\\Scripts\\python.exe lib\\inference\\check_ckpt.py
"""
import os
import glob
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
patterns = [
    os.path.join(ROOT, "assets", "*", "models", "gpt-sovits", "gpt", "*-e*.ckpt"),
    os.path.join(ROOT, "assets", "*", "gpt_checkpoints", "*-e*.ckpt"),  # 同一角色的权重可能落在这两个位置，两处都扫
]
pattern = " | ".join(patterns)
files = sorted({f for p in patterns for f in glob.glob(p)})

if not files:
    print("未找到任何训练 GPT ckpt:", pattern)
    raise SystemExit(1)

print(f"找到 {len(files)} 个训练 GPT ckpt\n" + "=" * 70)
all_ok = True
for f in files:
    rel = os.path.relpath(f, ROOT)
    try:
        d = torch.load(f, map_location="cpu", weights_only=False)
        keys = list(d.keys()) if isinstance(d, dict) else ["<not a dict>"]
        has_cfg = isinstance(d, dict) and "config" in d
        has_w = isinstance(d, dict) and "weight" in d
        status = "OK" if (has_cfg and has_w) else "FAIL"
        if not (has_cfg and has_w):
            all_ok = False
        print(f"[{status}] {rel}")
        print(f"        top keys : {keys}")
        print(f"        config={has_cfg}  weight={has_w}  info={'info' in d if isinstance(d, dict) else False}")
    except Exception as e:
        all_ok = False
        print(f"[ERR ] {rel}: {type(e).__name__}: {e}")
    print("-" * 70)

print("\n结论:", "全部含 config+weight, 可被推理服务直接加载 ✓" if all_ok
      else "存在缺失 config/weight 的 ckpt, 需重训或在推理侧报错处理 ✗")
