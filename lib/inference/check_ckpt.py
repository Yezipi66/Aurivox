"""
Task 6 复核: 检查训练产出的 GPT (-e<N>.ckpt) 是否含 init_t2s_weights 需要的
{weight, config, info} 结构。自动扫描 assets/*/gpt_checkpoints/*-e*.ckpt。
用法: venv\Scripts\python.exe lib\inference\check_ckpt.py
"""
import os
import glob
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
pattern = os.path.join(ROOT, "assets", "*", "gpt_checkpoints", "*-e*.ckpt")
files = sorted(glob.glob(pattern))

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
