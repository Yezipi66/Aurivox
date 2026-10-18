// Startup logic extracted from server.js (P0 refactor).
// Static file mounting, SPA catch-all, global JSON error handler,
// optional Flow/Flowgraph routes, and the app.listen() block.

const express = require("express");
const path = require("path");
const fs = require("fs");

function setupStatic(app, { ASSETS_DIR, OUTPUT_DIR, VOICES_DIR, WEB_DIST, safeStaticRoot }) {
  app.use("/assets", safeStaticRoot(ASSETS_DIR), express.static(ASSETS_DIR));
  app.use("/voices", safeStaticRoot(VOICES_DIR), express.static(VOICES_DIR));
  app.use("/outputs", safeStaticRoot(OUTPUT_DIR), (req, res, next) => {
    const rel = decodeURIComponent(req.path).replace(/^[\\/]+/, "");
    const filePath = path.resolve(OUTPUT_DIR, rel);
    if (!filePath.startsWith(OUTPUT_DIR + path.sep) && filePath !== OUTPUT_DIR) {
      return res.status(404).end();
    }
    if (!fs.existsSync(filePath)) return next();
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      if (start >= stat.size || end >= stat.size) {
        res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
        return;
      }
      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "audio/wav",
      });
      stream.pipe(res);
    } else {
      next();
    }
  }, express.static(OUTPUT_DIR));
}

function setupFrontend(app, { WEB_DIST, path, fs }) {
  app.use(express.static(WEB_DIST));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/outputs/") || req.path.startsWith("/v1/")) {
      return res.status(404).json({ error: "Not found" });
    }
    if (/\.[a-zA-Z0-9]+$/.test(req.path)) {
      return res.status(404).send("Not found: " + req.path);
    }
    const indexHtml = path.join(WEB_DIST, "index.html");
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.status(404).send("Frontend not built. Run: cd web && npm install && npm run build");
    }
  });
}

function setupErrorHandling(app, { clientError, localError }) {
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const MULTER_STATUS = { LIMIT_FILE_SIZE: 413, LIMIT_UNEXPECTED_FILE: 400,
      LIMIT_PART_COUNT: 400, LIMIT_FILE_COUNT: 400, LIMIT_FIELD_KEY: 400,
      LIMIT_FIELD_VALUE: 400, LIMIT_FIELD_COUNT: 400 };
    let status = (err && Number.isInteger(err.status)) ? err.status : 500;
    if (err && err.name === "MulterError") status = MULTER_STATUS[err.code] || 400;
    else if (err && err.type === "entity.too.large") status = 413;
    else if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) status = 400;
    else if (err && /Unsupported file type/i.test(err.message || "")) status = 400;
    const msg = status >= 500
      ? clientError(err, "Internal server error")
      : ((err && err.message) ? err.message : "Bad request");
    const code = (err && err.code) || (err && err.extra && err.extra.code) ||
      (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED");
    res.status(status).json({ code, message: msg, error: msg });
  });
}

function setupOptionalRoutes(app, ctx, { FLOWGRAPH_ENABLED, FLOW_ENABLED, FLOWGRAPH_DIR, console }) {
  if (String(FLOW_ENABLED || "").trim() && FLOW_ENABLED !== "0") {
    try {
      const { createFlowRuntime } = require("../workflow/runtime");
      const { generateService } = require("../services/synthesisService")(ctx);
      ctx.flowRuntime = createFlowRuntime(ctx, { generateService });
      app.use(require("../routes/flow")(ctx));
      console.log(`[flow] Aurivox Flow enabled — journal dir: ${ctx.flowRuntime.journalDir}`);
    } catch (err) {
      console.error(`[flow] FAILED to enable Aurivox Flow: ${err && err.message}`);
    }
  }
  if (String(FLOWGRAPH_ENABLED || "").trim() && FLOWGRAPH_ENABLED !== "0") {
    try {
      const { createFlowgraphService } = require("../flowgraph/service");
      const { generateService } = require("../services/synthesisService")(ctx);
      ctx.flowgraphService = createFlowgraphService(ctx, {
        generateService, concatWavFiles: ctx.concatWavFiles, rootDir: FLOWGRAPH_DIR,
      });
      app.use(require("../routes/flowgraph")(ctx));
      console.log(`[flowgraph] 画布已开启 — ${ctx.flowgraphService.nodeCatalogue().count} 个节点，输出目录: ${ctx.flowgraphService.outputDir}`);
    } catch (err) {
      console.error(`[flowgraph] 画布启动失败: ${err && err.message}`);
    }
  }
}

function startServer(app, opts) {
  const { PORT, HOST, API_KEY, checkFfmpeg, startCudaProbe, scanStagingTasks, assetsNeedScan, runFullAssetScan, console, PATHS } = opts;
  const server = app.listen(PORT, HOST, () => {
    console.log(`\n========================================`);
    console.log(`  TTS Voice Asset Manager`);
    console.log(`  http://${HOST}:${PORT}`);
    console.log(`  ffmpeg: ${checkFfmpeg() ? "available" : "not found (using pure-Node concat)"}`);
    startCudaProbe();
    if (!API_KEY) {
      console.log(`\n  note: no API_KEY set — local use (127.0.0.1) is unrestricted.`);
      console.log(`  A key is only needed for calls coming from another machine.`);
    }
    console.log(`========================================\n`);
    scanStagingTasks({ STAGING_ROOT: PATHS.STAGING_ROOT, console });
    (async () => {
      try {
        if (assetsNeedScan()) {
          console.log("[ASSETS] some voices are missing meta.json/segments.json; auto-scanning at startup...");
          const results = await runFullAssetScan();
          console.log(`[ASSETS] auto-scan complete: ${Object.keys(results).length} voice(s) ready`);
        } else {
          console.log("[ASSETS] asset metadata is ready; skipping auto-scan");
        }
      } catch (e) {
        console.error("[ASSETS] startup auto-scan failed:", e.message);
      }
    })();
  });
  return server;
}

module.exports = { setupStatic, setupFrontend, setupErrorHandling, setupOptionalRoutes, startServer };
