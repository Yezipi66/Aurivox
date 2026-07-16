# TTS Broker

基于 GPT-SoVITS (v2 / v2Pro / v2ProPlus) 的 TTS 训练与推理一体化工作流，解耦自 GPT-SoVITS 项目，
自包含、可独立部署。面向内部使用者提供「解压即用」的分发包：内嵌可重定位 Python，
一键部署脚本自动建 venv、装依赖、下载模型并自检。

- **训练**：去人声 → 切片 → ASR → 预处理 → S1(GPT) → S2(SoVITS) 全链路管线，带失败恢复。
- **推理**：内置 OpenAI 兼容的自包含推理服务（`lib/inference/infer_server.py`），完整 S1+S2 串联。
- **分发**：`deploy.bat`（首次部署向导）+ `start.ps1`（启动），无需手工配环境。

## 顶层目录导览

> 仅列稳定的顶层职责，避免随业务频繁变动而过时；细节以代码为准。

| 路径 | 职责 |
| --- | --- |
| `server.js` | Express 后端主入口（REST + 推理编排 + 资产/训练接口） |
| `web/` | 前端（Vite + React；`src/` 已模块化为 `lib/` + `components/{generate,train,compare,assets,broker}`） |
| `lib/training/` | 训练管线：`pipeline.js` 状态机 + `steps/`（denoise/slice/asr/preprocess/train_s1/train_s2）+ 解耦的 `gsv_code/` + `gsv-tools/`（预训练权重与 ASR 模型） |
| `lib/inference/` | 自包含推理服务（`infer_server.py` OpenAI 兼容 + `TTS.py` 引擎） |
| `assets/{voiceId}/` | 已发布角色资产（`meta.json` + 训练产物 + `logs_s1` / `logs_s2`） |
| `.staging/{taskId}/` | 训练任务工作区（`task.json` 运行日志 + 中间产物；发布成功后按需清理） |
| `docs/` · `scripts/` · `logs/` · `output/` | 文档 / 归档开发脚本（不参与运行）/ 归档日志与输出 |

## 环境要求

- **OS**: Windows 10/11
- **Python**: 3.11 (uv 管理)
- **Node.js**: 18+
- **CUDA**: 12.1+
- **GPU**: 支持 CUDA 的 NVIDIA 显卡即可（RTX 3050 / 3060 / 3070 均实测可部署，显存越大可用的 batch_size 越高）

## 快速开始

有两种使用方式：**分发包部署**（推荐给使用者）和 **开发模式**（改代码用）。

### A. 分发包部署（解压即用）

1. 解压分发包到**纯英文、无空格**的路径（如 `D:\TTS-Broker-1`；避免中文/特殊字符路径）。
2. 双击 `deploy.bat` 运行首次部署向导：自动用内嵌 Python 建 `venv\`、装依赖、装 PyTorch(CUDA12.1)、
   引导下载模型（约 9GB，需联网）并自检。
3. 部署完成后，双击 `start.ps1`（或 `启动.bat`）启动。

> 说明：模型不随分发包内置，由部署向导下载。首次部署需要联网。

### B. 开发模式

```bash
# Python 依赖（推荐 uv，回退 pip）
uv pip install -r requirements.txt

# Node.js 依赖
npm install

# 配置环境变量
cp .env.example .env    # 编辑 .env 设置 API keys 等

# 启动
start.bat
```

后端运行在 `http://127.0.0.1:9886`，前端 `http://127.0.0.1:5173`，
推理服务 `http://127.0.0.1:9880`（由 `start.ps1` 拉起，日志见 `logs/inference.log`）。

## 训练 Pipeline

### 数据流

```
原始音频 → [去人声] → [切片] → [ASR] → [预处理] → [S1训练] → [S2训练] → 模型
```

### 目录约定

发布（入库）后每个角色在 `assets/{voiceId}/` 下有以下结构：

| 文件/目录 | 说明 |
|-----------|------|
| `meta.json` | 资产元数据（`display_name` / 不可变 id / 语言 / assets 索引）|
| `segments.json` | 参考片段索引 |
| `raw/` | 原始音频 |
| `slicer_opt/` | 切片音频 |
| `asr_opt/` | ASR 结果 |
| `gpt_checkpoints/` | GPT (S1) 模型 |
| `sovits_models/` | SoVITS (S2) 模型 |
| `references/` | 参考音频 |

