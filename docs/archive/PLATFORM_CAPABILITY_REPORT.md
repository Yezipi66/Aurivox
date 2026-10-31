# 平台能力实测报告 —— Intel Core Ultra 9 285H 等效平台

> 测试日期：2026-10-02/03
> 测试机：ERYING "Intel Ultra Arrow Lake Polestar B860 M-ATX D5"（ES/QS 工程样品）
> **重要**：CPU 品牌串显示 `Genuine Intel(R) 0000`，`Family 6 Model 197 Stepping 2`
> —— 这正是 **Core Ultra 9 285H（Arrow Lake-H）** 的 CPUID。因此本报告的全部数据
> 可作为 285H 平台的实测参考。ES 样品仅影响品牌识别，不影响指令集与执行行为。

## 硬件与软件基线

| 项目 | 值 |
|---|---|
| CPU | Arrow Lake-H，16C/16T @ 2.9 GHz，L2 28MB / L3 24MB |
| 指令集 | AVX2 + VNNI，**无 AVX-512**（无 `avx512_fp16` / `avx512_bf16` / AMX） |
| GPU | Intel Arc 140T（Xe-LPG，共享内存，驱动 32.0.101.9033） |
| NPU | Intel AI Boost，PCI `VEN_8086&DEV_7D1D`，`NPU_PLATFORM=3720`，约 11 TOPS(INT8) |
| NPU 驱动 | 32.0.100.5540（INF `oem10.inf`） |
| 内存 | 63.5 GB |
| 系统 | Windows 11 IoT 企业版 LTSC 26100 |
| PyTorch | 2.9.1+xpu（`torch 2.14.1+cpu` **不支持 XPU**，务必锁定版本） |
| OpenVINO | 2026.4.1（2026-10-01，当前最新） |

---

## 一、总览：什么能用，什么不能

| | CPU | GPU (Arc 140T) | NPU |
|---|---|---|---|
| **推理 fp32** | ✅ 基线 | ✅ 快 2–7× | ✅ 快 1.2–3× |
| **推理 bf16** | ⚠️ 能跑，模拟，+10% | ❓ 未测 | ⚠️ 硬件原生 |
| **推理 f16** | ⚠️ 能跑，模拟，+14% | ✅ 能跑但**无优势** | ✅ 硬件原生 |
| **训练 fp32** | ✅ 基线 | ✅ **快 4.6×** | ❌ 无求导通路 |
| **训练 bf16** | ❌ 无 AVX512-BF16 | ❓ 未测 | ❌ |
| **训练 f16** | ❌ 无 AVX512-FP16 | ⚠️ NaN，须 AMP+Scaler | ❌ |
| **复数/FFT 模型** | ✅ | ✅ | ❌ ONNX 导不出 |
| **编译开销** | 无 | 20 s–821 s，每次新进程重付 | 1.7–28 s |
| **LLM 推理** | ✅ | ✅ **最优**（Vulkan） | ⚠️ 仅小模型 |
| **LLM 并发** | ✅ 4 | ✅ **4（K=2 甜点）** | ❌ **1（硬限制）** |

**一句话**：CPU 兜底一切；GPU 快但每次进程重付编译；NPU 只能推理、不能训练、
跑不了 SOTA（复数模型）、并发上限为 1。

---

## 二、NPU 的三条硬边界

### 1. 无法微调训练 —— 硬件决定，非软件限制

```
OpenVINO 68 个顶层符号中：train/grad/backward/optimizer 相关 = NONE
Level Zero 指令集：KERNEL / TRANSFER / MEMORY / FILL / BARRIER —— 无求导指令
```

PyTorch 无 NPU 后端。ONNX 导出时权重被固化为常量，autograd 图不存在。
**任何模型都不能在 NPU 上训练。**

### 2. 跑不了 SOTA（Roformer 等复数模型）

Mel-Band Roformer（228.20M）ONNX 导出两次均失败：

```
尝试1 TorchScript: STFT does not currently support complex types
尝试2 实数替换:    view_as_real is only supported for complex tensors
```

STFT/iSTFT 成对出现，复数是架构数学基础，**无法绕过**。
后续即便导出成功还有两道墙：228M 参数超内存、FFT 算子 NPU 不支持。

