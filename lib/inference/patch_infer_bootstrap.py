"""给 lib/inference/infer_server.py 注入活动配置的引导代码。

注入的那段在活动配置 tts_infer.yaml 缺失时，从同名加 .example 后缀的模板
（tts_infer.yaml.example）复制一份。活动配置会被运行时的热加载回写，所以不入库，
仓库只跟踪模板。

脚本按锚点就地改写 infer_server.py；目标文件里已有同样的引导时直接退出，
重复运行不会重复插入。

用法：venv\\Scripts\\python.exe lib\\inference\\patch_infer_bootstrap.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "infer_server.py")
if not os.path.exists(TARGET):
    # 本文件旁边没有 infer_server.py 时，改按当前工作目录下的 lib/inference/ 找。
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

# 写盘后做语法自检：解析失败只报错退出，不回滚已写入的文件。
import ast
try:
    ast.parse(src)
    print("[ok] 已注入配置引导, infer_server.py 语法校验通过。")
except SyntaxError as e:
    print(f"[FAIL] 注入后语法错误: {e}")
    sys.exit(1)