> 注：`2-name2text.txt`、`4-cnhubert/`、`5-wav32k/`、`6-name2semantic.tsv`、`logs_s1/`、`logs_s2/`
> 等是**训练过程中的中间产物**，位于训练工作区（staging），发布后即被清理，不属于入库约定。

### 训练配置

新建任务的内置默认值在 `lib/training/config.js`（**非对称**：S1 早停防过拟合、S2 更久收敛）：

```json
{
  "gpt_epochs": 8,
  "sovits_epochs": 25,
  "s1_save_every_n_epoch": 4,
  "s2_save_every_n_epoch": 5,
  "batch_size": 4
}
```

> 保存间隔取 S1=4 / S2=5，保证最终 epoch（8%4=0、25%5=0）必落 checkpoint。
> 若存在外部 `training_defaults.json`，其值覆盖内置默认；仅影响变更后新建的任务，已有 recipe/历史任务不追溯改写。

### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/train/start` | 启动训练 |
| GET | `/api/train/status/:id` | 查询状态 |
| POST | `/api/train/cancel/:id` | 取消训练 |
| GET | `/api/train/logs/:id` | 获取日志 |
| GET | `/api/train/tasks` | 获取所有任务 |

## 推理

### 完整推理链路（已实现）

自包含推理服务 `lib/inference/infer_server.py`（FastAPI，端口 9880，OpenAI 兼容）：

```
文本 → S1 (GPT) → semantic tokens → S2 (SoVITS) → 音频
```

由 `start.ps1` 随主服务一起拉起；前端「Generate」/「Compare Refs」页直接调用。
支持切换 GPT / SoVITS 权重、参考音频、逐词读音校准（`pron_overrides`）。

### S2 独立推理（调试用）

用预处理好的数据做 S2 独立推理：

```bash
python scripts/pipeline/infer_s2.py \
  --s2_ckpt assets/{voiceId}/logs_s2/{voiceId}/44k/logs_s2_v3/G_*.pth \
  --work_dir assets/{voiceId}/ \
  --output output.wav \
  --idx 0
```

## 模型文件

| 文件 | 大小 | 说明 |
|------|------|------|
| `pretrained/gsv-v2final/s1bert25hz-5kh-*.ckpt` | ~150MB | S1 预训练 |
| `pretrained/v2Pro/s2Gv2Pro.pth` | ~680MB | S2 Generator 预训练 |
| `pretrained/v2Pro/s2Dv2Pro.pth` | ~550MB | S2 Discriminator 预训练 |
| `pretrained/cnhubert/` | ~300MB | Hubert 特征提取 |
| `asr/models/faster-whisper-large-v3-turbo/` | ~1.6GB | ASR 模型 |

## 已知限制

1. **S2 训练数据格式**: 需要 `2-name2text-0.txt`（tab 分隔 4 列）
2. **安装路径**: 必须解压到纯英文、无空格路径；中文/特殊字符路径会导致嵌入式 Python 无法定位
3. **原生库加载顺序**: 部分 Windows 机器上 `torch` 先于 `librosa` 导入会触发原生崩溃
   （0xC0000005 / 退出码 3221225477，日志为空）；已在所有入口强制 librosa 先行修复

## 更新日志

### 2026-07-17 —— 训练默认非对称（#10）+ S2 声学精炼派生资产（#12）+ 参考文本手动校对（#13）
- ✅ **训练默认非对称（#10）**：废弃对称 20/20，新建任务内置 **S1(GPT)=8 / S2(SoVITS)=25**（S1 重文本-语音
  对齐、易过拟合；S2 重音质、需更久收敛；佐证 RVC-Boss issue #176 "overtraining GPT can cause missing text"）。
  保存间隔 `s1_save_every_n_epoch=4` / `s2_save_every_n_epoch=5`，保证最终 epoch（8%4=0、25%5=0）必落
  checkpoint；legacy 回退 `?? save_every_n_epoch ?? 4`。仅影响变更后新任务，已有 recipe 不受影响
  （`lib/training/config.js` + `steps/train.js`）。
- ✅ **S2 声学精炼（#12）**：从已训练资产的 S2 checkpoint 低学习率续训、复用父 S1，**派生为全新 Voice**
  （`allocateVoiceId()` + `reserve()`，父资产绝不被修改/覆盖）；仅重训 S2（`train_s1:false, train_s2:true`）。
  血统元数据 `parent_voice_id` / `root_voice_id` / `generation` / `base_s1_checkpoint` / `base_s2_checkpoint` /
  `additional_epochs` / `learning_rate`；训练数据冻结快照 `transcript.content_hash` + `frozen_at`；失败回滚
  `release(id)` + 删新目录。默认命名 `"<parent> · S2 Refined <n>"`（无 v2 后缀）。支持链式精炼。
