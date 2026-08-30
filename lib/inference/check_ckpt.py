"""
Task 6 复核: 检查训练产出的 GPT (-e<N>.ckpt) 是否含 init_t2s_weights 需要的
{weight, config, info} 结构。
用法: venv\Scripts\python.exe lib\inference\check_ckpt.py

⚠ 2026-08-30: 角色的模型改按引擎和模型位分目录存放, 老的
   assets/<角色>/gpt_checkpoints/ 变成 assets/<角色>/models/<引擎id>/<模型位>/。
   这个脚本查的是**这条训练管线**自己产的那种 ckpt, 所以引擎名写在这里是
   它自己的题目; 但仍然同时扫老目录, 因为还没搬家的机器上文件就在那儿。
"""
import os
import glob
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
patterns = [
    os.path.join(ROOT, "assets", "*", "models", "gpt-sovits", "gpt", "*-e*.ckpt"),
    os.path.join(ROOT, "assets", "*", "gpt_checkpoints", "*-e*.ckpt"),  # 搬家前的老位置
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
