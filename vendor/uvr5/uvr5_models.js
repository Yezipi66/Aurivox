// ===========================================================================
// UVR5 model registry — single source of truth for vocal-separation models.
// ===========================================================================
// Consumed by:
//   * lib/training/steps/denoise.js       — resolve a pipeline stage -> weight path
//   * lib/routes/uvr5.js                  — availability (installed?) + download
//   * server.js sanitizeCustomParams      — validate pipeline[].model ids
//   * web (via GET /api/uvr5/models)       — labels/categories/availability
//
// Design notes
// ------------
// * `id` is the STABLE key stored in the training recipe / step fingerprint.
//   Never rename an id (it would break resume/rerun detection); add a new one.
// * `arch` mirrors uvr5_cli.py::_build_separator selection:
//     'vr'       -> AudioPre / AudioPreDeEcho (agg applies)
//     'mdx'      -> MDXNetDereverb (onnx folder; agg ignored)
//     'roformer' -> Roformer_Loader (ckpt + yaml; agg ignored)
// * `files` are RELATIVE to the uvr5_weights/ dir. A model is "installed" iff
//   every file exists. `weightArg` is what denoise.js passes as uvr5_cli --model
//   (for onnx it is the FOLDER; uvr5_cli derives the model_name from its basename).
// * agg (0..20) only makes sense for VR models; the UI hides it otherwise.

const path = require('path');
const fs = require('fs');

// Category ids map 1:1 to the official webui grouping.
const CATEGORIES = {
  keep_vocals: { en: 'Keep vocals', zh: '保留人声' },
  main_vocal: { en: 'Only main vocal', zh: '仅保留主人声' },
  dereverb: { en: 'De-reverb / de-echo', zh: '去混响 / 去延迟' },
};

