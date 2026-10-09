# 引擎环境缺陷记录（2026-10-09 实测）

> 分支：`research/engine-onboarding-complexity`
> 口径：`[实测]` = 在本机跑出来的；`[读码]` = 从代码读的。
> 本文档只记录**实测确认的环境缺陷**，不含改造方案。

## 背景

为验证「自动提取引擎可调用参数」这条路的可行性（见 `ONBOARDING_PLAN.md`
A1 / 欠账 N6），需要在**真引擎**上跑 `lib/engines/reflect_params.py`。
实测发现：**反射工具本身没问题，是引擎环境坏了**。

---

## 缺陷 1：`uv venv` 不复制 `python3.dll` ⇒ 所有 abi3 轮子加载失败

### 症状

[实测] `engines/cosyvoice2/.venv` 里 `import tokenizers` 失败：

```
ImportError: DLL load failed while importing tokenizers: 找不到指定的模块。
```

### 根因

[实测] 用 PE 导入表解析对比两个 tokenizers：

| 来源 | pyd 文件名 | 依赖的 Python DLL |
|---|---|---|
| cosyvoice2（坏） | `tokenizers.pyd`（abi3 通用命名） | **`python3.dll`** |
| gpt-sovits（好，0.19.1） | `tokenizers.cp311-win_amd64.pyd` | `python311.dll` |

**`python3.dll` 是 CPython 的「稳定 ABI 转发库」**，abi3 轮子（用 maturin
编的 Rust 扩展，如新版 `tokenizers`）依赖它。而：

- 内嵌 Python 目录 `tools/runtime/python/` **有** `python3.dll` 和 `python311.dll`
- 但 **`uv venv` 建的 venv 的 `Scripts/` 里只复制了 `python311.dll`，没有 `python3.dll`**

⇒ venv 的 `Scripts/` 在 DLL 搜索路径里优先 ⇒ 加载 abi3 扩展时找不到 `python3.dll`
⇒ 失败。**且失败信息完全没提这件事**（只说「找不到指定的模块」）。

### 影响面

[实测] **五个 venv 全部缺**（复制前）：

```
venv（平台）              缺
engines/index-tts/.venv   缺
engines/indextts2/.venv   缺
engines/gpt-sovits/.venv  缺
engines/cosyvoice2/.venv  缺
```

⇒ 凡是 abi3 的轮子在这个项目里**全部装不上/加载不了**。这不是某一台引擎的问题，
是**建 venv 的方式**的问题。

### 修法（已验证）

```bash
cp tools/runtime/python/python3.dll <venv>/Scripts/
```

[实测] 复制后 `import tokenizers` 立即成功：

```
engines/index-tts: tokenizers 0.21.0
engines/indextts2: tokenizers 0.21.0
engines/gpt-sovits: tokenizers 0.19.1
engines/cosyvoice2: tokenizers 0.21.4
```

### ⚠️ 需要落成平台侧修复（未做）

这不是「手工补一个文件」就完了 —— 它会在**每一次**新建引擎环境时复现。
可能的落点：

| 选项 | 说明 |
|---|---|
| 甲 | 向导 `core/env.js` 在 `uv venv` / `uv sync` 之后补一行「复制 `python3.dll` 进 Scripts」 |
| 乙 | 查清 `uv venv` 是否有参数让它复制（`--python-preference` 之类）—— 待查 |
| 丙 | 换成 `python -m venv`（它会不会复制 `python3.dll`？待实测） |

⚠️ 目前**只有实测确认了「补文件有效」**，没查过 uv 是否有原生解法。

---

## 缺陷 2：torch 与 torchaudio 后端不匹配（XPU 机器装到 CUDA 版 torchaudio）

### 症状

[实测] `engines/index-tts/.venv` 里 `import torchaudio` 失败：

```
FileNotFoundError: Could not find module '...torchaudio/lib/libtorchaudio.pyd'
(or one of its dependencies).
```

### 根因（⚠️ 比「向导漏换」更深一层）

**上游的 `uv.lock` 自己就硬锁了 CUDA 版 torchaudio。**

[实测] `engines/index-tts/uv.lock`：

```
line 871:  { name = "torchaudio", version = "2.8.0",      source = { registry = "https://pypi.org/simple" },
             marker = "sys_platform != 'linux' and sys_platform != 'win32'" },
line 872:  { name = "torchaudio", version = "2.8.0+cu128", source = { registry = ".../whl/cu128" },
             marker = "sys_platform == 'linux' or sys_platform == 'win32'" },
```

