# voices.json 解耦重构任务清单

> 目标: 去除前端和后端对 voices.json 的依赖，改为直接从 assets/ 目录结构 + segments.json 推导数据。
> 原则: 从小到大，每一步独立可验证。

---

## Step 1: 新建 advanced_params.json + 后端接口 (最小改动)

**目标**: Advanced Settings 面板不再从 voices.json 读参数，改为读写独立的 advanced_params.json。

**状态: ✅ 已完成 (commit 72b43b0, 18cd92e)**

### 已完成:

- [x] 1.1 创建 `advanced_params.json` (项目根目录) — 扁平对象，不按角色区分
- [x] 1.2 后端新增 `GET /api/advanced-params` 和 `POST /api/advanced-params` (server.js)
- [x] 1.3 前端 GenerateTab: 高级参数从 `/api/advanced-params` 读，不再从 `selected?.xxx` 读
- [x] 1.4 前端 CompareTab: `defaultParams` 改为硬编码默认值
- [x] 1.5 生成成功后自动 POST 保存参数到 `/api/advanced-params`

### 关键决策:
- advanced_params.json 放在项目根目录，全局共享，不按角色区分
- 用户每次成功生成后自动保存，下次打开自动填入

---

## Step 2: Reference + Model 配置从 voices.json 解耦

**目标**: reference_audio/reference_text/gpt_model/sovits_model 不再从 voices.json 获取，改为从 assets/ 目录直接推导。voices.json 精简为纯注册信息。

**状态: ✅ 已完成 (commit e1e5088, 45bad13)**

### 已完成:

- [x] 2.1 `voices.json` 精简 — 只保留 `display_name`, `language`, `prompt_lang`, `text_lang`
  - 删掉: `reference_audio`, `reference_text`, `gpt_model`, `sovits_model`, `temperature`, `top_k`, `top_p`, `repetition_penalty`, `text_split_method`, `speed_factor`, `seed`
- [x] 2.2 后端 `/api/generate`: 用前端传的参数构建 cfg，不再从 voices.json 拿 reference/模型/高级参数
  - voices.json 只做注册检查 (voice 是否存在)
  - text_lang/prompt_lang fallback: 前端传 > voices.json > "ja"
- [x] 2.3 后端 `/v1/audio/speech`: 自己读 segments.json 拿 reference，读 meta.json 拿模型，读 advanced_params.json 拿高级参数
- [x] 2.4 后端 `/api/voices/:id/validate`: 检查 meta.json (模型) + segments.json (reference)，不再读 voices.json 的 reference 字段
- [x] 2.5 前端 GenerateTab: model selection 初始值不再从 `selected?.gpt_model` / `selected?.sovits_model` 读
- [x] 2.6 `autoRegisterVoice` (server.js) 精简 — 只写注册字段 (display_name, language, text_lang, prompt_lang)，不再写 gpt_model/reference_audio/temperature 等已删除的字段

### 关键决策:
- voices.json 保留注册功能 (id + display_name + language)，不删
- reference 完全从 segments.json 反查 (audio + text 天然配对)
- gpt_model / sovits_model 从 meta.json 的 checkpoints 列表让用户选

### 试错记录:

**错误做法:** Step 2 之后，scan/delete 不再调 `autoRegisterVoice`，也不更新 voices.json。
**后果:** scan 新角色后 generate 页面列表不更新；delete 角色后列表仍显示。
**原因:** voices.json 是注册文件，scan 写、delete 删、generate 读——这是正常的注册流程，跟解耦不矛盾。
**修正:** 恢复 scan/delete 的 `autoRegisterVoice` 调用，但只写注册字段。

---

## Step 3: Generate 页面 voice 列表从 assets 获取

**目标**: Generate 页面的 voice selector 不再从 voices.json 读列表，改为从 assets 目录扫描。

**状态: ✅ 已完成**

### 3.1 后端已有接口 (无需改动)

- `GET /api/assets` — 已存在，返回所有角色目录 + meta.json

### 3.2 前端改动 (App.jsx)

**App 根组件:**

- 保留现有的 `loadVoices()`，但改为从 `GET /api/assets` 拿数据
- voices 数组格式适配: `{ id, display_name, language }` 从 meta.json 取

**GenerateTab:**

- voice selector 的 option 显示 `display_name (id) [language]`
- 不再需要 `selected?.xxx` 读 voices.json 的字段 (已经在 Step 1 改掉了)

**验证:**
- 刷新页面，voice selector 应显示 platinum, Texas, Leizi
- 选不同角色，reference 列表跟着变

---

## Step 4: 清理 AssetsTab 对 voices.json 的写操作

**目标**: AssetsTab 不再往 voices.json POST/PUT。

**状态: ✅ 已完成 (commit 293ea77)**

### 4.1 前端改动 (App.jsx)

- [x] 简化 `handleSetAsVoice` — 只选中 voice 并切到 Generate 页面，不再写 voices.json
- [x] 简化 `handleUseAsReference` — 只选中 voice 并切到 Generate 页面，不再写 voices.json
- [x] 删掉 Import Asset 弹窗和相关代码
- [x] "Set as Voice" 按钮保留，功能改为选中 voice
- [x] "Use as Ref" 按钮保留，功能改为选中 voice
- [x] AssetsTab 只剩: Refresh, Scan All, Browse, Set as Voice, Delete

### 4.2 后端清理 (server.js)

暂不删 `/api/voices` 路由 — 保留供其他用途使用。

**验证:**
- AssetsTab 只剩资产管理功能
- Generate 页面仍正常工作 (voice 列表从 assets 来)

---

## Step 5: 删除 voices.json + 清理后端 voice CRUD

## Step 5: ~~删除 voices.json + 清理后端 voice CRUD~~

**状态: ❌ 不做 — voices.json 保留作为角色注册文件**

voices.json 继续承担角色注册信息的职责：
- key = 目录名（资产目录名）
- value = { display_name, language, prompt_lang, text_lang }
- scan all / scan 单个 / delete 时同步更新

---

## Step 6: 后端路由拆分 (可选/后续)

**状态: ❌ 未开始**

**状态: ❌ 未开始**

- `routes/assets.py` — asset CRUD + scan + segments
- `routes/generate.py` — /api/generate
- `routes/advanced_params.py` — /api/advanced-params
- `routes/openai.py` — /v1/audio/speech, /v1/models

> 注: 当前 server.js 是 Express.js，app.py 是 FastAPI。是否统一框架、怎么拆，到时候再定。

---

## 文件职责参考 (重构后)

| 文件 | 职责 | 读/写 |
|------|------|-------|
| `advanced_params.json` | 全局高级参数 (temperature, top_k 等) | 前端读写 |
| `assets/{id}/meta.json` | 角色资产元数据 (display_name, language, checkpoints) | 后端只读 |
| `assets/{id}/segments.json` | reference audio + text 配对 | 后端只读 |
| `voices.json` | 角色注册 (id + display_name + language) | scan/delete 写, generate 读 → Step 5 后删除 |
