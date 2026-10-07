# 第 3 步下载状态持久化 — 实现计划

> 状态：待实现  
> 日期：2026-10-07  
> 分支：`feat/env-isolation-gpu-detect`

---

## 1. 背景

当前第 2 步和第 3 步的下载状态（manifest、probeError、dedup）在切换页面或刷新时会丢失，用户需要重新嗅探仓库。需要将这些状态持久化到 localStorage，让用户体验更流畅。

---

## 2. 目标

1. 切换页面后 manifest 保留（不需要重新嗅探）
2. 刷新页面后 manifest 保留
3. probeError 保留（用户能看到之前的错误）
4. dedup 保留（记住用户偏好）
5. 不同引擎状态隔离

---

## 3. 范围

### 3.1 做

- 新增 `downloadState.js` 工具函数（localStorage 读写）
- 修改 `StepsExtra.jsx` 恢复/保存状态
- 测试覆盖

### 3.2 不做

- 不持久化临时状态（dlLive、dlTail、dlBusy、fileList）
- 不改动后端
- 不改动其他步骤

---

## 4. 改动文件

| 文件 | 改动 | 说明 |
|---|---|---|
| `editor/downloadState.js` | 新建 | localStorage 读写工具函数 |
| `editor/StepsExtra.jsx` | 修改 | 恢复/保存状态 |
| `test/downloadState.test.js` | 新建 | 测试覆盖 |

---

## 5. 预期效果

### 5.1 切换页面

1. 用户在第 3 步嗅探了 IndexTTS-2.5，看到文件列表
2. 用户切换到第 4 步写 manifest
3. 用户切回第 3 步
4. **文件列表还在**（不需要重新嗅探）

### 5.2 刷新页面

1. 用户在第 3 步嗅探了 IndexTTS-2.5，看到文件列表
2. 用户按 F5 刷新
3. **文件列表还在**（从 localStorage 恢复）

### 5.3 不同引擎隔离

1. 用户在第 3 步嗅探了 IndexTTS-2.5
2. 用户切换到另一个引擎
3. **显示另一个引擎的 manifest**（不是 IndexTTS-2.5 的）

---

## 6. 验收点

| # | 验收项 | 判据 |
|---|---|---|
| 1 | 切换页面后 manifest 保留 | 从第 3 步切换到第 4 步再回来，文件列表还在 |
| 2 | 刷新页面后 manifest 保留 | F5 刷新后，文件列表还在 |
| 3 | probeError 保留 | 嗅探失败后切换页面再回来，错误信息还在 |
| 4 | dedup 保留 | 取消去重后切换页面再回来，去重状态保持 |
| 5 | 不同引擎状态隔离 | 引擎 A 的 manifest 不会显示在引擎 B 里 |
| 6 | localStorage 容量 | manifest 不超过 5MB |

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| localStorage 被用户清除 | 状态丢失，但可重新获取 |
| manifest 过大 | 只存最近 10 个文件 |
| 跨域问题 | 向导和主站同域，无问题 |

---

## 8. 实现顺序

1. `editor/downloadState.js` — 新建工具函数
2. `editor/StepsExtra.jsx` — 恢复/保存状态
3. `test/downloadState.test.js` — 测试覆盖
4. 端到端验证 — 切换页面/刷新测试
