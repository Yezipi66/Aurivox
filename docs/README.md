# Aurivox 内部设计文档

> **TTS engine onboarding transition:** The former Engine Contract has been retired. Existing GPT-SoVITS and IndexTTS2 manifests are legacy implementation data, not templates for new engines. See `docs/ENGINE_ONBOARDING_STATUS.md`.


这里存放当前版本稳定化和未来 Workflow/Flow 方向的内部设计文档。

- [`ONBOARDING_PLAN.md`](./ONBOARDING_PLAN.md)：⭐ **引擎接入进度台账（进度的唯一真相）** —— 抽象层已建成什么、还欠哪几刀、下一刀是什么。**§2.6 = `installPlan.js` 为什么整体退役**；**§3c = 开发验证平台（Arc）现状与三笔环境事实**；**§4 = 2026-10-04 重排的下一刀**
- [`ENGINE_ADOPTION_FLOW.md`](./ENGINE_ADOPTION_FLOW.md)：⭐ **引擎接入流程 —— 当前设计**（2026-10-04 会话产出）—— 五步流程 · 第 3 步真下载 · 第 5 步三块独立显示 · 权重不再集中管理 · 权重自动发现 · 名片表单三件套 · 术语裁决。⚠️ 它只讲「该长什么样」，**进度看上一行那份**
- [`ENGINE_ONBOARDING_CONTRACT.md`](./ENGINE_ONBOARDING_CONTRACT.md)：引擎接入契约 v3 草案 —— **已实现行为的说明书**（为什么是这样），每条标 `[实测]`/`[读码]`
- [`MULTILINGUAL_ROUTING.md`](./MULTILINGUAL_ROUTING.md)：**多语混说为什么成立** —— 切片→分片 g2p→拼一条→一次推理的四步、歧义只在汉字所以要基底语言、能混到多细，以及第 5 节登记的三处已知不齐。核对基线是 `dev`
- [`../engines/_TEMPLATE/README.md`](../engines/_TEMPLATE/README.md)：⭐ **接一个新引擎的操作手册**（五步 + 写错了会怎样）。⚠️ **顶部有 2026-10-04 banner：五步顺序已被推翻、第 3 步整步作废**（`install-engine.cjs` 已退役），现行顺序见上一行的 `ENGINE_ADOPTION_FLOW.md`
- [`ENGINE_WIZARD_PLAN_v2.md`](./archive/ENGINE_WIZARD_PLAN_v2.md)：⛔ **已归档作废**，被 `ENGINE_ADOPTION_FLOW.md` 取代。留档是为了让「为什么改」可追，不是为了照着做
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
- [`FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md`](./archive/FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md)：D27 的 R0 草案与实测记录（**已被 R1 取代，不再是实现依据**）
- [`HEALTH-BASELINE-FLOW-2026-08-13.md`](./HEALTH-BASELINE-FLOW-2026-08-13.md)：Aurivox Flow 内核健康基线
- [`FLOW-TECH-DEBT-MATRIX-2026-08-13.md`](./FLOW-TECH-DEBT-MATRIX-2026-08-13.md)：技术债处理矩阵（fail-closed / warn-override / observe）
- ⛔ **已删除**：`FLOW-CORE-002B-LOCAL-AI-REVIEW-REPORT-2026-08-13.md`（交给本地 AI 的 002B 审阅报告）—— 索引里这条链接指向仓库根，**那个文件从来不在那儿**，[实测] 2026-10-04 复核时发现
- [`WORKFLOW_ARCHITECTURE.md`](./WORKFLOW_ARCHITECTURE.md)：整体架构与产品形态
- [`WORKFLOW_CONTRACT.md`](./WORKFLOW_CONTRACT.md)：Workflow JSON 契约
- [`ARTIFACT_AND_RUN_CONTRACT.md`](./ARTIFACT_AND_RUN_CONTRACT.md)：产物、运行和恢复契约
- [`NODE_AND_GATE_CONTRACT.md`](./NODE_AND_GATE_CONTRACT.md)：Node、Quality Gate 和资源策略
- [`TASK-1-WORKFLOW-CONTRACT.md`](./TASK-1-WORKFLOW-CONTRACT.md)：Task 1 范围和完成标准

## archive/ —— 退役文档

这些文档描述的设计已被取代或推翻，**留着是为了让「为什么改」可追**，不是照着做的依据。
其中 E2E 两份记录了当时实测到的缺陷，改动同一区域时值得先翻一眼，看那个缺陷今天还在不在。

- [`archive/ENGINE_WIZARD_PLAN_v2.md`](./archive/ENGINE_WIZARD_PLAN_v2.md)：向导计划 v2，被 `ENGINE_ADOPTION_FLOW.md` 取代
- [`archive/ENGINE_ONBOARDING_E2E_INDEX-TTS.md`](./archive/ENGINE_ONBOARDING_E2E_INDEX-TTS.md)：2026-10-10 IndexTTS2 接入实测记录（含当时 4 条硬伤）
- [`archive/ENGINE_ONBOARDING_E2E_WIZARD.md`](./archive/ENGINE_ONBOARDING_E2E_WIZARD.md)：2026-10-10 向导第 3 步端到端实测记录
- [`archive/FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md`](./archive/FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md)：D27 的 R0 草案，被 R3 契约取代
- [`archive/SCOPE_r12c.md`](./archive/SCOPE_r12c.md)：目录重整 scope，已作废

