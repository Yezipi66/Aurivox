// UVR5 人声分离模型的登记表，是这一类模型的唯一事实来源。
// 消费方：lib/training/steps/denoise.js（把流水线阶段解析成权重路径）、lib/routes/uvr5.js
// （是否已安装与下载）、lib/server/trainingParams.js（校验流水线里的模型 id）、
// web 前端（经 GET /api/uvr5/models 取标签、分类与可用状态）。
//
// 约定：
// * id 是训练配方与步骤指纹里存的稳定键。改 id 会让续跑与重跑的识别失效，要加模型就加新 id。
// * arch 对应 uvr5_cli.py 的 _build_separator 分支：
//   vr 走 AudioPre / AudioPreDeEcho（agg 有效）；mdx 走 MDXNetDereverb（onnx 目录，agg 无效）；
//   roformer 走 Roformer_Loader（ckpt 加 yaml，agg 无效）。
// * files 相对 uvr5_weights/ 目录。模型「已安装」的条件是每个文件都存在。
//   weightArg 是 denoise.js 传给 uvr5_cli --model 的值（onnx 那一项传的是目录，
//   uvr5_cli 从目录名推出模型名）。
// * agg 取值 0 到 20，只对 VR 架构有意义，界面对其他架构不显示这个旋钮。

const path = require('path');
const fs = require('fs');

// 分类 id 与官方 webui 的分组一一对应。
const CATEGORIES = {
  keep_vocals: { en: 'Keep vocals', zh: '保留人声' },
  main_vocal: { en: 'Only main vocal', zh: '仅保留主人声' },
  dereverb: { en: 'De-reverb / de-echo', zh: '去混响 / 去延迟' },
};

// 顺序让界面的分组自然呈现：保留人声、仅主人声、去混响。
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
    // 目录型模型（onnx）。MDXNetDereverb 在这个目录里写死读 vocals.onnx。
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
    // 只有 ckpt：bsroformer.py 从文件名识别架构，并为这一个 ep_317 权重内置默认配置，所以不需要 yaml。
    files: ['model_bs_roformer_ep_317_sdr_12.9755.ckpt'],
    weightArg: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
    heavy: true, // 权重约 305 MB，界面可能给出提示。
    note: {
      en: 'Roformer-based separation. Weight is about 305 MB; config auto (built-in default).',
      zh: '基于 Roformer 的分离。权重约 305 MB；配置自动选用内置默认值。',
    },
  },
  {
    // 官方 GPT-SoVITS 的 uvr5 提供的第二个 Roformer。bsroformer.py 从文件名（melbandroformer）
    // 识别架构，并为这个权重内置默认配置，所以不需要 .yaml。
    id: 'Mel-Band-Roformer',
    label: { en: 'Mel-Band Roformer (large)', zh: 'Mel-Band Roformer（大模型）' },
    category: 'main_vocal',
    arch: 'roformer',
    aggApplicable: false,
    files: ['MelBandRoformer.ckpt'],
    weightArg: 'MelBandRoformer.ckpt',
    heavy: true, // 权重约 871 MB，界面可能给出提示。
    note: {
      en: 'Roformer-based main-vocal isolation. Weight is about 871 MB; config auto (built-in default).',
      zh: '基于 Roformer 的主人声分离。权重约 871 MB；配置自动选用内置默认值。',
    },
  },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

// 旧 denoiseModel 字符串值到登记表 id 的映射。流水线之前的界面只有一个下拉项，
// 取值是 'mdx-net'，denoise.js 把它映射到 HP2 权重。读旧配方时要保留这个行为。
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

// 把一个模型引用（id 或旧字符串）归一成已知的 id，不是已知模型则返回 null。
function normalizeModelId(ref) {
  if (!ref) return null;
  if (BY_ID.has(ref)) return ref;
  return LEGACY_MODEL_ALIASES[ref] || null;
}

// 权重放在 <weightsDir>/<arch>/ 之下，免得三种架构堆在一个平铺目录里。子目录由模型自己的
// arch 字段推导，绝不写进 files 与 weightArg：同一件事写十处，第十一处一定写错。
// 加一个模型，它自然就落在正确的位置。
//
// 目录名只能是 vr / roformer / mdx：python 侧的载入器拿手到的路径做子串匹配，
// 一个叫 bs_roformer/ 的目录会让它下面每一个 Roformer 权重都被当成 BS-Roformer 载入，
// 而且是静默的，state_dict 载入器又很宽容，结果是听着不对而不是报错。
function archDir(weightsDir, m) {
  return path.join(weightsDir, m.arch);
}

// 模型声明的全部文件，相对 weightsDir，带上架构目录。只有这一处知道目录布局：
// 安装检查、错误消息与测试夹具都读它，所以它们不会各说各话。
function modelFiles(id) {
  const m = getModel(id);
  if (!m) return [];
  return m.files.map((f) => path.join(m.arch, f));
}

