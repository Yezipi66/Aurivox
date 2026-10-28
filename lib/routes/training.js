// 训练路由：/api/train/* 的启动、状态、审阅与续跑。
// 共享的服务端作用域符号由 ctx 注入，server.js 用 app.use(createRouter(ctx)) 挂载，
// 路径与处理流程与挂载前一致。

const express = require("express");
const { HttpError, asyncHandler } = require("../http/http");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { ALLOWED_LANGUAGES, ASSETS_DIR, TRAIN_DATA_ROOT, assetId, checkBaseModelsForVersion, clientError, collectTakenVoiceIds, fs, loadVoices, path, requireApiKey, safeId, sanitizeCustomParams, trainingPipeline, withVoicesLock } = ctx;

  // 训练启动服务。req.body 的字段：displayName 或 voiceId（显示名）、targetVoiceId（重训已有音色）、
  // language、inputDir、steps、customParams、overwrite、resumeTaskId、forkFromTaskId、restartFailedStep。
  // 成功返回 { ok: true, taskId, voiceId, displayName }；失败抛 HttpError。这个函数不碰 req/res，响应由下面的薄处理器适配。
  const trainStartService = async (req) => {
    const { voiceId: rawVoiceId, displayName: rawDisplayName, targetVoiceId,
            language, inputDir, steps: stepOptions, customParams, overwrite,
            resumeTaskId, forkFromTaskId, restartFailedStep } = req.body || {};
    // 建单表单发的是给人看的显示名。仍把 voiceId 当自由文本发来的老客户端也接受，
    // 但它被当作显示名参与 id 推导，不会直接当成 id 用。
    const displayName = String((rawDisplayName != null ? rawDisplayName : rawVoiceId) || "").trim();
    if (!displayName && !(resumeTaskId || forkFromTaskId) && !targetVoiceId) {
      throw new HttpError(400, "Missing 'displayName'");
    }
    if (!language) throw new HttpError(400, "Missing 'language'");

    // 恢复模式有两种：续跑（resumeTaskId）复用同一个 taskId 与工作目录，
    // 改参（forkFromTaskId）分叉出新任务并复用上游产物。恢复模式若不从 denoise/slice 起跑，
    // 原始 inputDir 可能已不存在，允许缺省；真正需要 inputDir 的早期步由下方门控拦截。
    const isRecovery = !!(resumeTaskId || forkFromTaskId);
    // 重跑起点：RESUME_STEP_ORDER 里第一个 enabled 的步骤。
    const RESUME_STEP_ORDER = ['denoise', 'slice', 'asr', 'preprocess', 'train_s1', 'train_s2', 'finalize', 'promote'];
    const stepEnabled = (k) => {
      const so = stepOptions || {};
      const dflt = { denoise: false, slice: true, asr: true, preprocess: true, train_s1: true, train_s2: true, finalize: true, promote: true };
      if (k === 'train_s1' || k === 'train_s2') return (so[k] ?? so.train ?? dflt[k]) !== false;
      return (so[k] ?? dflt[k]) !== false;
    };
    const rerunStart = RESUME_STEP_ORDER.find(stepEnabled) || null;
    const needsInputDir = !isRecovery || rerunStart === 'denoise' || rerunStart === 'slice';
    if (!inputDir && needsInputDir) {
      throw new HttpError(400, isRecovery
          ? "Input folder is required to resume from denoise/slice. Please re-select the original audio folder."
          : "Missing 'inputDir'",
        { code: isRecovery ? "INPUT_DIR_REQUIRED" : undefined });
    }

    // 音色 id 的生命周期：一次定好，之后不再变。
    // 三条来源，各自只走一条：
    //   恢复（续跑或分叉）：沿用源任务记下的 voiceId，不重新推导。
    //   指定 targetVoiceId：对已存在的音色重训或覆盖（需 overwrite:true 确认）。
    //   其余：新建音色，在临界区里按显示名分配一个全新的 ASCII id 并预留。
    // id 撞名或显示名重复都不表示可以覆盖已有音色。
    let publishId = null;              // 最终的音色 id
    let publishDisplayName = displayName || null;
    let reservedThisRequest = false;

    if (resumeTaskId || forkFromTaskId) {
      const srcId = resumeTaskId || forkFromTaskId;
      let j = null;
      try { j = trainingPipeline.readTaskJournal(srcId); } catch (_) {}
      if (!j || !j.voiceId) {
        throw new HttpError(400, `Cannot resume: source task '${srcId}' has no stored voice id.`,
          { code: "RESUME_NO_VOICEID" });
      }
      publishId = j.voiceId;
      publishDisplayName = publishDisplayName || j.displayName || publishId;
    } else if (targetVoiceId) {
      if (!safeId(targetVoiceId)) throw new HttpError(400, "Invalid targetVoiceId");
      const existDir = path.join(ASSETS_DIR, targetVoiceId);
      let existingDisplay = null;
      if (fs.existsSync(path.join(existDir, "meta.json"))) {
        try { existingDisplay = JSON.parse(fs.readFileSync(path.join(existDir, "meta.json"), "utf-8")).display_name || targetVoiceId; }
        catch (_) { existingDisplay = targetVoiceId; }
      } else {
        try { const vs = loadVoices(); if (vs[targetVoiceId]) existingDisplay = vs[targetVoiceId].display_name || targetVoiceId; } catch (_) {}
      }
      if (!existingDisplay) {
        throw new HttpError(404, `Target voice '${targetVoiceId}' does not exist.`, { code: "TARGET_NOT_FOUND" });
      }
      if (!overwrite) {
        throw new HttpError(409, `Retraining will overwrite the existing voice "${existingDisplay}" (id: ${targetVoiceId}). Confirm to proceed.`,
          { code: "VOICE_EXISTS", existingId: targetVoiceId, existingDisplay });
      }
      publishId = targetVoiceId;
      publishDisplayName = publishDisplayName || existingDisplay;
    } else {
      // 新建音色：分配并预留放在同一个临界区里，两个并发建单不会拿到同一个 id。
      publishId = await withVoicesLock(async () => {
        const taken = collectTakenVoiceIds({ loadVoices, assetId, trainingPipeline });
        const id = assetId.allocateVoiceId(displayName, taken);
        assetId.reserve(id);
        return id;
      });
      reservedThisRequest = true;
    }

    // 发布出来的资产至少要有一种参考音频：
    // 既不切片（slicer_opt/）也不把原始音频拷进资产（raw/），
    // 发布的资产就一份参考音频都没有。所以这一种组合直接拒绝。
    // copyRaw 默认开着。
    const willSlice = stepOptions?.slice !== false;
    const willCopyRaw = (stepOptions?.copyRaw ?? true) !== false;
    if (!willSlice && !willCopyRaw) {
      throw new HttpError(400, "At least one kind of reference audio is required: enable Slicing, or turn on “Copy raw into the asset”. Disabling both would publish an asset with no reference audio at all.",
        { code: "NO_REFERENCE_AUDIO" });
    }

    // 白名单校验 customParams
    const safeCustom = sanitizeCustomParams(customParams);

    // 底模门禁：要训练 S2(SoVITS) 时，逐一体检所有目标版本；
    // 任一 hard 版本（v2Pro/v2ProPlus）的关键底模缺失就拒绝，否则产出电流声。v2 可以回退，只警告。
    {
      const s2Enabled = ((stepOptions?.train_s2 ?? stepOptions?.train ?? true) !== false);
      if (s2Enabled) {
        const tv = safeCustom.training || {};
        const selVersions = (Array.isArray(tv.versions) && tv.versions.length) ? tv.versions
                          : (tv.version ? [tv.version] : ['v2']);
        const blocked = selVersions.map(checkBaseModelsForVersion).filter((r) => r.blocking);
        if (blocked.length) {
          throw new HttpError(412, `Base models missing for: ${blocked.map((b) => `${b.version} (${b.criticalMissing.join('+')})`).join(', ')}. `
                 + `Download them with download_models.py before training these versions.`,
            { code: "BASE_MODELS_MISSING", versions: blocked });
        }
      }
    }

    // 校验语种
    if (!ALLOWED_LANGUAGES.has(language)) {
      throw new HttpError(400, `Invalid language: ${language}. Allowed: ${[...ALLOWED_LANGUAGES].join(", ")}`);
    }

    // 校验 inputDir。配了 TRAIN_DATA_ROOT（发行或加固模式）时目录必须位于它之下；
    // 没配（本地工作台）时任何已存在的目录都可以。
    if (inputDir) {
      const resolved = path.resolve(inputDir);
      if (TRAIN_DATA_ROOT) {
        const root = path.resolve(TRAIN_DATA_ROOT);
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
          throw new HttpError(400, "inputDir must be under TRAIN_DATA_ROOT");
        }
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        // 恢复时若从需要 inputDir 的早期步起跑，目录缺失即拦下。
        if (needsInputDir) {
          throw new HttpError(400, isRecovery
              ? "The original audio folder no longer exists. Resuming from denoise/slice needs it — please re-select the source folder."
              : "inputDir does not exist or is not a directory",
            { code: isRecovery ? "INPUT_DIR_MISSING" : undefined });
        }
      }
    }

    console.log(`[TRAIN] Creating pipeline: voiceId=${publishId}, display=${publishDisplayName}, lang=${language}`);
    let pipeline;
    try {
      pipeline = trainingPipeline.createPipeline({
        voiceId: publishId,
        displayName: publishDisplayName,
        language,
        inputDir,
        stepOptions: stepOptions || {},
        customParams: safeCustom,
        resumeTaskId: resumeTaskId || null,
        forkFromTaskId: forkFromTaskId || null,
        restartFailedStep: !!restartFailedStep,
      });
    } catch (createErr) {
      // id 已分配但建管线失败：释放预留，否则这个 id 泄漏了
      // （它背后还没有任务与目录）。
      if (reservedThisRequest) { try { assetId.release(publishId); } catch (e) { console.warn("[train] failed to release asset id:", e.message); } }
      throw createErr;
    }
    console.log(`[TRAIN] Pipeline created: ${pipeline.id}${isRecovery ? ` (recovery of ${resumeTaskId || forkFromTaskId})` : ''}`);

    // 异步启动，不等待完成
    pipeline.start().catch(err => console.error("[TRAINING] Pipeline error:", err));
    console.log(`[TRAIN] Pipeline started, sending response`);

    // 预留在请求结束时不释放：id 在整个可恢复任务的生命周期内都保持预留。
    // 预留此时已被任务日志（getAllTasks）覆盖，collectTakenVoiceIds().prune()
    // 会在下次分配 id 时顺带清掉这个占位，前提是那个任务已经真正占住了这个 id。
    // id 真正释放的时机只有三种：显式删除、发布（目录接管了它）、
    // 失去可恢复资格。

    console.log(`[TRAIN] Response sent`);
    return { ok: true, taskId: pipeline.id, voiceId: publishId, displayName: publishDisplayName };
  };

  // 薄处理器：转给上面的服务。asyncHandler 把 HttpError 转成 res.status().json()，
  // 其余异常一律走 clientError 返回 500，
  // 与文件外层 catch 的 res.status(500).json({ error: clientError(err) }) 一致。
  router.post("/api/train/start", requireApiKey, asyncHandler(
    async (req) => trainStartService(req),
    (err) => { console.error("[TRAIN] Error:", err); return clientError(err); },
  ));

