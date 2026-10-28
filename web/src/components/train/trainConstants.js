// 训练页的常量表：表单默认值、ASR 选项、人声分离预设、专家参数、训练预设与步骤顺序。
// 这里的值只供界面使用；后端另有 lib/server/trainingParams.js 的白名单，不符的值会被丢弃。

// 训练、切片、ASR 各字段的可编辑默认值。训练页自己保存一份持久表单，
// 「恢复」弹窗则用这些值初始化一份新的副本。
const REBUILD_PARAM_DEFAULTS = {
  expertUnlocked: false,
  // 训练常用项
  modelVersion: 'v2Pro',
  gptEpochs: 8, sovitsEpochs: 8, batchSize: 'auto', learningRate: 'default',
  // 切片
  sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5,
  // ASR
  asrEngine: 'auto', asrModelSize: 'large-v3-turbo', asrPrecision: 'float16',
  // 人声提取（去背景）
  denoisePreset: 'bgm', denoisePipeline: [], denoisePresetParams: {}, denoiseAdvUnlocked: false, denoiseSavedPresets: [],
  // S1 高级项
  s1Seed: 1234, s1SaveEvery: 4, s1Precision: '16-mixed', s1GradClip: 1.0,
  s1Lr: 0.01, s1LrInit: 0.00001, s1LrEnd: 0.0001, s1Warmup: 2000, s1Decay: 40000,
  s1MaxSec: 54, s1NumWorkers: 4, s1MaxEval: 8,
  // S2 高级项
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

// 人声分离预设：把「素材是什么样子」映射到一条具体的分离链 [{model, agg?}]。
// agg（0-20）只对 VR 架构有意义，在专家模式下可调。
// 分离链里每一级的 model 必须是 pipeline/uvr5/uvr5_models.js 里的模型 id，后端按同一套 id 校验；
// custom 表示由用户自建分离链。模型名称与是否已安装由 GET /api/uvr5/models 给出。
const AGG_DEFAULT = 10
const VOCAL_PRESETS = [
  { id: 'bgm', label: ['Remove background music (HP2)', '去背景乐（HP2）'],
    hint: ['Most common. For material WITHOUT harmony — best main-vocal preservation.',
           '最常用。不带和声的素材，主人声保留最完整。'],
    pipeline: [{ model: 'HP2', agg: AGG_DEFAULT }] },
  { id: 'main_vocal', label: ['Only main vocal (HP5)', '仅保留主人声（HP5）'],
    hint: ['For material WITH harmony; may slightly weaken the main vocal.',
           '带和声的素材；对主人声可能有轻微削弱。'],
    pipeline: [{ model: 'HP5', agg: AGG_DEFAULT }] },
  { id: 'dereverb', label: ['De-reverb (MDX-Net)', '去混响（MDX-Net）'],
    hint: ['Best for stereo reverb; cannot remove mono reverb.',
           '对双声道混响效果最佳；无法去除单声道混响。'],
    pipeline: [{ model: 'MDX-Net' }] },
  { id: 'deep', label: ['Deep clean: MDX-Net → DeEcho-Aggressive  ★', '深度清洗：MDX-Net → DeEcho-Aggressive  ★'],
    hint: ['Official cleanest configuration. Two-stage chain — slower.',
           '官方推荐最佳配置。两级串联，耗时较长。'],
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

// 专家参数：与 pipeline/uvr5/uvr5_models.js 的 EXPERT_PARAMS 对应，按架构分层。
// agg 是唯一属于常规档的旋钮（且只对 VR 架构），其余都是专家档。
// 某个参数适用于哪些架构由 GET /api/uvr5/models 的 model.expertParams 给出，
// 这张表只提供名称与说明文案。
const EXPERT_META = {
  precision: { archs: ['vr', 'mdx', 'roformer'], type: 'enum', options: ['fp32', 'fp16'], default: 'fp32',
    label: ['Precision', '精度'],
    hint: ['fp32 is safest. fp16 is faster but makes HP models emit NaN on many GPUs.',
           'fp32 最稳定；fp16 更快，但 HP 系列在很多显卡上会产生 NaN。'] },
  tta: { archs: ['vr'], type: 'bool', default: false,
    label: ['TTA (test-time augmentation)', 'TTA 测试时增强'],
    hint: ['Cleaner separation, ~2× time.', '分离效果更佳，耗时约 2 倍。'] },
  postprocess: { archs: ['vr'], type: 'bool', default: false,
    label: ['Mask post-process', '掩码后处理'],
    hint: ['Extra refinement of the separation mask.', '对分离掩码做额外精修。'] },
  highEnd: { archs: ['vr'], type: 'enum', options: ['mirroring', 'bypass', 'none'], default: 'mirroring',
    label: ['High-frequency reconstruction', '高频重建'],
    hint: ['How lost high frequencies are rebuilt.', '如何重建丢失的高频。'] },
  chunks: { archs: ['mdx'], type: 'int', min: 5, max: 40, default: 8,
    label: ['Segment length (s)', '分段长度（秒）'],
    hint: ['MDX-Net is prone to running out of GPU memory (OOM). The default (8 s) targets a 4 GB GPU; on cards with more VRAM, raise it for more context and speed.',
           'MDX-Net 极易耗尽显存（OOM）。默认值（8 秒）以 4 GB 显存为基准；显存更大的显卡可自行调高，以获得更多上下文与更快速度。'] },
  overlap: { archs: ['roformer'], type: 'int', min: 1, max: 8, default: 2,
    label: ['Chunk overlap', '分块重叠'],
    hint: ['Higher = better quality, slower.', '值越大质量越好，同时耗时越长。'] },
  batchSize: { archs: ['roformer'], type: 'int', min: 1, max: 16, default: 2,
    label: ['Batch size', '批大小'],
    hint: ['Higher = faster on big GPUs, more VRAM.', '越大在大显存上越快、显存占用更大。'] },
}
const EXPERT_KEYS = Object.keys(EXPERT_META)
const expertKeysForArch = (arch) => EXPERT_KEYS.filter(k => EXPERT_META[k].archs.includes(arch))

// S1（GPT / Lightning）训练器的精度。取值必须与后端白名单
// （lib/server/trainingParams.js 的 sanitizeCustomParams 中 precision 那一项）一致，
// 不在白名单里的值会被丢弃。
const S1_PRECISIONS = [
  ['16-mixed', '16-mixed (recommended)'], ['bf16-mixed', 'bf16-mixed'],
  ['16-true', '16-true'], ['bf16-true', 'bf16-true'],
  ['32-true', '32-true (most stable / slowest)'],
]

// S2（SoVITS）用手动 AMP（GradScaler + autocast），由单个 fp16_run 布尔量驱动，
// s2_train.py 里没有 bf16 代码路径。所以 S2 的精度选项只有两个，映射到那个布尔量：
//   'fp16' -> fp16_run=true   'fp32' -> fp16_run=false
const S2_PRECISIONS = [
  ['fp16', 'fp16 (fast, default)'], ['fp32', 'fp32 (stable, slow)'],
]

// buildTrainingParams() 的哪些键归 S1（GPT）、哪些归 S2（SoVITS）。
// 两个步骤共用的键（version/versions/batch_size/learning_rate）记在前一步 train_s1 上，
// 因为改它们要从 S1 重跑，S1 重跑必然连 S2 一起重跑。
const S1_PARAM_KEYS = ['version', 'versions', 'batch_size', 'learning_rate',
  'gpt_epochs', 'seed', 'save_every_n_epoch', 's1_save_every_n_epoch', 'precision', 'gradient_clip',
  'lr', 'lr_init', 'lr_end', 'warmup_steps', 'decay_steps', 'max_sec', 'num_workers', 'max_eval_sample'];
const S2_PARAM_KEYS = ['sovits_epochs', 's2_save_every_n_epoch', 's2_seed', 'log_interval', 'eval_interval', 'fp16_run',
  'lr_decay', 'segment_size', 'c_mel', 'c_kl', 'text_low_lr_rate', 'grad_ckpt'];

// 流程步骤顺序，与后端的 STEP_ORDER（lib/training/pipeline/steps.js）一致，
// 失败重跑的界面按它显示。
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

// 训练预设：只在前端方便用户，不改后端行为。选一个就把一组训练表单字段写进去，
// 选 custom 则保持用户当前填的值。
// 后端参数不变：handleStart 本来就把这些 form.* 字段序列化进 customParams.training。
const TRAIN_PRESETS = [
  { key: 'smoke',    label: 'Quick Smoke Test',     hint: 'Tiny run to verify the pipeline end-to-end (~2 epochs).',
    hintZh: '极小规模的试运行，用于端到端验证整条流程（约 2 个 epoch）。',
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

// 训练预设能保存与恢复哪些表单字段。一个保存的预设就是这些字段的一份命名快照：
// 选中它会载入这些字段，「更新」把当前表单重新存回它，「删除」移除它。
// 这张表要与内置 TRAIN_PRESETS 以及 S1/S2 高级参数步骤能设置的字段保持一致。
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

// 切片预设的字段值，供切片步骤的预设下拉使用。
const SLICE_PRESET_VALUES = {
  default:    { sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5 },
  aggressive: { sliceMinSec: 2, sliceMaxSec: 10, sliceSilenceDb: -34, sliceMinSilenceSec: 0.3 },
  longer:     { sliceMinSec: 5, sliceMaxSec: 25, sliceSilenceDb: -45, sliceMinSilenceSec: 0.8 },
}

// 后端真实存在的流程步骤（lib/training/pipeline/steps.js 的 STEP_ORDER）。
// S1/GPT 与 S2/SoVITS 是两个独立步骤（train_s1 / train_s2），promote 负责发布产物。
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
