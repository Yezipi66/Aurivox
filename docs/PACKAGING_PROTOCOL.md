# TTS Broker 源码打包协议

> 版本：1.0 | 日期：2026-06-24

## 目的

交付可 code review 的源码包，包含项目所有执行层代码，排除运行时大文件（权重/模型/依赖环境）。

## 打包命令

```python
import os, tarfile

src = r'D:\Project\tts_broker_openai_compat'
dst = r'C:\Users\MECHREVO X10 Pro\Desktop\tts_broker_src.tar.gz'

include_exts = {
    '.py', '.js', '.jsx', '.ts', '.tsx',
    '.json', '.yaml', '.yml',
    '.md', '.txt', '.html', '.css', '.scss',
    '.env', '.sh', '.cmd', '.bat',
    '.gitignore', '.dockerignore',
}
exclude_dirs = {
    'venv', 'node_modules', '.git', '__pycache__',
    'logs_s1', 'logs_s2', 'ckpt',
    'assets', '.staging', 'GPT_SoVITS',
}
exclude_exts = {'.pyc', '.pth', '.pt', '.onnx', '.zip', '.model', '.ckpt', '.safetensors', '.bin'}
exclude_files = {'openai.env', '.env.local'}

# gsv-tools 下需排除的权重/模型子目录
exclude_gsv_subpaths = [
    'gsv-tools/pretrained',
    'gsv-tools/models',
    'gsv-tools/uvr5_weights',
    'gsv-tools/asr/models',
    'gsv-tools/asr/faster-whisper-large-v3',
    'gsv-tools/asr/faster-whisper-large-v3-turbo',
]

def should_include(relpath):
    rel = relpath.replace('\\', '/')
    parts = rel.split('/')
    for p in parts:
        if p in exclude_dirs:
            return False
    for sub in exclude_gsv_subpaths:
        if rel.startswith(sub):
            return False
    ext = os.path.splitext(rel)[1].lower()
    if ext in exclude_exts:
        return False
    basename = parts[-1]
    if basename in exclude_files:
        return False
    if ext in include_exts:
        return True
    if '.' not in basename:
        return True
    return False

with tarfile.open(dst, 'w:gz') as tar:
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        rel_root = os.path.relpath(root, src)
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.join(rel_root, f) if rel_root != '.' else f
            if not should_include(rel):
                continue
            tar.add(full, arcname=rel)
```

## 排除规则

| 类别 | 排除内容 | 原因 |
|------|----------|------|
| 虚拟环境 | `venv/` | 依赖包，非源码 |
| 前端依赖 | `node_modules/` | npm 安装，非源码 |
| Git | `.git/` | 版本数据，非源码 |
| 缓存 | `__pycache__/` | 编译缓存 |
| 运行时数据 | `logs_s1/`, `logs_s2/`, `ckpt/`, `assets/`, `.staging/` | 训练产物，非源码 |
| 外部项目 | `GPT_SoVITS/` | 非本项目代码 |
| 权重文件 | `*.pth`, `*.pt`, `*.onnx`, `*.bin`, `*.ckpt`, `*.safetensors`, `*.model` | 模型权重，非源码 |
| 权重目录 | `gsv-tools/pretrained/`, `gsv-tools/models/`, `gsv-tools/uvr5_weights/`, `gsv-tools/asr/models/`, `gsv-tools/asr/faster-whisper-large-v3/` | 模型存储目录 |
| 密钥 | `openai.env`, `.env.local` | 敏感信息 |

## 保留规则

| 类别 | 示例 | 说明 |
|------|------|------|
| Python 脚本 | `slicer2.py`, `s1_train.py`, `s2_train.py`, `asr/*.py`, `uvr5/*.py`, `gsv_code/**/*.py` | 核心执行代码 |
| JS 脚本 | `server.js`, `lib/training/**/*.js`, `web/src/**/*.jsx` | 前后端逻辑 |
| 配置文件 | `python.json`, `*.yaml`, `*.yml`, `*.json` | 训练配置/项目配置 |
| 文档 | `*.md`, `docs/` | 项目文档 |
| 前端 | `web/`（除 node_modules） | React 源码 |

## 预期产出

- 文件数：~380 个
- 总大小：~35 MB（未压缩）/ ~8 MB（压缩后）
- 不含任何权重、模型、运行时产物、密钥