// 传给 uvr5_cli --model 的主权重参数的绝对路径。
function resolveWeightArg(weightsDir, id) {
  const m = getModel(id);
  if (!m) return null;
  return path.join(archDir(weightsDir, m), m.weightArg);
}

// 模型已安装的条件：声明的每个文件都在 weightsDir 之下。
function isInstalled(weightsDir, id) {
  if (!getModel(id)) return false;
  return modelFiles(id).every((f) => fs.existsSync(path.join(weightsDir, f)));
}

// 哪些声明的文件缺失。路径相对 weightsDir 且带上架构目录，报错里的路径可以照着找。
function missingFiles(weightsDir, id) {
  return modelFiles(id).filter((f) => !fs.existsSync(path.join(weightsDir, f)));
}

// 给 API 用的可序列化清单：标签与可用状态，含两个 Roformer。
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
    // 这个模型真正支持的进阶旋钮（逐架构对着源码核过）。
    expertParams: expertParamsFor(m.arch).map((k) => ({ key: k, ...EXPERT_PARAMS[k] })),
    installed: weightsDir ? isInstalled(weightsDir, m.id) : false,
    missing: weightsDir ? missingFiles(weightsDir, m.id) : m.files.slice(),
  }));
}

// 训练工具自带的默认权重目录。权重位置由 lib/paths.js 统一定义，不按本文件自身位置推断：
// 代码在 pipeline/uvr5/ 而权重在别处，「权重就在我旁边」这个假设不成立。
function defaultWeightsDir() {
  return require('../../lib/paths').UVR5_WEIGHTS_DIR;
}

const MAX_PIPELINE_STAGES = 3;
const AGG_MIN = 0;
const AGG_MAX = 20;
const AGG_DEFAULT = 10;

// 进阶参数：每种分离器真正支持的旋钮（对着 vr.py / mdxnet.py / bsroformer.py 核过）。
// 各架构不同，所以标准阶段只带该模型架构适用的那些参数：
//   vr：agg（普通参数）与 tta、postprocess、highEnd、precision（进阶参数）
//   mdx：chunks、precision（进阶参数），无 agg
//   roformer：overlap、batchSize、precision（进阶参数），无 agg
// precision 是三种架构都有的唯一进阶参数。
const PRECISIONS = ['fp32', 'fp16'];
const PRECISION_DEFAULT = 'fp32';
const HIGH_END_MODES = ['mirroring', 'bypass', 'none'];
const HIGH_END_DEFAULT = 'mirroring';

const EXPERT_PARAMS = {
  precision: { archs: ['vr', 'mdx', 'roformer'], type: 'enum', values: PRECISIONS, default: PRECISION_DEFAULT },
  tta: { archs: ['vr'], type: 'bool', default: false },
  postprocess: { archs: ['vr'], type: 'bool', default: false },
  highEnd: { archs: ['vr'], type: 'enum', values: HIGH_END_MODES, default: HIGH_END_DEFAULT },
  // MDX-Net 极易显存不足；chunks 是它的分段长度（秒，每次喂进分离器的窗口）。
  // 默认值 8 以 4 GB 显存为基准，显存更大的卡可以安全调高，拿到更多上下文或更快。
  // 这个默认值与 web/src/components/train/trainConstants.js 的 EXPERT_META.chunks 保持一致。
  chunks: { archs: ['mdx'], type: 'int', min: 5, max: 40, default: 8 },
  overlap: { archs: ['roformer'], type: 'int', min: 1, max: 8, default: 2 },
  batchSize: { archs: ['roformer'], type: 'int', min: 1, max: 16, default: 2 },
};

// 某个架构适用的参数键，按表里的顺序（普通参数 agg 单独处理）。
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

// 按参数规格解析一个进阶参数的值：转换、夹到范围、回落默认值。
function resolveExpertValue(key, raw) {
  const spec = EXPERT_PARAMS[key];
  if (!spec) return undefined;
  if (raw == null) return spec.default;
  if (spec.type === 'bool') return raw === true || raw === 'true' || raw === 1 || raw === '1';
  if (spec.type === 'enum') return spec.values.includes(raw) ? raw : spec.default;
  if (spec.type === 'int') return clampInt(raw, spec.min, spec.max, spec.default);
  return spec.default;
}

// 把任意输入（新流水线数组或旧的 {model} 字符串）归一成一份干净、已校验的流水线。
// 每个阶段带 { model, [agg], <该架构适用的进阶参数> }。未知或空的模型被丢掉。
// 没有可用阶段时返回空数组（调用方当成「关闭」）。
// 服务端与去噪步骤共用同一份形状定义，两边指纹才对得上、才稳定。
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