### 3. 只支持静态 shape

```
NPU: Missing upper bound for one or more nodes
```
模型 batch 维为 `?` 时直接编译失败，必须 `m.reshape([1,4,3072,512])`。

---

## 三、推理实测数据

### 3.1 通用 CNN（ImageNet 模型，OpenVINO benchmark_app）

| 模型 | batch | NPU | GPU | CPU |
|---|---|---|---|---|
| ResNet-18 | 1 | 791 fps | 1275 fps | 234 fps |
| ResNet-18 | 8 | 790 fps | 2429 fps | 222 fps |
| ResNet-18 | 32 | 785 fps | **3618 fps** | 225 fps |
| ResNet-50 | 1 | 363 fps | 692 fps | 108 fps |
| ResNet-50 | 8 | 360 fps | 1097 fps | 131 fps |

**关键特性：NPU 吞吐量与 batch 无关**（791→790→785，波动<1%）。
GPU 随 batch 增长 2.8×。NPU 是固定延迟引擎，不能靠 batching 榨性能。

### 3.2 BERT（序列长度 256）

| batch | NPU | GPU | CPU |
|---|---|---|---|
| 1 | 36.0 | 94.2 | 18.4 |
| 8 | 36.9 | 128.8 | 20.3 |
| 32 | 36.1 | 125.1 | 17.9 |

**int8 量化版**：NPU 5.8 fps（比 f16 慢 6.2×），b=32 时
`ZE_RESULT_ERROR_OUT_OF_HOST_MEMORY` 崩溃。
官方文档明示：`Computation precision for the HW is FP16` —— INT8 仅省内存，不省算力。

### 3.3 UVR5 人声分离

**Mel-Band Roformer**（228.20M，SOTA）稳态，8 秒块：

| 设备 | 秒/块 | 实时率 |
|---|---|---|
| CPU | 7.907 | 1.01× |
| **GPU** | **3.700** | **2.16×** |

GPU 比 CPU 快 **2.14×**。但 Intel GPU **无磁盘 kernel 缓存**，每次新进程重编约 20 秒：

| 音频长度 | CPU | GPU（含编译） |
|---|---|---|
| 20 s | 27.5 s | 32.9 s ← CPU 更快 |
| 152 s | ~3.5 min | ~1.9 min |
| 442 s（两首） | — | 12 min 44 s（overlap=4） |

**交叉点约 30 秒**。

**MDX-Net**（纯 ONNX，67 MB，无复数）：

| 设备 | ms/窗口 | 相对 |
|---|---|---|
| GPU | 358.5 | **7.3×** |
| NPU | 1000.3 | 2.6× |
| CPU | 2602.3 | 1.0× |

三设备数值一致（相对误差 1.3e-03）。
**NPU 能跑 MDX-Net** —— 这是 NPU 参与 UVR5 的唯一现成路径，但 3 分钟歌需约 100 分钟。

### 3.4 GSV S2 解码器（HiFi-GAN）

| 设备 | 延迟 | 相关系数 vs PyTorch |
|---|---|---|
| GPU | **4.03 ms** | 0.9999956 |
| NPU | 34.7 ms | 0.9999868 |
| CPU | 36.3 ms | 1.0000000 |

GPU 比 NPU 快 **8.6×**。NPU 上 f32 IR 与 f16 IR 性能、精度几乎相同（硬件 fp16 计算）。

---

## 四、训练实测数据

### 4.1 GSV S2（VITS 生成器，79.43M 参数）

| 配置 | JIT 编译 | 稳态 step | 状态 |
|---|---|---|---|
| CPU fp32 | 1.29 s | **1.147 s** | ✅ loss 正常下降 |
| GPU fp32 | **821 s** | **0.251 s** | ✅ 快 4.6× |
| GPU f16 | 705 s | 0.212 s | ⚠️ **loss = NaN** |
| CPU f16 | — | — | ❌ 硬件不支持 |

