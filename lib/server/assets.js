'use strict'
//  资产域的服务层：资产扫描、底模体检、voice id 收集、生成产物管理、迁移任务。
//  这里只做数据整理与路径推算，不认识具体引擎；调用方是 server.js 的路由层。

const fs = require('fs');
const path = require('path');
// lib/paths.js 导出的名字是 ASSETS_ROOT（没有 ASSETS_DIR）：解构错名字拿到 undefined，资产目录就整个读不到。
const { ASSETS_ROOT: ASSETS_DIR, GSV_PRETRAINED_DIR } = require('../paths');
const { storedGeneration } = require('../engines/weightSummary');
const { resolveEngineProfile } = require('../engines/profile');

const BASE_VOICE_ID = "__base__";
const BASE_VOICE_DISPLAY = "Base model";
function isBaseVoice(id) { return id === BASE_VOICE_ID; }

function _mvFirstExisting(cands) {
  for (const rel of cands) { const fp = path.join(GSV_PRETRAINED_DIR, rel); try { if (fs.existsSync(fp)) return fp; } catch (_) {} }
  return null;
}
function normModelVersion(v) {
  const s = String(v || '').toLowerCase().replace(/[\s_-]/g, '');
  if (s === 'v2proplus') return 'v2ProPlus';
  if (s === 'v2pro') return 'v2Pro';
  return 'v2';
}
const _MV_BASE_REQ = {
  v2: [
    { label: 's2G', cands: ['v2/s2G2333k.pth', 'gsv-v2final/s2G2333k.pth', 'gsv-v2final-pretrained/s2G2333k.pth', 's2G2333k.pth', 'v1/s2G488k.pth', 'v2Pro/s2G488k.pth', 's2G488k.pth', 'gsv-v2final/s2G488k.pth'] },
    { label: 's2D', cands: ['v2/s2D2333k.pth', 'gsv-v2final/s2D2333k.pth', 'gsv-v2final-pretrained/s2D2333k.pth', 's2D2333k.pth', 'v1/s2D488k.pth', 'v2Pro/s2D488k.pth', 's2D488k.pth', 'gsv-v2final/s2D488k.pth'] },
  ],
  v2Pro: [
    { label: 's2G', cands: ['v2Pro/s2Gv2Pro.pth'] },
    { label: 's2D', cands: ['v2Pro/s2Dv2Pro.pth'] },
    { label: 'sv', cands: ['sv/pretrained_eres2netv2w24s4ep4.ckpt'] },
  ],
  v2ProPlus: [
    { label: 's2G', cands: ['v2ProPlus/s2Gv2ProPlus.pth', 'v2Pro/s2Gv2ProPlus.pth'] },
    { label: 's2D', cands: ['v2ProPlus/s2Dv2ProPlus.pth', 'v2Pro/s2Dv2ProPlus.pth'] },
    { label: 'sv', cands: ['sv/pretrained_eres2netv2w24s4ep4.ckpt'] },
  ],
};
const _MV_HARD = new Set(['v2Pro', 'v2ProPlus']);
function checkBaseModelsForVersion(v) {
  const version = normModelVersion(v);
  const reqs = _MV_BASE_REQ[version] || _MV_BASE_REQ.v2;
  const present = [], missing = [];
  for (const r of reqs) { (_mvFirstExisting(r.cands) ? present : missing).push(r.label); }
  const criticalMissing = missing.filter((m) => m === 's2G' || m === 's2D');
  const hard = _MV_HARD.has(version);
  const blocking = hard && criticalMissing.length > 0;
  const degraded = !blocking && missing.includes('sv');
  return { version, hard, ok: missing.length === 0, missing, present, criticalMissing, blocking, degraded };
}

function _baseS1Path() {
  return _mvFirstExisting([
    "v2/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
    "v1/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
    "gsv-v2final/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
    "gsv-v2final/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
    "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
  ]);
}
const _BASE_SOVITS_DEFS = [
  { version: "v2",        cands: ["v2/s2G2333k.pth", "gsv-v2final/s2G2333k.pth", "gsv-v2final-pretrained/s2G2333k.pth", "s2G2333k.pth", "v1/s2G488k.pth", "v2Pro/s2G488k.pth", "s2G488k.pth", "gsv-v2final/s2G488k.pth"] },
  { version: "v2Pro",     cands: ["v2Pro/s2Gv2Pro.pth"], default: true },
  { version: "v2ProPlus", cands: ["v2ProPlus/s2Gv2ProPlus.pth", "v2Pro/s2Gv2ProPlus.pth"] },
];
function baseCheckpoints() {
  const s1 = _baseS1Path();
  const gpt = s1
    ? [{ name: `${BASE_VOICE_DISPLAY}_s1`, path: s1.replace(/\\/g, "/"), steps: null, builtin: true, default: true }]
    : [];
  const sovits = [];
  for (const d of _BASE_SOVITS_DEFS) {
    const fp = _mvFirstExisting(d.cands);
    if (fp) sovits.push({ name: `${BASE_VOICE_DISPLAY}_${d.version}`, path: fp.replace(/\\/g, "/"), version: d.version, builtin: true, default: !!d.default });
  }
  return { gpt, sovits };
}

