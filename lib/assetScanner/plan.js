// 依赖图驱动的修复计划：只产出计划，不执行任何东西。

/**
 * Dependency-graph-driven repair planner. Returns the SHORTEST set of stages
 * needed to fill missing artifacts, reusing whatever already exists. It only
 * produces a plan — it does NOT execute anything.
 *
 * Hard rules:
 * - segments and models are independent branches off {slices, list};
 * rebuilding segments must never trigger training.
 * - training is high-cost: in "safe" mode it is not scheduled (caller must
 * confirm / pass mode "full").
 *
 * @param {{R,S,L,Seg,M}} state
 * @param {{mode?: "safe"|"full"|"emergency"}} options
 * @returns {{stages?:string[], stepOptions?:object, warnings:string[],
 * requires_confirmation?:boolean, error?:string, noop?:string,
 * health?:string}}
 */
function planRebuild(state, options = {}) {
 const { R, S, L, Seg, M } = state;
 const Ls = state.Ls ?? L; // slicer_opt.list present
 const Lr = state.Lr ?? false; // raw_opt.list present
 const Mg = state.Mg ?? M; // GPT (S1) weights present
 const Ms = state.Ms ?? M; // SoVITS (S2) weights present
 const mode = options.mode || "safe";
 const reslice = !!options.reslice; // force REAL slicing even when not retraining
 const skipAsr = !!options.skipAsr; // user opts out of transcription (reference-text-free)
 const stages = [];
 const warnings = [];

 // 0) No usable source material at all → dead end (no audio to reference).
 if (!R && !S) {
 return { error: "No raw or slices available; re-import audio required", health: "No Refs", warnings };
 }

 // Decide the model branch first — whether we retrain affects whether slices
 // must be REAL slices (training wants clean cut clips) vs raw passthrough.
 // Per-model retrain flags. S1 (GPT) and S2 (SoVITS) are independent steps, so we
 // only retrain the model(s) that are actually missing — or whatever the caller
 // explicitly requests (options.trainS1 / options.trainS2, from the restore modal).
 const wantS1 = options.trainS1; // true | false | undefined(=auto)
 const wantS2 = options.trainS2;
 const anyExplicit = wantS1 !== undefined || wantS2 !== undefined;

 let trainS1 = false; // run S1 (GPT) training
 let trainS2 = false; // run S2 (SoVITS) training
 let usePretrained = false; // emergency placeholder
 let modelsDeferred = false; // safe mode: do not auto-train
 if (!M || anyExplicit) {
 if (mode === "safe" && !anyExplicit) {
 modelsDeferred = true;
 warnings.push("Models missing; training is NOT scheduled in safe mode. Re-run with mode 'full' to retrain.");
 } else if (mode === "emergency") {
 usePretrained = true;
 warnings.push("Using a generic pretrained base model; output quality may be noticeably lower.");
 } else if (mode === "full" || anyExplicit) {
 // Default: retrain only the missing model(s); explicit flags override.
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

 // 1) Slices — two states: skip (already present or not needed) / slice (real).
 // Passthrough is gone: if we don't slice, raw itself is the reference source.
 // We only slice when slices are missing AND we must train (training wants clean
 // cut clips) or the caller explicitly opts into reslicing.
 let sliceMode = null; // 'slice' | null
 if (!S && (needTrain || reslice)) {
 if (!R) return { error: "Missing slices and no raw available; cannot slice", health: "No Refs", warnings };
 sliceMode = "slice";
 stages.push("slice");
 }

 // Which audio source will this asset use downstream? Slices win when they exist or
 // will be produced; otherwise raw is the source. This selects the relevant list.
 const willHaveSlices = S || sliceMode === "slice";
 const relevantList = willHaveSlices ? Ls : Lr;

 // 2) Transcript list — run ASR if the relevant list is missing OR we just (re)sliced
 // (the old list no longer matches the new clips). The user may opt out (skipAsr)
 // to keep a reference-text-free asset, but training always needs a matching
 // transcript so ASR stays forced when retraining.
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

 // 3) Segments (derived). The ASR step regenerates segments itself; only schedule a
 // standalone generateSegments when ASR is NOT running (source audio + its list
 // already present, just segments missing). Without a transcript there is nothing
 // to match text against, so skip it entirely in reference-text-free runs.
 const asrInPlan = stages.includes("asr");
 if (!Seg && !asrInPlan && relevantList) stages.push("generateSegments");

 // 4) Model branch. preprocess feeds both S1 and S2; each model trains independently.
 if (needTrain) stages.push("preprocess");
 if (trainS1) stages.push("train_s1");
 if (trainS2) stages.push("train_s2");
 if (usePretrained) stages.push("use_pretrained_base");

 if (stages.length === 0) {
 // Models intentionally deferred in safe mode: not a no-op — still missing models.
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

 // Map to pipeline stepOptions. generateSegments + use_pretrained_base are handled
 // outside the pipeline. Any data-producing pipeline step (slice/asr/preprocess/
 // train) MUST be followed by finalize+promote to land changes in assets/<id>;
 // finalize carries forward whatever wasn't regenerated, so models/slices survive.
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