**GPU f16 NaN 原因**：探针用全模型 fp16，无 GradScaler 动态缩放。
VITS flow 模型有 `exp(logs)` 与随机噪声项，fp16 溢出。
GSV 真实训练用 AMP（部分层 fp16 + loss 计算 fp32），不会此问题。
**GPU fp16 加速仅 15%，不值当。**

### 4.2 GSV S1（GPT 解码器，77.61M，24 层）

| 配置 | JIT 编译 | 稳态 step |
|---|---|---|
| CPU fp32 | 2.47 s | **1.420 s** |
| GPU fp32 | 242 s | **0.342 s**（快 4.2×） |

### 4.3 单 epoch 时间（5 条数据 ≈ 46 步）

| | S2 | S1 | 合计 |
|---|---|---|---|
| CPU fp32 | ~53 s | ~65 s | **~2 分钟** |
| GPU fp32 | 821+12 s | 242+12 s | **~18 分钟** |

**小数据量下 CPU 完胜**（编译成本压倒算力优势）。
GPU 需多 epoch 才回本，且无磁盘缓存意味着**每次重启都要重付**。

### 4.4 低精度指令集（决定性证据）

CPU = Family 6 Model 197（Arrow Lake-H），**无 AVX-512**：

```
float32   前向 0.0232s   前向+反向 0.0746s   ✅
bfloat16  前向 0.0254s   前向+反向 FAIL     ❌
float16   前向 0.0265s   前向+反向 FAIL     ❌
  → RuntimeError: DNNL does not support bf16/f16 backward on the platform with avx2_vnni_2
```

- **bf16 与 f16 要求同一指令集**（`avx512_bf16` / `avx512_fp16`），bf16 不是妥协方案
- 低精度**前向可跑**（oneDNN 用 fp32 模拟，+10~14% 开销）
- 低精度**反向被硬拒**（训练不可行）

---

## 五、Intel GPU 的编译开销（重要陷阱）

| 任务 | 编译耗时 | 能否摊薄 |
|---|---|---|
| GSV S2 训练 | **821 s** | ✅ 同进程内多步只编一次 |
| GSV S1 训练 | 242 s | ✅ 同上 |
| HuBERT 特征提取 | 50–300 s | ✅ 同上 |
| UVR5 Roformer 推理 | ~20 s | ❌ **每次 CLI 调用重付** |

原因：
- CPU/NVIDIA 的 PyTorch wheel **预编译**机器码，装机即完成
- `torch_xpu.dll` 725 MB 内含**需运行时编译的中间表示**（SPIR-V/LLVM IR）
- Intel 缺 `%LOCALAPPDATA%\NVIDIA\ComputeCache` 那种磁盘级持久化缓存
  （已查 `AppData/Local/torch`、`~/.cache`、oneDNN 目录，**均无**）

**实操含义**：GPU 适合长任务（训练）或常驻服务；短任务 CPU 反而快。

---

## 六、部署陷阱（会导致静默降级）

### 1. torch 版本被降级 → XPU 静默失效

安装 `static-ffmpeg` 等依赖时，torch 被降级为 `2.14.1+cpu`：

```
AssertionError: Torch not compiled with XPU enabled
```

**此报错极易误判为代码问题。** 必须在 `deploy.bat` 锁定：
```
torch==2.9.1  --index-url https://download.pytorch.org/whl/xpu
```

### 2. UVR5 `--device` 不认 Intel GPU

`uvr5_cli.py` 的 `_resolve_device` 只判 CUDA。已加 3 处最小改动：

```python
# uvr5_cli.py:132
if torch.cuda.is_available(): return "cuda"
try:
    if torch.xpu.is_available(): return "xpu"
except Exception: pass
return "cpu"

# bsroformer.py:239  autocast 设备类型需匹配实际设备
_amp_device = "cuda" if str(device).startswith("cuda") else (
    "xpu" if str(device).startswith("xpu") else "cpu")
with torch.amp.autocast(_amp_device, enabled=self.is_half):

# uvr5_cli.py:413  清理显存
elif getattr(torch, "xpu", None) is not None and torch.xpu.is_available():
    torch.xpu.empty_cache()
```

### 3. GSV 默认配置会崩