// Ordered so the UI groups render naturally (keep -> main -> dereverb).
const MODELS = [
  {
    id: 'HP2',
    label: { en: 'HP2 — vocal remover', zh: 'HP2（保留人声）' },
    category: 'keep_vocals',
    arch: 'vr',
    aggApplicable: true,
    files: ['HP2_all_vocals.pth'],
    weightArg: 'HP2_all_vocals.pth',
    note: {
      en: 'Best main-vocal preservation for material WITHOUT harmony.',
      zh: '不带和声的音频选这个，对主人声保留最好。',
    },
  },
  {
    id: 'HP3',
    label: { en: 'HP3 — vocal remover', zh: 'HP3（保留人声）' },
    category: 'keep_vocals',
    arch: 'vr',
    aggApplicable: true,
    files: ['HP3_all_vocals.pth'],
    weightArg: 'HP3_all_vocals.pth',
    note: {
      en: 'Slightly better vocal preservation than HP2; may leak a little instrumental.',
      zh: '对主人声保留比 HP2 稍好，但可能轻微漏伴奏。',
    },
  },
  {
    id: 'HP5',
    label: { en: 'HP5 — only main vocal', zh: 'HP5（仅主人声）' },
    category: 'main_vocal',
    arch: 'vr',
    aggApplicable: true,
    files: ['HP5_only_main_vocal.pth'],
    weightArg: 'HP5_only_main_vocal.pth',
    note: {
      en: 'For material WITH harmony; may weaken the main vocal.',
      zh: '带和声的音频选这个，对主人声可能有削弱。',
    },
  },
  {
    id: 'MDX-Net',
    label: { en: 'MDX-Net (de-reverb)', zh: 'MDX-Net（去混响）' },
    category: 'dereverb',
    arch: 'mdx',
    aggApplicable: false,
    // Folder model (onnx). MDXNetDereverb hardcodes vocals.onnx inside this dir.
    files: ['onnx_dereverb_By_FoxJoy/vocals.onnx'],
    weightArg: 'onnx_dereverb_By_FoxJoy',
    note: {
      en: 'Best for STEREO reverb; cannot remove mono reverb. Note: MDX-Net is very memory-hungry and prone to GPU out-of-memory (OOM); the default segment length targets a 4 GB GPU. On OOM it automatically falls back to CPU (slower). Torch-native Roformer / HP / DeEcho models are lighter on VRAM.',
      zh: '对双声道混响最佳，不能去除单声道混响。注意：MDX-Net 非常吃显存、极易触发显存不足（OOM），默认分段长度以 4 GB 显存为基准；发生 OOM 时会自动回退到 CPU（较慢）。Torch 原生的 Roformer / HP / DeEcho 系列对显存更友好。',
    },
  },
  {
    id: 'DeEcho-Normal',
    label: { en: 'DeEcho-Normal', zh: 'DeEcho-Normal（去延迟）' },
    category: 'dereverb',
    arch: 'vr',
    aggApplicable: true,
    files: ['VR-DeEchoNormal.pth'],
    weightArg: 'VR-DeEchoNormal.pth',
    note: { en: 'Removes echo (normal strength).', zh: '去除延迟（普通强度）。' },
  },
  {
    id: 'DeEcho-Aggressive',
    label: { en: 'DeEcho-Aggressive', zh: 'DeEcho-Aggressive（激进去延迟）' },
    category: 'dereverb',
    arch: 'vr',
    aggApplicable: true,
    files: ['VR-DeEchoAggressive.pth'],
    weightArg: 'VR-DeEchoAggressive.pth',
    note: {
      en: 'Removes echo more thoroughly than Normal.',
      zh: '比 Normal 去除得更彻底。',
    },
  },
  {
    id: 'DeEcho-DeReverb',
    label: { en: 'DeEcho-DeReverb', zh: 'DeEcho-DeReverb（去延迟去混响）' },
    category: 'dereverb',
    arch: 'vr',
    aggApplicable: true,
    files: ['VR-DeEchoDeReverb.pth'],
    weightArg: 'VR-DeEchoDeReverb.pth',
    note: {
      en: 'Also removes mono reverb; ~2x slower than the other DeEcho models.',
      zh: '额外去除混响，可去单声道混响；耗时约为其它 DeEcho 的 2 倍。',
    },
  },
  {
    id: 'BS-Roformer',
    label: { en: 'BS-Roformer (large)', zh: 'BS-Roformer（大模型）' },
    category: 'dereverb',
    arch: 'roformer',
    aggApplicable: false,
    // ckpt only — bsroformer.py detects the arch from the name and ships a
    // built-in default config for exactly this ep_317 checkpoint, so no yaml.
    files: ['model_bs_roformer_ep_317_sdr_12.9755.ckpt'],
    weightArg: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
    heavy: true, // 304.9 MB weight; UI may warn.
    note: {
      en: 'Roformer-based separation. Weight is about 305 MB; config auto (built-in default).',
      zh: '基于 Roformer 的分离。权重约 305 MB；配置自动选用内置默认值。',
    },
  },
  {
    // Second Roformer the OFFICIAL GPT-SoVITS uvr5 exposes. bsroformer.py detects
    // the arch from the filename ("melbandroformer") and ships a built-in default
    // config for this checkpoint, so NO .yaml is needed. The canonical weight is
    // KimberleyJSN/melbandroformer -> MelBandRoformer.ckpt (user-confirmed source).
    id: 'Mel-Band-Roformer',
    label: { en: 'Mel-Band Roformer (large)', zh: 'Mel-Band Roformer（大模型）' },
    category: 'main_vocal',
    arch: 'roformer',
    aggApplicable: false,
    files: ['MelBandRoformer.ckpt'],
    weightArg: 'MelBandRoformer.ckpt',
    heavy: true, // 870.8 MB weight; UI may warn.
    note: {
      en: 'Roformer-based main-vocal isolation. Weight is about 871 MB; config auto (built-in default).',
      zh: '基于 Roformer 的主人声分离。权重约 871 MB；配置自动选用内置默认值。',
    },
  },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

// Legacy denoiseModel string values -> registry id. The pre-pipeline UI shipped a
// single dropdown whose only value was 'mdx-net', which denoise.js mapped to the
// HP2 weight. Preserve that behaviour when reading old recipes.
const LEGACY_MODEL_ALIASES = {
  'mdx-net': 'HP2',
  'HP2_all_vocals.pth': 'HP2',
  'HP2_all_vocals': 'HP2',
  'HP3_all_vocals.pth': 'HP3',
  'HP5_only_main_vocal.pth': 'HP5',
};

function allIds() {
  return MODELS.map((m) => m.id);
}

function getModel(id) {
  return BY_ID.get(id) || null;
}

// Normalise a raw model reference (id OR legacy string) to a known id, or null.
function normalizeModelId(ref) {
  if (!ref) return null;
  if (BY_ID.has(ref)) return ref;
  return LEGACY_MODEL_ALIASES[ref] || null;
}

// Weights live under <weightsDir>/<arch>/ so that the three architectures are
// not piled into one flat directory. The sub-directory is DERIVED from the
// model's own `arch` field -- it is never written into `files` / `weightArg`,
// because repeating the same fact in ten places guarantees the eleventh entry
// gets it wrong. Add a model, and it lands in the right place by construction.
//
// Note the directory names are vr / roformer / mdx and nothing else: the
// python loaders match substrings against the path they are handed, so a
// directory called bs_roformer/ would make every Roformer weight underneath it
// load as BS-Roformer -- silently, and with a forgiving state_dict loader, so
// the result is audible garbage rather than an error.
function archDir(weightsDir, m) {
  return path.join(weightsDir, m.arch);
}

// Every declared file, relative to weightsDir, WITH the architecture directory
// in front. This is the one place that knows the layout: installation checks,
// error messages and test fixtures all read it, so they cannot drift apart.
function modelFiles(id) {
  const m = getModel(id);
  if (!m) return [];
  return m.files.map((f) => path.join(m.arch, f));
}

// Absolute path of the primary weight arg passed to uvr5_cli --model.
function resolveWeightArg(weightsDir, id) {
  const m = getModel(id);
  if (!m) return null;
  return path.join(archDir(weightsDir, m), m.weightArg);
}

// A model is installed iff every declared file exists under weightsDir.
function isInstalled(weightsDir, id) {
  if (!getModel(id)) return false;
  return modelFiles(id).every((f) => fs.existsSync(path.join(weightsDir, f)));
}

// Which declared files are missing, relative to weightsDir and including the
// architecture directory, so the message can be followed literally.
function missingFiles(weightsDir, id) {
  return modelFiles(id).filter((f) => !fs.existsSync(path.join(weightsDir, f)));
}

// Serialisable catalogue for the API (labels + availability), P3-Roformer included.
function catalogue(weightsDir, { includeHeavy = true } = {}) {
  return MODELS.filter((m) => includeHeavy || !m.heavy).map((m) => ({
    id: m.id,
    label: m.label,
    category: m.category,
    categoryLabel: CATEGORIES[m.category],
    arch: m.arch,
    aggApplicable: m.aggApplicable,
    heavy: !!m.heavy,
    note: m.note,
    // Expert knobs this model actually supports (source-verified per arch).
    expertParams: expertParamsFor(m.arch).map((k) => ({ key: k, ...EXPERT_PARAMS[k] })),
    installed: weightsDir ? isInstalled(weightsDir, m.id) : false,
    missing: weightsDir ? missingFiles(weightsDir, m.id) : m.files.slice(),
  }));
}

// Default weights dir shipped with the training tools.
// 权重位置由 lib/paths.js 统一裁定，不再按本文件自身位置推断：代码已迁到
// vendor/uvr5/ 而权重仍在旧处，「权重就在我旁边」这个假设不再成立。
function defaultWeightsDir() {
  return require('../../lib/paths').UVR5_WEIGHTS_DIR;
}

const MAX_PIPELINE_STAGES = 3;
const AGG_MIN = 0;
const AGG_MAX = 20;
const AGG_DEFAULT = 10;

// ---------------------------------------------------------------------------
// Expert parameters — the REAL, source-verified knobs each separator exposes.
// (See vr.py / mdxnet.py / bsroformer.py.) They differ by architecture, so the
// canonical stage carries only the params applicable to its model's arch.
//   vr       : agg (normal) + tta, postprocess, highEnd, precision (expert)
//   mdx      : chunks, precision (expert)  [no agg]
//   roformer : overlap, batchSize, precision (expert)  [no agg]
// `precision` is the only expert knob common to all archs.
// ---------------------------------------------------------------------------
const PRECISIONS = ['fp32', 'fp16'];
const PRECISION_DEFAULT = 'fp32';
const HIGH_END_MODES = ['mirroring', 'bypass', 'none'];
const HIGH_END_DEFAULT = 'mirroring';

const EXPERT_PARAMS = {
  precision: { archs: ['vr', 'mdx', 'roformer'], type: 'enum', values: PRECISIONS, default: PRECISION_DEFAULT },
  tta: { archs: ['vr'], type: 'bool', default: false },
  postprocess: { archs: ['vr'], type: 'bool', default: false },
  highEnd: { archs: ['vr'], type: 'enum', values: HIGH_END_MODES, default: HIGH_END_DEFAULT },
  // MDX-Net is very OOM-prone; `chunks` is its segment length (seconds; the demix
  // window fed per pass). The default (8) targets a 4 GB GPU — larger cards can
  // safely raise it for more context/speed. Keep this default in sync with the UI
  // spec in web/src/components/train/TrainingTab.jsx (EXPERT_META.chunks).
  chunks: { archs: ['mdx'], type: 'int', min: 5, max: 40, default: 8 },
  overlap: { archs: ['roformer'], type: 'int', min: 1, max: 8, default: 2 },
  batchSize: { archs: ['roformer'], type: 'int', min: 1, max: 16, default: 2 },
};

// Ordered param keys applicable to a given arch (normal 'agg' handled separately).
function expertParamsFor(arch) {
  return Object.keys(EXPERT_PARAMS).filter((k) => EXPERT_PARAMS[k].archs.includes(arch));
}

function clampAgg(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return AGG_DEFAULT;
  return Math.min(AGG_MAX, Math.max(AGG_MIN, n));
}

function clampInt(v, min, max, def) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Resolve one expert param value against its spec (coerce + clamp + fallback).
function resolveExpertValue(key, raw) {
  const spec = EXPERT_PARAMS[key];
  if (!spec) return undefined;
  if (raw == null) return spec.default;
  if (spec.type === 'bool') return raw === true || raw === 'true' || raw === 1 || raw === '1';
  if (spec.type === 'enum') return spec.values.includes(raw) ? raw : spec.default;
  if (spec.type === 'int') return clampInt(raw, spec.min, spec.max, spec.default);
  return spec.default;
}

// Normalise arbitrary input (new pipeline array OR legacy {model} string) into a
// clean, validated pipeline. Each stage carries: { model, [agg], <expert params
// applicable to that arch> }. Unknown/empty models are dropped. Returns [] when
// nothing usable (caller treats as "off"). Shared by the server validator and
// denoise.js so both agree on the canonical shape (fingerprint stability).
function normalizePipeline(input) {
  let stages = [];
  if (Array.isArray(input)) {
    stages = input;
  } else if (input && Array.isArray(input.pipeline)) {
    stages = input.pipeline;
  } else if (input && input.model != null) {
    stages = [{ model: input.model, agg: input.agg }];
  } else if (typeof input === 'string') {
    stages = [{ model: input }];
  }
  const out = [];
  for (const s of stages) {
    if (out.length >= MAX_PIPELINE_STAGES) break;
    const id = normalizeModelId(s && (s.model != null ? s.model : s.id));
    if (!id) continue;
    const m = getModel(id);
    const stage = { model: id };
    if (m.aggApplicable) stage.agg = (s && s.agg != null) ? clampAgg(s.agg) : AGG_DEFAULT;
    for (const key of expertParamsFor(m.arch)) {
      stage[key] = resolveExpertValue(key, s ? s[key] : undefined);
    }
    out.push(stage);
  }
  return out;
}

module.exports = {
  CATEGORIES,
  MODELS,
  allIds,
  getModel,
  normalizeModelId,
  resolveWeightArg,
  modelFiles,
  isInstalled,
  missingFiles,
  catalogue,
  defaultWeightsDir,
  normalizePipeline,
  clampAgg,
  clampInt,
  resolveExpertValue,
  expertParamsFor,
  EXPERT_PARAMS,
  PRECISIONS,
  PRECISION_DEFAULT,
  HIGH_END_MODES,
  HIGH_END_DEFAULT,
  MAX_PIPELINE_STAGES,
  AGG_MIN,
  AGG_MAX,
  AGG_DEFAULT,
  LEGACY_MODEL_ALIASES,
};
