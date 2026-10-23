// 角色修复：先算出补齐缺失产物所需的阶段，再按需执行。
// 计划由 lib/assetScanner/plan.js 的 planRebuild 产出，默认只返回计划不执行，
// 调用方确认后带 execute=true 再跑一次。
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
 // 每个模型单独指定的训练开关。undefined 表示由计划自行判断（只补缺失的模型），
 // true / false 表示显式指定训练或跳过。
 const bodyTrainS1 = req.body && req.body.trainS1;
 const bodyTrainS2 = req.body && req.body.trainS2;
 const trainS1 = bodyTrainS1 === undefined ? undefined : !!bodyTrainS1;
 const trainS2 = bodyTrainS2 === undefined ? undefined : !!bodyTrainS2;
 // 本次运行对切片、ASR、训练参数的覆盖，结构与训练管线的 customParams 相同：
 // { training, steps: { slice|asr: { params } } }。
 // 走与 /api/train/start 相同的白名单与取值夹取，两条路径共用一道安全闸。
 const params = sanitizeCustomParams(req.body && req.body.params);

 try {
 const state = assetScanner.detectAssetState(id);
 const plan = assetScanner.planRebuild(state, { mode, reslice, skipAsr, trainS1, trainS2 });

 // 硬错误或无事可做：按计划原样返回。
 if (plan.error) return res.status(400).json({ ok: false, state, ...plan });
 if (plan.noop) return res.json({ ok: true, state, ...plan });

 // 只出计划（默认）：调用方确认后才开始耗时的工作。
 if (!execute) {
 return res.json({ ok: true, state, executed: false, ...plan });
 }

 // 没有可执行的阶段（例如 safe 模式推迟了缺失的模型）：没有要跑的，
 // 返回计划里建议的后续动作，不进入训练。
 if (!plan.stages || plan.stages.length === 0) {
 return res.json({ ok: true, state, executed: false, ...plan });
 }

 // 后端尚未实现用预训练底模修复（emergency 模式）。
 if (plan.uses_pretrained_base) {
 return res.status(501).json({
 ok: false, state, ...plan,
 error: "Pretrained-base rebuild (emergency mode) is not implemented yet (backend-pending).",
 });
 }

 // 计划里含独立的分段重建时，先在这里跑：planRebuild 只在切片与清单都已存在时
 // 才排这一步，所以直接跑是安全的。分段结果会作为后续预处理与训练阶段的输入，
 // 那些阶段从资产目录读 segments.json。
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

 // 计划里没有管线阶段：整件事就是重建分段，到此返回，不碰训练。
 if (!plan.stepOptions) {
 return res.json({ ok: true, state, executed: true, action: "generateSegments", ...segResult, ...plan });
 }

 // 交给训练管线执行。输入目录取决于是否从原始音频重新切片：需要时用 raw 目录，
 // 否则用资产目录里已有的切片与分段。finalize 会把本次没有重新生成的核心资产
 // 一并带过去，已有模型因此不会被发布覆盖掉。
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