function baseModelsAll() {
  let profiles = [];
  try {
    const { listEngines } = require("../engines/registry");
    for (const e of (listEngines() || [])) {
      try { profiles.push(resolveEngineProfile(e.id || e)); } catch (_) { /* 跳过这一台 */ }
    }
  } catch (_) { return {}; }
  try {
    const { baseModelsByEngine } = require("../assets/baseModels");
    return baseModelsByEngine(profiles, {});
  } catch (_) { return {}; }
}
function baseVoiceMeta() {
  return {
    id: BASE_VOICE_ID,
    display_name: BASE_VOICE_DISPLAY,
    language: "auto", text_lang: "auto", prompt_lang: "auto",
    builtin: true,
    assets: { models: baseModelsAll(), references: [] },
    segment_total: 0, segment_matched: 0,
  };
}
function baseVoiceReg() {
  return { display_name: BASE_VOICE_DISPLAY, language: "auto", prompt_lang: "auto", text_lang: "auto", builtin: true };
}
function collectTakenVoiceIds({ loadVoices, assetId, trainingPipeline }) {
  const taken = new Set();
  const backed = new Set();
  taken.add(BASE_VOICE_ID);
  try {
    for (const e of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) { taken.add(e.name); backed.add(e.name); }
    }
  } catch (_) {}
  try { for (const k of Object.keys(loadVoices())) { taken.add(k); backed.add(k); } } catch (_) {}
  try {
    for (const t of (trainingPipeline.getAllTasks() || [])) {
      if (t && t.voiceId) { taken.add(t.voiceId); backed.add(t.voiceId); }
    }
  } catch (_) {}
  try { for (const id of assetId.listReservations()) taken.add(id); } catch (_) {}
  try { assetId.prune(backed); } catch (_) {}
  return taken;
}

// ---- 生成产物管理 ----
const { OUTPUT_ROOTS } = require('../paths');
function normSource(source) {
  const s = String(source || "generate").toLowerCase();
  if (s === "compare" || s === "comparerefs" || s === "compare_refs") return "comparerefs";
  if (s === "broker" || s === "openai" || s === "speech") return "broker";
  return "generate";
}
function outputRoot(source) { return OUTPUT_ROOTS[normSource(source)]; }
function genAssetDir(genId, source) { return path.join(outputRoot(source), genId); }
function writeGenMeta(genId, meta, source) {
  const dir = genAssetDir(genId, source || (meta && meta.source));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}
function resolveGenDir(id, source) {
  if (typeof id !== "string" || !id.trim()) return null;
  const base = path.basename(id.replace(/\\/g, "/"));
  if (!base || base === "." || base === "..") return null;
  const root = outputRoot(source);
  const full = path.join(root, base);
  if (!full.startsWith(root + path.sep)) return null;
  return { id: base, full, source: normSource(source) };
}
function genItemFromMeta(meta) {
  return {
    id: meta.id,
    source: meta.source || "generate",
    text: meta.text || "",
    voice: meta.voiceLabel || meta.voice || "",
    lang: meta.lang || "",
    ...storedGeneration(meta, resolveEngineProfile),
    segments: meta.segments || 1,
    createdAt: meta.createdAt || 0,
    audio_url: meta.audio_url || "",
    recipe_id: meta.recipe_id || null,
    batch: meta.batch || null,
    ref_audio: meta.ref_audio || "",
    duration: (typeof meta.duration === "number") ? meta.duration : null,
    segment_bounds: Array.isArray(meta.segment_bounds) ? meta.segment_bounds : null,
    seed: (typeof meta.seed === "number") ? meta.seed
        : (meta.recipe && typeof meta.recipe.seed === "number" ? meta.recipe.seed : null),
    params: meta.recipe || null,
  };
}

// ---- 资产扫描 ----
function assetsNeedScan() {
  try {
    if (!fs.existsSync(ASSETS_DIR)) return false;
    const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = path.join(ASSETS_DIR, e.name, "meta.json");
      const segPath = path.join(ASSETS_DIR, e.name, "segments.json");
      if (!fs.existsSync(metaPath) || !fs.existsSync(segPath)) return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

module.exports = {
  BASE_VOICE_ID,
  BASE_VOICE_DISPLAY,
  isBaseVoice,
  normModelVersion,
  checkBaseModelsForVersion,
  baseCheckpoints,
  baseModelsAll,
  baseVoiceMeta,
  baseVoiceReg,
  collectTakenVoiceIds,
  normSource,
  outputRoot,
  genAssetDir,
  writeGenMeta,
  resolveGenDir,
  genItemFromMeta,
  assetsNeedScan,
};
