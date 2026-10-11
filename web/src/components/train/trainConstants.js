// AUTO-EXTRACTED from TrainingTab.jsx (pure mechanical, zero logic change).
// --- Constants ---

// Default values for every editable training/slice/asr field. The Training page
// keeps its own persistent form; the Restore modal seeds a fresh copy of these.
const REBUILD_PARAM_DEFAULTS = {
  expertUnlocked: false,
  // training (common)
  modelVersion: 'v2Pro',
  gptEpochs: 8, sovitsEpochs: 8, batchSize: 'auto', learningRate: 'default',
  // slice
  sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5,
  // asr
  asrEngine: 'auto', asrModelSize: 'large-v3-turbo', asrPrecision: 'float16',
  // vocal extraction (denoise)
  denoisePreset: 'bgm', denoisePipeline: [], denoisePresetParams: {}, denoiseAdvUnlocked: false, denoiseSavedPresets: [],
  // S1 advanced/expert
  s1Seed: 1234, s1SaveEvery: 4, s1Precision: '16-mixed', s1GradClip: 1.0,
  s1Lr: 0.01, s1LrInit: 0.00001, s1LrEnd: 0.0001, s1Warmup: 2000, s1Decay: 40000,
  s1MaxSec: 54, s1NumWorkers: 4, s1MaxEval: 8,
  // S2 advanced/expert
  s2Seed: 1234, s2LogInterval: 100, s2EvalInterval: 500, s2Fp16: true,
  s2LrDecay: 0.999875, s2SegmentSize: 20480, s2CMel: 45, s2CKl: 1.0,
  s2TextLowLr: 0.4, s2GradCkpt: false,
}

const ASR_MODEL_SIZES = [
  ['large-v3-turbo', 'large-v3-turbo (fast)'], ['large-v3', 'large-v3 (best)'],
  ['large', 'large'], ['medium', 'medium'], ['small', 'small'],
  ['tiny', 'tiny'], ['distil-large-v3', 'distil-large-v3'],
]

const ASR_PRECISIONS = [
  ['float16', 'float16 (fast)'], ['float32', 'float32 (best)'], ['int8', 'int8 (low VRAM)'],
]

// --- Vocal extraction presets (encode the official UVR5 domain knowledge) ------
// Each preset maps a human intent ("what is my material like?") to a concrete
// separation pipeline [{model, agg?}]. `agg` (0-20) only applies to VR models and
// is user-tunable in Expert mode. ids MUST match pipeline/uvr5/
// uvr5_models.js (and the backend validator). `custom` opens the second-level
// chain editor. The authoritative labels/availability come from GET /api/uvr5/models.
const AGG_DEFAULT = 10
const VOCAL_PRESETS = [
  { id: 'bgm', label: ['Remove background music (HP2)', '去背景乐（HP2）'],
    hint: ['Most common. For material WITHOUT harmony — best main-vocal preservation.',
           '最常用。不带和声的素材，主人声保留最好。'],
    pipeline: [{ model: 'HP2', agg: AGG_DEFAULT }] },
  { id: 'main_vocal', label: ['Only main vocal (HP5)', '仅保留主人声（HP5）'],
    hint: ['For material WITH harmony; may slightly weaken the main vocal.',
           '带和声的素材；对主人声可能有轻微削弱。'],
    pipeline: [{ model: 'HP5', agg: AGG_DEFAULT }] },
  { id: 'dereverb', label: ['De-reverb (MDX-Net)', '去混响（MDX-Net）'],
    hint: ['Best for stereo reverb; cannot remove mono reverb.',
           '对双声道混响最佳；不能去单声道混响。'],
    pipeline: [{ model: 'MDX-Net' }] },
  { id: 'deep', label: ['Deep clean: MDX-Net → DeEcho-Aggressive  ★', '深度清洗：MDX-Net → DeEcho-Aggressive  ★'],
    hint: ['Official cleanest configuration. Two-stage chain — slower.',
           '官方推荐最干净配置。两级串联，耗时较长。'],
    pipeline: [{ model: 'MDX-Net' }, { model: 'DeEcho-Aggressive', agg: AGG_DEFAULT }] },
  { id: 'melband', label: ['Mel-Band Roformer', 'Mel-Band Roformer'],
    hint: ['Roformer-based vocal isolation. Large model (~700MB) — needs download.',
           '基于 Roformer 的人声分离。大模型（约 700MB），需下载。'],
    pipeline: [{ model: 'Mel-Band-Roformer' }] },
  { id: 'custom', label: ['Custom…', '自定义…'],
    hint: ['Build your own separation chain (advanced).', '自建分离链（高级）。'],
    pipeline: null },
]
const VOCAL_PRESET_BY_ID = Object.fromEntries(VOCAL_PRESETS.map(p => [p.id, p]))

