# 代码修复复盘 — 给本地 Agent 的学习材料

本次修复了三个回归 Bug，涉及 4 个文件。请逐条对照"根因 → 修复 → 你为什么会犯错 → 以后怎么避免"来学习。
**重点不是记住这次的改动，而是理解你犯错的模式，避免重蹈覆辙。**

---

## 改动文件清单

| 文件 | 改了什么 |
|------|----------|
| `server.js` | ① `/api/generate` 的 cfg 补 `id`；② `clientError` 不再吞错误；③ `/tts` 报错解析引擎 message；④ 加参考音频前置检查 |
| `lib/training/steps/train.js` | S1/S2 `save_every` 统一用参数，默认 4 |
| `web/src/App.jsx` | "Save Every N Epochs" 默认值 1→4，标注作用于 S1+S2 |
| `lib/assetScanner.js` | `scanVoiceDir` 保留并持久化用户元数据 |

---

## 问题 ①：推理报 400 / 前端卡在 Generating（最严重）

### 根因（两处叠加）
1. **`/api/generate` 构造 `cfg` 时漏了 `id` 字段。**
   `buildTtsPayload()` 的自动参考音频逻辑是：
   ```js
   const segFile = path.join(ASSETS_DIR, cfg.id || cfg.voiceId || "", "segments.json");
   ```
   `cfg.id` 为 `undefined` → 路径变成 `ASSETS_DIR/""/segments.json` → 文件不存在 → 参考音频为空 →
   引擎 `check_params()` 直接返回 `400 {"message":"ref_audio_path is required"}`。
   GPU 占用为 0，正是因为引擎在**参数校验阶段**就拒了，根本没进入推理。

2. **`clientError()` 把真实错误吞掉了。** 原代码：
   ```js
   if (!sanitized || sanitized.length > 200 || sanitized !== msg) return fallback;
   ```
   只要错误信息里含有路径（被打码后 `sanitized !== msg`），就整条丢弃，返回笼统的
   "Internal server error"。于是用户和你都"不知道为什么"。

### 修复
- `cfg` 增加 `id: voice, voiceId: voice` → 自动参考音频恢复。
- `clientError` 改为：打码路径但**保留信息主体**，只在为空时才回退。
- `generateOneSegment` 在调用引擎前**前置检查** `ref_audio_path`，为空就抛出中文明确提示；
  引擎返回 4xx 时解析其 JSON 的 `message`/`Exception` 字段再抛出。

### ⚠️ 你为什么会犯错 / 以后怎么避免
- **教训 1：跨函数的"隐式契约"必须显式满足。** `buildTtsPayload` 依赖 `cfg.id`，
  你在重构 `/api/generate` 时只搬运了"看得见"的字段，漏掉了下游函数依赖的字段。
  **改一个函数前，先 grep 它调用的所有下游函数，列出它们读取了 cfg 的哪些 key，逐一核对。**
- **教训 2：永远不要让错误处理把根因吞掉。** 日志/返回给用户的错误信息，宁可冗长也不要
  "贴心地"简化成一句笼统话。**调试信息的价值 > 美观。** 脱敏只该打码敏感片段，不该删掉整条。
- **教训 3：失败要快、要清晰（fail fast, fail loud）。** 能在本地校验出的错误（如参考音频为空），
  就不要甩给下游引擎去报一个晦涩的 400。在最早能发现问题的地方拦截并给出可操作提示。

---

## 问题 ②：训练时每个 epoch 都存一个模型文件

### 根因
`train.js` 里 SoVITS 配置**硬编码**：
```js
s2Config.train.save_every_epoch = 1;   // ← 写死，无视用户设置
```
而 S1 虽然读了参数，但默认值也是 1。前端有"Save Every N Epochs"输入框，
值却只传给了 S1、对 S2 完全无效。

### 修复
- S2 改为 `Math.max(1, Number(trainCfg.save_every_n_epoch) || 4)`。
- S1 同步用同一参数，默认 4。
- 前端默认值 1→4，标签注明"(S1+S2)"，让用户知道这个值同时控制两个阶段。
- 现在训练 20 epoch → 只存 5 个权重文件（每 4 个 epoch 存一次）。

### ⚠️ 你为什么会犯错 / 以后怎么避免
- **教训 4：暴露了 UI 参数，就必须打通整条链路。** 你加了前端输入框，却没把它接到 S2。
  **"暴露一个参数"的定义是：前端 → 后端 payload → 配置文件 → 训练脚本，端到端验证生效，
  而不是只摆一个控件。** 加参数后，必须 grep 这个参数名在整个仓库出现的所有位置，确认每一处都用上了。
- **教训 5：警惕硬编码常量。** `= 1` 这种魔法数字旁边如果存在一个同名的可配置参数，
  几乎一定是 Bug。提交前搜索硬编码的赋值，问自己"这个值是不是应该来自配置？"

---

## 问题 ③：Scan All 不再更新/会重置元数据

### 根因
`scanVoiceDir()` 每次都用**全新的默认值**重建 meta：
```js
const meta = { id: voiceId, display_name: voiceId, language: "ja", ... };
```
- 它**不读旧的 meta.json** → 用户设置的 display_name、language 被重置为默认（全部变 "ja"）。
- 它**也不写回 meta.json** → 扫描结果没有持久化，文件内容和扫描脱节。

### 修复
- 扫描前**先读取已存在的 meta.json**，保留 `display_name / language / prompt_lang / text_lang / created_at`。
- 扫描结束**原子写回 meta.json**，让磁盘文件真实反映最新扫描结果。

### ⚠️ 你为什么会犯错 / 以后怎么避免
- **教训 6：区分"派生数据"和"用户数据"。** checkpoints/segments 是从磁盘派生的，每次扫描重算没问题；
  但 display_name/language 是**用户输入的**，绝不能在扫描时被覆盖。
  **重建一个对象前，先问：里面哪些字段是用户的劳动成果？那些必须 merge 保留，不能 reset。**
- **教训 7：读-改-写要完整。** 你写了"扫描"却没有"写回"，等于只做了一半。
  涉及持久化的操作，确认 read → modify → write 三步都在。

---

## 给你（本地 Agent）的通用工作准则

1. **改动前先建立完整心智模型**：grep 出相关函数/参数的所有引用，理解数据如何流动，再动手。
   不要"看到哪改哪"。
2. **每次改源码后，至少做语法校验**：JS 用 `node --check <file>`，前端改完跑 `cd web && npm run build`。
   像本次的 `batchSize is not defined`（上一轮的 Bug）和参数没接通，`npm run build` 都能当场暴露。
3. **端到端验证，而不是单点验证**：加了参数/接口，必须从 UI 点一遍到最终生效，
   不能只看"代码写上了"。
4. **不要吞错误、不要硬编码、不要重置用户数据**——这是本次三个 Bug 的共同教训。
5. **小步提交 + 可回滚**：大改动开分支，跑通再合并；关键里程碑打 tag。
   你每次都 commit 是对的，但要确保 commit 的是**验证过能跑**的状态，否则历史里全是坏版本，回滚也没用。

> 一句话总结你这次的问题模式：**只完成了"代码层面看起来对"，没有完成"端到端真的能跑"。**
> 编程的交付标准是后者，不是前者。
