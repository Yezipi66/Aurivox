// 从上游引擎的输出目录导入角色素材：以 slicer_opt.list 为准，复制切片与原始音频，
// 并生成 segments.json 与 meta.json。只搬运，不裁剪也不改写音频内容。
// 不搬模型文件：模型由用户自己放到 assets/<角色>/models/<引擎id>/<模型位>/。

const fs = require("fs");
const path = require("path");
const { ASSETS_DIR, GSV_PATHS } = require("./consts");
const { getWavDuration } = require("./audioDuration");
const { atomicWriteFile } = require("./atomicWrite");
const { parseSlicerOptList } = require("./transcript");
const { scanVoiceDir } = require("./scan");

/**
 * 导入一个角色的素材。
 * @param {string} voiceId 角色 id，同时是 assets 下的目录名
 * @param {string} gsvBase 上游引擎的根目录，用于在角色目录里找不到清单时去它的输出目录找
 * @param {object} [opts] { rawSrc, slicesSrc, listSrc }，覆盖三个源目录的默认位置
 * @returns {object} { importedRaw, importedSlices, segments, meta }：各复制了多少份、
 *   segments.json 有多少条、以及 meta.json 的内容
 */
function importFromList(voiceId, gsvBase, opts = {}) {
 const voiceDir = path.join(ASSETS_DIR, voiceId);
 if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });

 // 清单的来源：角色自己的 asr_opt/slicer_opt.list
 const listSrc = opts.listSrc || path.join(voiceDir, "asr_opt", "slicer_opt.list");

 // 清单内容解析成 切片文件名 → 文本 的对照
 let textMap = {}; // { filename → text }
 if (fs.existsSync(listSrc)) {
 const listContent = fs.readFileSync(listSrc, "utf-8");
 const listEntries = parseSlicerOptList(listContent);
 for (const e of listEntries) {
 textMap[e.sliceFile] = e.text;
 }
 console.log(`[ASSETS] Using slicer_opt.list: ${Object.keys(textMap).length} entries`);
 } else {
 // 角色目录里没有清单时，去上游引擎的输出目录找一份
 const gsvListSrc = path.join(gsvBase, "output", "asr_opt", "slicer_opt.list");
 if (fs.existsSync(gsvListSrc)) {
 const listContent = fs.readFileSync(gsvListSrc, "utf-8");
 const listEntries = parseSlicerOptList(listContent);
 for (const e of listEntries) {
 textMap[e.sliceFile] = e.text;
 }
 // 把清单复制进角色目录，同时改写其中的路径
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

 // 三个源目录：原始音频、切片、清单
 const rawSrc = opts.rawSrc || path.join(GSV_PATHS.noSlice);
 const slicesSrc = opts.slicesSrc || path.join(gsvBase, "output", "slicer_opt");

 // 角色目录下的两个子目录：原始音频与切片
 const rawDir = path.join(voiceDir, "raw");
 const slicesDir = path.join(voiceDir, "slicer_opt");
 fs.mkdirSync(rawDir, { recursive: true });
 fs.mkdirSync(slicesDir, { recursive: true });

 // 逐个复制切片文件，计数
 let importedRaw = 0;
 let importedSlices = 0;

 if (fs.existsSync(slicesSrc)) {
 const srcFiles = fs.readdirSync(slicesSrc).filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f));
 for (const f of srcFiles) {
 // 只复制属于这个角色的文件：判据是清单里查得到这个名字
 const origKey = f.replace(/_\d{10}_\d{10}\.wav$/i, ".wav");
 if (!textMap[f] && !textMap[origKey]) continue;

 const srcFile = path.join(slicesSrc, f);
 const dstFile = path.join(slicesDir, f);
 if (!fs.existsSync(dstFile)) {
 fs.copyFileSync(srcFile, dstFile);
 importedSlices++;
 }

 // 复制对应的原始音频：文件名由切片名推出来
 const rawName = f.replace(/_\d{10}_\d{10}\.wav$/i, ".wav");
 const rawSrcFile = path.join(rawSrc, rawName);
 const rawDstFile = path.join(rawDir, rawName);
 if (fs.existsSync(rawSrcFile) && !fs.existsSync(rawDstFile)) {
 fs.copyFileSync(rawSrcFile, rawDstFile);
 importedRaw++;
 }
 }
 }

 // 模型文件不由这里搬运，用户自己放到
 // assets/<角色>/models/<引擎id>/<模型位>/
 // 引擎 id = engines/ 下的目录名；模型位名由那台引擎的名片声明。

 // 生成 segments.json：内容取自实际复制到的切片文件与清单对照
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

 // 生成 meta.json：走 scanVoiceDir，字段与扫盘那条路径一致
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
