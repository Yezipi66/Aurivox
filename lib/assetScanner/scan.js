// 扫盘：把角色目录读成 meta.json（含模型、参考文本、分段计数）。
const fs = require("fs");
const path = require("path");
const { ASSETS_DIR, DEFAULT_LANGUAGE } = require("./consts");
const { scanVoiceModels, legacyDirsPresent, enginesWithModels, modelsRoot } = require("../assets/modelLayout");
const { TRAINING_ENGINE_ID, TRAINING_SLOTS } = require("../training/pipelineIdentity");
const { getAudioDuration } = require("./audioDuration");
const { atomicWriteFile } = require("./atomicWrite");
const { extractStep, inspectTranscriptList, buildSegmentsFor, generateSegments } = require("./transcript");

/**
 * Get all voice asset directories.
 */
function listVoiceAssets() {
 const voices = {};
 try {
 const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
 for (const e of entries) {
 if (!e.isDirectory()) continue;
 const voiceDir = path.join(ASSETS_DIR, e.name);
 const metaPath = path.join(voiceDir, "meta.json");
 if (fs.existsSync(metaPath)) {
 try {
 voices[e.name] = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
 } catch {
 voices[e.name] = { id: e.name, _metaError: true };
 }
 } else {
 // No meta.json — scan and generate
 voices[e.name] = scanVoiceDir(e.name, voiceDir);
 }
 }
 } catch (err) {
 console.error("[ASSETS] Error listing assets:", err.message);
 }
 return voices;
}

/**
 * Rebuild a voice's language from published model filenames. Models are named
 * `<id>_<lang>-e<epoch>.ckpt` (GPT) and `<id>_<lang>_e<epoch>_s<step>.pth`
 * (SoVITS), so the language token is the segment immediately before the epoch
 * marker. Used ONLY to recover a lost/missing meta.language — a present
 * meta.language always wins (fine-tuned metadata is first-truth).
 * Returns a lang token (e.g. "ja", "en", "zh") or null if none can be parsed.
 */
function deriveLanguageFromModels(voiceDir) {
 const probe = (dir, re) => {
 try {
 if (!fs.existsSync(dir)) return null;
 for (const f of fs.readdirSync(dir)) {
 const m = f.match(re);
 if (m) return m[1].toLowerCase();
 }
 } catch (_) {}
 return null;
 };
 // 不再按两个写死的目录找，改成把这个角色 models/ 下所有
 // 引擎的所有权重位都过一遍。文件名里带语言 token 的就认出来。
 // 这两条正则仍是 GPT-SoVITS 的命名习惯：但它们现在是捡到算赚：
 // 别的引擎的文件名匹配不上，只是这条恢复线对它无效，
 // 而真正的语言来源是 meta.language（训练管线写的），这里只是丢了才用。
 const dirs = [];
 for (const engineId of enginesWithModels(voiceDir)) {
 const engDir = path.join(modelsRoot(voiceDir), engineId);
 try {
 for (const e of fs.readdirSync(engDir, { withFileTypes: true })) {
 if (e.isDirectory()) dirs.push(path.join(engDir, e.name));
 }
 } catch (_) {}
 }
 for (const re of [/_([a-zA-Z]{2,3})-e\d+\.ckpt$/, /_([a-zA-Z]{2,3})_e\d+_s\d+\.pth$/]) {
 for (const d of dirs) {
 const hit = probe(d, re);
 if (hit) return hit;
 }
 }
 return null;
}

