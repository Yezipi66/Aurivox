"""
patch_infer_bootstrap.py
为 lib/inference/infer_server.py 增加配置引导:
活动 tts_infer.yaml 不存在时, 自动从 tts_infer.yaml.example 复制一份。
这样 tts_infer.yaml 可被 .gitignore(运行时会被热加载回写改脏),
仓库只跟踪 tts_infer.yaml.example 模板, 全新 clone 仍可一键启动。

用法(项目根目录执行):  venv\\Scripts\\python.exe lib\\inference\\patch_infer_bootstrap.py
幂等: 重复运行不会重复插入。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "infer_server.py")
if not os.path.exists(TARGET):
    # 允许放在项目根运行
    alt = os.path.join(os.getcwd(), "lib", "inference", "infer_server.py")
    if os.path.exists(alt):
        TARGET = alt
    else:
        print(f"[FAIL] 找不到 infer_server.py(尝试: {TARGET})")
        sys.exit(1)

with open(TARGET, "r", encoding="utf-8") as f:
    src = f.read()

if '_example = config_path + ".example"' in src:
    print("[skip] infer_server.py 似乎已包含配置引导, 未改动。")
    sys.exit(0)

ANCHOR = "tts_config = TTS_Config(config_path)"
if ANCHOR not in src:
    print("[FAIL] 未找到锚点 'tts_config = TTS_Config(config_path)', 放弃修改。")
    sys.exit(1)

BOOTSTRAP = (
    "# 活动配置缺失时从模板复制(活动 yaml 会被运行时热加载回写, 故不入库)\n"
    "if not os.path.exists(config_path):\n"
    "    _example = config_path + \".example\"\n"
    "    if os.path.exists(_example):\n"
    "        import shutil\n"
    "        shutil.copyfile(_example, config_path)\n"
    "        print(f\"[config] {config_path} 不存在, 已从模板复制: {_example}\")\n"
    "    else:\n"
    "        print(f\"[config] 警告: {config_path} 与模板 {_example} 均不存在\")\n"
    "\n"
)

src = src.replace(ANCHOR, BOOTSTRAP + ANCHOR, 1)

with open(TARGET, "w", encoding="utf-8") as f:
    f.write(src)

# 语法自检
import ast
try:
    ast.parse(src)
    print("[ok] 已注入配置引导, infer_server.py 语法校验通过。")
except SyntaxError as e:
    print(f"[FAIL] 注入后语法错误: {e}")
    sys.exit(1)
