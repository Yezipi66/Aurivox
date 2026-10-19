// 转写清单与分段：解析 .list、对齐音频、生成 segments.json。
const fs = require("fs");
const path = require("path");
const { ASSETS_DIR } = require("./consts");
const { getWavDuration } = require("./audioDuration");
const { atomicWriteFile } = require("./atomicWrite");

/**
 * Extract step number from checkpoint filename.
 * e.g. "白金-e15.ckpt" => 15, "D_233333333333.pth" => null
 */
function extractStep(name) {
 const m = name.match(/-e(\d+)\.ckpt$/);
 if (m) return parseInt(m[1], 10);
 return null;
}

/**
 * Validate a transcript list for real (not just "file exists").
 * A list is "ok" only when its path column uses the modern asset-relative form
 * `<sub>/<file>` AND at least one referenced audio file actually exists in <sub>/.
 * Legacy/edited lists (absolute/dead paths) resolve their basenames but fail the
 * format check → "invalid" (re-transcribe recommended, never auto-repaired).
 * A list with NO usable reference-text lines (empty file, or every line lacks a
 * text column) counts as "none", NOT "invalid": there is simply no reference text
 * for this source — the same, honest state as an absent list. Only lists that DO
 * carry text but with stale/broken paths are "invalid". This prevents a leftover
 * empty list (e.g. a stale slicer_opt.list after the slice step is removed) from
 * permanently poisoning the aggregate reference-text light to red while the other
 * source (raw) still has perfectly valid text.
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
 const expected = new RegExp(`^${sub}/[^/\\\\]+$`); // exactly "<sub>/<file>", no abs/drive/nesting
 try {
 for (const line of fs.readFileSync(listFile, "utf-8").split("\n")) {
 const t = line.trim();
 if (!t) continue;
 const parts = t.split("|");
 if (parts.length < 4) continue;
 const rawPath = parts[0].trim().replace(/\\/g, "/");
 const text = parts.slice(3).join("|").trim();
 if (!text) continue; // no reference text on this line
 total++;
 if (expected.test(rawPath)) modern++;
 if (audioSet.has(path.basename(rawPath))) matched++;
 }
 } catch { /* unreadable → treat as invalid below */ }

 // Empty / text-less list => no reference text for this source (treat as "none",
 // never a red "invalid"). This is the key fix for the stuck text-health light:
 // a leftover empty list must not permanently flag the asset as invalid.
 if (total === 0) return { status: "none", present: true, total: 0, modern: 0, matched: 0 };
 // Modern format on (nearly) every line AND audio present → ok. Otherwise invalid.
 const status = (modern === total && matched > 0) ? "ok" : "invalid";
 return { status, present: true, total, modern, matched };
}

/**
 * Parse 2-name2text.txt and return structured segments.
 * Format: filename\tphoneme\ttext
 * filename pattern: "交谈1.wav_0000000000_0000152640.wav"
 * => scene: "交谈1", index derived from order within scene
 */
/**
 * Resolve which transcript list + audio source a voice should use.
 * Slices take precedence when both a slicer_opt.list and slice .wav files exist;
 * otherwise raw (raw_opt.list + raw/). Returns null if no transcript exists.
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
 // Prefer whichever list has its audio present; slices win over raw.
 if (fs.existsSync(slicesList) && dirHasAudio(slicesDir)) return { listFile: slicesList, sourceKind: "slicer_opt", srcDir: slicesDir };
 if (fs.existsSync(rawList) && dirHasAudio(rawDir)) return { listFile: rawList, sourceKind: "raw", srcDir: rawDir };
 // List present but its audio was deleted to save space — still report it.
 if (fs.existsSync(slicesList)) return { listFile: slicesList, sourceKind: "slicer_opt", srcDir: slicesDir };
 if (fs.existsSync(rawList)) return { listFile: rawList, sourceKind: "raw", srcDir: rawDir };
 return null;
}

/**
 * Source-aware segments builder (pure): parse the resolved transcript list and
 * match it against the actual audio files in srcDir. Does NOT write anything.
 * audio_path is APP_DIR-relative (assets/<id>/<sourceKind>/<file>) so the TTS
 * engine's resolveRefPath can locate it.
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
 // Preserve the transcript's per-line language (col 3 of the .list) so segments
 // built from a list keep their language. Preprocess phonemises each line in
 // seg.lang (falling back to the global training language), so dropping this
 // silently mis-tokenises a Chinese/English asset's text as the fallback language.
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

/**
 * Generate segments.json for a voice by parsing its transcript list
 * (slicer_opt.list or raw_opt.list) and matching to its audio files.
 */
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
 * Parse slicer_opt.list file.
 * Format: "output\slicer_opt\filename.wav_0000..._0000...wav|slicer_opt|lang|text"
 * Returns: [{ sliceFile, origName, speaker, lang, text }]
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
 // Keep the full filename as-is for exact matching later
 entries.push({ sliceFile: basename, origName: basename, speaker, lang, text });
 }
 return entries;
}

module.exports = { extractStep, inspectTranscriptList, resolveTranscript, buildSegmentsFor, generateSegments, parseSlicerOptList };