router.get("/api/train/status/:id", (req, res) => {
  const st = trainingPipeline.getStatusById(req.params.id);
  if (!st) return res.status(404).json({ error: "Task not found" });
  res.json(st);
});

router.post("/api/train/cancel/:id", requireApiKey, (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  task.cancel();
  res.json({ ok: true });
});

router.get("/api/train/review/:id", (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task || typeof task.getReviewList !== "function") return res.status(404).json({ error: "Task not found" });
  const data = task.getReviewList();
  if (!data) return res.status(404).json({ error: "No review list available (ASR not produced yet)" });
  res.json(data);
});

// 列出人声提取产物供试听（音频字节复用下方 /review/:id/audio 路由）。
router.get("/api/train/preview/:id/denoise", (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task || typeof task.getDenoisePreview !== "function") return res.status(404).json({ error: "Task not found" });
  res.json(task.getDenoisePreview());
});

router.get("/api/train/review/:id/audio", (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task || typeof task.resolveReviewAudioPath !== "function") return res.status(404).end();
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const filePath = task.resolveReviewAudioPath(rel);
  if (!filePath) return res.status(404).end();
  let stat;
  try { stat = fs.statSync(filePath); } catch { return res.status(404).end(); }
  const ext = path.extname(filePath).toLowerCase();
  const mime = { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".ogg": "audio/ogg" }[ext] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    if (isNaN(start) || start >= stat.size || end >= stat.size) {
      return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": stat.size, "Accept-Ranges": "bytes", "Content-Type": mime });
    fs.createReadStream(filePath).pipe(res);
  }
});