// ---------------------------------------------------------------------------
// 一笔明知而暂不还的账：GPT-SoVITS 的版本标签
// ---------------------------------------------------------------------------
//
// 下面这段（读 .pth 前 2 字节判版本、认不出按文件名 token、再认不出按文件大小
// 分三档）是一台引擎的私货住在平台里。它跟「模型放在哪」是同一类毛病。
//
// 明确标签留着，但现在不搬。
// 该去的地方是「像浏览器插件那样的扩展机制」：那是一件要单独设计的事，
// 现在为它开口子就是给自己挖坑。
// 所以：这段代码原样保留，数值一个不改；也不许把它扩散到别处。
// 它被限定在这一个函数里，将来扩展机制完善后，删掉这一个函数即可。
//
// 关键区别：这段代码现在只是给已经扫出来的条目贴标签，它不再决定
// 「哪些文件算模型」。后者已经交给纯目录驱动的扫描了。贴不上标签只是
// 少个小字，不会让任何模型从界面上消失。
// 这两个常量引用 lib/training/pipelineIdentity.js 那唯一一处声明：
// 它和这里说的是同一件事（「平台今天只有一条训练管线，它是 GPT-SoVITS
// 的形状」），不许有两个来源各自主张。
const _LEGACY_GSV_ENGINE_ID = TRAINING_ENGINE_ID;
const _LEGACY_GSV_VERSION_SLOT = TRAINING_SLOTS.sovits.name;

/** 读 .pth 前 2 字节版本头判断底模版本（与官方 process_ckpt 判定一致）。 */
function detectSovitsVersion(fp) {
 try {
 const fd = fs.openSync(fp, "r");
 const buf = Buffer.alloc(2);
 fs.readSync(fd, buf, 0, 2, 0);
 fs.closeSync(fd);
 const head = buf.toString("latin1");
 const map = { "00": "v1", "01": "v2", "02": "v3", "03": "v3", "04": "v4", "05": "v2Pro", "06": "v2ProPlus" };
 if (Object.prototype.hasOwnProperty.call(map, head)) return map[head];
 // 补救线（仅当权重头非官方标记时）：从文件名 version token 恢复版本。
 const _bn = path.basename(fp);
 if (/_v2ProPlus_/i.test(_bn)) return "v2ProPlus";
 if (/_v2Pro_/i.test(_bn)) return "v2Pro";
 if (/_v2_/i.test(_bn)) return "v2";
 // 传统 torch.save（zip，头为 'PK'）：按文件大小粗判
 const sz = fs.statSync(fp).size;
 if (sz < 82978 * 1024) return "v1";
 if (sz < 700 * 1024 * 1024) return "v2";
 return "v3";
 } catch (e) { return null; }
}

/**
 * 给扫出来的条目补两个只是给人看的小字：训练轮数、SoVITS 版本。
 * 全部 fail-open：贴不上就没有，不影响这个模型出现在候选里。
 */
function annotateLegacyGsvLabels(modelsByEngine) {
 if (!modelsByEngine || typeof modelsByEngine !== "object") return;
 for (const [engineId, slots] of Object.entries(modelsByEngine)) {
 for (const [slotName, items] of Object.entries(slots || {})) {
 for (const it of (items || [])) {
 // 轮数：文件名里的 e<数字>。 只是标签，取不到就没有。
 const st = extractStep(it.name);
 if (st != null) it.steps = st;
 if (engineId === _LEGACY_GSV_ENGINE_ID && slotName === _LEGACY_GSV_VERSION_SLOT && !it.is_dir) {
 it.version = detectSovitsVersion(it.path);
 }
 }
 }
 }
}

/**
 * Scan a single voice directory and build meta.json.
 */
