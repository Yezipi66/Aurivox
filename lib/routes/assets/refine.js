// 精调：从父角色的权重热启动，派生出一个新的角色。
const { HttpError, asyncHandler } = require("../../http/http");
const { slotDir } = require("../../assets/modelLayout");
const { TRAINING_ENGINE_ID, TRAINING_SLOTS } = require("../../training/pipelineIdentity");

module.exports = function register(router, ctx) {
 const { ASSETS_DIR, TRAIN_DATA_ROOT, assetId, assetScanner, clientError, collectTakenVoiceIds, crypto, fs, loadVoices, normalizeVersion, path, pickLatestByEpoch, requireApiKey, safeId, sanitizeCustomParams, trainingPipeline, versionFromName, withVoicesLock } = ctx;

 // 从父角色冻结的转写里推导它的主要具体语言（zh/ja/en）：先数 segments.json 的逐行语言列，
 // 再退回 ASR .list 的语言列。推导不出来时返回 null，调用方保持 "auto"。
 // 用途是防止 meta 只写 "auto" 的中/英资产被按日语读。
 const deriveParentDominantLang = (parentDir) => {
 const tally = Object.create(null);
 const bump = (l) => {
 const v = String(l || "").trim().toLowerCase();
 if (v === "zh" || v === "ja" || v === "en") tally[v] = (tally[v] || 0) + 1;
 };
 try {
 const segPath = path.join(parentDir, "segments.json");
 if (fs.existsSync(segPath)) {
 const data = JSON.parse(fs.readFileSync(segPath, "utf-8"));
 for (const seg of (data.segments || [])) bump(seg && seg.lang);
 }
 } catch (_) {
 }
 if (Object.keys(tally).length === 0) {
 for (const name of ["slicer_opt.list", "raw_opt.list"]) {
 try {
 const lp = path.join(parentDir, "asr_opt", name);
 if (!fs.existsSync(lp)) continue;
 for (const raw of fs.readFileSync(lp, "utf-8").split("\n")) {
 const parts = raw.replace(/\r$/, "").trim().split("|");
 if (parts.length >= 4) bump(parts[2]);
 }
 if (Object.keys(tally).length) break;
 } catch (_) {
 }
 }
 }
 let best = null, bestN = 0;
 for (const [l, n] of Object.entries(tally)) { if (n > bestN) { best = l; bestN = n; } }
 return best;
 };

 // 校验并创建精调流水线，返回 JSON 负载（以 200 返回），出错抛 HttpError。
 // 不碰 req/res，由下面那个薄 handler 适配。
 const refineService = async (req) => {
 const parentId = req.params.id;
 if (!safeId(parentId)) throw new HttpError(400, "Invalid id");
 const parentDir = path.join(ASSETS_DIR, parentId);
 if (!fs.existsSync(parentDir)) throw new HttpError(404, `Voice '${parentId}' not found`);

 {
    // 精调哪一步：S1（GPT）与 S2（SoVITS）互相独立，可以只精调其中一步或两步都做。
    // 取值 's1' | 's2' | 's1+s2'。被精调的那一步从父角色发布的 checkpoint 继续训练，
    // 没被精调的那一步原样复用。
 const rawType = String((req.body && req.body.refinement_type) || "s2").toLowerCase().replace(/\s+/g, "");
 const wantS1 = rawType === "both" || rawType.includes("s1");
 const wantS2 = rawType === "both" || rawType.includes("s2");
 if (!wantS1 && !wantS2) {
 throw new HttpError(400, "Select at least one model to refine (S1, S2, or both).",
 { code: "REFINE_TYPE_EMPTY" });
 }
 const refinementType = wantS1 && wantS2 ? "s1+s2" : wantS1 ? "s1" : "s2";

    // 两种精调模式：
    // reuse（默认）：接着父角色冻结的数据集练（切片/ASR 直接复用）；
    // own：用户自带新音频目录，对它执行完整流水线，但仍然从父角色的 checkpoint 热启动。
    // 只用新数据，不合并。
 const useOwnData = !!(req.body && req.body.use_own_data);
 const rawInputDir = String((req.body && req.body.input_dir) || "").trim().replace(/^["']|["']$/g, "");
 const reqS1File = String((req.body && req.body.base_s1_file) || "").trim();
 const reqS2File = String((req.body && req.body.base_s2_file) || "").trim();

 if (useOwnData) {
 if (!rawInputDir) {
 throw new HttpError(400, "input_dir is required when use_own_data is set.", { code: "INPUT_DIR_REQUIRED" });
 }
 const resolved = path.resolve(rawInputDir);
 if (TRAIN_DATA_ROOT) {
 const root = path.resolve(TRAIN_DATA_ROOT);
 if (!resolved.startsWith(root + path.sep) && resolved !== root) {
 throw new HttpError(400, "input_dir must be under TRAIN_DATA_ROOT");
 }
 }
 if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
 throw new HttpError(400, "input_dir does not exist or is not a directory", { code: "INPUT_DIR_MISSING" });
 }
 }

 let pMeta = {};
 try { pMeta = JSON.parse(fs.readFileSync(path.join(parentDir, "meta.json"), "utf-8")); } catch (_) {
 }
 const parentDisplay = pMeta.display_name || parentId;
    // 语言解析（谱系即派生模型）：派生角色默认继承父角色的语言。
    // own 模式可以为新语料显式声明另一种语言（比如拿日语模型退火中文数据，得到中文派生角色），
    // 那只是精调树上的另一个分支，所以请求里给了语言就照用。
    // "auto" 保持 "auto"（绝不悄悄改成某个具体语言），任何地方都不写死 "ja"。
 const VALID_LANGS = new Set(["auto", "ja", "zh", "en"]);
 const reqLang = String((req.body && req.body.language) || "").trim().toLowerCase();
 let language = (useOwnData && VALID_LANGS.has(reqLang))
 ? reqLang
 : (pMeta.language || "auto");
    // reuse 模式练的是父角色冻结的转写，必须用父角色自己的语言做音素化。
    // 父角色只声明 "auto"（或什么都没写）时，preprocess 会退回逐行的 'ja' 默认，那会把
    // 中/英资产的片段静默切错。所以从父角色的 segments.json / ASR .list 推导主要具体语言。
 if (!useOwnData && (!language || language === "auto")) {
 const derived = deriveParentDominantLang(parentDir);
 if (derived) language = derived;
 }
 const parentVersion = normalizeVersion(pMeta.base_version || "v2");

    // 找父角色发布的 checkpoint。做 S2 精调两个都要：S1 的 checkpoint 原样复用，
    // S2 的 checkpoint 是热启动点。
 const gptDir = slotDir(parentDir, TRAINING_ENGINE_ID, TRAINING_SLOTS.gpt.name);
 const sovDir = slotDir(parentDir, TRAINING_ENGINE_ID, TRAINING_SLOTS.sovits.name);
 const gptFiles = fs.existsSync(gptDir) ? fs.readdirSync(gptDir).filter(f => f.endsWith(".ckpt")) : [];
 const sovFiles = fs.existsSync(sovDir) ? fs.readdirSync(sovDir).filter(f => f.endsWith(".pth")) : [];
 if (gptFiles.length === 0 || sovFiles.length === 0) {
 throw new HttpError(400, "The selected Voice has no published S1/S2 checkpoints to refine from.",
 { code: "NO_CHECKPOINTS" });
 }
    // 热启动选点：用户在弹窗里指定了文件名就用它（必须存在于父角色的 checkpoint 目录），
    // 否则默认取 epoch 最大的那个。
 let s1Pick;
 if (reqS1File && gptFiles.includes(reqS1File)) {
 s1Pick = { file: reqS1File, epoch: Number((reqS1File.match(/-e(\d+)\.ckpt$/i) || [])[1]) || null };
 } else if (reqS1File) {
 throw new HttpError(400, `S1 checkpoint not found: ${reqS1File}`, { code: "CKPT_NOT_FOUND" });
 } else {
 s1Pick = pickLatestByEpoch(gptFiles, /-e(\d+)\.ckpt$/i);
 }
 const sovSameVersion = sovFiles.filter(f => normalizeVersion(versionFromName(f) || "") === parentVersion);
 const s2Pool = sovSameVersion.length ? sovSameVersion : sovFiles;
 let s2Pick;
 if (reqS2File && sovFiles.includes(reqS2File)) {
 const sm = reqS2File.match(/_e(\d+)_s\d+\.pth$/i);
 s2Pick = { file: reqS2File, epoch: sm ? Number(sm[1]) : null };
 } else if (reqS2File) {
 throw new HttpError(400, `S2 checkpoint not found: ${reqS2File}`, { code: "CKPT_NOT_FOUND" });
 } else {
 s2Pick = pickLatestByEpoch(s2Pool, /_e(\d+)_s\d+\.pth$/i) || { file: s2Pool[0], epoch: null };
 }
 if (!s1Pick || !s2Pick || !s2Pick.file) {
 throw new HttpError(400, "Could not resolve parent S1/S2 checkpoint filenames.", { code: "CKPT_RESOLVE_FAILED" });
 }
 const baseS1Abs = path.join(gptDir, s1Pick.file);
 const baseS2Abs = path.join(sovDir, s2Pick.file);

    // 从序列化文件本身解析 base S2 的真实版本，不看 meta.base_version（老资产可能没写，
    // 落回过时的默认值 'v2'）。savee()/my_save2 把 torch ZIP 的 'PK' 魔数换成 2 字节版本标记
    // （v2Pro=b"05"，v2ProPlus=b"06"），普通 v2 仍是 'PK'。
    // 把 v2Pro 的底模当成普通 "v2" 来训，s2_train 会按 v2 结构建网络（没有 v2Pro 的
    // SV-conditioning 路径），而维度对齐又强行用 Pro 的维度，于是热启动出一个四不像，
    // 发布出来的模型推理时只有静音。头部字节是权威。
 let baseS2Version = parentVersion;
 try {
 const _fd = fs.openSync(baseS2Abs, "r");
 try {
 const _head = Buffer.alloc(2);
 fs.readSync(_fd, _head, 0, 2, 0);
 const _h = _head.toString("latin1");
 if (_h === "05") baseS2Version = "v2Pro";
 else if (_h === "06") baseS2Version = "v2ProPlus";
 else if (_h === "PK") baseS2Version = normalizeVersion(versionFromName(s2Pick.file) || "v2");
 } finally { fs.closeSync(_fd); }
 } catch (_) {
 baseS2Version = normalizeVersion(versionFromName(s2Pick.file) || "") || parentVersion;
 }

    // 超参（已校验）。接受共享训练表单的形状（params.training，由 buildTrainingParams
    // 产出），这样精调流程暴露的字段与 Training/Restore 面板一致；
    // 再退回旧的扁平 additional_epochs/learning_rate。
 const bodyParams = (req.body && req.body.params && typeof req.body.params === "object") ? req.body.params : {};
 const bt = (bodyParams.training && typeof bodyParams.training === "object") ? bodyParams.training : {};
    // 夹到 [1,100]，与 sanitizeCustomParams 的 epoch 上下界一致，这样记录下来的
    // refinement.additional_*_epochs 不会和实际训练跑的不是一个数。
 const clampEpochs = (v, dflt) => {
 const e = Math.round(Number(v));
 return (Number.isFinite(e) && e >= 1 && e <= 100) ? e : dflt;
 };
 const s1Epochs = clampEpochs(bt.gpt_epochs, 8);
 const s2Epochs = clampEpochs(bt.sovits_epochs != null ? bt.sovits_epochs : (req.body && req.body.additional_epochs), 8);
 let learningRate = Number(
 (bt.learning_rate != null && bt.learning_rate !== "default") ? bt.learning_rate
 : (req.body && req.body.learning_rate)
 );
 if (!Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1) learningRate = 0.0001;
    // 单独一个 refinement.additional_epochs 字段的值（兼容旧格式）：取被精调的那一步的轮数。
 const additionalEpochs = wantS2 ? s2Epochs : s1Epochs;

    // 谱系：原始角色是第 0 代（没有 refinement 字段），每次精调把代数加一，
    // 并在整个链条上保留最初的根角色。
 const parentGen = Number(pMeta.refinement && pMeta.refinement.generation) || 0;
 const generation = parentGen + 1;
 const rootVoiceId = (pMeta.refinement && pMeta.refinement.root_voice_id) || parentId;

    // 派生角色的默认显示名："<父角色> · <S1|S2|S1+S2> Refined <n>"
    // （绝不带 "v2" 后缀，那会和 GPT-SoVITS 的模型版本撞名）。
    // <n> 是这个父角色下、同类型精调子角色的个数。
 const typeLabel = refinementType === "s1+s2" ? "S1+S2" : refinementType === "s1" ? "S1" : "S2";
 let n = 1;
 try {
 for (const e of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
 if (!e.isDirectory()) continue;
 try {
 const m = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, e.name, "meta.json"), "utf-8"));
 if (m.refinement && m.refinement.parent_voice_id === parentId && m.refinement.refinement_type === refinementType) n += 1;
 } catch (_) {
 }
 }
 } catch (_) {
 }
 const defaultName = `${parentDisplay} · ${typeLabel} Refined ${n}`;
 const displayName = String((req.body && req.body.display_name) || "").trim() || defaultName;

    // 创建时冻结训练数据来源（转写出处），之后父角色的转写被改动也不能反过来改变这一次运行。
 let transcriptSnapshot = null;
 try {
 const listPath = path.join(parentDir, "asr_opt", "slicer_opt.list");
 const rawListPath = path.join(parentDir, "asr_opt", "raw_opt.list");
 const usedList = fs.existsSync(listPath) ? listPath : (fs.existsSync(rawListPath) ? rawListPath : null);
 const prov = (pMeta.transcript && typeof pMeta.transcript === "object") ? pMeta.transcript : {};
 let contentHash = null;
 if (usedList) {
 contentHash = crypto.createHash("sha256").update(fs.readFileSync(usedList)).digest("hex").slice(0, 16);
 }
 transcriptSnapshot = {
 source: prov.source || (usedList ? "machine_generated" : "unknown"),
 revision: prov.revision != null ? prov.revision : null,
 revised_at: prov.revised_at || null,
 content_hash: contentHash,
 list: usedList ? path.basename(usedList) : null,
 frozen_at: new Date().toISOString(),
 };
 } catch (_) {
  // 冻结训练数据来源是尽力而为的：拿不到就把 transcriptSnapshot 留成 null，下游按「来源未知」处理。
 }

 const newId = await withVoicesLock(async () => {
 const taken = collectTakenVoiceIds({ loadVoices, assetId, trainingPipeline });
 const id = assetId.allocateVoiceId(displayName, taken);
 assetId.reserve(id);
 return id;
 });

 const newDir = path.join(ASSETS_DIR, newId);
 const stemLang = language && language !== "auto" ? language : "";
 const newStem = (!stemLang || new RegExp(`_${stemLang}$`, "i").test(newId)) ? newId : `${newId}_${stemLang}`;
 try {
    // 从父角色复制参考素材，让 preprocess（音频）与 finalize（结转）不重新切片、
    // 不重新 ASR 就能建出派生资产。
 fs.mkdirSync(newDir, { recursive: true });
 const copyDir = (sub) => {
 const src = path.join(parentDir, sub);
 if (fs.existsSync(src)) fs.cpSync(src, path.join(newDir, sub), { recursive: true });
 };
 // 只有 reuse 模式复制父角色冻结的数据集，让 preprocess 不用重新切片/ASR。
 // own 模式带来的是新目录，这些由完整流水线自己建。
 if (!useOwnData) {
 copyDir("slicer_opt");
 copyDir("raw");
 copyDir("asr_opt");
 const segSrc = path.join(parentDir, "segments.json");
 const segDst = path.join(newDir, "segments.json");
 if (fs.existsSync(segSrc)) {
 fs.copyFileSync(segSrc, segDst);
 } else {
    // reuse 但父角色没有现成的 segments.json：它可能只有 raw（或切片）加一份参考文本 .list。
    // 用那份转写清单建出 segments.json，这样「raw + 参考文本」的精调和「raw + 切片」走得一样：
    // 不 ASR、不重新切片。buildSegmentsFor 会把清单对上音频，并保留每行的语言。
 try {
 const built = assetScanner.buildSegmentsFor(parentDir, parentId);
 if (built && built.ok !== false && (built.matched || 0) > 0) {
 fs.writeFileSync(segDst, JSON.stringify(built, null, 2));
 }
 } catch (_) { /* fall through — preprocess surfaces the missing-transcript error */ }
 }
 }

    // 被复用的 checkpoint 用新 id 前缀落盘（重建元数据是按文件名走的：派生资产的模型文件
    // 必须带新 id，不能带父角色的）。finalize 的结转会发布这次没有重训的那一步；
    // 被精调的那一步刻意不复制，它要产出新的 checkpoint。
 if (!wantS1) {
 const s1EpochTok = (s1Pick.file.match(/-e(\d+)\.ckpt$/i) || [null, s1Pick.epoch])[1];
 const newGptDir = slotDir(newDir, TRAINING_ENGINE_ID, TRAINING_SLOTS.gpt.name);
 fs.mkdirSync(newGptDir, { recursive: true });
 fs.copyFileSync(baseS1Abs, path.join(newGptDir, `${newStem}-e${s1EpochTok}.ckpt`));
 }
 if (!wantS2) {
    // S1-only 模式：父角色的 S2 原样复用。文件名按新前缀重建，
    // 与 finalize 的 mkSovitsName（<stem>_<ver>_e<n>_s<k>.pth）对得上。
 const sm = s2Pick.file.match(/_e(\d+)_s(\d+)\.pth$/i);
 const verTag = normalizeVersion(versionFromName(s2Pick.file) || baseS2Version) || baseS2Version;
 const newSov = sm
 ? `${newStem}${verTag ? "_" + verTag : ""}_e${sm[1]}_s${sm[2]}.pth`
 : `${newStem}${verTag ? "_" + verTag : ""}.pth`;
 const newSovDir = slotDir(newDir, TRAINING_ENGINE_ID, TRAINING_SLOTS.sovits.name);
 fs.mkdirSync(newSovDir, { recursive: true });
 fs.copyFileSync(baseS2Abs, path.join(newSovDir, newSov));
 }
 } catch (seedErr) {
 try { assetId.release(newId); } catch (_) {}
 try { fs.rmSync(newDir, { recursive: true, force: true }); } catch (_) {}
 throw seedErr;
 }

 // base_s1/base_s2 是绝对路径，热启动加载器（train.js）可以直接读；
 // 同时也把这次派生的谱系记到派生资产的 meta 上。
 const refinement = {
 refinement_type: refinementType,
 parent_voice_id: parentId,
 root_voice_id: rootVoiceId,
 generation,
 base_s1_checkpoint: baseS1Abs,
 base_s2_checkpoint: baseS2Abs,
 additional_epochs: additionalEpochs,
 additional_s1_epochs: wantS1 ? s1Epochs : null,
 additional_s2_epochs: wantS2 ? s2Epochs : null,
 learning_rate: learningRate,
 created_at: new Date().toISOString(),
 data_mode: useOwnData ? "own" : "reuse",
 input_dir: useOwnData ? path.resolve(rawInputDir) : null,
 base_s1_file: s1Pick.file,
 base_s2_file: s2Pick.file,
 transcript_source: useOwnData ? "own_data" : (transcriptSnapshot ? transcriptSnapshot.source : null),
 transcript: useOwnData ? null : transcriptSnapshot,
 };

 const bodySteps = (bodyParams.steps && typeof bodyParams.steps === "object") ? bodyParams.steps : {};
    // 版本强制取 base S2 的真实版本（从文件头解析，不看可能过时的 meta），这样热启动形状
    // 与建出来的网络结构都对得上。用 parentVersion 可能把 v2Pro 的底模当成普通 "v2" 来训，
    // 产出静音模型。其余训练字段一律从共享表单（params.training）透传。
 const safeCustom = sanitizeCustomParams({
 training: {
 ...bt,
 version: baseS2Version,
 versions: [baseS2Version],
 gpt_epochs: s1Epochs,
 sovits_epochs: s2Epochs,
 learning_rate: learningRate,
 },
 ...(useOwnData ? { steps: bodySteps } : {}),
 });

    // 步骤计划：
    // reuse → preprocess → [train] → finalize → promote（切片/ASR 复用父角色的）；
    // own → (denoise) → slice → ASR → preprocess → [train] → finalize → promote，
    // 仍然从父角色的 checkpoint 热启动。只用新数据，不合并。
 const rt = (req.body && req.body.steps && typeof req.body.steps === "object") ? req.body.steps : {};
 const stepOptions = useOwnData
 ? {
 denoise: !!rt.denoise,
 slice: rt.slice !== false,
 asr: rt.asr !== false,
 preprocess: true,
 train_s1: wantS1, train_s2: wantS2, finalize: true, promote: true,
 copyRaw: rt.copyRaw !== false,
 pauseAfterAsr: !!rt.pauseAfterAsr,
 pauseAfterDenoise: !!rt.denoise && !!rt.pauseAfterDenoise,
 ...(rt.asrGraceSec != null ? { asrGraceSec: rt.asrGraceSec } : {}),
 }
 : {
 denoise: false, slice: false, asr: false, preprocess: true,
 train_s1: wantS1, train_s2: wantS2, finalize: true, promote: true,
 copyRaw: false,
 };

 let pipeline;
 try {
 pipeline = trainingPipeline.createPipeline({
 voiceId: newId,
 displayName,
 language,
    // reuse 模式从刚播种好的派生目录（newDir）读冻结数据集，那里已经复制了
    // slicer_opt/raw/asr_opt，segments.json 也是复制或新建的。preprocess 读
    // inputDir/segments.json，音频仍由 resolveAudioSource 里的 publishDir（=newDir）解析，
    // 所以「raw + 参考文本」新建出来的情形也能找到片段，不会因缺 segments.json 而失败。
 inputDir: useOwnData ? path.resolve(rawInputDir) : newDir,
 stepOptions,
 customParams: safeCustom,
 refinement,
 });
 } catch (createErr) {
 try { assetId.release(newId); } catch (_) {}
 try { fs.rmSync(newDir, { recursive: true, force: true }); } catch (_) {}
 throw createErr;
 }

 pipeline.start().catch(err => console.error("[REFINE] Pipeline error:", err));
 console.log(`[REFINE] ${parentId} → ${newId} (${refinementType}${wantS1 ? " S1+" + s1Epochs + "ep" : ""}${wantS2 ? " S2+" + s2Epochs + "ep" : ""} lr=${learningRate}, gen ${generation})`);
 return {
 ok: true, taskId: pipeline.id, voiceId: newId, displayName,
 refinementType, parentVoiceId: parentId, rootVoiceId, generation,
 additionalS1Epochs: wantS1 ? s1Epochs : null,
 additionalS2Epochs: wantS2 ? s2Epochs : null,
 learningRate,
 baseS1Checkpoint: s1Pick.file, baseS2Checkpoint: s2Pick.file,
 dataMode: useOwnData ? "own" : "reuse",
 };
 }
 };

  // 薄 handler：转交给 service。asyncHandler 把 HttpError 翻译成 res.status().json()，
  // 其它异常经 clientError 变成 500。
 router.post("/api/assets/:id/refine", requireApiKey, asyncHandler(
 async (req) => refineService(req),
 (err) => { console.error("[REFINE] Error:", err); return clientError(err); },
 ));

 return router;
};