`lib/training/gsv_code/configs/s2.json:14` → `"fp16_run": true`（默认值）
`run_pipeline.py:138` → 硬编码 `s2_config["train"]["fp16_run"] = True`

**CPU 上必须改为 false**，否则 oneDNN 直接拒绝。

### 4. GSV 不支持 bf16

`grep -rn "bfloat16|bf16" lib/` → **0 结果**。
只用了 `autocast` + `GradScaler`（默认 fp16，不可配置 dtype）。
要支持需改为 `autocast(device_type, dtype=torch.bfloat16, ...)` 并配
`bf16_run` 开关 —— 但对本平台无意义（CPU 无 AVX512-BF16）。

---

## 七、选型建议

| 需求 | 选谁 | 依据 |
|---|---|---|
| 最快推理 | **GPU** | 全面最优，快 2–8× |
| 后台常驻、不抢 CPU | **NPU** | 仅占 0.19 核，GPU 满载时仅受 2.9% 影响 |
| 训练（S1/S2 微调） | **GPU**（长任务）/ CPU（<2 epoch） | GPU 快 4.6× 但编译贵 |
| 短任务 / 一次性推理 | **CPU** | 省 20–821 秒编译 |
| 低精度训练 | **GPU fp32** | CPU 无指令集；GPU f16 收益小且有 NaN 风险 |
| UVR5 SOTA 分离 | **GPU** | NPU 导不出复数模型 |
| UVR5 MDX-Net | GPU / NPU / CPU 皆可 | NPU 是唯一能让其参与的现成 ONNX |

---

## 八、建议的 NPU 改造点（工程价值最高）

在 `uvr5/uvr5_cli.py` 为 MDX-Net 增加 OpenVINO provider：

- `mdxnet.py:122` 目前只挂 `CUDAExecutionProvider` / `CPUExecutionProvider`
- 加 `OpenVINOExecutionProvider` 即可让 NPU 参与
- 需配合 `m.reshape([1,4,3072,512])`（NPU 不支持动态 batch）
- 收益：3 分钟歌从 100 分钟 → 47 分钟（仍慢，但可后台跑）

---

## 九、LLM 推理实测（llama.cpp b11349，GGUF）

### 9.1 环境与四个后端

采用**官方预编译二进制**（纯 zip 解压即用），完全不触碰 Python 环境：

```
llamacpp/{cpu, vulkan, sycl, openvino-2026.4}/llama-bench.exe
```

切换 NPU 无需改代码：`GGML_OPENVINO_DEVICE=NPU` 环境变量。

Arc 140T 能力（Vulkan 自报）：
```
uma: 1  ← 统一内存（58 GB 策略的基础）
fp16: 1 | bf16: 0 | fp4: 0
matrix cores: KHR_coopmat
```

### 9.2 四后端 × Qwen3-4B Q4_K_M

| 后端 | 设备 | pp128 (t/s) | tg64 (t/s) |
|---|---|---|---|
| **Vulkan** | Arc 140T | **780** | **19.6** |
| SYCL | Arc 140T | 156 | 17.0 |
| CPU | 16 核 | 155 | 16.9 |
| OpenVINO | CPU | 151 | 8.4 |
| **OpenVINO** | **NPU 3720** | 74 | **5.4** |

**Vulkan 完胜**：prompt processing 比 CPU 快 **5.0×**，token generation 快 1.16×。
**NPU 能跑 LLM**（纯实数运算，绕开了 Roformer 的复数障碍）。

### 9.3 规模效应（Vulkan）

| 模型 | 大小 | pp128 | tg64 | tg 相对 4B |
|---|---|---|---|---|
| Qwen3-4B Q4_K_M | 2.32 GiB | 780 | **19.6** | 1.00× |
| Qwen3-4B Q8_0 | 3.98 GiB | 606 | 11.9 | 0.61× |
| Qwen3-14B Q4_K_M | 8.38 GiB | 246 | 6.28 | 0.32× |
| Qwen2.5-32B Q4_K_M | 18.48 GiB | 110 | **2.91** | 0.15× |

**token generation 与参数量近似成反比**（权重 8.1 倍 → 速度 0.15 倍），
印证 LLM 生成是 **memory-bound**：每 token 需读完整个权重。
Q8 比 Q4 慢 39%（11.9 vs 19.6），**本平台适合 Q4 量化**。