function scanVoiceDir(voiceId, voiceDir) {
 // Preserve user-/pipeline-authored metadata across rescans. A fresh scan must
 // only refresh the `assets` inventory + segment counts — it must NOT reset
 // display_name or language back to defaults (Bug B/E). Read any existing
 // meta.json first and inherit those fields.
 let prev = null;
 try {
 const prevPath = path.join(voiceDir, "meta.json");
 if (fs.existsSync(prevPath)) prev = JSON.parse(fs.readFileSync(prevPath, "utf-8"));
 } catch (e) {
 console.error(`[ASSETS] Could not read existing meta.json for ${voiceId}:`, e.message);
 }

 // Language resolution order (meta is always first-truth):
 // 1. existing meta.language (fine-tuned/pipeline-written value) — never overridden
 // 2. rebuilt from a published model filename (<id>_<lang>-e… / <id>_<lang>_e…_s…)
 // — used only when meta is missing/lost or the field is absent
 // 3. DEFAULT_LANGUAGE fallback (legacy models with no language token)
 const rebuiltLang = prev?.language ? null : deriveLanguageFromModels(voiceDir);
 const resolvedLang = prev?.language || rebuiltLang || DEFAULT_LANGUAGE;

 const meta = {
 id: voiceId,
 display_name: prev?.display_name || voiceId,
 mode: prev?.mode || "internal",
 language: resolvedLang,
 prompt_lang: prev?.prompt_lang || resolvedLang,
 text_lang: prev?.text_lang || resolvedLang,
 created_at: prev?.created_at || new Date().toISOString(),
 assets: {},
 };

 // preserve transcript provenance across rescans (source + revision +
 // verification). A fresh scan must not silently reset a transcript the user
 // has hand-edited/verified back to an unknown state.
 if (prev && prev.transcript && typeof prev.transcript === "object") {
 meta.transcript = prev.transcript;
 }
 // Preserve refinement lineage so a rescan never drops it.
 if (prev && prev.refinement && typeof prev.refinement === "object") {
 meta.refinement = prev.refinement;
 }

 // 扫描 _publish/ 目录结构（唯一入库来源）
 // 不再自动从 GSV 输出目录导入：训练流程通过 promote 步骤写入

 // --- raw/ ---
 const rawDir = path.join(voiceDir, "raw");
 if (fs.existsSync(rawDir)) {
 const files = fs.readdirSync(rawDir).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f));
 let totalDur = 0;
 for (const f of files) {
 totalDur += getAudioDuration(path.join(rawDir, f));
 }
 meta.assets.raw = {
 dir: rawDir.replace(/\\/g, "/"),
 file_count: files.length,
 total_duration: Math.round(totalDur * 100) / 100,
 files: files,
 };
 }

 // --- slicer_opt/ ---
 const slicesDir = path.join(voiceDir, "slicer_opt");
 const segmentsFile = path.join(voiceDir, "segments.json");
 if (fs.existsSync(slicesDir)) {
 const files = fs.readdirSync(slicesDir).filter(f => /\.wav$/i.test(f));
 meta.assets.slices = {
 dir: slicesDir.replace(/\\/g, "/"),
 file_count: files.length,
 };
 if (fs.existsSync(segmentsFile)) {
 meta.assets.slices.segments_file = segmentsFile.replace(/\\/g, "/");
 }
 }

 // --- segments.json (source-aware; works for slice OR raw-only assets) ---
 // Auto-generate when a transcript list exists but segments.json doesn't.
 // buildSegmentsFor picks slicer_opt.list / raw_opt.list appropriately.
 if (!fs.existsSync(segmentsFile)) {
 try {
 const segData = buildSegmentsFor(voiceDir, voiceId);
 if (segData && segData.ok !== false) {
 atomicWriteFile(segmentsFile, JSON.stringify(segData, null, 2));
 meta.segment_total = segData.matched;
 meta.segment_matched = segData.matched;
 if (meta.assets.slices) meta.assets.slices.segments_file = segmentsFile.replace(/\\/g, "/");
 }
 } catch (segErr) {
 console.error(`[ASSETS] Auto-generate segments failed for ${voiceId}:`, segErr.message);
 }
 }

 // --- models/<引擎id>/<权重位>/ ------------------------------------------
 //
 // 这一层纯目录驱动：有哪几台引擎看目录名，一台引擎有哪几个权重位也看
 // 目录名。⇒ 一台平台从没听说过的引擎，它的模型照样扫得出来，
 // 这个函数一个字都不用改。磁盘约定的唯一定义处在 lib/assets/modelLayout.js。
 meta.assets.models = scanVoiceModels(voiceDir);
 annotateLegacyGsvLabels(meta.assets.models);

 // 还没搬家的角色要明确报出来。
 // 「老目录还在、新目录还没建」和「这个角色本来就没有模型」，
 // 在界面上长得一模一样（都是空下拉）：静默是这个仓库最难查的一种坏法。
 // 搬家工具：node tools/migrate-asset-models.js（默认空跑）。
 const legacy = legacyDirsPresent(voiceDir);
 if (legacy.length) {
 meta.assets.models_unmigrated = legacy;
 console.warn(
 `[ASSETS] ${voiceId}: 老结构目录还在（${legacy.join(", ")}），平台已不再从这里读模型。` +
 ` 跑一次 node tools/migrate-asset-models.js 把它们搬到 models/<引擎id>/<权重位>/ 下。`
 );
 }

 // --- references/ ---
 const refDir = path.join(voiceDir, "references");
 if (fs.existsSync(refDir)) {
 const files = fs.readdirSync(refDir).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f));
 meta.assets.references = files.map(f => ({
 name: f,
 path: path.join(refDir, f).replace(/\\/g, "/"),
 }));
 }

 // --- reference-text advisory (advisory only — NOT a hard error) ---
 // Reference TEXT is optional: inference works without it. This is a REAL check,
 // not just file existence: a list only counts when its path column is the modern
 // asset-relative form (<sub>/<file>) AND those files actually exist. Legacy/edited
 // lists with dead absolute paths are flagged "invalid → re-transcribe" (we do NOT
 // auto-repair; a normal training run never produces bad paths, so this only trips
 // on hand-edited/legacy data — the fix is simply to re-run ASR).
 const rawStat = inspectTranscriptList(voiceDir, "raw", "raw_opt.list");
 const sliceStat = inspectTranscriptList(voiceDir, "slicer_opt", "slicer_opt.list");
 const anyInvalid = rawStat.status === "invalid" || sliceStat.status === "invalid";
 const rawOk = rawStat.status === "ok";
 const sliceOk = sliceStat.status === "ok";
 // Priority: a HEALTHY source always wins. A good raw (or slices) list must never be
 // masked by a stale/invalid *other* list. Concretely: after the slices are removed
 // but a leftover slicer_opt.list lingers (text lines whose audio is gone → matched=0
 // → "invalid"), running "Generate reference text" on raw produces a valid raw_opt.list
 // ("ok"); we then report "raw" (yellow ◑), NOT "invalid" (red). "invalid" is reserved
 // for when NO source is usable yet SOMETHING is broken (real stale/hand-edited list).
 let state, advisory;
 if (rawOk && sliceOk) { state = "both"; advisory = null; }
 else if (rawOk) {
 state = "raw";
 advisory = sliceStat.status === "invalid"
 ? "Reference text present for raw audio. A leftover slices list is stale — re-slice + ASR to restore slice text."
 : "Reference text present for raw audio only.";
 }
 else if (sliceOk) {
 state = "slices";
 advisory = rawStat.status === "invalid"
 ? "Reference text present for slices. A leftover raw list is stale — re-run ASR on raw to restore raw text."
 : "Reference text present for slices only.";
 }
 else if (anyInvalid) {
 state = "invalid";
 const which = [rawStat.status === "invalid" && "raw", sliceStat.status === "invalid" && "slices"].filter(Boolean).join(" & ");
 advisory = `Reference-text paths look invalid (${which}) — likely legacy or hand-edited. Re-run ASR to regenerate.`;
 }
 else { state = "none"; advisory = "No reference text — inference still works; generating one is recommended."; }
 meta.reference_text = { state, raw: rawStat, slices: sliceStat, advisory };

 return meta;
}

