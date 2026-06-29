# tb11 真正的根因找到了：训练用了 v2Pro 底模，却按 v2 配置训练

## 现象
推理时引擎控制台报：
```
RuntimeError: The size of tensor a (512) must match the size of tensor b (1024)
  at non-singleton dimension 1
  ... module/mrte_model.py line 42, in forward
INFO: 127.0.0.1 - "POST /tts HTTP/1.1" 200 OK
```
前端却显示成功 / 输出静音音频。

## 根因（确定）
训练流水线是一个 **v2 / v2Pro 的"缝合怪"配置**，三处自相矛盾：

| 位置 | 现状 | 属于 |
|---|---|---|
| `preprocess.js:84`（提取语义用的底模） | `v2Pro/s2Gv2Pro.pth` | v2Pro |
| `train.js:181-184`（S2 训练底模 G/D） | `s2Gv2Pro.pth` / `s2Dv2Pro.pth` | v2Pro |
| `configs/s2.json` `gin_channels` | `1024` | v2Pro |
| `train.js:267` `model.version` | `'v2'` | **v2** |
| 预处理特征提取 | 只有 `cnhubert`，**没有 SV(说话人验证) 嵌入** | **v2** |

**关键矛盾**：v2Pro 架构需要额外的 SV 嵌入（`sv_emb`），全局条件向量 `ge` 是 **1024** 维；
而 v2 架构里 `ge` 是 **512** 维，且 **没有 SV 提取步骤**。
这个流水线用 v2Pro 的底模(1024) + v2Pro 的 gin_channels(1024)，
但却声明 version='v2' 且根本没提取 SV → 训练出来的 checkpoint 内部维度对不上。

推理时 v2Pro 引擎在 `mrte` 里做 `cross_attention(...) + ssl_enc(512) + ge(1024)` → **512 vs 1024 报错**。

## 为什么前端看不到错（静音之谜的最终答案）
引擎日志开头 `False False False` = streaming_mode 关闭。按理 synthesis 抛错应返回 400，
但你的引擎 `TTS.py` 在批处理循环里 **吞掉了 decode 异常并继续 yield 空音频**，
于是 FastAPI 返回 **200 OK + 一个只有 ~44 字节 WAV 头的空音频**。
→ broker 收到 200，以为成功，保存了一段静音。**这就是"能跑通但没声音"的真相。**

---

## 修复（已应用，共 4 个文件）

### A. 让整条链路统一成 v2（这是最小、最稳的方向）
broker 本来就是按 v2 设计的（只提 cnhubert、没有 SV、version=v2），
错的只是"底模和 gin_channels 指向了 v2Pro"。把它们改回 v2：

1. `lib/training/gsv_code/configs/s2.json`：`gin_channels` **1024 → 512**
2. `lib/training/steps/preprocess.js:84`：`s2Gv2Pro.pth` → **`s2G488k.pth`**
3. `lib/training/steps/train.js:181-184`：`s2Gv2Pro.pth`/`s2Dv2Pro.pth` → **`s2G488k.pth`/`s2D488k.pth`**

> 这两个 v2 底模(`s2G488k.pth` 101MB / `s2D488k.pth` 89MB)就在你的
> `pretrained/v2Pro/` 目录里（你之前的文件列表里有），文件名直接换即可，目录不用动。

### B. 让 broker 不再把引擎错误"吞成静音"（server.js）
即使将来引擎再返回 200+空音频，broker 也要报错而不是存静音：
- `generateOneSegment`：新增 **`audioBytes.length <= 100` 判定**（≈裸 WAV 头）→ 直接抛中文错误，提示去看引擎控制台。
- `switchModels`：加载权重失败由 `console.error` 改为 **throw**（含 `[MODEL]` 日志）。
- 新增参考音频 `fs.existsSync` 校验 + payload 摘要日志。
- 多段拼接静音段采样率由写死 22050 改为 **跟随片段实际采样率(32000)**。

---

## 你必须做的两件事
1. **用本目录 4 个文件覆盖项目对应文件**，重启 broker。
2. **重新训练这个音色**——之前那个失败的模型是用错误配置训练的，已经废了，
   必须用修好的 v2 配置重新跑一遍训练，新模型才能正常推理出声音。

## 验证
重训后推理：
- 引擎控制台不应再有 `512 must match 1024` 的报错。
- broker 控制台会打印 `[MODEL]` / `[TTS] payload:` 日志，`ref=` 指向的文件应真实存在。
- 输出音频应有声音；若仍空，broker 现在会直接抛"音频几乎为空"的错误并让你去看引擎日志。

## 备注：想用 v2Pro（更好音质）怎么办？
那是另一条路，**不是改个文件名就行**：需要在预处理里增加 SV 嵌入提取
（额外的 eres2net SV 模型），训练和推理都要读 SV。工作量大、风险高。
当前以"先把推理跑通出声"为目标，统一 v2 是正确选择。v2Pro 可作为以后的独立任务。