// --- Expert parameters (mirror pipeline/uvr5 EXPERT_PARAMS) ----------------
// Source-verified knobs, tiered per architecture. `agg` is the only NORMAL knob
// (VR); everything below is EXPERT. The authoritative applicability comes from
// GET /api/uvr5/models (model.expertParams); this table only supplies labels/UI.
const EXPERT_META = {
  precision: { archs: ['vr', 'mdx', 'roformer'], type: 'enum', options: ['fp32', 'fp16'], default: 'fp32',
    label: ['Precision', '精度'],
    hint: ['fp32 is safest. fp16 is faster but makes HP models emit NaN on many GPUs.',
           'fp32 最稳；fp16 更快，但 HP 系列在很多显卡上会出 NaN。'] },
  tta: { archs: ['vr'], type: 'bool', default: false,
    label: ['TTA (test-time augmentation)', 'TTA 测试时增强'],
    hint: ['Cleaner separation, ~2× time.', '分离更干净，耗时约 2 倍。'] },
  postprocess: { archs: ['vr'], type: 'bool', default: false,
    label: ['Mask post-process', '掩码后处理'],
    hint: ['Extra refinement of the separation mask.', '对分离掩码做额外精修。'] },
  highEnd: { archs: ['vr'], type: 'enum', options: ['mirroring', 'bypass', 'none'], default: 'mirroring',
    label: ['High-frequency reconstruction', '高频重建'],
    hint: ['How lost high frequencies are rebuilt.', '如何重建丢失的高频。'] },
  chunks: { archs: ['mdx'], type: 'int', min: 5, max: 40, default: 8,
    label: ['Segment length (s)', '分段长度（秒）'],
    hint: ['MDX-Net is prone to running out of GPU memory (OOM). The default (8 s) targets a 4 GB GPU; on cards with more VRAM, raise it for more context and speed.',
           'MDX-Net 极易爆显存（OOM）。默认值（8 秒）以 4 GB 显存为基准；显存更大的显卡可自行调高，以获得更多上下文与更快速度。'] },
  overlap: { archs: ['roformer'], type: 'int', min: 1, max: 8, default: 2,
    label: ['Chunk overlap', '分块重叠'],
    hint: ['Higher = better quality, slower.', '越大质量越好、越慢。'] },
  batchSize: { archs: ['roformer'], type: 'int', min: 1, max: 16, default: 2,
    label: ['Batch size', '批大小'],
    hint: ['Higher = faster on big GPUs, more VRAM.', '越大在大显存上越快、更吃显存。'] },
}
const EXPERT_KEYS = Object.keys(EXPERT_META)
const expertKeysForArch = (arch) => EXPERT_KEYS.filter(k => EXPERT_META[k].archs.includes(arch))