router.post("/api/train/review/:id", requireApiKey, (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task || typeof task.saveReviewList !== "function") return res.status(404).json({ error: "Task not found" });
  try {
    const rows = (req.body && req.body.rows) || [];
    const result = task.saveReviewList(rows);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: clientError(err) });
  }
});

router.post("/api/train/resume/:id", requireApiKey, (req, res) => {
  const task = trainingPipeline.getTask(req.params.id);
  if (!task || typeof task.resume !== "function") return res.status(404).json({ error: "Task not found" });
  // 若同时带了 rows，则先保存再放行，省一次往返。
  try {
    if (req.body && Array.isArray(req.body.rows) && typeof task.saveReviewList === "function") {
      task.saveReviewList(req.body.rows);
    }
  } catch (err) {
    return res.status(400).json({ error: clientError(err) });
  }
  const ok = task.resume();
  if (!ok) return res.status(409).json({ error: "Task is not awaiting review" });
  res.json({ ok: true });
});

router.get("/api/train/logs/:id", (req, res) => {
  const logs = trainingPipeline.getLogsById(req.params.id);
  if (logs === null) return res.status(404).json({ error: "Task not found" });
  res.json({ logs });
});

router.get("/api/train/tasks", (req, res) => {
  res.json({ tasks: trainingPipeline.getAllTasks() });
});