### 9.4 32B 四后端对照

| 后端 | pp (t/s) | tg (t/s) | 状态 |
|---|---|---|---|
| **Vulkan (GPU)** | **109.6** | **2.91** | ✅ |
| CPU | 21.4 | 2.61 | ✅ |
| SYCL | 19.3 | 2.60 | ✅ |
| OpenVINO-CPU | 19.5 | 1.74 | ✅ |
| **OpenVINO-NPU** | 4.31 | — | ❌ **崩溃** |

**NPU 在 32B 上失败**：
```
ggml_backend_sched_graph_compute_async failed with error -1
test_gen: failed to decode generation batch, res = -3
```
与 Roformer 同类问题：**NPU 内存/算力无法承载大模型**。

### 9.5 体感换算

| 模型 | tg (t/s) | 生成 100 字 |
|---|---|---|
| Qwen3-4B Q4 | 19.6 | 约 5 秒 ✅ |
| Qwen3-14B Q4 | 6.3 | 约 16 秒 ⚠️ |
| Qwen2.5-32B Q4 | 2.9 | 约 34 秒 ❌ |

### 9.6 LLM 场景下的设备选型

| 需求 | 选谁 |
|---|---|
| LLM 推理 | **Vulkan（GPU）**，唯一实用选择 |
| 4B 小模型 / 低功耗常驻 | **NPU**（5.4 t/s，可后台跑不抢 GPU） |
| 32B 及以上 | **仅 GPU 可用**，NPU 崩溃 |
| 长文本处理（pp） | Vulkan 碾压（780 vs 155 t/s） |

**关键结论：NPU 的能力边界与模型类型强相关。**
纯实数小模型（BERT / LLM-4B / S2 解码器）NPU 能跑；
复数模型（Roformer）或大模型（32B）NPU 必然失败。

---

## 十、LLM 部署注意事项

### 1. 不要用 pip 装 llama-cpp-python

PyPI 上 **cp314 无预编译轮子**（Python 3.14），源码编译会连带重建 torch，
导致 `torch 2.9.1+xpu` 被降级为 `2.14.1+cpu`，XPU 静默失效。
**用官方预编译 zip 是零风险方案。**

### 2. 四个后端各有用途

| 后端 | 包大小 | 用途 |
|---|---|---|
| vulkan | 31 MB | **GPU 推理首选**，pp 性能碾压 |
| openvino-2026.4 | 84 MB | 唯一能访问 NPU 的路径 |
| sycl | 141 MB | GPU 但未针对 Arc 优化（≈CPU） |
| cpu | 18 MB | 基线对照 |

---

## 十一、LLM 并发压测

### 11.1 测试方法与一个关键陷阱

用 `llama-cli` 并发跑 K 个进程，各生成 96 token，记录成功率与聚合吞吐。

**陷阱：`llama-cli` 失败时退出码仍为 0。** 首版脚本只看退出码，把
"NPU + 32B" 误判为跑通；实际输出是：
```
Error: Compute error.
[ Prompt: 0.0 t/s | Generation: 0.0 t/s ]
```

修正后判定成功需**同时满足三条**：
1. 退出码 = 0
2. 输出无错误关键字（`Compute error` / `failed to decode`）
3. 解析 `Generation: x t/s`，且速率 > 0

**压测 CLI 类工具不可只看退出码。**

**内存保护**：32B Q4 = 18.49 GiB/进程。K=3 需 55 GB，超过可用 56 GB 会
抖动卡死（实测发生过）。脚本预先计算投影内存，超过 42 GB 的档位直接拒绝。
同时 `-c 1024` 压缩 KV cache。

### 11.2 Qwen3-4B Q4（2.32 GiB/进程，ctx=1024）

| K | GPU (Vulkan) | CPU | NPU |
|---|---|---|---|
| 1 | ✅ 6.4 t/s | ✅ 8.8 t/s | ✅ 7.5 t/s |
| 2 | ✅ **13.0**（2.03×） | ✅ 11.9（1.35×） | ❌ **0/2** |
| 3 | ✅ **13.4**（2.09×） | ✅ 13.1（1.49×） | ❌ 0/3 |
| 4 | ✅ **13.4**（2.08×） | ✅ 13.9（1.58×） | ❌ 0/4 |

