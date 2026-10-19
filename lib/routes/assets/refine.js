// 精调：从父角色的权重热启动，派生出一个新的角色。
const { HttpError, asyncHandler } = require("../../http/http");
const { slotDir } = require("../../assets/modelLayout");
const { TRAINING_ENGINE_ID, TRAINING_SLOTS } = require("../../training/pipelineIdentity");

module.exports = function register(router, ctx) {
 const { ASSETS_DIR, TRAIN_DATA_ROOT, assetId, assetScanner, clientError, collectTakenVoiceIds, crypto, fs, loadVoices, normalizeVersion, path, pickLatestByEpoch, requireApiKey, safeId, sanitizeCustomParams, trainingPipeline, versionFromName, withVoicesLock } = ctx;

 // Derive an asset's dominant concrete language (zh/ja/en) from its frozen
 // transcript — the per-line language tally of segments.json, falling back to the
 // ASR .list's language column. Returns null when nothing concrete can be found
 // (so the caller keeps "auto"). Used by reuse-refine to stop a Chinese/English
 // asset whose meta only says "auto" from being phonemised as Japanese.
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
  // segments.json 缺失或坏了 ⇒ 这次统计没有数据，下面退回 .list 那一列。
 }
 if (Object.keys(tally).length === 0) {
 // Fall back to the ASR .list (col 3 = language) when segments carry no lang.
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
  // 这一份 .list 读不动就试下一份；两份都不行 ⇒ 返回 null，调用方按「语言未知」处理。
 }
 }
 }
 let best = null, bestN = 0;
 for (const [l, n] of Object.entries(tally)) { if (n > bestN) { best = l; bestN = n; } }
 return best;
 };

 // Stage-2 service: validates + creates the refinement pipeline and returns a
 // JSON payload (sent as 200), or throws HttpError for any error response. It
 // never touches req/res — the thin handler below adapts it.
 const refineService = async (req) => {
 const parentId = req.params.id;
 if (!safeId(parentId)) throw new HttpError(400, "Invalid id");
 const parentDir = path.join(ASSETS_DIR, parentId);
 if (!fs.existsSync(parentDir)) throw new HttpError(404, `Voice '${parentId}' not found`);

 {
 // Refinement mode. S1 (GPT) and S2 (SoVITS) are independent steps, so the user can
 // refine either or both — exactly like the Restore flow's independent train toggles.
 // Canonical types: 's1' | 's2' | 's1+s2'. The refined step continues training from
 // the parent's published checkpoint; the un-refined step is reused verbatim.
 const rawType = String((req.body && req.body.refinement_type) || "s2").toLowerCase().replace(/\s+/g, "");
 const wantS1 = rawType === "both" || rawType.includes("s1");
 const wantS2 = rawType === "both" || rawType.includes("s2");
 if (!wantS1 && !wantS2) {
 throw new HttpError(400, "Select at least one model to refine (S1, S2, or both).",
 { code: "REFINE_TYPE_EMPTY" });
 }
 const refinementType = wantS1 && wantS2 ? "s1+s2" : wantS1 ? "s1" : "s2";

 // Two-mode refine:
 // reuse (default) — continue from the parent's frozen dataset (slice/ASR reused).
 // own — user brings a NEW audio folder; run the FULL pipeline on it, still
 // warm-starting from the parent's checkpoints. New data only; no merge.
 const useOwnData = !!(req.body && req.body.use_own_data);
 const rawInputDir = String((req.body && req.body.input_dir) || "").trim().replace(/^["']|["']$/g, "");
 // Explicit warm-start checkpoint filenames (optional; default = latest by epoch).
 const reqS1File = String((req.body && req.body.base_s1_file) || "").trim();
 const reqS2File = String((req.body && req.body.base_s2_file) || "").trim();

 // Own-data mode: validate the new audio folder up front (same rules as train/start).
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

 // Parent metadata: display name, language, version, lineage, transcript source.
 let pMeta = {};
 try { pMeta = JSON.parse(fs.readFileSync(path.join(parentDir, "meta.json"), "utf-8")); } catch (_) {
  // 父资产没有 meta.json（或坏了）⇒ 显示名退回 parentId，语言走下面的推导。
 }
 const parentDisplay = pMeta.display_name || parentId;
 // Language resolution (lineage-as-derivation model): the derived Voice inherits the
 // parent's language by default. Own-data refinement may explicitly declare a DIFFERENT
 // language for the new corpus (e.g. annealing a Japanese model on Chinese data → a
 // Chinese derivative) — that is just another branch in the refinement tree, so we
 // honour the client's language when provided. "auto" stays "auto" (never silently
 // coerced to a concrete language). No hard "ja" fallback anywhere.
 const VALID_LANGS = new Set(["auto", "ja", "zh", "en"]);
 const reqLang = String((req.body && req.body.language) || "").trim().toLowerCase();
 let language = (useOwnData && VALID_LANGS.has(reqLang))
 ? reqLang
 : (pMeta.language || "auto");
 // Reuse mode trains on the parent's FROZEN transcript, so its language must be
 // phonemised in the parent's OWN language. When the parent only declares "auto"
 // (or nothing), preprocess falls back to a 'ja' per-line default — which silently
 // mis-tokenises a Chinese/English asset's segments. Derive the dominant concrete
 // language from the parent's segments.json / ASR .list so Chinese segments are
 // carried through as Chinese instead of being read as Japanese.
 if (!useOwnData && (!language || language === "auto")) {
 const derived = deriveParentDominantLang(parentDir);
 if (derived) language = derived;
 }
 const parentVersion = normalizeVersion(pMeta.base_version || "v2");

 // Locate the parent's published checkpoints. Both are required for S2 refinement:
 // the S1 checkpoint is reused verbatim, the S2 checkpoint is the warm-start point.
 // 这一段是 GPT-SoVITS 的"从上一个角色继续练"（S1 原样复用、S2 热启动），
 // 引擎名是它自己的题目。⇒ 只是目录跟着当前结构走。
 const gptDir = slotDir(parentDir, TRAINING_ENGINE_ID, TRAINING_SLOTS.gpt.name);
 const sovDir = slotDir(parentDir, TRAINING_ENGINE_ID, TRAINING_SLOTS.sovits.name);
 const gptFiles = fs.existsSync(gptDir) ? fs.readdirSync(gptDir).filter(f => f.endsWith(".ckpt")) : [];
 const sovFiles = fs.existsSync(sovDir) ? fs.readdirSync(sovDir).filter(f => f.endsWith(".pth")) : [];
 if (gptFiles.length === 0 || sovFiles.length === 0) {
 throw new HttpError(400, "The selected Voice has no published S1/S2 checkpoints to refine from.",
 { code: "NO_CHECKPOINTS" });
 }
 // Warm-start selection. Honor an explicit filename when the user picked one in the
 // modal (must exist in the parent's checkpoint dir); otherwise default to latest epoch.
 let s1Pick;
 if (reqS1File && gptFiles.includes(reqS1File)) {
 s1Pick = { file: reqS1File, epoch: Number((reqS1File.match(/-e(\d+)\.ckpt$/i) || [])[1]) || null };
 } else if (reqS1File) {
 throw new HttpError(400, `S1 checkpoint not found: ${reqS1File}`, { code: "CKPT_NOT_FOUND" });
 } else {
 s1Pick = pickLatestByEpoch(gptFiles, /-e(\d+)\.ckpt$/i);
 }
 // Prefer an S2 model matching the parent version so the warm-start shape matches.
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

 // Resolve the base S2's TRUE version from the serialized file itself, NOT from
 // meta.base_version (older assets may lack it -> stale default 'v2'). savee()/
 // my_save2 replace the torch ZIP 'PK' magic with a 2-byte version tag
 // (v2Pro=b"05", v2ProPlus=b"06"); a plain v2 keeps 'PK'. If we train a v2Pro base
 // as plain "v2", s2_train builds the v2 architecture (no v2Pro SV-conditioning
 // path) while dim-alignment forces Pro dims -> a warm-start Frankenstein whose
 // published model produces SILENCE at inference. Header byte is authoritative;
 // fall back to the filename token, then meta's parentVersion.
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
 // v3/v4/lora header tags are out of scope here; keep parentVersion for those.
 } finally { fs.closeSync(_fd); }
 } catch (_) {
 baseS2Version = normalizeVersion(versionFromName(s2Pick.file) || "") || parentVersion;
 }

 // Hyper-parameters (validated). Accept the shared training-form shape (params.training,
 // produced by buildTrainingParams) so the refine flow exposes the same fields as the
 // Training/Restore panels; fall back to the legacy flat additional_epochs/learning_rate.
 const bodyParams = (req.body && req.body.params && typeof req.body.params === "object") ? req.body.params : {};
 const bt = (bodyParams.training && typeof bodyParams.training === "object") ? bodyParams.training : {};
 // Clamp to [1,100] to match sanitizeCustomParams' epoch bounds, so the recorded
 // refinement.additional_*_epochs never diverges from what actually gets trained.
 const clampEpochs = (v, dflt) => {
 const e = Math.round(Number(v));
 return (Number.isFinite(e) && e >= 1 && e <= 100) ? e : dflt;
 };
 // "Additional epochs" per step == the epochs to run this warm-started session.
 const s1Epochs = clampEpochs(bt.gpt_epochs, 8);
 const s2Epochs = clampEpochs(bt.sovits_epochs != null ? bt.sovits_epochs : (req.body && req.body.additional_epochs), 8);
 let learningRate = Number(
 (bt.learning_rate != null && bt.learning_rate !== "default") ? bt.learning_rate
 : (req.body && req.body.learning_rate)
 );
 if (!Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1) learningRate = 0.0001;
 // The value surfaced as the singular refinement.additional_epochs (back-compat):
 // the primary refined step's epoch count.
 const additionalEpochs = wantS2 ? s2Epochs : s1Epochs;

 // Lineage: original voice = generation 0 (no refinement field); each refinement
 // increments generation and preserves the ORIGINAL root across chains.
 const parentGen = Number(pMeta.refinement && pMeta.refinement.generation) || 0;
 const generation = parentGen + 1;
 const rootVoiceId = (pMeta.refinement && pMeta.refinement.root_voice_id) || parentId;

 // Default derived display name: "<parent> · <S1|S2|S1+S2> Refined <n>" (NEVER a
 // "v2" suffix, which collides with GPT-SoVITS model versions). <n> counts existing
 // children of THIS parent that share the same refinement_type.
 const typeLabel = refinementType === "s1+s2" ? "S1+S2" : refinementType === "s1" ? "S1" : "S2";
 let n = 1;
 try {
 for (const e of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
 if (!e.isDirectory()) continue;
 try {
 const m = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, e.name, "meta.json"), "utf-8"));
 if (m.refinement && m.refinement.parent_voice_id === parentId && m.refinement.refinement_type === refinementType) n += 1;
 } catch (_) {
  // 这个资产目录里没有可解析的 meta.json：不计入同类型编号。
 }
 }
 } catch (_) {
  // ASSETS_DIR 整个读不出来 ⇒ 编号停在 1，显示名仍然生成得出来。
 }
 const defaultName = `${parentDisplay} · ${typeLabel} Refined ${n}`;
 const displayName = String((req.body && req.body.display_name) || "").trim() || defaultName;

 // Freeze the training-data source (transcript provenance) at creation time so a
 // later edit to the parent's transcript can't retroactively change this run.
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
  // 冻结训练数据来源是尽力而为的：拿不到就把 transcriptSnapshot 留成 null，
  // 下游按「来源未知」处理，创建这次精调本身不受影响。
 }

 // Allocate + reserve a fresh id atomically, then seed the new asset directory.
 const newId = await withVoicesLock(async () => {
 const taken = collectTakenVoiceIds({ loadVoices, assetId, trainingPipeline });
 const id = assetId.allocateVoiceId(displayName, taken);
 assetId.reserve(id);
 return id;
 });

 const newDir = path.join(ASSETS_DIR, newId);
 // Only tag the checkpoint stem with a CONCRETE language ("auto" is not a real
 // language and must not leak into filenames).
 const stemLang = language && language !== "auto" ? language : "";
 const newStem = (!stemLang || new RegExp(`_${stemLang}$`, "i").test(newId)) ? newId : `${newId}_${stemLang}`;
 try {
 // Seed reference material from the parent so preprocess (audio) + finalize
 // (carry-forward) can build the derived asset without re-slicing/re-ASR.
 fs.mkdirSync(newDir, { recursive: true });
 const copyDir = (sub) => {
 const src = path.join(parentDir, sub);
 if (fs.existsSync(src)) fs.cpSync(src, path.join(newDir, sub), { recursive: true });
 };
 // Reuse mode only: seed the parent's frozen dataset so preprocess can run without
 // re-slicing/re-ASR. Own-data mode brings a NEW folder → full pipeline builds these.
 if (!useOwnData) {
 copyDir("slicer_opt");
 copyDir("raw");
 copyDir("asr_opt");
 const segSrc = path.join(parentDir, "segments.json");
 const segDst = path.join(newDir, "segments.json");
 if (fs.existsSync(segSrc)) {
 fs.copyFileSync(segSrc, segDst);
 } else {
 // Reuse without a pre-built segments.json: the parent may only carry raw (or
 // slices) + a reference-text .list. Build segments.json from that transcript
 // list so "raw + reference text" refines exactly like "raw + slices" — no ASR,
 // no re-slice. buildSegmentsFor resolves the list (slicer_opt/raw_opt) against
 // its audio and preserves each line's language.
 try {
 const built = assetScanner.buildSegmentsFor(parentDir, parentId);
 if (built && built.ok !== false && (built.matched || 0) > 0) {
 fs.writeFileSync(segDst, JSON.stringify(built, null, 2));
 }
 } catch (_) { /* fall through — preprocess surfaces the missing-transcript error */ }
 }
 }

 // Seed REUSED checkpoints under the NEW id stem (metadata rebuild is filename
 // driven — the derived asset's model files MUST carry the new id, not the parent).
 // finalize's carry-forward will publish whichever step is NOT retrained this run.
 // A refined step is intentionally NOT seeded — it produces a fresh checkpoint.
 if (!wantS1) {
 // S2-only mode: reuse the parent S1 verbatim.
 const s1EpochTok = (s1Pick.file.match(/-e(\d+)\.ckpt$/i) || [null, s1Pick.epoch])[1];
 const newGptDir = slotDir(newDir, TRAINING_ENGINE_ID, TRAINING_SLOTS.gpt.name);
 fs.mkdirSync(newGptDir, { recursive: true });
 fs.copyFileSync(baseS1Abs, path.join(newGptDir, `${newStem}-e${s1EpochTok}.ckpt`));
 }
 if (!wantS2) {
 // S1-only mode: reuse the parent S2 verbatim. Rebuild the filename under the
 // new stem so it matches finalize's mkSovitsName (<stem>_<ver>_e<n>_s<k>.pth).
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

 // base_s1/base_s2 are ABSOLUTE paths so the warm-start loader (train.js) can read
 // them directly; they also record the exact lineage on the derived asset's meta.
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
 // reuse = continue from parent's frozen dataset; own = user's new audio folder.
 data_mode: useOwnData ? "own" : "reuse",
 input_dir: useOwnData ? path.resolve(rawInputDir) : null,
 base_s1_file: s1Pick.file,
 base_s2_file: s2Pick.file,
 transcript_source: useOwnData ? "own_data" : (transcriptSnapshot ? transcriptSnapshot.source : null),
 transcript: useOwnData ? null : transcriptSnapshot,
 };

 // Own-data mode may carry slice/asr/denoise params (params.steps.{slice|asr|denoise}.params).
 const bodySteps = (bodyParams.steps && typeof bodyParams.steps === "object") ? bodyParams.steps : {};
 // Force the version to the base S2's REAL version (resolved from the file header,
 // not stale meta) so both the warm-start shapes AND the built architecture match.
 // Using parentVersion here could train a v2Pro base as plain "v2" -> silent model.
 // All other training fields flow through from the shared form (params.training).
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

 // Step plan:
 // reuse → preprocess → [train] → finalize → promote (slice/ASR reused from parent).
 // own → (denoise) → slice → ASR → preprocess → [train] → finalize → promote,
 // warm-started from the parent checkpoints. New data only, no merge.
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
 // Reuse mode reads its frozen dataset from the seeded derived dir (newDir),
 // where we just copied slicer_opt/raw/asr_opt and copied-or-BUILT segments.json.
 // preprocess reads inputDir/segments.json; audio still resolves via publishDir
 // (=newDir) in resolveAudioSource, so the built-from-list "raw + reference text"
 // case now finds its segments instead of failing on a missing segments.json.
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

 // Thin handler: delegates to the service. asyncHandler translates HttpError ->
 // res.status().json() and any other throw -> 500 via clientError, preserving
 // the original outer catch's `res.status(500).json({ error: clientError(err) })`.
 router.post("/api/assets/:id/refine", requireApiKey, asyncHandler(
 async (req) => refineService(req),
 (err) => { console.error("[REFINE] Error:", err); return clientError(err); },
 ));

 return router;
};
