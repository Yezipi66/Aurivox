// ===========================================================================
// ROUTES: UVR5 vocal-separation models — availability + on-demand download.
// ===========================================================================
// GET  /api/uvr5/models             -> catalogue with per-model `installed` flag
// POST /api/uvr5/download           -> start a download job { models:[ids], source }
// GET  /api/uvr5/download/:jobId     -> poll job progress
//
// The download spawns lib/training/gsv-tools/uvr5/download_uvr5.py (stdlib urllib,
// HF primary + ModelScope fallback) and parses its `PROGRESS/DONE/FAIL` lines into
// a live in-memory job. Weights land in gsv-tools/uvr5/uvr5_weights/.

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const uvr5 = require("../training/gsv-tools/uvr5/uvr5_models");
const { getPythonPath, getCleanEnv } = require("../training/python_helper");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { spawn, requireApiKey } = ctx;

  const weightsDir = uvr5.defaultWeightsDir();
  const scriptPath = path.join(
    __dirname, "..", "training", "gsv-tools", "uvr5", "download_uvr5.py"
  );

  // In-memory download jobs (id -> job). Bounded: prune finished jobs > 1h old.
  const jobs = new Map();
  function pruneJobs() {
    const now = Date.now();
    for (const [id, j] of jobs) {
      if (j.finishedAt && now - j.finishedAt > 3600_000) jobs.delete(id);
    }
  }

  // GET /api/uvr5/models — labels/categories + installed/missing for the UI.
  router.get("/api/uvr5/models", (req, res) => {
    res.json({
      weightsDir,
      models: uvr5.catalogue(weightsDir),
    });
  });

  // POST /api/uvr5/download { models:[ids], source? } — start a job.
  router.post("/api/uvr5/download", requireApiKey, (req, res) => {
    pruneJobs();
    const body = req.body || {};
    const source = ["auto", "hf", "modelscope"].includes(body.source) ? body.source : "auto";
    const requested = Array.isArray(body.models) ? body.models : [];
    const models = [...new Set(requested)].filter((m) => uvr5.getModel(m));
    if (models.length === 0) {
      return res.status(400).json({ error: "No valid model ids to download." });
    }

    const jobId = crypto.randomBytes(8).toString("hex");
    const job = {
      id: jobId,
      status: "running",
      source,
      startedAt: Date.now(),
      finishedAt: null,
      models: Object.fromEntries(models.map((m) => [m, { status: "pending", pct: 0 }])),
      log: [],
      error: null,
    };
    jobs.set(jobId, job);

    const args = [scriptPath, "--source", source];
    for (const m of models) args.push("--model", m);

    const python = getPythonPath();
    let child;
    try {
      child = spawn(python, args, {
        cwd: path.dirname(scriptPath),
        env: getCleanEnv({}),
      });
    } catch (e) {
      job.status = "failed";
      job.error = String(e && e.message || e);
      job.finishedAt = Date.now();
      return res.status(500).json({ error: job.error, jobId });
    }

    const onLine = (line) => {
      if (!line) return;
      if (job.log.length < 500) job.log.push(line);
      // PROGRESS <model> <file> <pct>
      let m = line.match(/^PROGRESS\s+(\S+)\s+(\S+)\s+(\d+)/);
      if (m && job.models[m[1]]) {
        job.models[m[1]].status = "downloading";
        job.models[m[1]].pct = Math.max(job.models[m[1]].pct, parseInt(m[3], 10));
        job.models[m[1]].file = m[2];
        return;
      }
      m = line.match(/^DONE\s+(\S+)/);
      if (m && job.models[m[1]]) {
        job.models[m[1]].status = "done";
        job.models[m[1]].pct = 100;
        return;
      }
      m = line.match(/^FAIL\s+(\S+)\s*(.*)/);
      if (m && job.models[m[1]]) {
        job.models[m[1]].status = "failed";
        job.models[m[1]].error = m[2] || "download failed";
      }
    };

    let buf = "";
    const feed = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, idx).trim());
        buf = buf.slice(idx + 1);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => {
      job.status = "failed";
      job.error = String(e && e.message || e);
      job.finishedAt = Date.now();
    });
    child.on("close", (code) => {
      if (buf.trim()) onLine(buf.trim());
      const anyFailed = Object.values(job.models).some((v) => v.status === "failed");
      job.status = code === 0 && !anyFailed ? "completed" : "failed";
      if (job.status === "failed" && !job.error) {
        job.error = `download exited ${code}`;
      }
      job.finishedAt = Date.now();
      // Refresh installed flags snapshot.
      for (const id of Object.keys(job.models)) {
        job.models[id].installed = uvr5.isInstalled(weightsDir, id);
      }
    });

    res.json({ jobId, models });
  });

  // GET /api/uvr5/download/:jobId — poll progress.
  router.get("/api/uvr5/download/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json({
      id: job.id,
      status: job.status,
      source: job.source,
      models: job.models,
      error: job.error,
      log: job.log.slice(-40),
    });
  });

  return router;
};
