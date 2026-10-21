// 从 GPT-SoVITS 输出目录按 slicer_opt.list 导入角色素材。
const fs = require("fs");
const path = require("path");
const { ASSETS_DIR, GSV_PATHS } = require("./consts");
const { getWavDuration } = require("./audioDuration");
const { atomicWriteFile } = require("./atomicWrite");
const { parseSlicerOptList } = require("./transcript");
const { scanVoiceDir } = require("./scan");

/**
 * Import voice assets from a GPT-SoVITS output directory using slicer_opt.list.
 * Reads the list file, copies/symlinks raw audio and slices into the assets directory,
 * and generates segments.json.
 *
 * @param {string} voiceId - voice ID (e.g. "platinum")
 * @param {string} gsvBase - GPT-SoVITS root directory
 * @param {object} opts - { rawSrc, slicesSrc, listSrc } optional overrides
 */
function importFromList(voiceId, gsvBase, opts = {}) {
 const voiceDir = path.join(ASSETS_DIR, voiceId);
 if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });

 // Find slicer_opt.list for text mapping
 const listSrc = opts.listSrc || path.join(voiceDir, "asr_opt", "slicer_opt.list");

 // Parse text mapping from slicer_opt.list
 let textMap = {}; // { filename → text }
 if (fs.existsSync(listSrc)) {
 const listContent = fs.readFileSync(listSrc, "utf-8");
 const listEntries = parseSlicerOptList(listContent);
 for (const e of listEntries) {
 textMap[e.sliceFile] = e.text;
 }
 console.log(`[ASSETS] Using slicer_opt.list: ${Object.keys(textMap).length} entries`);
 } else {
 // Fallback: try GPT-SoVITS engine's slicer_opt.list
 const gsvListSrc = path.join(gsvBase, "output", "asr_opt", "slicer_opt.list");
 if (fs.existsSync(gsvListSrc)) {
 const listContent = fs.readFileSync(gsvListSrc, "utf-8");
 const listEntries = parseSlicerOptList(listContent);
 for (const e of listEntries) {
 textMap[e.sliceFile] = e.text;
 }
 // Copy list to assets, rewriting paths
 const newListPath = path.join(voiceDir, "asr_opt", "slicer_opt.list");
 fs.mkdirSync(path.dirname(newListPath), { recursive: true });
 const rewrittenLines = listContent.split("\n").map(line => {
 if (!line.trim()) return line;
 const parts = line.split("|");
 if (parts.length < 4) return line;
 const filename = path.basename(parts[0].trim());
 parts[0] = `assets/${voiceId}/slicer_opt/${filename}`;
 return parts.join("|");
 });
 fs.writeFileSync(newListPath, rewrittenLines.join("\n"), "utf-8");
 console.log(`[ASSETS] Using GPT-SoVITS slicer_opt.list: ${Object.keys(textMap).length} entries (paths rewritten)`);
 } else {
 throw new Error(`No slicer_opt.list found for ${voiceId}`);
 }
 }

 // Determine source directories
 const rawSrc = opts.rawSrc || path.join(GSV_PATHS.noSlice);
 const slicesSrc = opts.slicesSrc || path.join(gsvBase, "output", "slicer_opt");

 // Create asset subdirectories
 const rawDir = path.join(voiceDir, "raw");
 const slicesDir = path.join(voiceDir, "slicer_opt");
 fs.mkdirSync(rawDir, { recursive: true });
 fs.mkdirSync(slicesDir, { recursive: true });

 // Scan actual slicer_opt files and copy
 let importedRaw = 0;
 let importedSlices = 0;

 if (fs.existsSync(slicesSrc)) {
 const srcFiles = fs.readdirSync(slicesSrc).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f));
 for (const f of srcFiles) {
 // Only copy files that belong to this voice (by textMap lookup)
 const origKey = f.replace(/_\d{10}_\d{10}\.wav$/i, ".wav");
 if (!textMap[f] && !textMap[origKey]) continue;

 const srcFile = path.join(slicesSrc, f);
 const dstFile = path.join(slicesDir, f);
 if (!fs.existsSync(dstFile)) {
 fs.copyFileSync(srcFile, dstFile);
 importedSlices++;
 }

 // Copy corresponding raw audio (derive raw name from slice filename)
 const rawName = f.replace(/_\d{10}_\d{10}\.wav$/i, ".wav");
 const rawSrcFile = path.join(rawSrc, rawName);
 const rawDstFile = path.join(rawDir, rawName);
 if (fs.existsSync(rawSrcFile) && !fs.existsSync(rawDstFile)) {
 fs.copyFileSync(rawSrcFile, rawDstFile);
 importedRaw++;
 }
 }
 }

 // Note: 模型文件不由这里搬运。用户自己放到
 // assets/<角色>/models/<引擎id>/<模型位>/
 // 引擎 id = engines/ 下的目录名；模型位名由那台引擎的名片声明（契约 §5.7）。

 // Generate segments.json from actual files + textMap
 const copiedSlices = fs.existsSync(slicesDir) ? fs.readdirSync(slicesDir).filter(f => f.endsWith(".wav")) : [];
 const segmentsArr = copiedSlices.map((f, i) => {
 const origKey = f.replace(/_\d{10}_\d{10}\.wav$/i, ".wav").replace(/\.wav\.wav$/i, ".wav");
 const text = textMap[origKey] || textMap[f] || "";
 const slicePath = path.join(slicesDir, f).replace(/\\/g, "/");
 const dur = Math.round(getWavDuration(path.join(slicesDir, f)) * 100) / 100;
 return {
 scene: f.split(".")[0].replace(/_\d+$/, ""),
 index: i,
 text,
 phoneme: "",
 audio_filename: f,
 audio_path: slicePath,
 duration: dur,
 matched: !!text,
 };
 });
 const segmentsData = {
 voice: voiceId,
 source_file: listSrc.replace(/\\/g, "/"),
 generated_at: new Date().toISOString(),
 total: copiedSlices.length,
 matched: segmentsArr.filter(s => s.matched).length,
 segments: segmentsArr,
 };
 const segFile = path.join(voiceDir, "segments.json");
 atomicWriteFile(segFile, JSON.stringify(segmentsData, null, 2));

 // Build meta.json using scanVoiceDir for consistent schema
 const publishDir = path.dirname(voiceDir); // assets/
 const tempVoiceId = `_import_${voiceId}`;
 const tempDir = path.join(publishDir, tempVoiceId);
 fs.mkdirSync(tempDir, { recursive: true });
 fs.writeFileSync(path.join(tempDir, 'segments.json'), JSON.stringify(segmentsData, null, 2));
 const sliceFiles2 = fs.existsSync(slicesDir) ? fs.readdirSync(slicesDir).filter(f => f.endsWith('.wav')) : [];
 const tempSlicesDir = path.join(tempDir, 'slicer_opt');
 fs.mkdirSync(tempSlicesDir, { recursive: true });
 for (const f of sliceFiles2) { fs.copyFileSync(path.join(slicesDir, f), path.join(tempSlicesDir, f)); }
 const tempRawDir = path.join(tempDir, 'raw');
 fs.mkdirSync(tempRawDir, { recursive: true });
 if (fs.existsSync(rawDir)) { for (const f of fs.readdirSync(rawDir)) { fs.copyFileSync(path.join(rawDir, f), path.join(tempRawDir, f)); } }
 const fresh = scanVoiceDir(tempVoiceId, tempDir);
 const meta = { ...fresh, id: voiceId, display_name: voiceId, mode: 'internal', language: 'ja', prompt_lang: 'ja', text_lang: 'ja', created_at: new Date().toISOString() };
 atomicWriteFile(path.join(voiceDir, 'meta.json'), JSON.stringify(meta, null, 2));
 fs.rmSync(tempDir, { recursive: true, force: true });

 console.log(`[ASSETS] Imported ${voiceId}: ${importedRaw} raw, ${importedSlices} slices, ${segmentsData.total} segments`);
 return { importedRaw, importedSlices, segments: segmentsData.total, meta };
}

module.exports = { importFromList };
