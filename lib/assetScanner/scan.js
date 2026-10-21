// 扫盘：把角色目录读成 meta.json（含模型、参考文本、分段计数）。
// 磁盘布局的唯一约定在 lib/assets/modelLayout.js，本文件只按它读。
const fs = require("fs");
const path = require("path");
const { ASSETS_DIR, DEFAULT_LANGUAGE } = require("./consts");
const { scanVoiceModels, legacyDirsPresent, enginesWithModels, modelsRoot } = require("../assets/modelLayout");
const { TRAINING_ENGINE_ID, TRAINING_SLOTS } = require("../training/pipelineIdentity");
const { getAudioDuration } = require("./audioDuration");
const { atomicWriteFile } = require("./atomicWrite");
const { extractStep, inspectTranscriptList, buildSegmentsFor, generateSegments } = require("./transcript");

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
 voices[e.name] = scanVoiceDir(e.name, voiceDir);
 }
 }
 } catch (err) {
 console.error("[ASSETS] Error listing assets:", err.message);
 }
 return voices;
}

/**
 * 从已发布模型的文件名里反推语种。模型名形如 <id>_<lang>-e<epoch>.ckpt（GPT）
 * 与 <id>_<lang>_e<epoch>_s<step>.pth（SoVITS），语种 token 是 epoch 标记前一段。
 * 只用于找回丢失的 meta.language；已有的 meta.language 永远优先。
 * @returns 语种 token（如 "ja"、"en"、"zh"），认不出返回 null。
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
 // 扫这个角色 models/ 下所有引擎的所有权重位，文件名里带语种 token 的就认出来。
 // 两条正则沿用 GPT-SoVITS 的命名习惯：别的引擎匹配不上，只是这条恢复线对它无效。
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

// GPT-SoVITS 的版本标签是这台引擎的私货住在平台里，与「模型放在哪」是同一类毛病。
// 明确标签留着，但不许扩散到别处：它被限定在下面这两个函数里，
// 而它只给已扫出来的条目贴标签，不再决定「哪些文件算模型」（那由目录驱动的扫描管）。
// 这两个常量引用 lib/training/pipelineIdentity.js 那唯一一处声明，不许有两个来源各自主张。
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
 // 权重头非官方标记时的补救线：从文件名 version token 恢复版本。
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
 // 轮数：文件名里的 e<数字>。只是标签，取不到就没有。
 const st = extractStep(it.name);
 if (st != null) it.steps = st;
 if (engineId === _LEGACY_GSV_ENGINE_ID && slotName === _LEGACY_GSV_VERSION_SLOT && !it.is_dir) {
 it.version = detectSovitsVersion(it.path);
 }
 }
 }
 }
}

function scanVoiceDir(voiceId, voiceDir) {
 // 重扫只刷新 assets 清单与分段计数，不许把 display_name 或 language 重置回默认值：
 // 那两个字段是用户与训练管线写的，先读已有 meta.json 再继承下来。
 let prev = null;
 try {
 const prevPath = path.join(voiceDir, "meta.json");
 if (fs.existsSync(prevPath)) prev = JSON.parse(fs.readFileSync(prevPath, "utf-8"));
 } catch (e) {
 console.error(`[ASSETS] Could not read existing meta.json for ${voiceId}:`, e.message);
 }

 // 语种解析顺序（meta 优先）：已有 meta.language → 从模型文件名重建 → DEFAULT_LANGUAGE。
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

 // 转写的来源、修订号与校验状态跨重扫保留：用户手改过或已校验的转写不能被悄悄打回未知。
 if (prev && prev.transcript && typeof prev.transcript === "object") {
 meta.transcript = prev.transcript;
 }
 // 精修的来路同样跨重扫保留。
 if (prev && prev.refinement && typeof prev.refinement === "object") {
 meta.refinement = prev.refinement;
 }

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

 // segments.json 认切片也认纯原始音频：有转写清单却没有 segments.json 时自动生成。
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

 // 模型层纯目录驱动：有哪几台引擎看目录名，一台引擎有哪几个权重位也看目录名。
 // 平台从没听说过的引擎，它的模型照样扫得出来，这个函数一个字都不用改。
 meta.assets.models = scanVoiceModels(voiceDir);
 annotateLegacyGsvLabels(meta.assets.models);

 // 老结构目录还在而新目录还没建，与「这个角色本来就没有模型」在界面上长得一样（空下拉）。
 // 这种情况要明确报出来，不能静默。
 const legacy = legacyDirsPresent(voiceDir);
 if (legacy.length) {
 meta.assets.models_unmigrated = legacy;
 console.warn(
 `[ASSETS] ${voiceId}: 老结构目录还在（${legacy.join(", ")}），平台已不再从这里读模型。` +
 ` 跑一次 node tools/migrate-asset-models.js 把它们搬到 models/<引擎id>/<权重位>/ 下。`
 );
 }

 const refDir = path.join(voiceDir, "references");
 if (fs.existsSync(refDir)) {
 const files = fs.readdirSync(refDir).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f));
 meta.assets.references = files.map(f => ({
 name: f,
 path: path.join(refDir, f).replace(/\\/g, "/"),
 }));
 }

 // 参考文本只是建议，不是硬错误：没有它推理照样能跑。
 // 判「invalid」要看路径列是不是现代的 <sub>/<file> 形式，且这些文件确实存在；
 // 路径失效的清单只提示重新转写，不自动修。
 const rawStat = inspectTranscriptList(voiceDir, "raw", "raw_opt.list");
 const sliceStat = inspectTranscriptList(voiceDir, "slicer_opt", "slicer_opt.list");
 const anyInvalid = rawStat.status === "invalid" || sliceStat.status === "invalid";
 const rawOk = rawStat.status === "ok";
 const sliceOk = sliceStat.status === "ok";
 // 健康的来源优先：好的那份清单不能被另一份失效的清单盖掉。
 // 「invalid」只留给「还没有任何可用来源，同时确实有东西坏了」的情形。
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

function fullScan() {
 console.log("[ASSETS] Starting full scan...");
 const results = {};

 // 扫 assets 目录下的每个角色
 const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
 for (const e of entries) {
 if (!e.isDirectory()) continue;
 const voiceDir = path.join(ASSETS_DIR, e.name);

 // 一个角色目录坏了不许带累整次扫描：记下错误继续往下走。
 try {
 const meta = scanVoiceDir(e.name, voiceDir);

 // 重新生成 segments.json，并把计数回填到内存结果里，让接口返回的与写到磁盘的一致。
 const segResult = generateSegments(e.name);
 if (segResult && typeof segResult.matched === "number") {
 meta.segment_total = segResult.matched;
 meta.segment_matched = segResult.matched;
 }

 // 落盘这份 meta（display_name 与 language 由 scanVoiceDir 保留，assets 与分段计数在这里刷新）。
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
 * 检查角色目录里各类产物在不在，供修复计划用。
 * R = 原始音频
 * S = 切片（slicer_opt/*.wav）
 * L = 转写清单（asr_opt/slicer_opt.list 或 raw_opt.list）
 * Seg = 可用分段（segments.json 里 matched > 0）
 * M = GPT 与 SoVITS 两个权重位都在
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
 // 不是「这个角色有没有模型」：那与「模型在哪」不是一回事。
 // 引擎 id 与两个位名引用唯一那处声明（lib/training/pipelineIdentity.js），不在这里写字面量。
 // 目录得跟着搬，否则搬完家的角色会被判成「没训过」而重训一遍。
 const gsvSlot = (slot, re) =>
 hasFiles(path.join(modelsRoot(voiceDir), TRAINING_ENGINE_ID, slot), re);
 const Mg = gsvSlot(TRAINING_SLOTS.gpt.name, new RegExp(`\\${TRAINING_SLOTS.gpt.ext}$`, 'i'));
 const Ms = gsvSlot(TRAINING_SLOTS.sovits.name, new RegExp(`\\${TRAINING_SLOTS.sovits.ext}$`, 'i'));
 const M = Mg && Ms;

 return { R, S, L, Ls, Lr, Seg, M, Mg, Ms };
}

module.exports = { listVoiceAssets, deriveLanguageFromModels, detectSovitsVersion, annotateLegacyGsvLabels, scanVoiceDir, fullScan, detectAssetState };