### 2026-11-01 归档（本轮文档体检）

- [`archive/INTERNAL-1.0.8-STABILIZATION.md`](./archive/INTERNAL-1.0.8-STABILIZATION.md)：1.0.8 内部稳定化计划。它要求“不合并 `main`、不 push、不 release”，围绕 `work/1.0.8-stabilization` 集成分支；该分支已不在，远端 tag 仍停 `v1.0.7`，1.0.8 作为发布目标已搁置
- [`archive/P0_SPLIT_PLAN.md`](./archive/P0_SPLIT_PLAN.md)：拆分执行清单。它自述前提是“`server.js` 2217 行、`lib/engines/profile.js` 1334 行”，现在两个文件已是 248 / 320 行，清单不再指向真实工作
- [`archive/STEP4_FRONTEND_REWRITE_RFC.md`](./archive/STEP4_FRONTEND_REWRITE_RFC.md) / [`archive/STEP4_THREE_ZONES_IMPLEMENTATION_PLAN.md`](./archive/STEP4_THREE_ZONES_IMPLEMENTATION_PLAN.md) / [`archive/step4-three-zones-mockup.html`](./archive/step4-three-zones-mockup.html)：第 4 步三区重排方案与视觉稿。`tools/engine-wizard/editor/ManifestForm.jsx` 现为“两区：① 必填字段 ② 可选参数”，方案未按原文落地
- [`archive/PLATFORM_CAPABILITY_REPORT.md`](./archive/PLATFORM_CAPABILITY_REPORT.md)：2026-10-02/03 一次性平台实测报告，非现行设计依据
- [`archive/COPY_TONE_FINDINGS.md`](./archive/COPY_TONE_FINDINGS.md)：逐行待改清单（全仓 0 处引用）。规则本体仍在 `COPY_TONE_GUIDELINE.md`，且被 `tools/dev/` 脚本引用
- [`archive/ENGINE_ENV_DEFECTS_2026-10-09.md`](./archive/ENGINE_ENV_DEFECTS_2026-10-09.md) / [`archive/REFLECT_FIRST_RUN_2026-10-09.md`](./archive/REFLECT_FIRST_RUN_2026-10-09.md) / [`archive/ENGINE_ONBOARDING_RESEARCH_CONCLUSION.md`](./archive/ENGINE_ONBOARDING_RESEARCH_CONCLUSION.md) / [`archive/ENGINE_ONBOARDING_IMPLEMENTATION_PLAN.md`](./archive/ENGINE_ONBOARDING_IMPLEMENTATION_PLAN.md)：2026-10-09 反射调研链（环境缺陷 → 首次跑通 → 结论 → 提案）。结论已兑现为 A1；提案自述“Owner 审阅通过后才执行”，已不是执行依据
- [`archive/VOXCPM_COSYVOICE_ONBOARDING_REPORT.md`](./archive/VOXCPM_COSYVOICE_ONBOARDING_REPORT.md)：2026-10-11 可行性实测报告，结论已并入名片/向导口径

⛔ **已删除**（2026-10-23）：`ENGINE_WIZARD_DOWNLOAD_PLAN.md` / `ENGINE_WIZARD_DOWNLOAD_FIX_PLAN.md` /
`ENGINE_WIZARD_PERSISTENCE_PLAN.md` / `WEBUI-ANY-ENGINE-PLAN.md` ——
四份都是执行清单，所列事项已在代码中兑现（逐条核过），执行细节留在 git 历史里。
留着自称「待实现」而实际已完成的文档，比没有更坏。

## 维护约定

⛔ **过期文档比没有文档更坏** —— 2026-10-23 实测过一次：`ONBOARDING_PLAN.md` §3c 的
三笔环境事实停在 2026-10-04，被当成现状引用，结论全错。

- **本目录下的活文档，改动相关代码时顺手核对**，对不上就改文档，不许留着让它说错话。
- **自己写了「已完成 / 待实现」的，结项当天改**。状态写错一次，后面每个人都要重新核一遍。
- **文档开头标「最后核对日期」**，读者一眼能看出它说的哪天的事。
- **`docs/WIZARD_FIX_PLAN_DCABD.md` 与 `docs/ROOT_LAYOUT.md` 不参与归档**：前者是注释归位守卫的判据来源（`tools/engine-wizard/test/styleguard.node.test.js` 直接读它），后者是根目录准入表（`lib/root_layout.node.test.js` 读它）。搬走就等于把守卫废掉。
- **执行清单类文档做完就删**（细则在上面），**设计决策类才归档**。
