// 转写相关的路由：读取与编辑转写列表，以及 ASR 作业的起停与状态查询。
// 列表在 assets/<voiceId>/asr_opt/<kind>.list，机器置信度放在同名的 <kind>.conf.json 旁车里。
// 人工改过文本的行会从旁车里剔除：机器置信度对改过的文本已经失真。
module.exports = function register(router, ctx) {
 const { ASSETS_DIR, TRANSCRIPT_KINDS, assetScanner, clientError, fs, loadTrainingConfig, loadVoices, path, readTranscriptListRows, requireApiKey, runAsr, safeId, transcribeJobs } = ctx;

router.get("/api/assets/:id/transcript", requireApiKey, (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const voiceDir = path.join(ASSETS_DIR, id);
 if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
 try {
 const buckets = [];
 for (const k of TRANSCRIPT_KINDS) {
 const listPath = path.join(voiceDir, "asr_opt", k.listName);
 if (!fs.existsSync(listPath)) continue;
 const audioDir = path.join(voiceDir, k.audioSub);
 // 置信度旁车 <kind>.conf.json（键为片段文件名），有则逐行附带。
 let confMap = {};
 try {
 const confPath = path.join(voiceDir, "asr_opt", k.listName.replace(/\.list$/i, ".conf.json"));
 if (fs.existsSync(confPath)) {
 const parsed = JSON.parse(fs.readFileSync(confPath, "utf-8"));
 if (parsed && typeof parsed === "object") confMap = parsed;
 }
 } catch (_) {
  // <kind>.conf.json 是可选的：读不到或坏了就整档留空，
  // 前端那两个字段（confidence / words）显示为「无」，不阻断列表返回。
 }
 const rows = readTranscriptListRows(listPath).map((r) => {
 const c = confMap[r.audio_filename] || null;
 return {
 ...r,
 exists: !!(r.audio_filename && fs.existsSync(path.join(audioDir, r.audio_filename))),
 url: r.audio_filename ? `/assets/${id}/${k.audioSub}/${encodeURIComponent(r.audio_filename)}` : null,
 confidence: c && typeof c.confidence === "number" ? c.confidence : null,
 words: c && Array.isArray(c.words) ? c.words : null,
 };
 });
 buckets.push({ kind: k.kind, listName: k.listName, rows });
 }
 // 语言与来源信息取自 meta.json（有就取，没有就用下面的默认值）。
 let language = "ja";
 let transcript = null;
 try {
 const m = JSON.parse(fs.readFileSync(path.join(voiceDir, "meta.json"), "utf-8"));
 if (m.language) language = m.language;
 if (m.transcript && typeof m.transcript === "object") transcript = m.transcript;
 } catch (_) {
  // meta.json 缺失或坏了 ⇒ language 保持默认 "ja"、transcript 为 null。
 }
 res.json({ ok: true, buckets, language, transcript, hasTranscript: buckets.length > 0 });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

router.post("/api/assets/:id/transcript", requireApiKey, (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const voiceDir = path.join(ASSETS_DIR, id);
 if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });

 const kind = (req.body && req.body.kind) || "slicer_opt";
 const kindDef = TRANSCRIPT_KINDS.find((k) => k.kind === kind);
 if (!kindDef) return res.status(400).json({ error: `Invalid transcript kind '${kind}'` });
 const rows = req.body && req.body.rows;
 if (!Array.isArray(rows)) return res.status(400).json({ error: "rows must be an array" });

 const listPath = path.join(voiceDir, "asr_opt", kindDef.listName);
 if (!fs.existsSync(listPath)) {
 return res.status(404).json({ error: `No ${kindDef.listName} for '${id}'. Run ASR to create one first.` });
 }

 try {
 // 按音频文件名把改过的文本并回原表：其余列原样带过，没在提交里出现的行不动。
 const existing = readTranscriptListRows(listPath);
 const textByName = {};
 for (const r of rows) {
 const fname = String(r.audio_filename || r.audio_path || "").replace(/\\/g, "/").split("/").pop();
 if (fname) textByName[fname] = r.text == null ? "" : String(r.text);
 }
 let changed = 0;
 const changedNames = [];
 const lines = existing.map((r) => {
 const fname = r.audio_filename;
 const text = (fname in textByName) ? textByName[fname] : r.text;
 if (fname in textByName && textByName[fname] !== r.text) { changed += 1; changedNames.push(fname); }
 return `${r.audio_path}|${r.speaker}|${r.lang}|${text}`;
 });
 const tmp = listPath + ".tmp." + process.pid + "." + Date.now();
 fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf-8");
 fs.renameSync(tmp, listPath);

 // 人工改过的行，其机器置信度已失真，从旁车剔除以免误导着色。
 if (changedNames.length) {
 try {
 const confPath = path.join(voiceDir, "asr_opt", kindDef.listName.replace(/\.list$/i, ".conf.json"));
 if (fs.existsSync(confPath)) {
 const cm = JSON.parse(fs.readFileSync(confPath, "utf-8"));
 if (cm && typeof cm === "object") {
 let dirty = false;
 for (const n of changedNames) { if (n in cm) { delete cm[n]; dirty = true; } }
 if (dirty) fs.writeFileSync(confPath, JSON.stringify(cm), "utf-8");
 }
 }
 } catch (e) { console.error(`[TRANSCRIPT ${id}] conf prune warning:`, e.message); }
 }

 // 由更新后的列表重建 segments.json（推理读的是它的文本）。
 try { assetScanner.generateSegments(id); } catch (e) { console.error(`[TRANSCRIPT ${id}] segments rebuild warning:`, e.message); }

 // 来源标记：人工编辑；调用方确认过则记为人工校对通过。
 try {
 const metaPath = path.join(voiceDir, "meta.json");
 const m = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf-8")) : {};
 const verified = !!(req.body && req.body.verified);
 m.transcript = {
 ...(m.transcript || {}),
 source: verified ? "human_verified" : "human_edited",
 revised_at: new Date().toISOString(),
 revision: (Number((m.transcript && m.transcript.revision) || 0) || 0) + 1,
 };
 fs.writeFileSync(metaPath, JSON.stringify(m, null, 2));
 } catch (e) { console.error(`[TRANSCRIPT ${id}] meta update warning:`, e.message); }

 res.json({ ok: true, kind, changed, total: lines.length });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

router.post("/api/assets/:id/transcribe", requireApiKey, async (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const voiceDir = path.join(ASSETS_DIR, id);
 if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });

 const existing = transcribeJobs.get(id);
 if (existing && existing.status === "running") {
 const { _child, _cancelled, ...pub } = existing;
 return res.status(409).json({ error: "A transcription job is already running.", job: pub });
 }

 // 语言先取 voices.json，再取 meta.json，都没有则用上面的默认值。
 let language = "ja";
 try { const vs = loadVoices(); if (vs[id] && vs[id].language) language = vs[id].language; } catch (_) {}
 try {
 const m = JSON.parse(fs.readFileSync(path.join(voiceDir, "meta.json"), "utf-8"));
 if ((!language || language === "ja") && m.language) language = m.language;
 } catch (_) {
  // meta.json 读不到 ⇒ 沿用上面 voices.json 给出的结论。
 }

 const AUDIO = /\.(wav|mp3|flac|m4a|ogg)$/i;
 const hasAudio = (sub) => {
 const d = path.join(voiceDir, sub);
 try { return fs.existsSync(d) && fs.readdirSync(d).some(f => AUDIO.test(f)); } catch { return false; }
 };
 const hasList = (name) => fs.existsSync(path.join(voiceDir, "asr_opt", name));
 const hasRaw = hasAudio("raw");
 const hasSlices = hasAudio("slicer_opt");

 const sel = (req.body && req.body.source) || "missing";
 const sources = [];
 const add = (kind, sub) => { if (!sources.find(s => s.kind === kind)) sources.push({ kind, sub }); };
 if (sel === "raw") { if (hasRaw) add("raw", "raw"); }
 else if (sel === "slices") { if (hasSlices) add("slicer_opt", "slicer_opt"); }
 else if (sel === "both") { if (hasRaw) add("raw", "raw"); if (hasSlices) add("slicer_opt", "slicer_opt"); }
 else { // 'missing'：只转写有音频而还没有列表的那一路
 if (hasRaw && !hasList("raw_opt.list")) add("raw", "raw");
 if (hasSlices && !hasList("slicer_opt.list")) add("slicer_opt", "slicer_opt");
 }
 if (sources.length === 0) {
 return res.status(400).json({
 error: "No audio to transcribe (the selected source has no audio, or in “Fill missing” mode a transcript already exists).",
 hasRaw, hasSlices,
 });
 }

 const config = loadTrainingConfig();
 const outDir = path.join(voiceDir, "asr_opt");
 const job = {
 status: "running", startedAt: Date.now(), finishedAt: null,
 sources: sources.map(s => s.kind), done: [], error: null, logs: [],
 _child: null, _cancelled: false,
 };
 transcribeJobs.set(id, job);
 const log = (m) => {
 job.logs.push(`[${new Date().toISOString()}] ${m}`);
 if (job.logs.length > 500) job.logs.shift();
 console.log(`[TRANSCRIBE ${id}] ${m}`);
 };

 // 立刻返回，ASR 在后台跑，客户端轮询状态接口。
 res.json({ ok: true, started: true, sources: job.sources, language });

 (async () => {
 const backups = [];
 try {
 for (const s of sources) {
 if (job._cancelled) throw new Error("cancelled");
 // ASR 会覆盖现有转写，先备份一份，避免人工改过或校对通过的列表被悄悄冲掉。
 const listName = s.kind === "raw" ? "raw_opt.list" : "slicer_opt.list";
 const existingList = path.join(outDir, listName);
 if (fs.existsSync(existingList)) {
 const stamp = new Date().toISOString().replace(/[:.]/g, "-");
 const bak = path.join(outDir, `${listName}.bak.${stamp}`);
 try { fs.copyFileSync(existingList, bak); backups.push(path.basename(bak)); log(`backed up ${listName} → ${path.basename(bak)}`); }
 catch (e) { log(`backup warning for ${listName}: ${e.message}`); }
 }
 log(`ASR start: ${s.kind}`);
 await runAsr({
 srcDir: path.join(voiceDir, s.sub), sourceKind: s.kind, language,
 voiceId: id, outDir, config,
 setChild: (child) => { job._child = child; },
 }, log);
 job.done.push(s.kind);
 }
 // 就地重建 segments.json 并重扫 meta，不做发布。
 try { assetScanner.generateSegments(id); } catch (e) { log(`segments rebuild warning: ${e.message}`); }
 try {
 const m = assetScanner.scanVoiceDir(id, voiceDir);
 // 转写现在是机器生成的，记下来源与备份文件名。
 m.transcript = {
 source: "machine_generated",
 revised_at: new Date().toISOString(),
 revision: (Number((m.transcript && m.transcript.revision) || 0) || 0) + 1,
 backups: backups.length ? backups : undefined,
 };
 fs.writeFileSync(path.join(voiceDir, "meta.json"), JSON.stringify(m, null, 2));
 } catch (e) { log(`meta rescan warning: ${e.message}`); }
 job.status = "done"; job.finishedAt = Date.now(); job.backups = backups; log("done");
 } catch (err) {
 const wasCancelled = job._cancelled || /cancel|killed/i.test(err.message || "");
 job.status = wasCancelled ? "cancelled" : "error";
 job.error = wasCancelled ? null : clientError(err);
 job.finishedAt = Date.now();
 log(wasCancelled ? "cancelled" : `failed: ${err.message}`);
 } finally {
 job._child = null;
 }
 })();
});

router.get("/api/assets/:id/transcribe-status", requireApiKey, (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const job = transcribeJobs.get(id);
 if (!job) return res.json({ ok: true, status: "idle" });
 const { _child, _cancelled, ...pub } = job;
 res.json({ ok: true, ...pub });
});

router.get("/api/transcribe-jobs", requireApiKey, (req, res) => {
 const jobs = {};
 for (const [id, job] of transcribeJobs.entries()) {
 if (!job || job.status === "idle") continue;
 const { _child, _cancelled, logs, ...pub } = job;
 jobs[id] = pub;
 }
 res.json({ ok: true, jobs });
});

router.delete("/api/assets/:id/transcribe", requireApiKey, (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const job = transcribeJobs.get(id);
 if (!job || job.status !== "running") return res.json({ ok: true, status: job ? job.status : "idle" });
 job._cancelled = true;
 try { if (job._child) job._child.kill("SIGTERM"); } catch (_) {}
 res.json({ ok: true, status: "cancelling" });
});

 return router;
};
