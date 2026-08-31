// ===========================
//  ROUTES: Voices CRUD + reference audio
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");
const { acceptedRequestKeys } = require("../engines/paramTable");
// ⭐ meta.assets.models 这层结构只许在一个地方拆包。
const { slotFromMeta } = require("../assets/modelLayout");
const { resolveEngineProfile } = require("../engines/profile");
const { listEngines } = require("../engines/registry");

// ⭐⭐⭐ 2026-08-31（刀 A1，Owner 12:22 裁决）：这里过去有 voiceKnobDefaults()，
//   新建音色时把「某一台引擎的旋钮默认值」逐键拷进 voices.json。**已删。**
//
//   Owner 原话：「参数哪里会有默认值，该填啥填啥，不归我们管」。
//   ⇒ 病根不是「默认值取自哪台名片」，是**平台根本不该保管一份默认值**。
//     值是名片上的，谁被选中就是谁的；拷出来的那一份从拷贝的那一刻起就开始
//     漂，而漂了**不报错** —— 症状是「新建音色的初始参数和高级设置里显示的
//     不一样」。
//
// ⛔ 禁令（契约 §12.10.1 ②）：不许把任何引擎的默认值**拷贝**进平台的存档
//    （voices.json / recipes / advanced_params.json）。存的只能是**用户真的
//    改过的那些值**；没改过的键**不存**，用的时候现问名片。

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
    // 引擎旋钮：**客户端给了才存**。⛔ 没给就不存这个键。
    // ⭐ 刀 A1：这里过去是 `for (旋钮默认值) voices[id][k] = entry[k] ?? def`
    //   —— 把某一台引擎的整张默认值表拷进这条音色。现在只留下用户真的
    //   写下来的那些键，其余的**缺席**，用的时候现问那台引擎的名片。
    //   ⇒ 「这条音色上没有 top_k」和「这条音色的 top_k 恰好等于名片默认值」
    //     从此是两件看得出区别的事。前者能跟着名片改，后者永远钉在拷贝的
    //     那一刻。
    for (const k of acceptedRequestKeys()) {
      if (entry[k] != null) voices[id][k] = entry[k];
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

// ---------------------------------------------------------------------------
//  「这个角色能不能开工」—— 按名片有几个模型位就问几个
// ---------------------------------------------------------------------------
// ⭐⭐⭐ 2026-08-30（刀 3）：这个接口过去固定回答两件事 ——
//     gpt_model_exists / sovits_model_exists
//   那不是"两个模型位"，那是**一台引擎的零件清单被抄进了平台**。它写死
//   `slotFromMeta(meta, "gpt-sovits", "gpt")`：换任何一台引擎，这两行要么恒为
//   false（界面上两个红叉，而那台引擎其实什么都不缺），要么答非所问
//   （IndexTTS2 只有一个位，界面却问它 SoVITS 在不在）。
//
//   现在：**几个位、叫什么名字，是这台引擎的名片说的**，平台一个位名都不认识。
//   ⛔ 平台不判断"齐不齐算不算够"—— 只如实报每个位上有没有文件。
//
// ⚠ 回答里保留 checks.slots[]（新形状）。老的两个键**不再造**——
//   它们只对某几台引擎为真，留着就是留一个会说谎的字段。
function weightSlotsOf(engineId) {
  try {
    const p = resolveEngineProfile(engineId);
    return Array.isArray(p.weight_slots) ? p.weight_slots : [];
  } catch (_) { return []; }
}

// 请求点名了就用点名的那台；没点名就把**装着的每一台**都答一遍 ——
// ⛔ 不挑一台代表：挑哪一台都是平台在替用户猜，而猜错的症状是红叉指错引擎。
function enginesToValidate(req) {
  const asked = req.query && req.query.engine_id ? String(req.query.engine_id) : "";
  if (asked) return [asked];
  try { return listEngines().map((m) => m.id); } catch (_) { return []; }
}

router.get("/api/voices/:id/validate", (req, res) => {
  const id = req.params.id;
  // Base model: models exist on disk (base weights); reference is always "borrow"
  // (missing until the user picks one from another voice).
  if (isBaseVoice(id)) {
    // 底模这一"角色"不是磁盘上的角色目录，它的候选来自引擎的全局底模位。
    // ⚠ baseCheckpoints() 今天仍然只知道 gpt/sovits 两个桶 —— 那是它自己的
    //   一笔账（引擎全局位置的发现规则），不在这一刀里。这里只做一件事：
    //   **不再把那两个桶当成平台的字段名往外发**。
    const cks = baseCheckpoints();
    const slots = [];
    for (const engineId of enginesToValidate(req)) {
      for (const s of weightSlotsOf(engineId)) {
        const bucket = Array.isArray(cks[s.name]) ? cks[s.name] : [];
        slots.push({ engine_id: engineId, name: s.name, label: s.label || s.name, present: bucket.length > 0 });
      }
    }
    return res.json({
      ok: true, voice: id,
      checks: {
        slots,
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
  // ⭐ 位名一个都不写死：问名片要，一个位一行，如实说有没有。
  const metaPath = path.join(ASSETS_DIR, id, "meta.json");
  let meta = null;
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch (e) { /* non-blocking */ }
  }
  const slots = [];
  for (const engineId of enginesToValidate(req)) {
    for (const s of weightSlotsOf(engineId)) {
      const list = meta ? slotFromMeta(meta, engineId, s.name) : [];
      let present = false;
      if (list.length > 0) { const b = pickBestCkpt(list); present = !!(b && fs.existsSync(b.path)); }
      slots.push({ engine_id: engineId, name: s.name, label: s.label || s.name, present });
    }
  }

  res.json({
    ok: true, voice: id,
    checks: {
      slots,
      reference_audio_exists: refAudioExists,
      reference_text_present: refTextPresent,
      reference_text_placeholder: false,
    },
  });
});

  return router;
};
