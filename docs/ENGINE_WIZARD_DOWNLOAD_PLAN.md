# 第 3 步下载模型 — 实现计划

> 状态：进行中  
> 日期：2026-10-07  
> 分支：`feat/env-isolation-gpu-detect`

---

## 1. 背景

当前第 3 步的下载流程存在以下问题：

| 问题 | 现状 | 目标 |
|---|---|---|
| 大小/SHA-256 | 表格显示"(未知)" | 请求 HF/ModelScope API 获取 |
| 状态判断 | 只检查有没有同名文件 | 逐文件校验：存在 + 大小匹配 + SHA-256 匹配 |
| 断点续传 | 命令级别（整条命令成功/失败） | 文件级别（每个文件单独续传） |
| 半截文件 | 只判断 `size > 0` | 检测 `.tmp` 文件，支持 Range 续传或删掉重下 |
| 表格粒度 | 按仓库一行（如 IndexTeam/IndexTTS-2.5） | 按文件一行（每个 ckpt/onnx/bin 单独列出） |
| 下载命令 | 没有展示 | 平台只打印命令，不代下载 |
| 状态展示 | 文字 + badge | ✅已完成 / ⌛下载中 / ❌未下载（⚠️ emoji 破例，见下方说明） |

业内方案调研结论：**ModelScope SDK 的方案**最成熟 — `.tmp` 后缀 + 原子重命名 + SHA-256 校验 + Range 续传。

---

## ⚠️ emoji 破例说明

项目规范禁止在用户可见文案中使用 emoji 表语气。但 `✅已完成 / ⌛下载中 / ❌未下载` 是**一次使用 emoji 的破例**，理由：

1. **直观性**：用户能一眼看出下载状态，不需要读文字
2. **国际惯例**：下载器（IDM、FDM、Motrix 等）普遍用 emoji 表示状态
3. **语义明确**：✅/⌛/❌ 在下载场景下无歧义

代码注释里也要标注这是破例，避免后续维护者误以为可以随意使用 emoji。

---

## 2. 目标

1. 从 README 提取下载命令（已完成，保持不变）
2. 请求 HF/ModelScope API 获取**文件列表**（大小 + SHA-256）
3. **按文件**列出，每个文件一行（不是按仓库）
4. 逐文件校验状态：✅已完成 / ⌛下载中 / ❌未下载
5. 下载：`.tmp` 后缀 + Range 续传 + SHA-256 校验 + 原子重命名
6. 前端表格展示完整信息 + 三态状态
7. 展示下载命令（平台只打印，不代下载）

---

## 3. 范围

### 3.1 做

- 第 3 步下载模型的完整改造
- 新增 `/wizard/download/manifest` 端点（获取**文件列表**）
- 新增 `/wizard/download/file` 端点（单文件下载）
- `download.js` 新增文件级别下载逻辑
- `StepsExtra.jsx` 表格展示大小/SHA-256/状态（**按文件列出**）
- 展示下载命令（平台只打印，不代下载）
- 测试覆盖

### 3.2 不做

- 不改动第 1/2/4/5 步
- 不改动平台 `server.js`
- 不改动 `fieldmeta.js`（Owner 裁定保留不动）
- 不改动 `clone.js` 的 git 原话透传
- 不改动 `extractDownloadCommands` / `parseDownloadCmd`（已能处理 IndexTTS 和 VoxCPM）

---

## 4. 改动文件

| 文件 | 改动 | 说明 |
|---|---|---|
| `core/download.js` | 新增 `downloadFile` | 文件级别下载：`.tmp` 后缀 + Range 续传 + SHA-256 校验 + 原子重命名 |
| `core/download.js` | 新增 `fetchRemoteManifest` | 请求 HF/ModelScope API 获取文件列表（大小 + SHA-256） |
| `core/download.js` | 新增 `checkFileStatus` | 三态判断：✅已完成 / ⌛下载中 / ❌未下载 |
| `core/wizardbridge.js` | 新增 `/wizard/download/manifest` | 返回**文件列表** + 大小 + SHA-256 |
| `core/wizardbridge.js` | 新增 `/wizard/download/file` | 单文件下载（SSE 流式） |
| `editor/StepsExtra.jsx` | 表格展示 | **按文件列出**，大小/SHA-256/状态 + 续传/重下按钮 + 下载命令展示 |
| `test/download.node.test.js` | 新增测试 | 状态判断 + 断点续传 + SHA-256 校验 |

