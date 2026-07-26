// ===========================
//  ROUTES: Outputs + audio-files listing/management
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { OUTPUT_ROOTS, VOICES_DIR, clientError, fs, genBaseName, genItemFromMeta, normSource, outputRoot, path, requireApiKey, resolveGenDir, spawn } = ctx;

router.get("/api/audio-files", (req, res) => {
  const dir = req.query.dir || "voices";
  const baseDir = dir === "no_slice" ? (process.env.NO_SLICE_DIR || "") : VOICES_DIR;
  if (!baseDir) return res.status(400).json({ error: "NO_SLICE_DIR not configured" });
  try {
    const files = fs.readdirSync(baseDir)
      .filter(f => /\.(wav|mp3|flac|m4a|ogg)$/i.test(f))
      .map(f => {
        const full = path.join(baseDir, f);
        const stat = fs.statSync(full);
        let dur = 0;
        try {
          const fd = fs.openSync(full, 'r');
          const buf = Buffer.alloc(64);
          fs.readSync(fd, buf, 0, 64, 0);
          fs.closeSync(fd);
          if (buf.length >= 44 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
            const sr = buf.readUInt32LE(24);
            let off = 0;
            for (let i = 12; i < buf.length - 8; i++) {
              if (buf[i]===0x64&&buf[i+1]===0x61&&buf[i+2]===0x74&&buf[i+3]===0x61) { off=i+8; break; }
            }
            if (off) dur = buf.readUInt32LE(off-4) / (sr * 2);
          }
        } catch {}
        return { name: f, path: full.replace(/\\/g, "/"), size: stat.size, duration: Math.round(dur * 100) / 100 };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ files, dir });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

router.get("/api/outputs", requireApiKey, (req, res) => {
  try {
    const src = normSource(req.query.source);
    const root = OUTPUT_ROOTS[src];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
    const items = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const metaPath = path.join(root, d.name, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        items.push(genItemFromMeta(meta));
      } catch (e) {
        console.error(`[OUTPUTS] bad meta ${d.name}: ${e.message}`);
      }
    }
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

router.get("/api/outputs/batches", requireApiKey, (req, res) => {
  try {
    const src = normSource(req.query.source);
    const root = OUTPUT_ROOTS[src];
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
    const byId = new Map();
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const metaPath = path.join(root, d.name, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch (_) { continue; }
      if (!meta.batch || !meta.batch.id) continue;
      const bid = meta.batch.id;
      if (!byId.has(bid)) {
        byId.set(bid, {
          batch_id: bid, source: meta.source || src,
          label: meta.batch.label || "",
          total: meta.batch.total || 0,   // intended size (rows submitted)
          createdAt: meta.createdAt || 0,
          members: [],
        });
      }
      const grp = byId.get(bid);
      // Batch label/total taken from the freshest member that carries them.
      if (meta.batch.label && !grp.label) grp.label = meta.batch.label;
      if ((meta.batch.total || 0) > grp.total) grp.total = meta.batch.total;
      if ((meta.createdAt || 0) && (!grp.createdAt || meta.createdAt < grp.createdAt)) grp.createdAt = meta.createdAt;
      grp.members.push({ ...genItemFromMeta(meta), batch_seq: (meta.batch.seq ?? null) });
    }
    const batches = Array.from(byId.values()).map(b => {
      b.members.sort((x, y) => (x.batch_seq ?? 0) - (y.batch_seq ?? 0));
      b.count = b.members.length;   // actually-present members (may be < total after deletes)
      return b;
    });
    batches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ ok: true, batches });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

router.post("/api/outputs/reveal", requireApiKey, (req, res) => {
  const g = resolveGenDir(req.body && (req.body.id || req.body.name), req.body && req.body.source);
  if (!g) return res.status(400).json({ error: "Invalid generation id" });
  if (!fs.existsSync(g.full)) {
    return res.status(404).json({ error: "Generation not found (it may have been cleaned)" });
  }
  let target = g.full;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(g.full, "meta.json"), "utf-8"));
    const primary = genBaseName(meta.audio_url || "");
    if (primary && fs.existsSync(path.join(g.full, primary))) target = path.join(g.full, primary);
  } catch (_) {}
  try {
    if (process.platform === "win32") {
      spawn("explorer", [`/select,${target}`], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      spawn("open", ["-R", target], { stdio: "ignore" });
    } else {
      spawn("xdg-open", [g.full], { stdio: "ignore" });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

router.delete("/api/outputs/:id", requireApiKey, (req, res) => {
  const g = resolveGenDir(req.params.id, req.query.source);
  if (!g) return res.status(400).json({ error: "Invalid generation id" });
  try {
    // Windows frequently holds a transient lock (EPERM/EBUSY) on a just-generated
    // or currently-loaded audio file (browser range stream, AV scanner, indexer),
    // which made a plain rmSync fail with a generic 500. Let rmSync retry, and on a
    // real failure log the errno + return an actionable message instead of masking it.
    if (fs.existsSync(g.full)) {
      fs.rmSync(g.full, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
    res.json({ ok: true, id: g.id });
  } catch (err) {
    console.error(`[OUTPUTS] delete failed ${g.full}: ${err.code || ""} ${err.message}`);
    const locked = err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "ENOTEMPTY");
    res.status(500).json({
      error: locked
        ? `Failed to delete audio (${err.code}) — the file is in use (likely still playing, or held by antivirus/Explorer). Stop playback and try again.`
        : `Failed to delete audio (${err.code || "error"})`,
    });
  }
});

router.post("/api/outputs/clear-all", requireApiKey, (req, res) => {
  try {
    let removed = 0, bytes = 0;
    const root = outputRoot((req.body && req.body.source) || req.query.source);
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = path.join(root, entry.name);
      try {
        for (const f of fs.readdirSync(p)) {
          try { bytes += fs.statSync(path.join(p, f)).size; } catch (_) {}
        }
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      } catch (e) {
        console.error(`[OUTPUTS] delete failed ${p}: ${e.message}`);
      }
    }
    console.log(`[OUTPUTS] clear-all removed ${removed} generation(s), freed ${bytes} bytes`);
    res.json({ ok: true, removed, bytes });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

  return router;
};