// S1 (GPT / Lightning) trainer precision. Values MUST match the server-side
// whitelist (server.js validatePayload `precision` oneOf) or they are dropped.
const S1_PRECISIONS = [
  ['16-mixed', '16-mixed (recommended)'], ['bf16-mixed', 'bf16-mixed'],
  ['16-true', '16-true'], ['bf16-true', 'bf16-true'],
  ['32-true', '32-true (most stable / slowest)'],
]

// S2 (SoVITS) uses manual AMP (GradScaler + autocast) driven by a single
// `fp16_run` boolean — there is no bf16 code path in s2_train.py. So the S2
// precision selector is intentionally just two options mapped to that bool:
//   'fp16' -> fp16_run=true   'fp32' -> fp16_run=false
const S2_PRECISIONS = [
  ['fp16', 'fp16 (fast, default)'], ['fp32', 'fp32 (stable, slow)'],
]

// Which buildTrainingParams() keys belong to S1 (GPT) vs S2 (SoVITS). Shared keys
// (version/versions/batch_size/learning_rate) affect both, so they are attributed to
// the EARLIER step (train_s1) — changing them re-runs from S1, which also re-runs S2.
const S1_PARAM_KEYS = ['version', 'versions', 'batch_size', 'learning_rate',
  'gpt_epochs', 'seed', 'save_every_n_epoch', 's1_save_every_n_epoch', 'precision', 'gradient_clip',
  'lr', 'lr_init', 'lr_end', 'warmup_steps', 'decay_steps', 'max_sec', 'num_workers', 'max_eval_sample'];
const S2_PARAM_KEYS = ['sovits_epochs', 's2_save_every_n_epoch', 's2_seed', 'log_interval', 'eval_interval', 'fp16_run',
  'lr_decay', 'segment_size', 'c_mel', 'c_kl', 'text_low_lr_rate', 'grad_ckpt'];

// Pipeline step order shared by the failure-resume UI (mirrors backend STEP_ORDER).
const FSTEP_ORDER = ['denoise', 'slice', 'asr', 'preprocess', 'train_s1', 'train_s2', 'finalize', 'promote'];

const FSTEP_LABELS = {
  denoise: 'Vocal extraction', slice: 'Slicing', asr: 'ASR', preprocess: 'Preprocess',
  train_s1: 'S1 (GPT)', train_s2: 'S2 (SoVITS)', finalize: 'Finalize', promote: 'Publish',
};

const LANGUAGES = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese (Mandarin)' },
  { code: 'yue', label: 'Cantonese' },
  { code: 'en', label: 'English' },
  { code: 'ko', label: 'Korean' },
]

// Training presets — frontend-only convenience. Selecting one writes a bundle of
// training-form fields; "custom" leaves whatever the user has set. No backend change:
// handleStart already serialises these same form.* fields into customParams.training.
const TRAIN_PRESETS = [
  { key: 'smoke',    label: 'Quick Smoke Test',     hint: 'Tiny run to verify the pipeline end-to-end (~2 epochs).',
    hintZh: '极小规模的试跑，用于端到端验证整条流程（约 2 个 epoch）。',
    fields: { gptEpochs: 2,  sovitsEpochs: 2,  batchSize: 'auto', s1SaveEvery: 1, s2SaveEvery: 1, s2GradCkpt: false, s2Fp16: true } },
  { key: 'default',  label: 'Default (S1 8 / S2 25)', hint: 'S1 trains fewer epochs to limit prosody overfitting; S2 trains more epochs for acoustic and timbre adaptation.',
    hintZh: 'S1 训练较少的 epoch 以限制韵律过拟合；S2 训练更多 epoch 以适配音质与音色。',
    fields: { gptEpochs: 8, sovitsEpochs: 25, batchSize: 'auto', s1SaveEvery: 4, s2SaveEvery: 5, s2GradCkpt: false, s2Fp16: true } },
  { key: 'lowvram',  label: 'Low VRAM Safe',         hint: 'Batch size 1 + gradient checkpoint for 8GB GPUs. Same S1 8 / S2 25 epoch split.',
    hintZh: 'batch size 1 + gradient checkpoint，适合 8GB 显存的 GPU。epoch 划分同样为 S1 8 / S2 25。',
    fields: { gptEpochs: 8, sovitsEpochs: 25, batchSize: 1,      s1SaveEvery: 4, s2SaveEvery: 5, s2GradCkpt: true,  s2Fp16: true } },
  { key: 'custom',   label: 'Custom',               hint: 'Your own values — edit anything in the pipeline steps below.',
    hintZh: '使用自定义参数，可在下方各流程步骤中任意修改。',
    fields: null },
]

