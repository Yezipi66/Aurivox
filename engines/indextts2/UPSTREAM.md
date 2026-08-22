# UPSTREAM — IndexTTS2

本目录下的 `indextts/` 是**上游代码**，不是我们写的。

| 项 | 值 |
|---|---|
| 上游 | https://github.com/index-tts/index-tts |
| commit | `13495845e3028f0bb6ca1462ad22aa0e76349e40` |
| 日期 | 2026-07-14 19:43:37 +0800 |
| commit message | `chore: pin Python development version to 3.11.13    (#720)` |
| 取得方式 | git clone → 删 `.git`（34.3MB，避免嵌套仓库/gitlink） |
| 记录时间 | 2026-08-21 |

⭐ **这个 sha 是在删 `.git` 之前抢记下来的，事后拿不回来。**
删了 `.git` 就再也无法回答「我们 fork 的是哪一版」——所以它写在这里，
而不是留在某次对话里。

## Python 环境

上游用 `uv` 管理，配方是本目录下的 `pyproject.toml` + `uv.lock`
（371797 字节，**精确锁定**）+ `.python-version`（3.11.13）。

```powershell
cd engines\indextts2
uv sync
```

⚠ **首次建环境必须联网**：`pyproject.toml` 的 `[tool.uv.sources]` 把 torch
指向 `download.pytorch.org/whl/cu128`，要下几个 GB。

| 环境 | torch | 状态 |
|---|---|---|
| GSV（项目根 `venv\`） | 2.2.0+cu121 | 生产在跑 |
| IndexTTS2（本目录 `.venv\`） | 2.8.0+cu128 | 实测已验证 |

⇒ 四个 minor 版本 + 两个 CUDA 大版本之差，**两套环境不可能合并**。
每个引擎自带 Python 环境是契约，不是权宜之计 —— 它是「加一个引擎 =
新建 `engines\<id>\` 一个目录」这条判据的必然推论：目录里应当包含它
跑起来需要的一切，包括解释器。共享环境的代价是**把两个引擎的稳定性
焊死**（IndexTTS2 升 torch 就逼 GSV 跟着升、跟着重测 106 处
`from gsv_code`），那是「加引擎会动到别人」的隐蔽形态。

## ⛔ 已知的坑（搬家探针实测，2026-08-21）

1. **`checkpoints/xxx` 是相对 CWD 的**。上游全仓 61 处引用，闭包内 2 处是
   真的（`indextts/utils/front.py:331` 的 `checkpoints/glossary.yaml` 是
   **调用实参不是默认值 ⇒ 显式传参救不了**、`:667` 的 `checkpoints/bpe.model`）。
   ⇒ 解法是 **spawn 子进程时设 cwd**，让工作目录下有个叫 `checkpoints` 的
   真权重目录，61 处全部自动正确，**上游一行不改**。
   ⇒ 所以权重目录**保留上游名字** `checkpoints`。它和包名 `indextts` 同性质：
   **是上游契约的一部分，不是我们能挑的标识符**，不违反 C8.1。

2. **bigvgan 的 CUDA JIT**：`indextts/s2mel/modules/bigvgan/alias_free_activation/
   cuda/activation1d.py:11` 在**模块级**调用 `load(...)`，`load.py:14` 在模块级设
   `TORCH_CUDA_ARCH_LIST=''`。import 就触发 nvcc 编译，产物落
   `~\.cache\torch_extensions\`（**在用户 home，不在项目里**）。
   ⇒ pip 装的 torch 只带 CUDA runtime，**不带 nvcc**，多半编不过。
   ⇒ 用 `use_cuda_kernel=False` 关掉（`IndexTTS2.__init__` 有这个参数）。

3. **运行时会联网**：`config.yaml:119` 的 `nvidia/bigvgan_v2_22khz_80band_256x`
   是 **HF 模型 ID 不是本地文件**；`infer_v2.py` 还**直接 import modelscope**
   ⇒ HF + ModelScope **两套下载器两套缓存**。加上 torch_extensions，
   这个引擎会往磁盘上撒好几个缓存位置。⛔ 必须在接 shim 时一并定死，
   否则症状不是报错，是几个月后 C 盘少了几十 GB 不知道去哪了。

4. **`infer.py` 与 `infer_v2.py` 是两条独立的链**（实测：`infer_v2` 不 import
   `infer`）。`infer.py:3` 那句模块级 `os.environ['HF_HUB_CACHE']` 我们走不到。