---

## 5. 预期效果

### 5.1 第 2 步（嗅探）

```
GET /wizard/download/manifest?id=xxx&repo=IndexTeam/IndexTTS-2.5
→
{
  ok: true,
  files: [
    { name: "config.yaml", size: 1234, sha256: "abc123...", status: "missing" },
    { name: "model.bin", size: 1073741824, sha256: "def456...", status: "partial" },
    { name: "tokenizer.json", size: 5678, sha256: "ghi789...", status: "ok" }
  ]
}
```

### 5.2 第 3 步（下载）

- 点击"下载"→ 写入 `.tmp` → 校验 → 原子重命名
- 半截文件 → 显示"续传"按钮（Range 请求）或"删掉重下"按钮
- 下载完成后自动刷新状态

### 5.3 前端表格（按文件列出）

| 模型名字 | 仓库链接 | 大小 | SHA-256 | 状态 |
|---|---|---|---|---|
| config.yaml | IndexTeam/IndexTTS-2.5 | 1.2 KB | abc123... | ❌未下载 |
| model.bin | IndexTeam/IndexTTS-2.5 | 2.1 GB | def456... | ⌛下载中 |
| tokenizer.json | IndexTeam/IndexTTS-2.5 | 5.7 KB | ghi789... | ✅已完成 |

### 5.4 下载命令展示

平台只打印命令，不代下载：

```
hf download IndexTeam/IndexTTS-2.5 --local-dir=checkpoints
```

---

## 6. 验收点

| # | 验收项 | 判据 |
|---|---|---|
| 1 | IndexTTS README 提取 | 能提取 `hf download IndexTeam/IndexTTS-2.5` 和 `modelscope download --model IndexTeam/IndexTTS-2.5` |
| 2 | VoxCPM README 提取 | 能提取 `snapshot_download("OpenBMB/VoxCPM2", local_dir='...')` |
| 3 | HF API 请求 | `GET https://huggingface.co/api/models/{repo}` 返回文件列表 |
| 4 | ModelScope API 请求 | `GET https://modelscope.cn/api/v1/models/{repo}` 返回文件列表 |
| 5 | 状态判断 | 正式文件存在 + 大小匹配 + SHA-256 匹配 → `ok`；`.tmp` 存在 → `partial`；都不存在 → `missing` |
| 6 | 断点续传 | `.tmp` 文件存在时，发送 `Range: bytes=<size>-` 请求 |
| 7 | SHA-256 校验 | 下载完成后计算 SHA-256 并与远端比对 |
| 8 | 原子写入 | 下载完成后 `.tmp` → 正式文件重命名 |
| 9 | 前端表格 | 显示模型名/仓库/大小/SHA-256/状态 |
| 10 | 前端三态 | 已下载（绿）/ 未下载（黄）/ 半截（橙） |
| 11 | 测试覆盖 | `test/download.node.test.js` 覆盖状态判断 + 断点续传 + SHA-256 |

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| HF/ModelScope API 请求慢 | 只在第 2 步做一次，不阻塞下载 |
| SHA-256 计算慢（大文件） | 只在下载完成后做一次，显示进度 |
| 平台不支持 Range 请求 | 检测 `Accept-Ranges` 头，不支持则删掉重下 |
| API 返回的 SHA-256 格式不一致 | HF 返回 hex，ModelScope 返回 base64，需要统一 |
| 大文件下载超时 | 设置合理超时（2 小时），支持断点续传 |

---

## 8. 实现顺序

1. `core/download.js` — 新增 `fetchRemoteManifest` / `checkFileStatus` / `downloadFile`
2. `core/wizardbridge.js` — 新增 `/wizard/download/manifest` / `/wizard/download/file` 端点
3. `test/download.node.test.js` — 测试覆盖
4. `editor/StepsExtra.jsx` — 前端表格 + 三态展示
5. 端到端验证 — 用 IndexTTS 和 VoxCPM 实测