/**
 * Full scan of all voice assets.
 */
function fullScan() {
 console.log("[ASSETS] Starting full scan...");
 const results = {};

 // Scan internal assets
 const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
 for (const e of entries) {
 if (!e.isDirectory()) continue;
 const voiceDir = path.join(ASSETS_DIR, e.name);

 // Per-voice error isolation (Bug D): a single corrupt/locked voice dir must
 // not abort the whole scan. Record the error and continue.
 try {
 const meta = scanVoiceDir(e.name, voiceDir);

 // Regenerate segments.json and backfill its counts into the in-memory
 // result so the API response matches what is written to disk (Bug A).
 // Previously generateSegments only updated the on-disk meta, leaving the
 // returned object without segment_total → frontend saw "No Segments" for
 // every voice until a manual refresh.
 const segResult = generateSegments(e.name);
 if (segResult && typeof segResult.matched === "number") {
 meta.segment_total = segResult.matched;
 meta.segment_matched = segResult.matched;
 }

 // Persist the corrected meta (display_name/language preserved by
 // scanVoiceDir, assets + segment_total refreshed here).
 try {
 const metaPath = path.join(voiceDir, "meta.json");
 fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
 } catch (e2) { /* best-effort: meta.json 只是缓存，上面返回的 meta 已是正确值；写盘失败只会在下次扫描时重算，不该让整个 voice 扫描失败 */ }

 results[e.name] = meta;
 } catch (voiceErr) {
 console.error(`[ASSETS] Scan failed for voice '${e.name}':`, voiceErr.message);
 results[e.name] = { id: e.name, display_name: e.name, _scanError: voiceErr.message };
 }
 }

 console.log(`[ASSETS] Scan complete. Found ${Object.keys(results).length} voices.`);
 return results;
}