⇒ **在 Windows 上，锁文件指定的就是 `+cu128`**（`source = whl/cu128`）。
⇒ `uv sync` 照锁装，必然拿到 CUDA 版 torchaudio。

[实测] `uv sync` 输出确认：

```
+ torchaudio==2.8.0+cu128
```

**所以「装 CUDA 版 torchaudio」不是向导的 bug，是上游 lock 的事实。**
向导的 bug 是**只换了一半**：

[读码] 向导 `core/env.js` 的 `suggestBackendAlternative` 只处理 **torch**：

```
uv sync --no-install-package torch          ← 只跳过 torch
uv pip install torch==<版本> --index-url <本机后端 index>
```

**`--no-install-package` 只点了 `torch` 一个**，`torchaudio` / `torchvision`
仍然照 lock 装（CUDA 版）⇒ 与换过的 XPU torch 不匹配 ⇒ 必然崩。

⚠️ 这与 README「依赖锁定」节的说法不一致：README 说
`tools/cli/install-torch.js` 会处理 `torch/torchaudio/torchvision` 三个
（`--no-deps` 单独装）。但**向导这条路只处理了 torch 一个** —— 两条路的
行为不同，而向导那条是错的。

⭐ **推论**：`--no-install-package` 必须把 **torch 全家**都点上
（`torch` / `torchaudio` / `torchvision`），然后用同一个 index 把它们一起装。
只换一个，就是把「后端不匹配」从 torch 搬到了 torchaudio 上。

### 修法（进行中）

xpu index 上没有 torchaudio 2.8，两者都升到 2.10：

```bash
uv pip install --reinstall-package torch --reinstall-package torchaudio \
  torch==2.10.0 torchaudio==2.10.0 \
  --index-url https://download.pytorch.org/whl/xpu
```

⚠️ 待验证：升到 2.10 后 index-tts 能否 import 成功。

### ⚠️ 需要落成平台侧修复（未做）

向导的 `suggestBackendAlternative` / `buildSteps` 应该把 **torch 全家**
（`torch` / `torchaudio` / `torchvision`）一起换 index，而不是只换 torch。
判据：装完之后 `import torchaudio` 必须能过 —— 这一条今天没有任何自检。

---

## 缺陷 3：进度文件与 venv 状态脱钩 ⇒ 环境重建后永远装不上

### 症状

[实测] `engines/index-tts/.wizard-env-progress.json` 写着两步都成功：

```json
{"engine":"index-tts","updatedAt":"2026-10-06T07:03:16.480Z",
 "done":[{"key":"...uv sync --no-install-package torch",...},
         {"key":"...torch==2.8.0 --index-url .../xpu",...}]}
```

**但那个 `.venv` 是空壳**（只有 pip / setuptools，7 个包）。

### 根因

[实测] 时间线：

| 时间 | 事件 |
|---|---|
| 10-06 07:03 | 进度文件写入（说装成功） |
| 10-07 16:11 | `.venv` 被**重新创建**（pyvenv.cfg 时间），内容为空 |

⇒ **venv 被重建，但进度文件没清**。向导的断点续传逻辑是「命令行 key 命中就跳过」，
而 key 只含命令行文本、**不含 venv 的状态** ⇒ 再点「安装」会**全部跳过** ⇒
用户以为在装、实际什么都没装。

### ⚠️ 需要落成平台侧修复（未做）

断点续传的判据应包含「环境还在不在」，而不只是「这条命令跑过没」。
可能的判据：venv 的 `Scripts/python.exe` 存在 + `pyvenv.cfg` 的 mtime 不晚于
进度文件的 mtime（晚了就说明环境被重建过 ⇒ 进度作废）。

---

## 附：反射工具本身的状态

[实测] `lib/engines/reflect_params.py` 在环境修好之前**一直失败**，而失败信息
指向的是引擎自己的 import 错误（缺 librosa / torchaudio 等），**不是工具的问题**。

⇒ 这解释了为什么 `ONBOARDING_PLAN.md` 的欠账 N6（`--help` 解析器）一直没做：
**在坏环境上做不了任何「起引擎解释器跑东西」的验证**。

修完环境之后，反射这条路才第一次具备实测条件。
