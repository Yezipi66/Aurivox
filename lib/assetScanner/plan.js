// 依赖图驱动的修复计划：只产出计划，不执行任何东西。切片与模型是两条独立分支，重建切片
// 不触发训练。训练成本高：safe 模式不排训练，要训练须显式指定 mode。

/**
 * 算出补齐缺失产物所需的最短阶段序列，尽量复用已有产物。state：R 原始音频、
 * S 切片、L 转写清单、Seg 分段、M 模型；options.mode 取 safe/full/emergency。
 */
function planRebuild(state, options = {}) {
 const { R, S, L, Seg, M } = state;
 const Ls = state.Ls ?? L;
 const Lr = state.Lr ?? false;
 const Mg = state.Mg ?? M;
 const Ms = state.Ms ?? M;
 const mode = options.mode || "safe";
 const reslice = !!options.reslice; // 即使不训练也强制重新切片
 const skipAsr = !!options.skipAsr; // 放弃转写（做成无参考文本的资产）
 const stages = [];
 const warnings = [];

 // 0) 没有任何可用素材：没有音频可参考，无从修复。
 if (!R && !S) {
 return { error: "No raw or slices available; re-import audio required", health: "No Refs", warnings };
 }

 // 先定模型分支：要不要重训决定切片必须是真切片（训练要干净的切段）还是用原始音频。
 // S1（GPT）与 S2（SoVITS）是独立两步，只重训缺失的那一个，或调用方用
 // options.trainS1 / options.trainS2 指定的那一个。
 const wantS1 = options.trainS1;
 const wantS2 = options.trainS2;
 const anyExplicit = wantS1 !== undefined || wantS2 !== undefined;

 let trainS1 = false;
 let trainS2 = false;
 let usePretrained = false; // emergency 模式用通用预训练底模顶替
 let modelsDeferred = false; // safe 模式不排训练
 if (!M || anyExplicit) {
 if (mode === "safe" && !anyExplicit) {
 modelsDeferred = true;
 warnings.push("Models missing; training is NOT scheduled in safe mode. Re-run with mode 'full' to retrain.");
 } else if (mode === "emergency") {
 usePretrained = true;
 warnings.push("Using a generic pretrained base model; output quality may be noticeably lower.");
 } else if (mode === "full" || anyExplicit) {
 trainS1 = wantS1 !== undefined ? !!wantS1 : !Mg;
 trainS2 = wantS2 !== undefined ? !!wantS2 : !Ms;
 if (!trainS1 && !trainS2 && !M) {
 warnings.push("No training selected but models are still missing; asset will remain incomplete.");
 }
 } else {
 return { error: `Unsupported repair mode: ${mode}`, warnings };
 }
 }
 const needTrain = trainS1 || trainS2;

 // 1) 切片：要么跳过（已有或不需要），要么真切；只有切片缺失且必须训练才切。
 let sliceMode = null;
 if (!S && (needTrain || reslice)) {
 if (!R) return { error: "Missing slices and no raw available; cannot slice", health: "No Refs", warnings };
 sliceMode = "slice";
 stages.push("slice");
 }

 // 下游用哪份音频：切片存在或将被产出时以切片为准，否则用原始音频。
 const willHaveSlices = S || sliceMode === "slice";
 const relevantList = willHaveSlices ? Ls : Lr;

 // 2) 转写清单：相关清单缺失、或刚（重新）切过片时跑 ASR。skipAsr 可放弃转写，但重训时 ASR
 // 强制执行（训练必须有配套转写）。
 const asrForced = needTrain && (!relevantList || !!sliceMode);
 let runAsr = (!relevantList || !!sliceMode);
 if (skipAsr && !asrForced) {
 runAsr = false;
 if (sliceMode) {
 warnings.push("ASR skipped: rebuilt clips will have no transcript (reference-text-free).");
 } else if (!relevantList) {
 warnings.push("ASR skipped: no transcript will be generated (reference-text-free).");
 }
 }
 if (runAsr && !stages.includes("asr")) stages.push("asr");

 // 3) 分段（派生）：ASR 步骤自己会重算分段，只有 ASR 不跑时才单排 generateSegments；没有
 // 转写就没有可比对的文本，整步跳过。
 const asrInPlan = stages.includes("asr");
 if (!Seg && !asrInPlan && relevantList) stages.push("generateSegments");

 // 4) 模型分支：preprocess 是 S1 与 S2 的共同前置，两步训练彼此独立。
 if (needTrain) stages.push("preprocess");
 if (trainS1) stages.push("train_s1");
 if (trainS2) stages.push("train_s2");
 if (usePretrained) stages.push("use_pretrained_base");

 if (stages.length === 0) {
 // safe 模式下有意推迟训练：不是「无事可做」，模型仍缺失。
 if (modelsDeferred) {
 return {
 health: "Missing Models",
 repairable: true,
 requires_confirmation: true,
 suggested_mode: "full",
 suggested_stages: ["preprocess", ...(!Mg ? ["train_s1"] : []), ...(!Ms ? ["train_s2"] : [])],
 warnings,
 };
 }
 return { noop: "already complete", health: "Complete", warnings };
 }

 // 映射成 pipeline 的 stepOptions。generateSegments 与 use_pretrained_base 在 pipeline 之外。
 // 任何产出数据的 pipeline 步骤之后必须跟 finalize+promote 才会落到 assets/<id>；finalize
 // 会把没重新生成的部分带过去，模型与切片才不会丢。
 const pipelineDataStages = stages.filter(s => ["slice", "asr", "preprocess", "train_s1", "train_s2"].includes(s));
 const stepOptions = pipelineDataStages.length === 0 ? null : {
 denoise: false,
 slice: stages.includes("slice"),
 asr: stages.includes("asr"),
 preprocess: stages.includes("preprocess"),
 train_s1: stages.includes("train_s1"),
 train_s2: stages.includes("train_s2"),
 finalize: true,
 promote: true,
 };

 return {
 stages,
 stepOptions,
 slice_mode: sliceMode,
 needs_segments: stages.includes("generateSegments"),
 uses_pretrained_base: stages.includes("use_pretrained_base"),
 requires_confirmation: stages.includes("train_s1") || stages.includes("train_s2"),
 warnings,
 };
}

module.exports = { planRebuild };