/**
 * Inspect a voice directory and return the boolean presence of each asset
 * artifact used by the rebuild planner.
 * R = raw audio present
 * S = slices present (slicer_opt/*.wav)
 * L = ASR transcript list present (asr_opt/slicer_opt.list)
 * Seg = usable segments present (segments.json matched > 0)
 * M = both GPT and SoVITS models present
 */
function detectAssetState(voiceId) {
 const voiceDir = path.join(ASSETS_DIR, voiceId);
 const countWav = (dir) => {
 try { return fs.readdirSync(dir).filter(f => /\.wav$/i.test(f)).length; }
 catch { return 0; }
 };
 const hasFiles = (dir, re) => {
 try { return fs.readdirSync(dir).some(f => re.test(f)); }
 catch { return false; }
 };

 const R = countWav(path.join(voiceDir, "raw")) > 0
 || hasFiles(path.join(voiceDir, "raw"), /\.(wav|mp3|flac|m4a|ogg)$/i);
 const S = countWav(path.join(voiceDir, "slicer_opt")) > 0;
 const Ls = fs.existsSync(path.join(voiceDir, "asr_opt", "slicer_opt.list"));
 const Lr = fs.existsSync(path.join(voiceDir, "asr_opt", "raw_opt.list"));
 const L = Ls || Lr;
 let Seg = false;
 try {
 const segPath = path.join(voiceDir, "segments.json");
 if (fs.existsSync(segPath)) {
 const data = JSON.parse(fs.readFileSync(segPath, "utf-8"));
 Seg = (data.matched || 0) > 0;
 }
 } catch { Seg = false; }
 // 这里问的是训练管线的两个阶段各自出货了没（train_s1 / train_s2），
 // 不是「这个角色有没有模型」。今天平台只有 GPT-SoVITS 一条训练管线，
 // 所以这两问天然是它的形状：这跟「模型在哪」不是一回事，
 // 不用抽象掉；等第二条训练管线进来时它自己会带一份自己的判据。
 // 但目录得跟着搬，否则搬完家的角色会被判成「没训过」而重训一遍。
 // 引擎 id 与两个位名引用唯一那处声明（lib/training/pipelineIdentity.js），
 // 不在这里写字面量。语义一个字没变：变的是"谁在主张这件事"。
 const gsvSlot = (slot, re) =>
 hasFiles(path.join(modelsRoot(voiceDir), TRAINING_ENGINE_ID, slot), re);
 const Mg = gsvSlot(TRAINING_SLOTS.gpt.name, new RegExp(`\\${TRAINING_SLOTS.gpt.ext}$`, 'i'));
 const Ms = gsvSlot(TRAINING_SLOTS.sovits.name, new RegExp(`\\${TRAINING_SLOTS.sovits.ext}$`, 'i'));
 const M = Mg && Ms;

 return { R, S, L, Ls, Lr, Seg, M, Mg, Ms };
}

module.exports = { listVoiceAssets, deriveLanguageFromModels, detectSovitsVersion, annotateLegacyGsvLabels, scanVoiceDir, fullScan, detectAssetState };
