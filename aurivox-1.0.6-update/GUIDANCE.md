# Aurivox · 使用指南(最终用户)

> 面向最终用户的部署与使用说明。全程双击 `.bat` 即可完成，无需自行安装 Python 或 Node —— 已内置。

---

## 一、环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11(64 位) |
| 显卡(推理) | 推荐 NVIDIA(支持 **CUDA 12.1**);**无 N 卡也可用** —— 自动回退 CPU 运行,可用但明显更慢 |
| 显卡(微调 / 训练) | **必须 NVIDIA GPU**;CPU 训练慢到不可用,且人声分离(UVR5)不支持 CPU |
| 显存 | 微调建议 ≥ 8 GB;**≤4 GB 也能微调**,但有 OOM 风险 |
| 网络 | 首次部署需联网,下载 PyTorch 与模型,约 **10 GB** 流量 |
| Python / Node | ✅ 无需自行安装,已内置 |

> 🟢 **CUDA 状态灯**:界面右上角有一颗状态徽章 —— `CUDA <显存>`(绿=检测到 N 卡)/ `CPU only`(红=未检测到)/ `GPU: detecting…`(灰=检测中)。鼠标悬停可看设备名与显存。
> - **仅 AMD / 无独显**:不在支持范围内(仅测试过 NVIDIA);推理可在 CPU 模式下使用,但**不建议**用于微调。

---

## 二、首次部署

> 双击 **`deploy.bat`**

脚本会自动完成以下步骤:

