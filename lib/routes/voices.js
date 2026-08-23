// ===========================
//  ROUTES: Voices CRUD + reference audio
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");
// 契约 C11：参数表只有一份。音色里存的引擎旋钮，键名和默认值都问名片要。
const { findLegacyDefaultId } = require("../engines/legacyDefault");
const { engineParamDefaults, acceptedRequestKeys } = require("../engines/paramTable");

// 新建音色时要落盘哪些旋钮 + 它们的初值。
// ⛔ 不缓存：装了哪些引擎、环境变量拧到几，都是运行时事实。
// ⚠ 用老路径引擎的名片：音色这个概念今天还没有「属于哪台引擎」这一说
//   （那是契约 §12 第 2 步），而所有存量音色都是老路径引擎的。
function voiceKnobDefaults() {
  return engineParamDefaults(findLegacyDefaultId());
}

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { ASSETS_DIR, BASE_VOICE_DISPLAY, BASE_VOICE_ID, VOICES_DIR, _backupVoicesUnlocked, baseCheckpoints, clientError, customRefUpload, fs, isBaseVoice, loadVoices, path, pickBestCkpt, requireApiKey, resolveRefPath, safeId, saveVoices, upload, withVoicesLock } = ctx;

router.get("/api/voices", (req, res) => {
  try {
    const data = loadVoices();
    const voices = Object.entries(data).map(([id, cfg]) => ({
      id, display_name: cfg.display_name || id,
      language: cfg.language || cfg.text_lang || "unknown",
    }));
    // Surface the built-in Base model voice (default) alongside the disk roster.
    voices.unshift({ id: BASE_VOICE_ID, display_name: BASE_VOICE_DISPLAY, language: "auto", builtin: true });
    res.json({ voices });
  } catch (err) {
    res.status(500).json({ error: clientError(err, "Failed to read voices.json") });
  }
});

router.get("/api/voices/full", (req, res) => {
  const voices = loadVoices();
  res.json({ voices });
});

router.post("/api/voices", requireApiKey, async (req, res) => {
  const entry = req.body || {};
  const id = (entry.id || "").trim();
  if (!id) return res.status(400).json({ error: "Missing 'id' field" });
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id: only letters, numbers, underscore, hyphen allowed" });

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (voices[id]) {
      errStatus = 409;
      errBody = { error: `Voice '${id}' already exists` };
      return;
    }
    await _backupVoicesUnlocked();
    voices[id] = {
      display_name: entry.display_name || id, language: entry.language || "auto",
      prompt_lang: entry.prompt_lang || entry.language || "auto",
      text_lang: entry.text_lang || entry.language || "auto",
      gpt_model: entry.gpt_model || "", sovits_model: entry.sovits_model || "",
      reference_audio: entry.reference_audio || "", reference_text: entry.reference_text || "",
    };
    // 引擎旋钮：客户端给了就用，没给用名片上的默认值。
    // ⛔ 原来这里写死了 5 个键和 5 个默认值（cut5 / 15 / 1.0 / 1.0 / 1.35）——
    //    契约 C11 说的第 N 份参数表。默认值一旦和名片对不上，症状是「新建音色
    //    的初始参数和高级设置里显示的不一样」，而不会报任何错。
    for (const [k, def] of Object.entries(voiceKnobDefaults())) {
      voices[id][k] = entry[k] != null ? entry[k] : def;
    }
    saveVoices(voices);
    result = voices[id];
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, voice: result });
});

router.put("/api/voices/:id", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    await _backupVoicesUnlocked();
    const existing = voices[id];
    const e = req.body || {};
    voices[id] = {
      display_name: e.display_name ?? existing.display_name,
      language: e.language ?? existing.language,
      prompt_lang: e.prompt_lang ?? existing.prompt_lang,
      text_lang: e.text_lang ?? existing.text_lang,
      gpt_model: e.gpt_model ?? existing.gpt_model,
      sovits_model: e.sovits_model ?? existing.sovits_model,
      reference_audio: e.reference_audio ?? existing.reference_audio,
      reference_text: e.reference_text ?? existing.reference_text,
    };
    // 除了上面那些结构字段（名字/语言/模型/参考音频），其余一律：
    // 客户端提了就以客户端为准，没提就沿用盘上原值。
    //
    // ⛔ 原来这里是两份写死的清单（对象字面量里 5 个 + 循环里 10 个），
    //    合起来 15 个键。列漏一个的后果不是报错，是**静默丢失**：
    //    原来的循环条件是 `existing[key] !== undefined && e[key] === undefined`，
    //    也就是说一个音色里还没有 sample_steps 时，客户端 PUT 一个 sample_steps
    //    进来会被直接扔掉 —— 那个参数永远存不进去。这是这次顺手查出来的真缺陷。
    //
    // 放行范围 = 平台词 + 已装引擎认得的词 + 这个音色盘上已经有的键
    // （最后一项保证：我们不认识的旧字段不会因为一次 PUT 就消失）。
    const allowed = acceptedRequestKeys();
    for (const k of new Set([...Object.keys(existing), ...Object.keys(e)])) {
      if (k in voices[id]) continue;              // 结构字段，上面已处理
      if (!allowed.has(k) && !(k in existing)) continue;
      const v = e[k] !== undefined ? e[k] : existing[k];
      if (v !== undefined) voices[id][k] = v;
    }
    saveVoices(voices);
    result = voices[id];
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, voice: result });
});