// The training-form fields a saved Training Preset captures/restores. A saved preset
// is a named snapshot of these; selecting it loads them, "Update" re-snapshots the
// current form back into it, "Delete" removes it. Kept in sync with the values the
// built-in TRAIN_PRESETS and the S1/S2 advanced-parameter steps can set.
const TRAIN_PRESET_FIELDS = [
  'gptEpochs', 'sovitsEpochs', 'batchSize', 'learningRate',
  's1SaveEvery', 's2SaveEvery', 's2GradCkpt', 's2Fp16',
  's1Seed', 's1Precision', 's1GradClip', 's1Lr', 's1LrInit', 's1LrEnd',
  's1Warmup', 's1Decay', 's1MaxSec', 's1NumWorkers', 's1MaxEval',
  's2Seed', 's2LogInterval', 's2EvalInterval', 's2LrDecay', 's2SegmentSize',
  's2CMel', 's2CKl', 's2TextLowLr',
]
const pickTrainFields = (src) => {
  const out = {}
  for (const k of TRAIN_PRESET_FIELDS) if (src[k] !== undefined) out[k] = src[k]
  return out
}

// Slicing preset field values, used by the Slicing-step preset dropdown.
const SLICE_PRESET_VALUES = {
  default:    { sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5 },
  aggressive: { sliceMinSec: 2, sliceMaxSec: 10, sliceSilenceDb: -34, sliceMinSilenceSec: 0.3 },
  longer:     { sliceMinSec: 5, sliceMaxSec: 25, sliceSilenceDb: -45, sliceMinSilenceSec: 0.8 },
}

// Real backend pipeline steps (lib/training/pipeline.js). S1/GPT and S2/SoVITS are
// now independent steps (train_s1 / train_s2); 'promote' publishes the asset.
const TRAIN_STEPS = [
  { key: 'denoise',    label: 'Vocal Extraction', labelZh: '人声提取' },
  { key: 'slice',      label: 'Slicing',          labelZh: '切片' },
  { key: 'asr',        label: 'ASR',              labelZh: 'ASR' },
  { key: 'preprocess', label: 'Preprocess',       labelZh: '预处理' },
  { key: 'train_s1',   label: 'S1 (GPT)',         labelZh: 'S1 (GPT)' },
  { key: 'train_s2',   label: 'S2 (SoVITS)',      labelZh: 'S2 (SoVITS)' },
  { key: 'finalize',   label: 'Finalize',         labelZh: '打包完成' },
  { key: 'promote',    label: 'Publish',          labelZh: '发布' },
]

export {
  REBUILD_PARAM_DEFAULTS,
  ASR_MODEL_SIZES,
  ASR_PRECISIONS,
  AGG_DEFAULT,
  VOCAL_PRESETS,
  VOCAL_PRESET_BY_ID,
  EXPERT_META,
  EXPERT_KEYS,
  expertKeysForArch,
  S1_PRECISIONS,
  S2_PRECISIONS,
  S1_PARAM_KEYS,
  S2_PARAM_KEYS,
  FSTEP_ORDER,
  FSTEP_LABELS,
  LANGUAGES,
  TRAIN_PRESETS,
  TRAIN_PRESET_FIELDS,
  pickTrainFields,
  SLICE_PRESET_VALUES,
  TRAIN_STEPS,
}
