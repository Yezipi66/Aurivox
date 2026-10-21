// 修复计划与执行：按缺失环节重跑。
module.exports = function register(router, ctx) {
 const { ASSETS_DIR, assetScanner, clientError, fs, loadVoices, path, requireApiKey, safeId, sanitizeCustomParams, trainingPipeline } = ctx;

router.post("/api/assets/:id/rebuild", requireApiKey, async (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const voiceDir = path.join(ASSETS_DIR, id);
 if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });

 const mode = (req.body && req.body.mode) || "safe";
 const reslice = !!(req.body && req.body.reslice);
 const skipAsr = !!(req.body && req.body.skipAsr);
 const execute = !!(req.body && req.body.execute);
 // Optional per-model retrain overrides from the restore modal. undefined = auto
 // (retrain only whichever model is missing); true/false = explicit force/skip.
 const bodyTrainS1 = req.body && req.body.trainS1;
 const bodyTrainS2 = req.body && req.body.trainS2;
 const trainS1 = bodyTrainS1 === undefined ? undefined : !!bodyTrainS1;
 const trainS2 = bodyTrainS2 === undefined ? undefined : !!bodyTrainS2;
 // Optional per-run overrides for slice / asr / training parameters, shaped like
 // the training pipeline's customParams: { training, steps: { slice|asr: { params } } }.
 // Run through the SAME whitelist + clamp as /api/train/start so the rebuild path
 // (a lighter pipeline that skips already-satisfied steps) shares one safety gate.
 const params = sanitizeCustomParams(req.body && req.body.params);

 try {
 const state = assetScanner.detectAssetState(id);
 const plan = assetScanner.planRebuild(state, { mode, reslice, skipAsr, trainS1, trainS2 });

 // Hard errors / nothing to do → report the plan as-is.
 if (plan.error) return res.status(400).json({ ok: false, state, ...plan });
 if (plan.noop) return res.json({ ok: true, state, ...plan });

 // Plan-only (default): caller confirms before any heavy work runs.
 if (!execute) {
 return res.json({ ok: true, state, executed: false, ...plan });
 }

 // No executable stages (e.g. safe mode deferred missing models): there is
 // nothing to run — surface the suggested follow-up instead of training.
 if (!plan.stages || plan.stages.length === 0) {
 return res.json({ ok: true, state, executed: false, ...plan });
 }

 // use_pretrained_base is not yet supported by the backend (Phase 4 backlog).
 if (plan.uses_pretrained_base) {
 return res.status(501).json({
 ok: false, state, ...plan,
 error: "Pretrained-base rebuild (emergency mode) is not implemented yet (backend-pending).",
 });
 }

 // Step 1: if the plan includes a standalone segments rebuild, run it inline
 // first. planRebuild only schedules this when slices+list already exist, so
 // it is always safe; it also provides segments.json as input for a following
 // preprocess/train stage (which reads it from the asset dir).
 let segResult = null;
 if (plan.needs_segments) {
 const seg = assetScanner.generateSegments(id);
 if (!seg || seg.ok === false) {
 return res.status(400).json({ ok: false, state, ...plan, error: (seg && seg.error) || "Failed to rebuild segments" });
 }
 const meta = assetScanner.scanVoiceDir(id, voiceDir);
 meta.segment_total = seg.matched; meta.segment_matched = seg.matched;
 try { fs.writeFileSync(path.join(voiceDir, "meta.json"), JSON.stringify(meta, null, 2)); } catch (e) { console.warn("[assets] failed to write meta.json:", e.message); }
 segResult = { total: seg.total, matched: seg.matched, missing: seg.missing };
 }

 // Step 2: if there are no pipeline stages, the segments rebuild was the whole
 // job — return now (lightweight, no training touched).
 if (!plan.stepOptions) {
 return res.json({ ok: true, state, executed: true, action: "generateSegments", ...segResult, ...plan });
 }

 // Step 3: hand off to the training pipeline. inputDir depends on whether we
 // are re-deriving slices from raw (needs the flat raw folder) or reusing the
 // existing slices/segments under the asset root. finalize carries forward any
 // core asset not regenerated this run, so existing models survive promote.
 const voices = loadVoices();
 const language = (voices[id] && voices[id].language) || "ja";
 const rawDir = path.join(voiceDir, "raw");
 const inputDir = plan.stepOptions.slice ? rawDir : voiceDir;
 if (plan.stepOptions.slice && !fs.existsSync(rawDir)) {
 return res.status(400).json({ ok: false, state, ...plan, error: "Re-slice requested but raw/ folder is missing." });
 }
 const pipeline = trainingPipeline.createPipeline({
 voiceId: id,
 language,
 inputDir,
 stepOptions: plan.stepOptions,
 customParams: params,
 });
 pipeline.start().catch(err => console.error("[REBUILD] Pipeline error:", err));
 return res.json({ ok: true, state, executed: true, action: "pipeline", taskId: pipeline.id, segments: segResult, ...plan });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

 return router;
};