router.delete("/api/voices/:id", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });

  let errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    await _backupVoicesUnlocked();
    delete voices[id];
    saveVoices(voices);
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id });
});

router.post("/api/voices/:id/reference-audio", requireApiKey, upload.single("audio"), async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    await _backupVoicesUnlocked();
    const filePath = path.join(VOICES_DIR, req.file.filename).replace(/\\/g, "/");
    voices[id].reference_audio = filePath;
    saveVoices(voices);
    result = filePath;
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, reference_audio: result });
});

router.post("/api/custom-ref-audio", requireApiKey, (req, res) => {
  customRefUpload.single("audio")(req, res, (err) => {
    if (err) return res.status(400).json({ error: clientError(err, "Upload failed") });
    if (!req.file) return res.status(400).json({ error: "No audio file uploaded" });
    res.json({
      ok: true,
      path: `voices/custom_refs/${req.file.filename}`,
      url: `/voices/custom_refs/${encodeURIComponent(req.file.filename)}`,
      name: req.file.originalname,
      size: req.file.size,
    });
  });
});

router.post("/api/voices/:id/aux-ref-audio", requireApiKey, upload.array("audio", 10), async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No audio files uploaded" });

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    await _backupVoicesUnlocked();
    const auxPaths = voices[id].aux_ref_audio_paths || [];
    for (const file of req.files) {
      const filePath = path.join(VOICES_DIR, file.filename).replace(/\\/g, "/");
      auxPaths.push(filePath);
    }
    voices[id].aux_ref_audio_paths = auxPaths;
    saveVoices(voices);
    result = auxPaths;
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, aux_ref_audio_paths: result });
});

router.delete("/api/voices/:id/aux-ref-audio/:index", requireApiKey, async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: "Invalid id" });
  const idx = parseInt(req.params.index, 10);

  let result, errStatus, errBody;
  await withVoicesLock(async () => {
    const voices = loadVoices();
    if (!voices[id]) {
      errStatus = 404;
      errBody = { error: `Voice '${id}' not found` };
      return;
    }
    const auxPaths = voices[id].aux_ref_audio_paths || [];
    if (idx < 0 || idx >= auxPaths.length) {
      errStatus = 400;
      errBody = { error: "Invalid index" };
      return;
    }
    await _backupVoicesUnlocked();
    const removed = auxPaths.splice(idx, 1);
    voices[id].aux_ref_audio_paths = auxPaths;
    saveVoices(voices);
    result = { removed: removed[0], aux_ref_audio_paths: auxPaths };
  });

  if (errStatus) return res.status(errStatus).json(errBody);
  res.json({ ok: true, id, ...result });
});

router.get("/api/voices/:id/validate", (req, res) => {
  const id = req.params.id;
  // Base model: models exist on disk (base weights); reference is always "borrow"
  // (missing until the user picks one from another voice).
  if (isBaseVoice(id)) {
    const cks = baseCheckpoints();
    return res.json({
      ok: true, voice: id,
      checks: {
        gpt_model_exists: cks.gpt.length > 0,
        sovits_model_exists: cks.sovits.length > 0,
        reference_audio_exists: false,
        reference_text_present: false,
        reference_text_placeholder: false,
      },
    });
  }
  const voices = loadVoices();
  const cfg = voices[id];
  if (!cfg) return res.status(404).json({ error: `Voice '${id}' not found` });

  // Check reference from segments.json (not voices.json)
  const segPath = path.join(ASSETS_DIR, id, "segments.json");
  let refAudioExists = false;
  let refTextPresent = false;
  if (fs.existsSync(segPath)) {
    try {
      const segData = JSON.parse(fs.readFileSync(segPath, "utf-8"));
      const first = (segData.segments || []).find(s => s.matched && (s.audio || s.audio_path || s.audio_filename));
      if (first) {
        const raw = first.audio || first.audio_path || first.audio_filename;
        const absPath = resolveRefPath(raw);
        refAudioExists = fs.existsSync(absPath);
        refTextPresent = !!first.text;
      }
    } catch (e) { /* non-blocking */ }
  }

  // Check models from meta.json (not voices.json)
  const metaPath = path.join(ASSETS_DIR, id, "meta.json");
  let gptModelExists = false;
  let sovitsModelExists = false;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const ckpts = meta?.assets?.checkpoints || {};
      const gptList = ckpts.gpt || [];
      const sovitsList = ckpts.sovits || [];
      if (gptList.length > 0) { const b = pickBestCkpt(gptList); gptModelExists = !!(b && fs.existsSync(b.path)); }
      if (sovitsList.length > 0) { const b = pickBestCkpt(sovitsList); sovitsModelExists = !!(b && fs.existsSync(b.path)); }
    } catch (e) { /* non-blocking */ }
  }

  res.json({
    ok: true, voice: id,
    checks: {
      gpt_model_exists: gptModelExists,
      sovits_model_exists: sovitsModelExists,
      reference_audio_exists: refAudioExists,
      reference_text_present: refTextPresent,
      reference_text_placeholder: false,
    },
  });
});

  return router;
};
