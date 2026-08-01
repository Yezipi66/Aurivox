// ===========================
//  ROUTES: Assets (scan, segments, transcript, transcribe, refine)
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");
const { HttpError, asyncHandler } = require("../http/http");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { ASSETS_DIR, TRAIN_DATA_ROOT, TRANSCRIPT_KINDS, assetId, assetScanner, baseVoiceMeta, clientError, collectTakenVoiceIds, crypto, fs, isBaseVoice, loadTrainingConfig, loadVoices, localError, normalizeVersion, path, pickLatestByEpoch, readTranscriptListRows, requireApiKey, runAsr, runFullAssetScan, safeId, sanitizeCustomParams, saveVoices, spawn, trainingPipeline, transcribeJobs, versionFromName, withVoicesLock } = ctx;

router.get("/api/assets", (req, res) => {
  try {
    const assets = assetScanner.listVoiceAssets();
    res.json({ ok: true, assets });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

// NOTE: must be registered BEFORE "/api/assets/:id" — otherwise Express matches
// this literal path against the param route (id = "voices-with-models") and the
// cross-asset mixing pickers receive an empty list (severe: the model dropdowns
// then vanish in mix mode).
router.get("/api/assets/voices-with-models", requireApiKey, (req, res) => {
  let voices;
  try { voices = loadVoices(); } catch (err) { return res.status(500).json({ error: clientError(err, "voices.json error") }); }
  const out = [];
  for (const [voiceId, reg] of Object.entries(voices)) {
    const voiceDir = path.join(ASSETS_DIR, voiceId);
    const metaPath = path.join(voiceDir, "meta.json");
    let ck = {};
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        ck = (meta && meta.assets && meta.assets.checkpoints) || {};
      }
    } catch (_) { /* fall through to live scan */ }
    let gptArr = Array.isArray(ck.gpt) ? ck.gpt : [];
    let sovitsArr = Array.isArray(ck.sovits) ? ck.sovits : [];
    // Live-scan fallback: the persisted meta.json roster can be stale (e.g. the user
    // dropped .ckpt/.pth files into gpt_checkpoints/ or sovits_models/ without a
    // rebuild). Re-scan the dirs so any real on-disk model is still selectable for
    // cross-asset mixing. scanVoiceDir is pure (no disk write).
    if (gptArr.length === 0 && sovitsArr.length === 0) {
      try {
        const fresh = assetScanner.scanVoiceDir(voiceId, voiceDir);
        const fck = (fresh && fresh.assets && fresh.assets.checkpoints) || {};
        if (Array.isArray(fck.gpt)) gptArr = fck.gpt;
        if (Array.isArray(fck.sovits)) sovitsArr = fck.sovits;
      } catch (_) { /* ignore unscannable asset */ }
    }
    if (gptArr.length === 0 && sovitsArr.length === 0) continue;
    out.push({
      voiceId,
      displayName: (reg && (reg.display_name || reg.name)) || voiceId,
      hasGpt: gptArr.length > 0,
      hasSovits: sovitsArr.length > 0,
      gptCount: gptArr.length,
      sovitsCount: sovitsArr.length,
      gpt: gptArr,
      sovits: sovitsArr,
    });
  }
  out.sort((a, b) => a.voiceId.localeCompare(b.voiceId));
  // Built-in Base model as a virtual asset: it has no folder on disk, so inject a
  // synthetic entry from the pretrained-weights checkpoints (same source the
  // Generate dropdowns already use via GET /api/assets/__base__). This lets users
  // mix Base's GPT / SoVITS with any fine-tuned asset in the cross-asset pickers.
  try {
    const meta = baseVoiceMeta();
    const bck = (meta && meta.assets && meta.assets.checkpoints) || {};
    const bGpt = Array.isArray(bck.gpt) ? bck.gpt : [];
    const bSovits = Array.isArray(bck.sovits) ? bck.sovits : [];
    if (bGpt.length || bSovits.length) {
      out.unshift({
        voiceId: meta.id,
        displayName: meta.display_name || meta.id,
        builtin: true,
        hasGpt: bGpt.length > 0,
        hasSovits: bSovits.length > 0,
        gptCount: bGpt.length,
        sovitsCount: bSovits.length,
        gpt: bGpt,
        sovits: bSovits,
      });
    }
  } catch (_) { /* base weights unavailable — omit from mix pickers */ }
  res.json({ voices: out });
});

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
    try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch (_) {}
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
      // Patch #23：置信度旁车 <kind>.conf.json（键为片段文件名），有则逐行附带。
      let confMap = {};
      try {
        const confPath = path.join(voiceDir, "asr_opt", k.listName.replace(/\.list$/i, ".conf.json"));
        if (fs.existsSync(confPath)) {
          const parsed = JSON.parse(fs.readFileSync(confPath, "utf-8"));
          if (parsed && typeof parsed === "object") confMap = parsed;
        }
      } catch (_) {}
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
    // Language + provenance from meta (transcript source/verification, if any).
    let language = "ja";
    let transcript = null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(voiceDir, "meta.json"), "utf-8"));
      if (m.language) language = m.language;
      if (m.transcript && typeof m.transcript === "object") transcript = m.transcript;
    } catch (_) {}
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
    // Merge edited text onto the existing list by audio filename (basename), so
    // path/speaker/lang columns round-trip exactly and unknown rows are untouched.
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

    // Patch #23：人工改过的行，其机器置信度已失真，从旁车剔除避免误导着色。
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

    // Rebuild segments.json from the updated list (its text is what inference reads).
    try { assetScanner.generateSegments(id); } catch (e) { console.error(`[TRANSCRIPT ${id}] segments rebuild warning:`, e.message); }

    // Provenance: mark human-edited (or human-verified when the user confirms).
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

  // Resolve language from voices.json, then meta.json, else default.
  let language = "ja";
  try { const vs = loadVoices(); if (vs[id] && vs[id].language) language = vs[id].language; } catch (_) {}
  try {
    const m = JSON.parse(fs.readFileSync(path.join(voiceDir, "meta.json"), "utf-8"));
    if ((!language || language === "ja") && m.language) language = m.language;
  } catch (_) {}

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
  else { // 'missing': only transcribe available audio whose list is absent
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

  // Respond immediately; ASR runs in the background and is polled via -status.
  res.json({ ok: true, started: true, sources: job.sources, language });

  (async () => {
    const backups = [];
    try {
      for (const s of sources) {
        if (job._cancelled) throw new Error("cancelled");
        // Patch #13: back up any existing transcript before ASR replaces it, so a
        // hand-edited/verified list is never silently destroyed by re-running ASR.
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
      // In-place: regenerate segments.json + rescan meta. No promote.
      try { assetScanner.generateSegments(id); } catch (e) { log(`segments rebuild warning: ${e.message}`); }
      try {
        const m = assetScanner.scanVoiceDir(id, voiceDir);
        // The transcript is now machine-generated; record provenance + backups.
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

router.post("/api/assets/:id/rebuild", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const voiceDir = path.join(ASSETS_DIR, id);
  if (!fs.existsSync(voiceDir)) return res.status(404).json({ error: `Voice '${id}' not found` });

  const mode = (req.body && req.body.mode) || "safe";
  const reslice = !!(req.body && req.body.reslice);
  const skipAsr = !!(req.body && req.body.skipAsr);
  const execute = !!(req.body && req.body.execute);
  // Optional per-model retrain overrides from the restore modal. undefined = auto
  // (retrain only whichever model is missing); true/false = explicit force/skip.
  const bodyTrainS1 = req.body && req.body.trainS1;
  const bodyTrainS2 = req.body && req.body.trainS2;
  const trainS1 = bodyTrainS1 === undefined ? undefined : !!bodyTrainS1;
  const trainS2 = bodyTrainS2 === undefined ? undefined : !!bodyTrainS2;
  // Optional per-run overrides for slice / asr / training parameters, shaped like
  // the training pipeline's customParams: { training, steps: { slice|asr: { params } } }.
  // Run through the SAME whitelist + clamp as /api/train/start so the rebuild path
  // (a lighter pipeline that skips already-satisfied steps) shares one safety gate.
  const params = sanitizeCustomParams(req.body && req.body.params);

  try {
    const state = assetScanner.detectAssetState(id);
    const plan = assetScanner.planRebuild(state, { mode, reslice, skipAsr, trainS1, trainS2 });

    // Hard errors / nothing to do → report the plan as-is.
    if (plan.error) return res.status(400).json({ ok: false, state, ...plan });
    if (plan.noop) return res.json({ ok: true, state, ...plan });

    // Plan-only (default): caller confirms before any heavy work runs.
    if (!execute) {
      return res.json({ ok: true, state, executed: false, ...plan });
    }

    // No executable stages (e.g. safe mode deferred missing models): there is
    // nothing to run — surface the suggested follow-up instead of training.
    if (!plan.stages || plan.stages.length === 0) {
      return res.json({ ok: true, state, executed: false, ...plan });
    }

    // use_pretrained_base is not yet supported by the backend (Phase 4 backlog).
    if (plan.uses_pretrained_base) {
      return res.status(501).json({
        ok: false, state, ...plan,
        error: "Pretrained-base rebuild (emergency mode) is not implemented yet (backend-pending).",
      });
    }

    // Step 1: if the plan includes a standalone segments rebuild, run it inline
    // first. planRebuild only schedules this when slices+list already exist, so
    // it is always safe; it also provides segments.json as input for a following
    // preprocess/train stage (which reads it from the asset dir).
    let segResult = null;
    if (plan.needs_segments) {
      const seg = assetScanner.generateSegments(id);
      if (!seg || seg.ok === false) {
        return res.status(400).json({ ok: false, state, ...plan, error: (seg && seg.error) || "Failed to rebuild segments" });
      }
      const meta = assetScanner.scanVoiceDir(id, voiceDir);
      meta.segment_total = seg.matched; meta.segment_matched = seg.matched;
      try { fs.writeFileSync(path.join(voiceDir, "meta.json"), JSON.stringify(meta, null, 2)); } catch (_) {}
      segResult = { total: seg.total, matched: seg.matched, missing: seg.missing };
    }

    // Step 2: if there are no pipeline stages, the segments rebuild was the whole
    // job — return now (lightweight, no training touched).
    if (!plan.stepOptions) {
      return res.json({ ok: true, state, executed: true, action: "generateSegments", ...segResult, ...plan });
    }

    // Step 3: hand off to the training pipeline. inputDir depends on whether we
    // are re-deriving slices from raw (needs the flat raw folder) or reusing the
    // existing slices/segments under the asset root. finalize carries forward any
    // core asset not regenerated this run, so existing models survive promote.
    const voices = loadVoices();
    const language = (voices[id] && voices[id].language) || "ja";
    const rawDir = path.join(voiceDir, "raw");
    const inputDir = plan.stepOptions.slice ? rawDir : voiceDir;
    if (plan.stepOptions.slice && !fs.existsSync(rawDir)) {
      return res.status(400).json({ ok: false, state, ...plan, error: "Re-slice requested but raw/ folder is missing." });
    }
    const pipeline = trainingPipeline.createPipeline({
      voiceId: id,
      language,
      inputDir,
      stepOptions: plan.stepOptions,
      customParams: params,
    });
    pipeline.start().catch(err => console.error("[REBUILD] Pipeline error:", err));
    return res.json({ ok: true, state, executed: true, action: "pipeline", taskId: pipeline.id, segments: segResult, ...plan });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

router.post("/api/assets/derive-id", requireApiKey, (req, res) => {
  const displayName = String((req.body && req.body.display_name) || "").trim();
  if (!displayName) return res.status(400).json({ error: "display_name is required" });
  const { base, proposed } = assetId.proposeVoiceId(displayName);
  // Surface whether the illustrative proposal currently collides so the UI can
  // hint that the final id will differ.
  let collides = false;
  try { collides = collectTakenVoiceIds().has(proposed); } catch (_) {}
  res.json({ proposed_id: proposed, base, reserved: false, collides });
});

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
    } catch (_) {}
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
        } catch (_) {}
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
    //   reuse (default) — continue from the parent's frozen dataset (slice/ASR reused).
    //   own  — user brings a NEW audio folder; run the FULL pipeline on it, still
    //          warm-starting from the parent's checkpoints. New data only; no merge.
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
    try { pMeta = JSON.parse(fs.readFileSync(path.join(parentDir, "meta.json"), "utf-8")); } catch (_) {}
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
    const gptDir = path.join(parentDir, "gpt_checkpoints");
    const sovDir = path.join(parentDir, "sovits_models");
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
        } catch (_) {}
      }
    } catch (_) {}
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
    } catch (_) {}

    // Allocate + reserve a fresh id atomically, then seed the new asset directory.
    const newId = await withVoicesLock(async () => {
      const taken = collectTakenVoiceIds();
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
        const newGptDir = path.join(newDir, "gpt_checkpoints");
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
        const newSovDir = path.join(newDir, "sovits_models");
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
    //   reuse → preprocess → [train] → finalize → promote (slice/ASR reused from parent).
    //   own   → (denoise) → slice → ASR → preprocess → [train] → finalize → promote,
    //           warm-started from the parent checkpoints. New data only, no merge.
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
