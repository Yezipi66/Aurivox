// 角色本身：扫盘、打开目录、改名、删除、导入、单查。
module.exports = function register(router, ctx) {
 const { ASSETS_DIR, assetScanner, baseVoiceMeta, clientError, fs, isBaseVoice, loadVoices, localError, path, requireApiKey, runFullAssetScan, safeId, saveVoices, spawn, withVoicesLock } = ctx;

router.post("/api/assets/scan", requireApiKey, async (req, res) => {
 try {
 const results = await runFullAssetScan();
 res.json({ ok: true, scanned: Object.keys(results).length, assets: results });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

router.post("/api/assets/:id/open", requireApiKey, (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const voiceDir = path.join(ASSETS_DIR, id);
 if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
 try {
 if (process.platform === "win32") {
 spawn("explorer", [voiceDir], { stdio: "ignore" });
 } else if (process.platform === "darwin") {
 spawn("open", [voiceDir], { stdio: "ignore" });
 } else {
 spawn("xdg-open", [voiceDir], { stdio: "ignore" });
 }
 res.json({ ok: true });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

router.patch("/api/assets/:id/rename", requireApiKey, async (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const newName = ((req.body && req.body.display_name) || "").trim();
 if (!newName) return res.status(400).json({ error: "display_name is required" });
 if (newName.length > 80) return res.status(400).json({ error: "display_name too long (max 80)" });

 const dir = path.join(ASSETS_DIR, id);
 const metaPath = path.join(dir, "meta.json");
 if (!fs.existsSync(metaPath)) return res.status(404).json({ error: `Voice '${id}' not found` });

 try {
 // Non-blocking duplicate-name advisory (NOT an identity constraint): report
 // any OTHER voice already showing this display name so the UI can surface the
 // internal id for disambiguation. Never rejects.
 const duplicates = [];
 const lname = newName.toLowerCase();
 try {
 for (const e of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
 if (!e.isDirectory() || e.name === id) continue;
 try {
 const m = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, e.name, "meta.json"), "utf-8"));
 if (m && String(m.display_name || "").trim().toLowerCase() === lname) duplicates.push(e.name);
 } catch (_) { /* ignore unreadable meta */ }
 }
 } catch (_) { /* assets dir unreadable */ }

 await withVoicesLock(async () => {
 // meta.json is authoritative for display_name; folder name stays the id.
 const meta0 = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
 meta0.display_name = newName;
 meta0.id = id; // mirror only
 fs.writeFileSync(metaPath, JSON.stringify(meta0, null, 2));

 const voices2 = loadVoices();
 if (voices2[id]) {
 voices2[id] = { ...voices2[id], display_name: newName };
 saveVoices(voices2);
 }
 });

 res.json({ ok: true, id, previousId: id, idChanged: false, display_name: newName, duplicates });
 } catch (err) {
 const status = err && err.httpStatus ? err.httpStatus : 500;
 res.status(status).json({ error: localError(err) });
 }
});

router.delete("/api/assets/:id", requireApiKey, async (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const voiceDir = path.join(ASSETS_DIR, id);
 if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
 try {
 fs.rmSync(voiceDir, { recursive: true, force: true });
 await withVoicesLock(async () => {
 const voices1 = loadVoices();
 if (voices1[id]) { delete voices1[id]; saveVoices(voices1); }
 });
 res.json({ ok: true, deleted: id });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

router.post("/api/assets/:id/scan", requireApiKey, async (req, res) => {
 const id = req.params.id;
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const voiceDir = path.join(ASSETS_DIR, id);
 if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });
 try {
 const meta = assetScanner.scanVoiceDir(id, voiceDir);
 // Persist the freshly-scanned meta first so the refreshed assets inventory
 // is not lost, then regenerate segments and backfill the counts (Bug A).
 const metaPath = path.join(voiceDir, "meta.json");
 const segResult = assetScanner.generateSegments(id);
 if (segResult && typeof segResult.matched === "number") {
 meta.segment_total = segResult.matched;
 meta.segment_matched = segResult.matched;
 }
 try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch (e) { console.warn("[assets] failed to write meta.json:", e.message); }
 const updatedMeta = meta;
 // Surface a warning when slices are missing so the client can prompt re-slice (Bug C).
 const segWarning = segResult && segResult.ok === false ? segResult.error : null;
 await withVoicesLock(async () => {
 const voices2 = loadVoices();
 voices2[id] = {
 display_name: updatedMeta?.display_name || id,
 language: updatedMeta?.language || "ja",
 prompt_lang: updatedMeta?.prompt_lang || updatedMeta?.language || "ja",
 text_lang: updatedMeta?.text_lang || updatedMeta?.language || "ja",
 };
 saveVoices(voices2);
 });
 res.json({ ok: true, meta: updatedMeta, warning: segWarning });
 } catch (err) {
 // 引擎的 scan.json 写错了，那条消息本来就是给人照着改的话（哪个引擎、哪个键、怎么改）；
 // 换成通用提示等于让用户去猜盘上的内容。状态用 400：要修的是配置，不是服务。
 // 其余错误照旧只进日志，客户端拿通用提示。
 if (err && err.code === "ENGINE_SCAN_INVALID") {
 return res.status(400).json({
 error: localError(err),
 code: err.code,
 engine_id: err.engine_id,
 key: err.key,
 });
 }
 res.status(500).json({ error: clientError(err) });
 }
});

router.post("/api/assets/import", requireApiKey, async (req, res) => {
 const { voiceId, gsvBase } = req.body || {};
 if (!voiceId) return res.status(400).json({ error: "Missing 'voiceId' field" });
 const base = gsvBase || assetScanner.GSV_BASE;
 try {
 const result = assetScanner.importFromList(voiceId, base);
 res.json({ ok: true, ...result });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

router.get("/api/assets/:id", (req, res) => {
 const id = req.params.id;
 // Built-in Base model: synthesize meta (checkpoints + empty roster) — it has no
 // folder on disk, so populate the Generate dropdowns from the pretrained weights.
 if (isBaseVoice(id)) return res.json({ ok: true, meta: baseVoiceMeta() });
 if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
 const metaPath = path.join(ASSETS_DIR, id, "meta.json");
 if (!fs.existsSync(metaPath)) return res.status(404).json({ error: `No meta.json for '${id}'` });
 try {
 const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
 res.json({ ok: true, meta });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

 return router;
};
