// 分段与原始音频清单。
module.exports = function register(router, ctx) {
 const { ASSETS_DIR, assetScanner, clientError, fs, isBaseVoice, path, requireApiKey, safeId } = ctx;

router.get("/api/assets/:id/segments", (req, res) => {
 const id = req.params.id;
 // Base model has no slices — return an empty segment set (Slices count = 0).
 if (isBaseVoice(id)) return res.json({ ok: true, segments: { segments: [], live_matched: 0 } });
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const segPath = path.join(ASSETS_DIR, id, "segments.json");
 if (!fs.existsSync(segPath)) return res.status(404).json({ error: `No segments.json for '${id}'` });
 try {
 const data = JSON.parse(fs.readFileSync(segPath, "utf-8"));
 // Privacy / correctness: segments.json is a snapshot from scan time. The user
 // may have since deleted slice .wav files (e.g. to keep only models). Re-check
 // each slice's real existence on disk NOW and expose `exists` so the client
 // never lists / offers a reference audio that cannot actually be played or used.
 const slicesDir = path.join(ASSETS_DIR, id, "slicer_opt");
 if (data && Array.isArray(data.segments)) {
 let liveMatched = 0;
 for (const seg of data.segments) {
 const fname = seg.audio_filename || (seg.audio_path ? String(seg.audio_path).replace(/\\/g, "/").split("/").pop() : "");
 const exists = !!(fname && fs.existsSync(path.join(slicesDir, fname)));
 seg.exists = exists;
 if (exists) liveMatched += 1;
 }
 data.live_matched = liveMatched;
 }
 res.json({ ok: true, segments: data });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

router.get("/api/assets/:id/raw-list", (req, res) => {
 const id = req.params.id;
 // Base model has no raw audio — return an empty list (Raw count = 0).
 if (isBaseVoice(id)) return res.json({ ok: true, raw: [] });
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const rawDir = path.join(ASSETS_DIR, id, "raw");
 if (!fs.existsSync(rawDir)) return res.json({ ok: true, raw: [] });
 try {
 // Build basename -> reference text map from raw_opt.list (if present).
 const textByName = {};
 const listFile = path.join(ASSETS_DIR, id, "asr_opt", "raw_opt.list");
 if (fs.existsSync(listFile)) {
 try {
 for (const entry of assetScanner.parseSlicerOptList(fs.readFileSync(listFile, "utf-8"))) {
 if (entry.origName && entry.text) textByName[entry.origName] = entry.text;
 }
 } catch { /* unreadable list → no texts, non-fatal */ }
 }
 const files = fs.readdirSync(rawDir)
 .filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f))
 .map(f => {
 const dur = /\.wav$/i.test(f)
 ? Math.round(assetScanner.getWavDuration(path.join(rawDir, f)) * 100) / 100
 : 0;
 return {
 filename: f,
 url: `/assets/${id}/raw/${encodeURIComponent(f)}`,
 text: textByName[f] || "",
 duration: dur,
 };
 });
 res.json({ ok: true, raw: files });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

router.post("/api/assets/:id/generate-segments", requireApiKey, (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const voiceDir = path.join(ASSETS_DIR, id);
 if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
 try {
 const data = assetScanner.generateSegments(id);
 if (!data) return res.status(400).json({ error: "No slicer_opt.list found" });
 if (data.ok === false) return res.status(400).json({ error: data.error });
 res.json({ ok: true, total: data.total, matched: data.matched, missing: data.missing || 0 });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

 return router;
};