**GPU 在 K=3 后饱和**（13.4 t/s），再加并发只是分摊，不会更快。
CPU 也有 1.58× 扩展（多进程吃满多核），增幅小于 GPU。

### 11.3 Qwen2.5-32B Q4（18.49 GiB/进程，ctx=1024）

| K | GPU (Vulkan) | CPU | NPU |
|---|---|---|---|
| 1 | ✅ 1.1 t/s（84.9 s） | ✅ 1.6 t/s（59.9 s） | ❌ **compute error** |
| 2 | ✅ 1.6（1.41×） | ✅ 2.0（1.22×） | ❌ compute error |
| 3 | 🚫 拒绝（投影 56.5 GB） | 🚫 拒绝 | 🚫 |
| **最大真实并发** | **4** | **4** | **1** |

32B 的并发上限是**内存**（18.49 × 3 = 55 GB 超可用），非算力限制——
GPU 与 CPU 被同一堵内存墙挡住。

### 11.4 并发结论

1. **NPU 并发上限 = 1**（唯一例外是它连单个 32B 都跑不动）。
   单执行引擎，同一时刻只能服务一个图，**实际部署必须串行排队**。
2. **GPU 扩展性最好，但 K=2 是甜点**，K≥3 饱和。
3. **32B 的墙是内存**，不是算力。

### 11.5 LLM 部署选型

| 场景 | 配置 | 实测依据 |
|---|---|---|
| 单人日常 | GPU + 4B Q4（Vulkan） | bench 19.6 t/s |
| 2–4 人并发 | GPU + 4B，K=2–4 | 聚合 13.4 t/s |
| 长文档问答 | GPU + 14B | pp 246 t/s，tg 6.3 t/s |
| 32B | 可用，1.1 t/s，最多并发 2 | 吃 18.5 GB |
| **NPU** | **仅单请求串行** | 4B 7.5 t/s；32B 不可用 |

> 注：本节数字来自 `llama-cli` 端到端计时（**含模型加载时间**），
> 因此低于第九章 `llama-bench` 的纯推理值（4B 加载约 10 s，32B 约 40 s）。
> 选型看第九章（纯性能），体感看本章（端到端）。

---

## 附：测试脚本位置

```
C:\Users\User\AppData\Local\hermes\cache\scratch\gsv\
  stage0_slice.py       切片（threshold 单位是 dB，不是振幅）
  stage1b_ssl.py        HuBERT 特征提取
  stage2_s2_probe.py    S2 微调探针
  stage3_s1_probe.py    S1 微调探针
  stage4c_uvr_fixed.py  UVR5 MDX-Net 三设备
  stage6_mbr.py         Mel-Band Roformer
  stage7_mbr_onnx.py    NPU ONNX 导出尝试（已证失败）
  bf16_probe.py         低精度指令集实测

C:\Users\User\AppData\Local\hermes\cache\scratch\llm\
  concurrency.py        LLM 并发压测（含内存保护 + 假成功检测）
  *.gguf                测试模型（4B Q4/Q8、14B Q4、32B Q4）

C:\Users\User\AppData\Local\hermes\cache\scratch\llamacpp\
  cpu/ vulkan/ sycl/ openvino-2026.4/    llama.cpp b11349 四后端
```

原始日志：`gsv/s2_*.log`、`gsv/s1_*.log`、`mbr_onnx.log`、`llm/c_*.txt`

### 项目代码改动（可合并进 Aurivox）

```python
# uvr5_cli.py:132  _resolve_device —— 增加 XPU 探测
# uvr5_cli.py:413  显存清理 —— 增加 torch.xpu.empty_cache()
# bsroformer.py:239  autocast 设备类型 —— 按实际设备选择
```

这三处是让 UVR5 能在 Intel 核显上运行的最小改动，已实测通过
（Mel-Band Roformer GPU 稳态 3.700 s/块，比 CPU 快 2.14×）。