- ✅ **参考文本手动校对（#13）**：资产页 `Proofread Reference Transcript` 入口，默认只编辑现有 transcript、
  **绝不默认重跑 ASR**（`GET/POST /api/assets/:id/transcript` 读写 `.list` + 重建 `segments.json`）；
  `Re-run ASR` 为独立次级操作（`POST /api/assets/:id/transcribe`），执行前把旧文本备份为 `*.bak.<ts>`。
  新增 transcript 来源/验证 provenance：`machine_generated` / `human_edited` / `human_verified`；不触碰已训练 checkpoint。
- ✅ CR：PATCH 可合并（#10 数学正确、#12 血统+回滚+命名无歧义、#13 读写分离+备份安全+provenance 完整）。

### 2026-07-16 —— 中文资产命名（身份/显示解耦）+ Recipe v3 路径可移植性
- ✅ **中文资产命名（Option A）**：`display_name`（允许中文/任意 Unicode、允许重名）与不可变 ASCII
  canonical id 解耦。文件夹名为权威 id，`meta.id` 仅镜像；id 由服务器在建任务时**原子分配一次**
  （`lib/assetId.js`：`slugify` / `allocateVoiceId` 碰撞检查 / `proposeVoiceId` 预览 / 保留占位跨重启持久化），
  永不再从显示名派生。**改名 = 仅改 `display_name`**（不移动文件夹、不改 id、不拒重名，UI 显示非阻塞重名提示）。
- ✅ **Recipe v3 路径可移植性 + 安全**：managed 路径（`reference_audio` / `aux_ref_audio_paths` /
  `gpt_ckpt` / `sovits_pth`）改结构化 `{ base: "asset"|"external", path }`；asset→`ASSETS_ROOT` 相对（可移植），
  external→绝对（不可移植）。**版本感知解析**（legacy v≤2 字符串仍按 APP_DIR，v3 对象按 ASSETS_ROOT，无静默回退）；
  **字段级外部权限**（GPT/SoVITS 需 `allow_external_models`，参考音频另需 `allow_external_audio`，模型权限绝不授权音频）；
  **双层 containment**（词法 + realpath 挡 symlink/junction 逃逸）。`lib/pathResolver.js`。
- ✅ **Legacy 迁移 API（显式/辅助）**：`lib/recipeMigration.js` + 3 端点（preview 只读分类 /
  apply 先备份再改写 v3 / revert 逐字节还原），保守 `ambiguous` 分类须用户裁决，**绝无启动/扫描时静默改写**。
- ✅ 测试：`pathResolver.assetId.test.js` 24/24 + `recipeV3Migration.test.js` 12/12。

### 2026-07-16 —— 多语种混合 + UX 整改 + 全量模块化 + 可复现性
- ✅ **多语种混合输入（#4）**：假名消歧（有假名判日、无假名 CJK 回退角色元数据语言）、逐字汉字语言
  覆盖（`lang_overrides`，共享汉字按需强制中/日）、校对面板与逐字语言互斥、Compare Refs 同步支持。
- ✅ **推理间歇性 500 修复（#5）**：`infer_server.py` 改用 `asyncio.Lock` + `call_soon_threadsafe`
  跨线程加/解锁，消除并发请求下的竞态 500。
- ✅ **Compare Refs P0 整改（#6，6 项）**：🎭 参考角色动态标注、参考音频 3–10s 黄色警告、编辑区
  生成后默认折叠、Model 三级级联下拉、Items 三级联、结果卡管理按钮（Reveal / Rerun / Delete）。
- ✅ **Broker 页面改进（#7）**：GPT/SoVITS 一行三下拉、Example call 默认折叠为单行、
  「Save models」手点才落盘（明确对未来 API 调用的影响）。
- ✅ **资产健康状态全面修复（#8，A~F 六子项）**：健康来源优先聚合、Complete 与 Ready 严格区分、
  转写状态持久化、Rebuild / Restore TASK 通用化（`lib/assetScanner.js`）。
