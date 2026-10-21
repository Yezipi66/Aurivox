// 转写清单与分段：解析 .list、对齐音频、生成 segments.json。
const fs = require("fs");
const path = require("path");
const { ASSETS_DIR } = require("./consts");
const { getWavDuration } = require("./audioDuration");
const { atomicWriteFile } = require("./atomicWrite");

/** 从权重文件名里取训练轮数，认不出返回 null。 */
function extractStep(name) {
 const m = name.match(/-e(\d+)\.ckpt$/);
 if (m) return parseInt(m[1], 10);
 return null;
}

/**
 * 校验一份转写清单是否真的可用（不只看文件在不在）。
 * ok 的条件：路径列是现代的资产相对形式 <sub>/<file>，且这些音频文件确实存在。
 * 路径失效的清单判 invalid，只提示重新转写，不自动修。
 * 没有任何可用文本行的清单算 none 而不是 invalid：那只是这个来源没有参考文本。
 * 否则一份残留的空清单会把资产的参考文本灯永久染红。
 * @returns {{status:'none'|'invalid'|'ok', present:boolean, total:number,
 * modern:number, matched:number}}
 */
function inspectTranscriptList(voiceDir, sub, listName) {
 const listFile = path.join(voiceDir, "asr_opt", listName);
 if (!fs.existsSync(listFile)) return { status: "none", present: false, total: 0, modern: 0, matched: 0 };
 const srcDir = path.join(voiceDir, sub);
 const AUDIO = /\.(wav|mp3|flac|m4a|ogg)$/i;
 let audioSet = null;
 try { audioSet = new Set(fs.readdirSync(srcDir).filter(f => AUDIO.test(f))); }
 catch { audioSet = new Set(); }

 let total = 0, modern = 0, matched = 0;
 const expected = new RegExp(`^${sub}/[^/\\\\]+$`); // 恰好 "<sub>/<file>"，不许绝对路径、盘符或嵌套
 try {
 for (const line of fs.readFileSync(listFile, "utf-8").split("\n")) {
 const t = line.trim();
 if (!t) continue;
 const parts = t.split("|");
 if (parts.length < 4) continue;
 const rawPath = parts[0].trim().replace(/\\/g, "/");
 const text = parts.slice(3).join("|").trim();
 if (!text) continue;
 total++;
 if (expected.test(rawPath)) modern++;
 if (audioSet.has(path.basename(rawPath))) matched++;
 }
 } catch { /* 解析失败就按下面那样判 invalid */ }

 // 空清单或全是无文本行：这个来源就是没有参考文本，算 none，不报红。
 if (total === 0) return { status: "none", present: true, total: 0, modern: 0, matched: 0 };
 const status = (modern === total && matched > 0) ? "ok" : "invalid";
 return { status, present: true, total, modern, matched };
}

/**
 * 决定这个角色用哪份转写清单、哪份音频：切片清单与切片音频都在时优先用切片，
 * 否则用 raw（raw_opt.list + raw/）。
 * @returns {{listFile, sourceKind:'slicer_opt'|'raw', srcDir}|null}
 */
function resolveTranscript(voiceDir) {
 const asrDir = path.join(voiceDir, "asr_opt");
 const slicesList = path.join(asrDir, "slicer_opt.list");
 const rawList = path.join(asrDir, "raw_opt.list");
 const slicesDir = path.join(voiceDir, "slicer_opt");
 const rawDir = path.join(voiceDir, "raw");
 const AUDIO = /\.(wav|mp3|flac|m4a|ogg)$/i;
 const dirHasAudio = (d) => {
 try { return fs.existsSync(d) && fs.readdirSync(d).some(f => AUDIO.test(f)); }
 catch { return false; }
 };
 if (fs.existsSync(slicesList) && dirHasAudio(slicesDir)) return { listFile: slicesList, sourceKind: "slicer_opt", srcDir: slicesDir };
 if (fs.existsSync(rawList) && dirHasAudio(rawDir)) return { listFile: rawList, sourceKind: "raw", srcDir: rawDir };
 // 清单在但音频被删了（省空间）：仍然报出来。
 if (fs.existsSync(slicesList)) return { listFile: slicesList, sourceKind: "slicer_opt", srcDir: slicesDir };
 if (fs.existsSync(rawList)) return { listFile: rawList, sourceKind: "raw", srcDir: rawDir };
 return null;
}

/**
 * 按来源生成分段（纯计算，不写盘）：解析转写清单并与 srcDir 里的实际音频对齐。
 * audio_path 是相对应用根的路径，引擎的 resolveRefPath 才能据此定位。
 */
