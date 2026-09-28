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
| 源码 / 环境 / 权重三者分离 | ✅ `engines/<id>/` · `.venv` · `models/tts/<id>/` | [实测] |
| **生成配置草稿**而非手写重复字段 | ⬜ **「生成」的那一半没有** | [实测] 全仓库无 scaffold |
| 人工确认语义输入输出绑定 | ✅ 名片即绑定：`call.bind` 三槽位 + `maps` 逐词声明 | [实测] |
| 严格校验 + **真实合成验证** | ⚠️ 前两道 ✅，**第三道「出得了声」⬜** | [实测] 唯一关键路径欠账 |
| 前端档案动态生成 | ✅ 界面完全按名片长 | [实测] 82 条真函数测试 |
| Workbench / API / Flow 共用一条调用 | ✅ 合成走同一服务；Flow 的 `io.engine` 节点强制 `engine_id` | [实测] |
