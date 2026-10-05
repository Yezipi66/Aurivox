# Aurivox 内部设计文档

> **TTS engine onboarding transition:** The former Engine Contract has been retired. Existing GPT-SoVITS and IndexTTS2 manifests are legacy implementation data, not templates for new engines. See `docs/ENGINE_ONBOARDING_STATUS.md`.


这里存放当前版本稳定化和未来 Workflow/Flow 方向的内部设计文档。

- [`ONBOARDING_PLAN.md`](./ONBOARDING_PLAN.md)：⭐ **引擎接入进度台账（进度的唯一真相）** —— 抽象层已建成什么、还欠哪几刀、下一刀是什么。**§2.6 = `installPlan.js` 为什么整体退役**；**§3c = 开发验证平台（Arc）现状与三笔环境事实**；**§4 = 2026-10-04 重排的下一刀**
- [`ENGINE_ADOPTION_FLOW.md`](./ENGINE_ADOPTION_FLOW.md)：⭐ **引擎接入流程 —— 当前设计**（2026-10-04 会话产出）—— 五步流程 · 第 3 步真下载 · 第 5 步三块独立显示 · 权重不再集中管理 · 权重自动发现 · 名片表单三件套 · 术语裁决。⚠️ 它只讲「该长什么样」，**进度看上一行那份**
- [`ENGINE_ONBOARDING_CONTRACT.md`](./ENGINE_ONBOARDING_CONTRACT.md)：引擎接入契约 v3 草案 —— **已实现行为的说明书**（为什么是这样），每条标 `[实测]`/`[读码]`
- [`../engines/_TEMPLATE/README.md`](../engines/_TEMPLATE/README.md)：⭐ **接一个新引擎的操作手册**（五步 + 写错了会怎样）。⚠️ **顶部有 2026-10-04 banner：五步顺序已被推翻、第 3 步整步作废**（`install-engine.cjs` 已退役），现行顺序见上一行的 `ENGINE_ADOPTION_FLOW.md`
- [`ENGINE_WIZARD_PLAN_v2.md`](./ENGINE_WIZARD_PLAN_v2.md)：⛔ **已归档作废**，被 `ENGINE_ADOPTION_FLOW.md` 取代。顶部有对照表说明它哪几节还成立 —— **留档是为了让「为什么改」可追，不是为了照着做**
- [`ENGINE_ONBOARDING_STATUS.md`](./ENGINE_ONBOARDING_STATUS.md)：引擎接入的**方向**（七条目标）与各自兑现情况；过程记在 `ONBOARDING_PLAN.md`
- [`FLOW-ARCH-001-DECISION.md`](./FLOW-ARCH-001-DECISION.md)：Workbench / Flow 产品边界与人工等待架构决策
- [`FLOW-ARCH-002-HUMAN-GATE-DECISION.md`](./FLOW-ARCH-002-HUMAN-GATE-DECISION.md)：Human Gate、Artifact Revision 与 Run Resume 契约
- [`FLOW-CORE-002B-EXECUTOR-SKELETON.md`](./FLOW-CORE-002B-EXECUTOR-SKELETON.md)：Journal Store 与 Executor 骨架边界
- [`FLOW-CORE-002C-PERSISTENCE-RETRY-HARDENING.md`](./FLOW-CORE-002C-PERSISTENCE-RETRY-HARDENING.md)：Journal / Retry / Input snapshot 硬化
- [`FLOW-CORE-003-LEGACY-SYNTHESIS-ADAPTER.md`](./FLOW-CORE-003-LEGACY-SYNTHESIS-ADAPTER.md)：Legacy synthesis 适配边界
- [`FLOW-CORE-003B-SYNTHESIS-SERVICE-EXTRACTION.md`](./FLOW-CORE-003B-SYNTHESIS-SERVICE-EXTRACTION.md)：Synthesis service 抽取边界
- [`FLOW-CORE-003B-DEBT-CONVERGENCE.md`](./FLOW-CORE-003B-DEBT-CONVERGENCE.md)：Executor 取消 / 重试副作用 / 运行时输入生命周期收敛（FLOW-D06 / D07 / D21）
- [`FLOW-CORE-004-LIVE-WIRING.md`](./FLOW-CORE-004-LIVE-WIRING.md)：Flow 内核首次接入运行进程 + **真实运行偏差清单**（含新债 FLOW-D27）
- [`FLOW-D10-INPUT-REBIND-CONTRACT.md`](./FLOW-D10-INPUT-REBIND-CONTRACT.md)：inputResolver 恢复对账契约（R1 冻结，§2 已实现 / §3 待 Artifact Store）
- [`FLOW-D10B-ARTIFACT-STORE-CONTRACT.md`](./FLOW-D10B-ARTIFACT-STORE-CONTRACT.md)：Artifact Store 只读取回契约（R1 冻结，只读切片已实现）
- [`FLOW-D26-LOCAL-AI-PATCH-REVIEW-2026-08-13.md`](./FLOW-D26-LOCAL-AI-PATCH-REVIEW-2026-08-13.md)：本地 AI D26 补丁审阅与修正（legacy artifact fingerprint / 身份）
- [`FLOW-D27-JOURNAL-PLAINTEXT-CONTRACT.md`](./FLOW-D27-JOURNAL-PLAINTEXT-CONTRACT.md)：**用户原文在 Flow 持久层中的留存（R3 冻结，唯一实现依据；五通道 / 七问已裁决 / 分阶段实施；R2 以探针实测推翻阶段 2 一条前提改为「值保真」，R3 以【实现实测】再推翻两条 —— resume 拆为三种能力、形状 B 一并移除通道 ② 持久化）**
- [`FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md`](./FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md)：D27 的 R0 草案与实测记录（**已被 R1 取代，不再是实现依据**）
- [`HEALTH-BASELINE-FLOW-2026-08-13.md`](./HEALTH-BASELINE-FLOW-2026-08-13.md)：Aurivox Flow 内核健康基线
- [`FLOW-TECH-DEBT-MATRIX-2026-08-13.md`](./FLOW-TECH-DEBT-MATRIX-2026-08-13.md)：技术债处理矩阵（fail-closed / warn-override / observe）
- ⛔ **已删除**：`FLOW-CORE-002B-LOCAL-AI-REVIEW-REPORT-2026-08-13.md`（交给本地 AI 的 002B 审阅报告）—— 索引里这条链接指向仓库根，**那个文件从来不在那儿**，[实测] 2026-10-04 复核时发现
- [`WORKFLOW_ARCHITECTURE.md`](./WORKFLOW_ARCHITECTURE.md)：整体架构与产品形态
- [`WORKFLOW_CONTRACT.md`](./WORKFLOW_CONTRACT.md)：Workflow JSON 契约
- [`ARTIFACT_AND_RUN_CONTRACT.md`](./ARTIFACT_AND_RUN_CONTRACT.md)：产物、运行和恢复契约
- [`NODE_AND_GATE_CONTRACT.md`](./NODE_AND_GATE_CONTRACT.md)：Node、Quality Gate 和资源策略
- [`TASK-1-WORKFLOW-CONTRACT.md`](./TASK-1-WORKFLOW-CONTRACT.md)：Task 1 范围和完成标准
- [`internal/INTERNAL-1.0.8-STABILIZATION.md`](./internal/INTERNAL-1.0.8-STABILIZATION.md)：1.0.8 内部稳定化计划
