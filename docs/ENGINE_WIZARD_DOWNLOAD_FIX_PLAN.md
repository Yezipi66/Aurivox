# 第 3 步下载修复计划

> 状态：待实现  
> 日期：2026-10-07  
> 分支：`feat/env-isolation-gpu-detect`

---

## 1. 问题清单

| # | 问题 | 严重度 | 影响 |
|---|---|---|---|
| 1 | 下载子目录文件时报 `ENOENT` | 高 | 无法下载带子目录的文件（如 `qwen0.6bemo4-merge/model.safetensors`） |
| 2 | 仓库列显示纯文本，不是超链接 | 中 | 用户无法点击跳转到 HF/ModelScope 页面 |
| 3 | SHA-256 列对不存在的文件显示"未知" | 低 | 预期行为，但需要确认 |

---

## 2. 问题 1：下载报错 ENOENT

### 2.1 现象

```
下载失败： ENOENT: no such file or directory, open
'D:\Project\tts_broker_openai_compat\engines\index-tts\checkpoints\qwen0.6bemo4-merge\model.safetensors.tmp'
```

### 2.2 根因

`downloadFileFromUrl` 函数（`download.js:294`）只创建了 `checkpoints/` 目录：

```js
const dir = path.join(root, 'engines', String(id || ''), 'checkpoints')
const finalPath = path.join(dir, file.name)
// ...
fs.mkdirSync(dir, { recursive: true })  // 只创建 checkpoints/
```

但文件路径包含子目录 `qwen0.6bemo4-merge/`，所以 `checkpoints/qwen0.6bemo4-merge/` 目录不存在，写入 `.tmp` 文件时报 `ENOENT`。

### 2.3 修复方案

把 `mkdirSync` 的目标从 `dir` 改为 `path.dirname(finalPath)`：

```js
// 修复前
fs.mkdirSync(dir, { recursive: true })

// 修复后
fs.mkdirSync(path.dirname(finalPath), { recursive: true })
```

这样会创建文件所在的所有父目录，包括 `checkpoints/qwen0.6bemo4-merge/`。

### 2.4 改动文件

| 文件 | 行号 | 改动 |
|---|---|---|
| `core/download.js` | 294 | `fs.mkdirSync(dir, ...)` → `fs.mkdirSync(path.dirname(finalPath), ...)` |

### 2.5 验收点

| # | 验收项 | 判据 |
|---|---|---|
| 1 | 下载带子目录的文件 | `qwen0.6bemo4-merge/model.safetensors` 能成功下载 |
| 2 | 下载不带子目录的文件 | `config.yaml` 仍能正常下载 |
| 3 | 目录已存在时不会报错 | 重复下载同一文件不会报 `EEXIST` |

---

## 3. 问题 2：仓库列无超链接

### 3.1 现象

表格"仓库"列显示纯文本 `IndexTeam/IndexTTS-2.5`，无法点击跳转到 HF/ModelScope 页面。

### 3.2 根因

`StepsExtra.jsx:366` 只用了 `<code>` 标签：

```jsx
<td><code>{f.repo || ''}</code></td>
```

### 3.3 修复方案

改成 `<a>` 标签，根据 `f.tool` 判断是 HF 还是 ModelScope：

```jsx
<td>
  {f.repo ? (
    <a
      href={f.tool === 'modelscope'
        ? `https://modelscope.cn/models/${f.repo}`
        : `https://huggingface.co/${f.repo}`}
      target="_blank"
      rel="noreferrer"
    >
      {f.repo}
    </a>
  ) : t('(unknown)', '（未知）')}
</td>
```

### 3.4 改动文件

| 文件 | 行号 | 改动 |
|---|---|---|
| `editor/StepsExtra.jsx` | 366 | `<code>{f.repo}</code>` → `<a href={...}>{f.repo}</a>` |

### 3.5 验收点

| # | 验收项 | 判据 |
|---|---|---|
| 1 | HF 仓库显示超链接 | 点击 `IndexTeam/IndexTTS-2.5` 跳转到 `https://huggingface.co/IndexTeam/IndexTTS-2.5` |
| 2 | ModelScope 仓库显示超链接 | 点击 `OpenBMB/VoxCPM2` 跳转到 `https://modelscope.cn/models/OpenBMB/VoxCPM2` |
| 3 | 新窗口打开 | 链接在 `target="_blank"` 新窗口打开 |
| 4 | 无 repo 时显示"未知" | `f.repo` 为空时显示"（未知）" |

---

## 4. 问题 3：SHA-256 显示"未知"

### 4.1 现象

表格"SHA-256"列对不存在的文件显示"（未知）"。

### 4.2 根因

`checkFileStatus` 函数对不存在的文件返回 `sha256: null`，前端显示"未知"。

### 4.3 分析

这是**预期行为**——文件不存在时无法计算 SHA-256。但需要确认：

- 已存在的文件（✅ 重下）：显示实际 SHA-256（如 `b82c299ad0e975be...`）
- 不存在的文件（❌ 下载）：显示"未知"

### 4.4 修复方案

**保持现状**。如果用户希望显示 HF API 的 `blobId`，可以改，但 `blobId` 不是真实 SHA-256，会误导用户。

### 4.5 验收点

| # | 验收项 | 判据 |
|---|---|---|
| 1 | 已存在的文件显示实际 SHA-256 | ✅ 状态的文件显示 `b82c299ad0e975be...` |
| 2 | 不存在的文件显示"未知" | ❌ 状态的文件显示"（未知）" |

---

## 5. 实现顺序

1. 修复 `download.js` 的 `mkdirSync` 目标（问题 1）
2. 修复 `StepsExtra.jsx` 的仓库列超链接（问题 2）
3. 验证 SHA-256 显示逻辑（问题 3，可能不需要改）
4. 测试覆盖
5. 端到端验证

---

## 6. 测试覆盖

### 6.1 单元测试

| 测试文件 | 测试用例 |
|---|---|
| `test/download.node.test.js` | 下载带子目录的文件，验证目录创建 |
| `test/download.node.test.js` | 下载不带子目录的文件，验证目录已存在时不报错 |

### 6.2 端到端验证

| # | 验收项 | 判据 |
|---|---|---|
| 1 | 下载 `qwen0.6bemo4-merge/model.safetensors` | 成功下载，不报 `ENOENT` |
| 2 | 下载 `config.yaml` | 成功下载 |
| 3 | 点击仓库列超链接 | 跳转到 HF/ModelScope 页面 |
| 4 | 已存在的文件显示实际 SHA-256 | ✅ 状态的文件显示哈希 |
| 5 | 不存在的文件显示"未知" | ❌ 状态的文件显示"（未知）" |

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `path.dirname(finalPath)` 在某些边缘情况下可能返回空 | 加 `|| dir` 兜底 |
| 超链接在某些浏览器中可能被拦截 | 用 `target="_blank" rel="noreferrer"` |