1. 用内置 Python 3.11 创建虚拟环境 `venv\`
2. 安装依赖(离线轮子 + 联网 PyPI,不含 torch)
3. 安装 PyTorch(CUDA 12.1)
4. 弹出**模型下载向导**,引导你下载模型(约 9 GB)
   - 选 `1` 下载全部;若在国内,菜单里可切换 **hf-mirror** 镜像加速
5. 自检

**提示**

- ⏳ 全程耐心等待,首次可能 **20~60 分钟**(取决于网速)。
- 🔁 若中途失败,重跑本脚本即可(支持续跑,已装的会跳过)。
- 🎵 **如需对外提供 OpenAI 兼容接口的 MP3(或 opus / aac / flac)输出,请一并安装 ffmpeg**(引擎只出 WAV,MP3 转码依赖 ffmpeg,项目未内置其它编码器)。安装方式见 [FAQ · Q7](#q7-需要-ffmpeg-吗)。

---

## 三、启动

> 双击 **`start.bat`**

- 浏览器会自动打开 <http://127.0.0.1:9886>
- 后端与推理引擎在后台运行,**关闭黑窗口不影响它们**。
- 日志位于 `logs\` 下(`startup` / `backend` / `inference`)。

---

## 四、停止

> 双击 **`stop.bat`**

---

## 五、常见问题(FAQ)

### Q1. `start.bat` 提示未检测到 `venv`?

先运行 **`deploy.bat`**。

### Q2. 模型没下全 / 想补下?

命令行运行:

```bat
venv\Scripts\python.exe tools\deploy\download_models.py --wizard
```

或先体检:

```bat
venv\Scripts\python.exe tools\deploy\download_models.py --check
```

### Q3. `torch.cuda.is_available() = False` / 状态灯显示 `CPU only`?

- **若你有 NVIDIA 显卡**:说明驱动 / CUDA 不匹配。请更新 NVIDIA 驱动到**支持 CUDA 12.1** 的版本。
- **若你本就没有 N 卡**:属正常现象,可忽略。程序会以 **CPU 模式**运行推理(可用但更慢)。
  但**不建议在 CPU 上微调**——开始微调时会弹出确认框提醒(耗时数小时甚至数十倍,且人声分离不可用)。

### Q4. 显存较小(≤4 GB)微调会不会出问题?

可以微调,但有**显存不足(OOM)风险**。首次进入微调页会**一次性**提示你 —— 建议**手动把 Batch Size 调小**(如 1–2)后再开始。程序不会自动替你改参数。

### Q5. 端口被占用?

后端 **9886** / 引擎 **9880**。先运行 `stop.bat` 再启动。

### Q6. 人声分离 / UVR5 报 `No module named 'onnxruntime'` 或 MDX 段直接失败?

UVR5 的 **MDX-Net**(`onnx_dereverb`)与中文 **g2pW** 多音字都依赖 `onnxruntime`。正常情况下 `deploy.bat`
会随 `requirements.txt` 自动装好;若你的 `venv` 是旧版本部署遗留、缺这个包,手动补装即可:

```bat
venv\Scripts\python.exe -m pip install "onnxruntime-gpu==1.18.0"
```

> ⚠️ **务必装 `1.18.0` 这个版本**,别装最新版。onnxruntime-gpu `1.19+` 需要 cuDNN 9,而随包 torch(cu121)
> 自带的是 cuDNN 8——版本对不上时,GPU 加速会**静默失效**、MDX 悄悄退回 CPU(不报错,只是慢到超时)。
> `1.18.0` 正好匹配 cuDNN 8。

验证是否真的走上了 GPU(注意 **先 import torch 再 import onnxruntime**):

```bat
venv\Scripts\python.exe -c "import torch; import onnxruntime as ort; print(ort.get_available_providers())"
```

输出里出现 **`CUDAExecutionProvider`** 就说明 GPU 生效了。若只有 `CPUExecutionProvider`,多半是驱动偏老,
把上面的 `nvidia-smi` 顶部 CUDA 版本发出来对一下,或退一档试 `onnxruntime-gpu==1.17.1`。

- **无 N 卡 / ARM 平台**:改装 CPU 版 `pip install onnxruntime`;MDX 在 CPU 上 fp32 较慢,长音频耐心等待。

> 💡 MDX-Net 处理过程中**没有进度条属正常**(进度条被刻意关闭以免刷屏);实时进度可看
> 输出目录下的 `uvr5_cli.log`,里面 `[uvr5] ... device=cuda|cpu` 一行能确认走的是 GPU 还是 CPU。

> ⏱️ **超时**:人声分离每段(pipeline 里每个模型)默认超时 **30 分钟**。在**非 CUDA 设备(CPU)上会非常非常慢**
> ——MDX-Net / Roformer 尤甚,整首歌可能跑数十分钟。若确实需要在 CPU 上处理超长音频,可在启动前设置环境变量
> `UVR5_STAGE_TIMEOUT_MS`(毫秒)把上限调得更大。日志开头也会打印当前超时上限,并在检测不到 CUDA 时给出提醒。
> (本功能仅在 NVIDIA/CUDA 上验证过;AMD / Intel Arc 等非 CUDA 设备未经调试。)

### Q7. 需要 ffmpeg 吗?

**看用途**。ffmpeg **不随包分发**(约 275 MB),以下两种情况需要它:

1. **OpenAI 兼容接口输出 MP3 / opus / aac / flac(分发必备)**
   推理引擎**永远只渲染 WAV**,所有非 WAV 格式都由 broker 侧用 ffmpeg 转码(MP3 走 `libmp3lame`)。项目**未内置任何其它编码器**,因此没有 ffmpeg 就**无法输出 MP3**。只要你要对外分发 / 用 OpenAI 兼容格式,**ffmpeg 是必需的**。
   > ⚠️ 注意:未安装 ffmpeg 时,请求 MP3 **不会报错,而是静默降级为 WAV**(响应里带一条 `ffmpeg not available…` 警告)。这会让期待 MP3 的 OpenAI 客户端拿到"扩展名对不上内容"的音频,排查困难 —— 分发前请务必确认已安装。

2. **人声分离 / UVR5 去背景音**
   该功能同样依赖 ffmpeg。若你的素材本身就是干净人声,通常无需人声分离。

安装命令:

```bat
venv\Scripts\python.exe tools\deploy\download_ffmpeg.py
```

- 会自动下载到 `vendor\ffmpeg\` 下(broker 会优先使用该项目内的自带副本,其次才回退到系统 PATH 上的 ffmpeg)
- `--check` 只检查,`--force` 重下

> 💡 只在内部自用、且直接消费 WAV 输出时,可以不装 ffmpeg;但一旦要对外提供 OpenAI 兼容的 MP3 输出,请务必先安装。

### Q8. 校对页的「置信度」一列是空的 / 没有颜色?

**取决于用的哪个 ASR 引擎,属正常现象。**

- **Faster Whisper**:会输出逐词后验概率,校对页按「较为可信 / 可疑 / 存疑」三档着色,帮你快速定位可能识别错的行。
- **FunASR(Paraformer)**:是非自回归结构,**默认不输出可用的置信度分数**,所以校对页的置信度徽标会**留空、不着色**——这是**如实呈现**,不是出错。此时列表上方会有一行灰色提示说明。

> 💡 想要置信度高亮辅助校对,就在训练页把 **ASR 引擎切回 Faster Whisper**。FunASR 的优势在中文/粤语识别更准且自带标点,但代价是没有逐词置信度。

### Q9. 选了 FunASR,但训练语言不是中文/粤语,开始时弹出提醒?

FunASR **只支持中文/粤语**。当你选了 FunASR 却把训练语言设为日语/英语等其它语言时,开始训练会弹一个**告知**对话框(仅提醒,不强制):

- **继续**:坚持用 FunASR 跑(可能识别不准;后端在失败时也会自动兜底回退 Faster Whisper)。
- **切换到 Whisper**:一键把引擎改回 Faster Whisper 再开始(**最稳,推荐**)。
- **取消**:先不开始,回去调参。

> 语言设成「自动检测(auto)」时**不会**弹这个提醒(自动检测有可能识别为中文)。

### Q10. UVR5 的 MDX-Net 很容易爆显存(OOM)?

**会,MDX-Net 是 UVR5 里最吃显存的模型。** 它按窗口切块做 onnx 推理,长音频 + 大 batch 很容易触发 `cudaErrorMemoryAllocation: out of memory`。

- **默认参数按 4 GB 小显存设计**(逐窗 batch=1),多数卡能直接跑。
- **大显存显卡**(如 ≥8–12 GB)想更快,可自行**调大分段长度 / batch**,按显卡能力加码。
- 万一还是 OOM:把该段的分段/批大小调小,或把 MDX-Net 段**强制切到 CPU**(设环境变量 `UVR5_MDX_DEVICE=cpu`,慢但稳)。
- 素材本身是干净人声时,通常**无需**人声分离,可直接关掉这一步。

> 💡 单纯 GPU 显存被占用但「不干活」,多半是 onnxruntime 没走上 CUDA(见 [Q6](#q6-人声分离--uvr5-报-no-module-named-onnxruntime-或-mdx-段直接失败));确认 `uvr5_cli.log` 里 `device=cuda` 后再排查 OOM。

### Q11. Mel-Band Roformer 报「checkpoint does not match the model architecture」?

Roformer 系列(Mel-Band / BS-Roformer)对**权重文件与配置(.yaml)必须严格配套**。报错里出现 `NNN/NNN model params are missing from the checkpoint`,意思是**配置和权重对不上**,常见原因:

- `uvr5_weights\` 下缺少对应的 **`MelBandRoformer.yaml`** 配置(dim/depth/num_bands 等),loader 只能退回默认配置,和你的 `.ckpt` 结构不符。
- 下载到的 `.ckpt` 与该配置不是同一份(版本/来源不一致)。

**解决**:确保 `.ckpt` 与其**配套的 `.yaml`** 同时放进 `uvr5_weights\`(同名成对),或改用 **MDX-Net / HP 系列**这类不依赖额外 yaml 的模型。

### Q12. 人声分离能不能保存成预设,反复复用?

可以。人声分离支持把你调好的**多段链条 + 逐模型专家参数**保存为**自定义预设**,并像系统预设一样管理:

- **另存为新预设** → 起名保存。
- 选中某个已保存预设后可**继续调参**;改动后点 **Update preset(更新预设)** 才会写回(不是每次改动都自动保存)。
- **删除预设**有**二级确认**(避免手抖误删)。

训练页的「训练预设(Training Preset)」同理,也支持保存/更新/删除自定义参数组合。

> 🎧 **试听闸门**:可在「人声分离后暂停试听(Pause after vocal extraction to audition)」处停下来,先听分离效果再决定继续还是取消;试听播放器支持**波形 / 电平条**两种预览样式切换。

### Q13. 资产里的 `raw\` 和 `raw_b4_extraction\` 分别是什么?为什么启用人声提取后 `raw\` 变成了分离后的人声?

这是**有意为之**的:一旦启用人声提取,**分离出来的人声**才是切片/ASR/训练真正使用的素材,所以它才配叫「raw(原始训练素材)」。因此发布到音色资产时:

- **`raw\`** = **提取后的人声**(即 `denoise\` 的产物)。未启用人声提取时,`raw\` 仍是你的原始输入(原始输入本身就是 raw,行为不变)。
- **`raw_b4_extraction\`** = **提取前的原始混音**,归档留底,便于日后**审计 / 重构 / 换参重跑**。只有启用了人声提取才会有这个目录。

这样一个音色目录里同时留有「进去之前」和「分离之后」两份,自包含,不依赖你外部的原始文件夹(以后被移动/删除也不影响)。

- **想省磁盘、只留最终人声?** 在「人声提取」面板取消勾选 **「保留提取前的原始音频(raw_b4_extraction/)」** 即可(默认勾选)。命令行场景也可用环境变量 `UVR5_KEEP_RAW=0` 跳过暂存快照。
- 训练暂存目录 `.staging\<任务号>\` 下会先有一份 `raw_b4_extraction\` 快照(分离前拷入),收尾发布时再随 `raw\` 一起转入资产。
- 改人声提取参数重跑时,暂存目录里的 `raw_b4_extraction\` 会随 `denoise\` 一起清掉并重新快照(始终对应本次输入)。

### Q14. 对外提供接口（Broker）：流式传输 / 请求内并行加速 / 模型留驻怎么用？（v1.0.6）

如果你用本项目对外提供 **OpenAI 兼容的 TTS 接口**（`/v1/audio/speech`，把训练好的音色打包成
recipe 分发），下面三项能默认生效、也能按需调。**都无需改代码**，必要时改环境变量即可（可写在
`start.bat` 之前 `set` 或系统环境变量里）。

**① 流式传输（边合成边下发，默认不落盘）**
请求体加 `"stream": true` 即可分块返回，首字节更快。**默认不在服务器留文件**；确需归档时再加
`"persist": true`（会一边回流一边存档）。**流式只支持 `wav` / `ogg`**（`mp3` 需整段转码，不走流式）。
```bat
curl -N http://127.0.0.1:9886/v1/audio/speech ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"<你的recipe>\",\"input\":\"你好，这是一段流式示例。\",\"response_format\":\"wav\",\"stream\":true}" ^
  --output out.wav
