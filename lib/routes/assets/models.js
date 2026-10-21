// 按引擎分组的模型清单。平台在这条链路上不认识任何引擎名，目录里有什么就报什么。
const { engineModelsDir } = require("../../assets/modelLayout");
const { resolveEngineSlots, noteText } = require("../../assets/slotResolve");
const { listEngines } = require("../../engines/registry");
const { resolveEngineProfile } = require("../../engines/profile");

module.exports = function register(router, ctx) {
 const { ASSETS_DIR, assetScanner, baseVoiceMeta, clientError, fs, loadVoices, path, requireApiKey } = ctx;

// 必须注册在 "/api/assets/:id" 之前，否则 Express 会把这条字面量路径匹配到参数路由上
// （id = "voices-with-models"）。
//
// 这个接口按引擎分组原样端出来（按引擎分组是它唯一的形状要求）：
// models: { <引擎id>: { <权重位>: [ {name, path, size_mb, ...}, ... ] } }
// 顶层的 engines: [...] 是给界面做筛选用的：「这个角色有哪几台引擎的模型」。
router.get("/api/assets/voices-with-models", requireApiKey, (req, res) => {
 let voices;
 try { voices = loadVoices(); } catch (err) { return res.status(500).json({ error: clientError(err, "voices.json error") }); }

 const modelsOf = (voiceId, voiceDir) => {
 let m = null;
 try {
 const metaPath = path.join(voiceDir, "meta.json");
 if (fs.existsSync(metaPath)) {
 const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
 m = (meta && meta.assets && meta.assets.models) || null;
 }
 } catch (_) { /* fall through to live scan */ }
 if (!m || Object.keys(m).length === 0) {
 try {
 const fresh = assetScanner.scanVoiceDir(voiceId, voiceDir);
 m = (fresh && fresh.assets && fresh.assets.models) || null;
 } catch (_) { /* ignore unscannable asset */ }
 }
 return m || {};
 };
    // 扫盘那一层是纯目录驱动的：它报的键是「盘上有哪几个目录」，不保证是权重位名。
    // 用户没建权重位那一层，直接把一份模型摊在引擎目录下，于是那份模型自己的两个
    // 内部子目录被当成了两个权重位，十几个文件被整个丢掉，而且一个字都没说。
    // 归位要用到名片（有哪几个位、一份模型算齐要什么），所以只能在这一层做，不能塞回
    // 扫盘那一层（那一层不问名片是有意的）。规矩的唯一定义处：lib/assets/slotResolve.js。
 const engineSpecs = () => {
 const out = new Map();
 let manifests = [];
 try { manifests = listEngines(); } catch (_) { manifests = []; }
 for (const m of manifests) {
 if (!m || !m.id) continue;
 try {
 const p = resolveEngineProfile(m.id);
 out.set(p.id, {
 slots: Array.isArray(p.weight_slots) ? p.weight_slots : [],
 required: (p.models && Array.isArray(p.models.required)) ? p.models.required : [],
 });
 } catch (_) {
 }
 }
 return out;
 };

    // 一台平台不认识的引擎（盘上有目录、但没装这台引擎，或名片坏了）⇒ 原样端出扫描到的内容。
    // 不许因为「与名片不匹配」就把它隐藏：用户看得见目录却在界面上找不到。
 const reconcile = (voiceDir, models, specs) => {
 const outModels = {};
 const notes = [];
 for (const [engineId, scannedSlots] of Object.entries(models || {})) {
 const spec = specs.get(engineId);
 if (!spec || spec.slots.length === 0) { outModels[engineId] = scannedSlots; continue; }
 const r = resolveEngineSlots({
 scannedSlots,
 engineDir: engineModelsDir(voiceDir, engineId),
 slots: spec.slots,
 required: spec.required,
 });
 outModels[engineId] = r.bySlot;
 for (const n of r.notes) notes.push({ engine: engineId, ...n, text: noteText(n, engineId) });
 }
 return { models: outModels, notes };
 };

 const nonEmptyEngines = (models) => Object.keys(models)
 .filter(e => Object.values(models[e] || {}).some(list => Array.isArray(list) && list.length > 0))
 .sort();

 const out = [];
 const specs = engineSpecs();
 for (const [voiceId, reg] of Object.entries(voices)) {
 const voiceDir = path.join(ASSETS_DIR, voiceId);
 const raw = modelsOf(voiceId, voiceDir);
 const { models, notes } = reconcile(voiceDir, raw, specs);
 const engines = nonEmptyEngines(models);
    // 一份候选都没列出来、但有话要说（放错了一层、位名不对……）⇒ 照样把这个角色报出来，
    // 否则那句诊断没有任何地方可以出现。
 if (engines.length === 0 && notes.length === 0) continue;
 out.push({
 voiceId,
 displayName: (reg && (reg.display_name || reg.name)) || voiceId,
 engines,
 models,
 ...(notes.length ? { model_notes: notes } : {}),
 });
 }
 out.sort((a, b) => a.voiceId.localeCompare(b.voiceId));

    // 内置底模作为一个虚拟角色：盘上没有它的目录，元数据是现合成的。
    // 它在每台引擎的下拉里都该出现（底模是全局的，跟角色无关）。
 try {
 const meta = baseVoiceMeta();
 const bModels = (meta && meta.assets && meta.assets.models) || {};
 const bEngines = nonEmptyEngines(bModels);
 if (bEngines.length) {
 out.unshift({
 voiceId: meta.id,
 displayName: meta.display_name || meta.id,
 builtin: true,
 engines: bEngines,
 models: bModels,
 });
 }
 } catch (_) { /* base weights unavailable — omit */ }
 res.json({ voices: out });
});

 return router;
};