- ✅ **恢复 / 分叉正确性回归（#3 v2）**：进入 Resume 快照各步参数并实时 diff；改动映射到步骤后
  **自动前移重启点**触发 fork（新任务），banner 明确提示"将创建新任务、只复制上游产物、预留磁盘"；
  后端新增 `copyWorkDirUpstream` 只复制上游产物（不再整目录翻倍复制），`clearFromStep` 防御性保留。
- ✅ **推理可复现性（seed）**：`server.js` 上移 `resolveSeed` helper，在调用引擎前把 `seed=-1/空`
  解析成 `[0, 2^32-1]` 的具体值，写入 `meta.recipe` 与顶层审计字段 → Recent 的 Rerun 现可逐字节
  复现（seed + `pron_overrides` 读音 + `lang_overrides` 逐字语言 + 全部采样参数）；默认随机行为不变。
- ✅ **UX 文案微调（5 项）**：删除 Compare Refs 冗余 Back；红色 × 明确为 "Remove from comparison"
  tooltip；发布后清理说明"仅清理任务 workspace，不删除已发布模型资产"；Broker「Change models」
  说明对未来 API 调用的影响；训练音频目录提示"仅支持文件夹，单文件请先放入文件夹"。
- ✅ **全量模块化**：`App.jsx` 6520 → 141 行，拆分为 `lib/api.js` + `pron` + `common` +
  `generate` / `train` / `compare` / `assets` / `broker` 模块树。
- ✅ **ASR 切换** `faster-whisper-large-v3-turbo`（1.6GB）。
- ✅ **中文注释全面英文化**（代码库注释统一英文）。

### 2026-07-14 —— UI 大改版 & 资产健康修复（patch #6 / #7 / #8）
- ✅ **Compare Refs 页面重构（#6）**：Model 输入拆分为三级级联下拉 [Voice ID][GPT][SoVITS]；
  Target Language 上移为顶部窄下拉节省空间；主参考音频支持在大框内直接框选（本角色 slices / raw 双标签页，
  可选其他角色）；参考角色 🎭 标注随所选参考音频动态解析；参考音频不符合 3–10s 时黄色警告；
  生成后编辑区收起为纯音频；结果卡新增 Show in Explorer / Rerun / Delete。
- ✅ **Broker 页面重构（#7）**：GPT/SoVITS 权重选择拆为 [Voice ID][GPT][SoVITS] 三级联动（保留自选 ckpt/pth 逃生通道）；
  「Save models」时才落盘；Example call 折叠为单行可展开。
- ✅ **共享对比文案 & 读音校对**：「Default Test Text」更名「Comparison Text」，附共享 Reading proofing
  （逐词读音覆盖，应用到留空行）。
- ✅ **资产健康指示灯修复（#8）**：去掉 slice 步骤后残留的空 `slicer_opt.list` 不再把 text 健康灯误判为红色
  `invalid`；空/无文本列表现按 `none` 处理，`invalid` 仅保留给「有文本但路径失效」的列表，
  使 text 灯与整体健康灯一致（`lib/assetScanner.js`）。
- ✅ **顺手修复（drive-by）**：推理服务锁释放 `RuntimeError` 兜底路径补注释（`infer_server.py`）；
  recipe 命名占位符英文化；全部新增 UI 文案统一英文。

### 2026-07-14 —— 分发化大更新
- ✅ 完整 S1+S2 推理链路上线（自包含 `infer_server.py`，OpenAI 兼容，端口 9880）
- ✅ 解压即用分发包：内嵌可重定位 Python + `deploy.bat` 首次部署向导（venv/依赖/PyTorch/模型/自检）
- ✅ 项目相对路径解析 + venv 自愈重建；纯英文路径守卫；`.ps1` UTF-8 BOM、`.bat` ASCII 化
- ✅ 系统性修复 torch-before-librosa 原生崩溃：s2_train、2-get-hubert、uvr5/webui、
  infer_server、TTS 五处入口统一 librosa 先行（附静态审计工具 `import_order_audit.py`）
- ✅ 支持 uv 并行安装加速依赖部署；离线 wheel 优先
- ✅ 读音校准（pron_overrides）逐词覆盖 + 推理透传

### 2026-06-20
- ✅ S1 训练跑通（6 epochs）
- ✅ S2 训练跑通（2/10 epochs）
- ✅ S2 推理跑通（生成 5.12s 音频）
- ✅ 修复 train.js S2 配置缺失字段
- ✅ 整理根目录临时文件（141 个文件归档）