```
> `-N` 让 curl 不缓冲、真正流式落盘。客户端断开连接时，服务端会立即中止这次合成，不浪费算力。

**② 请求内并行（单条请求更快）**
一条较长的请求会被自动切成多段并行合成，压低这一条的时延。**默认 `batch_size=4`**，一般不用管。
- 显卡显存小、合很长文本时若报显存不足（OOM）：把批大小设为 1（关闭批处理）
  ```bat
  set AURIVOX_TTS_BATCH_SIZE=1
  ```
- 显存富裕想更快：可上调（1–16，如 `set AURIVOX_TTS_BATCH_SIZE=8`）。
> 这是**单请求内部**的加速；由于推理引擎是单卡串行，**多个请求之间仍是排队逐个处理**（见 ③ 与下方过载保护）。

> **前端页面怎么吃到这个并行？** 网页的 **Generate（生成）** 和 **Compare Refs（参考音频对比）**
> 默认是「先把文本切成几段、一段一段合成」（会保留分段文件），这几段之间**不并行**。
> 想让它们并行提速，在该页 **Advanced Settings（高级设置）** 勾选 **Engine Batch（引擎批量并行）**：
> 整段文本一次性交给引擎并行批量合成。**注意**：这样只会得到**一个完整音频、没有分段小文件**
> （大多数人最终听的就是拼好的成品，通常没影响）。**Compare Refs 页有一个总开关**（对所有行生效），
> 每一行还能单独选「继承 / 开 / 关」（默认继承总开关）。不勾就是老行为，保留分段。

**③ 模型留驻（同一模型换参考音频，不用重新加载）**
同一个音色连续合成时，权重不会反复重载；**换参考音频**也走缓存——最近用过的参考音频会被记住，
再次用到时**免重新提取、免重载权重**，多音色 recipe 来回切也能各自保持热。默认记 8 个，够用不用管。
- 想多缓存几个（略占显存，约数十 MB/个）：`set AURIVOX_REF_CACHE=16`；想关掉：`set AURIVOX_REF_CACHE=0`。

**④ 高并发下的过载保护（不会雪崩）**
同时涌入的请求会排队；排队积压超过上限时，服务端**直接返回 HTTP 503** 并带 `Retry-After` 头，
让客户端稍后重试，而不是把机器拖垮。默认最多排 32 个、建议 3 秒后重试。
```bat
set AURIVOX_MAX_QUEUE=32     rem 最多排队数；设 0 表示不限（退回旧行为）
set AURIVOX_RETRY_AFTER=3    rem 返回 503 时告诉客户端几秒后重试
```

> 环境变量小抄：`AURIVOX_TTS_BATCH_SIZE=4` · `AURIVOX_REF_CACHE=8` · `AURIVOX_MAX_QUEUE=32` · `AURIVOX_RETRY_AFTER=3`。
> 全部有安全默认，不设也能正常跑；只有遇到显存不足或想调并发行为时才需要改。
