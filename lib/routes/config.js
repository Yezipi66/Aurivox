// ===========================
//  ROUTES: Config + filesystem browse
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { ASSETS_DIR, ASSETS_ROOT, ASSETS_ROOT_SOURCE, CONFIG_FILE, crypto, fs, fsp, localError, migrationJobs, path, requireApiKey, runMigrationJob, writeConfig } = ctx;

router.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    assetsRoot: ASSETS_ROOT,
    assetsRootSource: ASSETS_ROOT_SOURCE, // 'env' | 'config' | 'default'
    configFile: CONFIG_FILE,
    envOverride: ASSETS_ROOT_SOURCE === "env",
    platform: process.platform,
  });
});

router.post("/api/config/assets-root", requireApiKey, async (req, res) => {
  const p = ((req.body && req.body.path) || "").trim();
  const migration = ((req.body && req.body.migration) || "switch").toLowerCase();
  if (!p) return res.status(400).json({ error: "path is required" });
  if (!path.isAbsolute(p)) return res.status(400).json({ error: "path must be absolute" });
  if (!["switch", "copy", "move"].includes(migration)) {
    return res.status(400).json({ error: "invalid migration mode" });
  }
  const target = path.resolve(p);
  if (target === path.resolve(ASSETS_DIR)) {
    return res.status(400).json({ error: "That is already the current assets directory." });
  }
  // Refuse copy/move into a directory nested under the current one (would recurse).
  const rel = path.relative(ASSETS_DIR, target);
  const targetInsideSource = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (targetInsideSource && migration !== "switch") {
    return res.status(400).json({ error: "Target is inside the current assets directory; choose a separate location." });
  }
  try {
    await fsp.mkdir(target, { recursive: true });
    await fsp.access(target, fs.constants.W_OK);
  } catch (err) {
    return res.status(400).json({ error: `Directory is not writable: ${localError(err)}` });
  }

  const verb = migration === "copy" ? "copied" : migration === "move" ? "moved" : "switched";
  const envOverride = ASSETS_ROOT_SOURCE === "env";
  const doneNote = envOverride
    ? `Data ${verb}, but the ASSETS_ROOT environment variable overrides the saved path. Unset it for the new directory to take effect.`
    : `Data ${verb}. Restart the server for the new assets directory to take effect.`;

  // "switch" is instant (no data movement) → stay synchronous.
  if (migration === "switch") {
    try {
      writeConfig({ assetsRoot: target });
      return res.json({ ok: true, assetsRoot: target, migration, needsRestart: true, envOverride, note: doneNote });
    } catch (err) {
      return res.status(500).json({ error: localError(err) });
    }
  }

  // copy/move can be slow and may stall on locked files → run as a background job
  // and expose a simple copy → verify → delete pipeline the UI can poll.
  let entries;
  try {
    entries = (await fsp.readdir(ASSETS_DIR, { withFileTypes: true }))
      .filter(e => e.name !== ".staging"); // never migrate transient staging
  } catch (err) {
    return res.status(500).json({ error: localError(err) });
  }

  const jobId = crypto.randomBytes(6).toString("hex");
  const job = {
    id: jobId, migration, target, phase: "copying",
    total: entries.length, current: 0, currentName: "",
    steps: { copy: "running", verify: migration === "move" ? "pending" : "skipped", delete: migration === "move" ? "pending" : "skipped" },
    error: null, done: false, assetsRoot: target, envOverride, note: null,
    startedAt: Date.now(),
  };
  migrationJobs.set(jobId, job);
  runMigrationJob(job, entries, doneNote); // fire-and-forget; polled via status endpoint

  res.json({ ok: true, async: true, jobId, migration, total: entries.length });
});

router.get("/api/config/migrate-status/:id", requireApiKey, (req, res) => {
  const job = migrationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Migration job not found (server may have restarted)." });
  res.json({ ok: true, ...job });
  // Reap finished jobs a little after they complete so status is still pollable.
  if (job.done && job.finishedAt && Date.now() - job.finishedAt > 60000) migrationJobs.delete(job.id);
});

router.get("/api/fs/browse", requireApiKey, async (req, res) => {
  try {
    let target = (req.query.path || "").toString().trim();
    const isWin = process.platform === "win32";

    // Windows with no path → enumerate drive letters (async access probes so a
    // slow/absent removable drive can't block the event loop).
    if (!target && isWin) {
      const letters = [];
      for (let c = 67; c <= 90; c++) letters.push(String.fromCharCode(c) + ":\\"); // C..Z
      const probes = await Promise.all(letters.map(root =>
        fsp.access(root).then(() => root).catch(() => null)
      ));
      const drives = probes.filter(Boolean).map(root => ({ name: root, path: root }));
      return res.json({ ok: true, path: "", parent: null, isDriveList: true, drives, dirs: [] });
    }
    if (!target) target = "/"; // POSIX root

    // Optional file-picking mode (PC): `?files=.ckpt,.pth` also lists files whose
    // extension matches, so the Broker page can pick a model file (not just a
    // folder). Absent → folder-only (unchanged, backward compatible).
    const fileExts = (req.query.files || "").toString().trim()
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
      .map(e => (e.startsWith(".") ? e : "." + e));

    target = path.resolve(target);
    let stat;
    try { stat = await fsp.stat(target); } catch (e) {
      return res.status(400).json({ error: `Cannot open "${target}": ${localError(e)}` });
    }
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: `Not a directory: ${target}` });
    }

    // Fully async + parallel so the event loop stays responsive. On Windows the
    // user profile is full of junctions (reparse points) whose per-entry stat can
    // throw EPERM; doing those in parallel (and only when the dirent type is
    // unknown/symlink) avoids the serial-exception stall that made this lag.
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const files = [];
    const resolved = await Promise.all(entries.map(async (entry) => {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) return { name: entry.name, path: full };
      // A symlink/junction may point at a directory — resolve it, but never pay
      // for an extra stat on plain files (the common case, always skipped).
      if (entry.isSymbolicLink()) {
        try { if ((await fsp.stat(full)).isDirectory()) return { name: entry.name, path: full }; } catch (_) {}
      }
      // File-picking mode: collect files matching the requested extensions.
      if (fileExts.length > 0 && (entry.isFile() || entry.isSymbolicLink())) {
        const ext = path.extname(entry.name).toLowerCase();
        if (fileExts.includes(ext)) files.push({ name: entry.name, path: full.replace(/\\/g, "/") });
      }
      return null;
    }));
    const dirs = resolved.filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    // parent: null when at a drive root (Windows) or filesystem root (POSIX),
    // in which case the frontend offers "up to drives" on Windows.
    const parentDir = path.dirname(target);
    const atRoot = parentDir === target;
    const parent = atRoot ? (isWin ? "" : null) : parentDir;

    res.json({ ok: true, path: target, parent, isDriveList: false, drives: [], dirs, files });
  } catch (err) {
    res.status(500).json({ error: localError(err) });
  }
});

router.post("/api/fs/mkdir", requireApiKey, async (req, res) => {
  try {
    const raw = ((req.body && req.body.path) || "").toString().trim();
    if (!raw) return res.status(400).json({ error: "path is required" });
    if (!path.isAbsolute(raw)) return res.status(400).json({ error: "path must be absolute" });
    const target = path.resolve(raw);
    await fsp.mkdir(target, { recursive: true });
    res.json({ ok: true, path: target });
  } catch (err) {
    res.status(500).json({ error: localError(err) });
  }
});

  return router;
};