router.get("/api/train/recoverable", (req, res) => {
  try {
    const list = typeof trainingPipeline.listRecoverable === "function"
      ? trainingPipeline.listRecoverable() : [];
    res.json({ tasks: list });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

router.post("/api/train/clear-staging", requireApiKey, (req, res) => {
  try {
    const STAGING_ROOT = trainingPipeline.STAGING_ROOT;
    if (!STAGING_ROOT || !fs.existsSync(STAGING_ROOT)) {
      return res.json({ ok: true, removed: 0, bytes: 0, skipped: 0 });
    }

    // 收集受保护的任务 id：内存中处于 running/pending 状态的任务。
    const protectedIds = new Set();
    for (const t of trainingPipeline.getAllTasks()) {
      if (t && (t.status === 'running' || t.status === 'pending')) protectedIds.add(t.id);
    }

    const dirSize = (dir) => {
      let total = 0;
      const stack = [dir];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const p = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(p);
          else { try { total += fs.statSync(p).size; } catch (_) {} }
        }
      }
      return total;
    };

    let removed = 0, bytes = 0, skipped = 0;
    for (const entry of fs.readdirSync(STAGING_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(STAGING_ROOT, entry.name);
      if (protectedIds.has(entry.name)) { skipped++; continue; }

      // 二级保护：task.json 标记为运行中或待处理的目录不删。
      const taskJson = path.join(dir, 'task.json');
      if (fs.existsSync(taskJson)) {
        try {
          const data = JSON.parse(fs.readFileSync(taskJson, 'utf-8'));
          if (data.status === 'running' || data.status === 'pending') { skipped++; continue; }
        } catch (_) { /* 损坏的 task.json 视为可清理 */ }
      }

      try {
        bytes += dirSize(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch (e) {
        skipped++;
        console.error(`[CLEAR-STAGING] failed to remove ${dir}:`, e.message);
      }
    }

    console.log(`[CLEAR-STAGING] removed ${removed} staging dir(s), freed ${bytes} byte(s), skipped ${skipped}`);
    res.json({ ok: true, removed, bytes, skipped });
  } catch (err) {
    console.error("[CLEAR-STAGING] Error:", err);
    res.status(500).json({ error: clientError(err) });
  }
});

  return router;
};
