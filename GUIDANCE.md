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
- 🎵 **如需对外提供 OpenAI 兼容接口的 MP3(或 opus / aac / flac)输出,请一并安装 ffmpeg**(引擎只出 WAV,MP3 转码依赖 ffmpeg,项目未内置其它编码器)。安装方式见 [FAQ · Q5](#q5-需要-ffmpeg-吗)。

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

### Q6. 需要 ffmpeg 吗?

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
