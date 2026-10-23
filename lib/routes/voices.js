//  音色档案与参考音频的路由：增删改查音色、上传与删除参考音频、校验角色的模型是否齐全。
//  server.js 的作用域符号由 `ctx` 注入，本模块不持有全局状态；
//  server.js 用 app.use(createRouter(ctx)) 挂载，完整路径保持不变。

const express = require("express");
const { acceptedRequestKeys } = require("../engines/paramTable");
// meta.assets.models 这层结构只在 lib/assets/modelLayout.js 拆包。
const { slotFromMeta } = require("../assets/modelLayout");
const { resolveEngineProfile } = require("../engines/profile");
const { listEngines } = require("../engines/registry");

// 新建音色时不把某一台引擎的旋钮默认值逐键拷进 voices.json。
// 参数的默认值归名片管：谁被选中就用谁的。拷出来的那一份从拷贝的那一刻起就开始漂，
// 而漂了不报错，症状是「新建音色的初始参数与高级设置里显示的不一样」。
// 平台的存档（voices.json / recipes / advanced_params.json）只存用户真的改过的值；
// 没改过的键不存，用的时候现问名片。

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
    // 内置的底模音色（默认项）与盘上的音色清单一起返回。
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
    // 引擎旋钮：客户端给了才存，没给就不存这个键。
    // 「这条音色上没有 top_k」与「这条音色的 top_k 恰好等于名片默认值」从此是两件
    // 看得出区别的事：前者能跟着名片改，后者永远钉在拷贝的那一刻。
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
    // 除了上面那些结构字段（名字、语言、模型、参考音频），其余一律：
    // 客户端提了就以客户端为准，没提就沿用盘上原值。
    // 按键列清单会把键漏掉，后果不是报错而是静默丢失：条件写错时，音色里还没有的
    // 参数会被直接扔掉，那个参数永远无法保存。
    // 放行范围 = 平台词 + 已装引擎认得的词 + 这个音色盘上已经有的键
    // （最后一项保证：不认识的旧字段不会因为一次 PUT 就消失）。
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

//  这个接口答的是「有几个位、每个位齐不齐」，不是一份零件清单：
//  几个位、叫什么名字，由这台引擎的名片决定，平台一个位名都不认识。
//  平台不判断「齐不齐算不算够」，只如实报每个位上有没有文件。
//  回答里保留 checks.slots[]；老的 gpt_model_exists / sovits_model_exists 两个键不再造，
//  它们只对某几台引擎为真，留着就是留一个会说谎的字段。
function weightSlotsOf(engineId) {
  try {
    const p = resolveEngineProfile(engineId);
    return Array.isArray(p.weight_slots) ? p.weight_slots : [];
  } catch (_) { return []; }
}

// 请求点名了就用点名的那台；没点名就把装着的每一台都答一遍，不挑一台代表：
// 挑哪一台都是平台在替用户猜，而猜错的症状是红叉指错引擎。
function enginesToValidate(req) {
  const asked = req.query && req.query.engine_id ? String(req.query.engine_id) : "";
  if (asked) return [asked];
  try { return listEngines().map((m) => m.id); } catch (_) { return []; }
}

router.get("/api/voices/:id/validate", (req, res) => {
  const id = req.params.id;
  // 底模：模型在盘上（底模权重），参考音频一律算「借用」
  // （用户从别的音色里挑一个之前，它都不存在）。
  if (isBaseVoice(id)) {
    // 底模这一「角色」不是磁盘上的角色目录，它的候选来自引擎的全局底模位。
    // baseCheckpoints() 只认它自己的两个桶（引擎全局位置的发现规则），
    // 这里不再把那两个桶当成平台的字段名往外发。
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

  // 参考音频从 segments.json 读，不从 voices.json 读。
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

  // 模型从 meta.json 读，不从 voices.json 读。
  // 位名一个都不写死：问名片要，一个位一行，如实说有没有。
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
