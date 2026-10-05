# TTS Engine Onboarding Status

The former Engine Contract has been retired and is no longer an authoring or compatibility specification.

> 📍 **三份文档分工**：
> - 方向（本文）—— 要做成什么样
> - 进度 [`ONBOARDING_PLAN.md`](./ONBOARDING_PLAN.md) —— 现在在哪、下一刀是什么
> - 行为 [`ENGINE_ONBOARDING_CONTRACT.md`](./ENGINE_ONBOARDING_CONTRACT.md) —— 为什么是这样（每条标 `[实测]`/`[读码]`）
> - 怎么接 [`../engines/_TEMPLATE/README.md`](../engines/_TEMPLATE/README.md) —— 操作手册

GPT-SoVITS and IndexTTS2 remain supported through the current legacy integration path. Their existing manifests describe that implementation only and must not be copied as templates for new engines.

The replacement onboarding system will be designed around these goals:

- no routine modification of upstream TTS source code;
- separate engine source, runtime environment, and model storage;
- generated configuration drafts instead of hand-written duplicated fields;
- explicit human confirmation of semantic input and output bindings;
- strict validation plus real synthesis verification;
- dynamic frontend profiles;
- one invocation model shared by Workbench, API, and Flow.

Until the replacement schemas and tooling are frozen, there is no supported third-party self-service engine onboarding procedure.

## 这七条目标的当前兑现情况

> 每一条都标了证据来源。`[实测]` = 在开发机上跑出来的；`[读码]` = 从代码读的，**未实机验证**。

| 目标 | 状态 | 证据 |
|---|---|---|
| 不改上游源码 | ✅ 通用宿主 `lib/engines/host.py` 反射调用 | [实测] IndexTTS2 `LOCAL-CHANGES.md` 零改动 |
| 源码 / 环境 / 权重三者分离 | ⚠️ **源码 ✅ · 环境 ✅ · 权重 ⬜ 即将重排** | [实测] `engines/<id>/` · `.venv` 分离已成立；但**权重仍集中在 `models/tts/`（20G）**，而 Owner 2026-10-04 已定方向搬到 `engines/<id>/checkpoints/` ⇒ 见 ONBOARDING_PLAN **A6**（**必须分两步，GSV 那份等 C3**） |
| **生成配置草稿**而非手写重复字段 | ✅ **已兑现**（这份表当时写的是「⬜ 全仓库无 scaffold」）| [实测] `tools/scaffold-params.cjs`（22.5KB）+ `lib/engines/reflect_params.py`（15.6KB）；拿 IndexTTS2（人已手写 14 条）当标准答案：**漏 0、误排 0、类型 13/14 一致**。⚠️ 生成的是**草稿**：`min/max/label/only_when` 反射拿不到，仍要人核对（见 ONBOARDING_PLAN A1） |
| 人工确认语义输入输出绑定 | ✅ 名片即绑定：`call.bind` 三槽位 + `maps` 逐词声明 | [实测] |
| 严格校验 + **真实合成验证** | ✅ 前三道已做 · ⚠️ 第四道（内容）⬜ | [实测] 三道校验都有（A 级「出得了声」2026-09-29 已做）。⚠️ **但 A 级只查 WAV 有没有帧，查不出内容乱码** —— 实测有一段所有非空判据全绿而 FunASR 反查相似度只有 0.216。⇒ 「出得了声」≠「说得对」，后者平台今天没有判据（Owner 已定：接入向导的第 5 步降级成三块独立显示，ASR 那块延后 —— 见 ONBOARDING_PLAN **C4**） |
| 前端档案动态生成 | ✅ 界面完全按名片长 | [实测] 82 条真函数测试 |
| Workbench / API / Flow 共用一条调用 | ✅ 合成走同一服务；Flow 的 `io.engine` 节点强制 `engine_id` | [实测] |