function buildSegmentsFor(voiceDir, voiceId) {
 const t = resolveTranscript(voiceDir);
 if (!t) return null;
 const { listFile, sourceKind, srcDir } = t;
 const listEntries = parseSlicerOptList(fs.readFileSync(listFile, "utf-8"));

 const AUDIO = /\.(wav|mp3|flac|m4a|ogg)$/i;
 const dirExists = fs.existsSync(srcDir);
 const wavMap = {};
 if (dirExists) {
 for (const f of fs.readdirSync(srcDir)) { if (AUDIO.test(f)) wavMap[f] = f; }
 }
 const available = Object.keys(wavMap).length;
 if (!dirExists || available === 0) {
 const reason = !dirExists ? `${sourceKind}/ directory is missing` : `${sourceKind}/ contains no audio files`;
 console.warn(`[ASSETS] ${voiceId}: cannot rebuild segments — ${reason}.`);
 return {
 voice: voiceId, ok: false, source_kind: sourceKind,
 error: `No ${sourceKind} audio available (${reason}); regenerate the source audio before rebuilding segments.`,
 total: listEntries.length, matched: 0, missing: listEntries.length, segments: [],
 };
 }

 const segments = listEntries.map((e, i) => {
 const actualFile = wavMap[e.origName] || null;
 const isMatched = !!actualFile;
 const audioPath = isMatched ? `assets/${voiceId}/${sourceKind}/${actualFile}` : null;
 const dur = isMatched ? Math.round(getWavDuration(path.join(srcDir, actualFile)) * 100) / 100 : 0;
 return {
 scene: (actualFile || e.sliceFile).replace(/_\d{10}_\d{10}\.wav$/i, "").replace(/\.wav$/i, ""),
 index: i, text: e.text, phoneme: "",
 audio_filename: actualFile || e.sliceFile, audio_path: audioPath,
 // 保留清单里每行的语种（.list 的第 3 列）：preprocess 按 seg.lang 逐行转音素，
 // 丢掉它会把中英混排的文本按全局训练语种切分。
 lang: e.lang ? String(e.lang).trim().toLowerCase() : undefined,
 duration: dur, matched: isMatched,
 };
 });
 const matched = segments.filter(s => s.matched).length;
 return {
 voice: voiceId, ok: true, source_kind: sourceKind,
 source_file: listFile.replace(/\\/g, "/"),
 generated_at: new Date().toISOString(),
 total: segments.length, matched, missing: segments.length - matched, segments,
 };
}

/** 生成角色的 segments.json。 */
function generateSegments(voiceId) {
 const voiceDir = path.join(ASSETS_DIR, voiceId);
 const metaPath = path.join(voiceDir, "meta.json");
 const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf-8")) : null;

 const segmentsData = buildSegmentsFor(voiceDir, voiceId);
 if (!segmentsData) {
 console.log(`[ASSETS] No transcript list (raw_opt/slicer_opt) found for ${voiceId}`);
 return null;
 }
 if (segmentsData.ok === false) return segmentsData;

 const segmentsFile = path.join(voiceDir, "segments.json");
 atomicWriteFile(segmentsFile, JSON.stringify(segmentsData, null, 2));
 console.log(`[ASSETS] Generated segments.json for ${voiceId} (${segmentsData.source_kind}): ${segmentsData.total} entries (${segmentsData.matched} matched, ${segmentsData.missing} missing)`);

 if (meta) {
 meta.segment_total = segmentsData.matched;
 meta.segment_matched = segmentsData.matched;
 fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
 }
 return segmentsData;
}

/**
 * 解析 slicer_opt.list，每行格式：
 * "output\slicer_opt\filename.wav_0000..._0000...wav|slicer_opt|lang|text"
 * @returns [{ sliceFile, origName, speaker, lang, text }]
 */
function parseSlicerOptList(content) {
 const entries = [];
 const lines = content.split("\n").map(l => l.trim()).filter(l => l);
 for (const line of lines) {
 const parts = line.split("|");
 if (parts.length < 4) continue;
 const sliceFile = parts[0].trim();
 const speaker = parts[1].trim();
 const lang = parts[2].trim();
 const text = parts[3].trim();
 if (!text) continue;
 const basename = path.basename(sliceFile);
 entries.push({ sliceFile: basename, origName: basename, speaker, lang, text });
 }
 return entries;
}

module.exports = { extractStep, inspectTranscriptList, resolveTranscript, buildSegmentsFor, generateSegments, parseSlicerOptList };
