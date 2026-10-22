// 训练页的表单与参数之间的转换：表单值转成训练参数、归档参数转回表单。
// 降噪管线有单独一份工作缓冲：选中的预设与自定义链共用它，
// 「更新预设」写回该预设，因此实际执行的一定是缓冲里的内容。
import {
  VOCAL_PRESET_BY_ID,
  EXPERT_KEYS,
  AGG_DEFAULT,
  S1_PARAM_KEYS,
  S2_PARAM_KEYS,
} from './trainConstants'

// 由当前表单解析后端要执行的降噪管线。
// 预设从模板复制一份，per-preset 的参数改动因此留在表单上；custom 用用户自建的链。
// @param form 表单值。denoise 为假时返回空数组。
// @returns {Array} 管线阶段数组，预设按阶段叠加 form.denoisePresetParams[preset] 的覆盖值。
function resolveVocalPipeline(form) {
  if (!form.denoise) return []
  const preset = form.denoisePreset || 'bgm'
  // 自定义链与已存预设改的是同一份工作缓冲 denoisePipeline：选中已存预设时用它填缓冲，
  // 「更新预设」再把缓冲写回该预设，所以真正执行的永远是缓冲里的内容。
  // 只有缓冲为空时才回退到已存预设（例如从配置恢复的场景）。
  if (preset === 'custom' || preset.startsWith('saved:')) {
    const buf = Array.isArray(form.denoisePipeline) ? form.denoisePipeline : []
    if (buf.length) return buf
    if (preset.startsWith('saved:')) {
      const name = preset.slice(6)
      const saved = (form.denoiseSavedPresets || []).find(s => s.name === name)
      return saved && Array.isArray(saved.pipeline) ? saved.pipeline : []
    }
    return buf
  }
  const p = VOCAL_PRESET_BY_ID[preset]
  if (!p || !p.pipeline) return []
  // 叠加按预设逐阶段存放的用户调参（form.denoisePresetParams）。
  // 阶段覆盖值是对象 {agg?, tta?, ...}；旧格式的数字表示 {agg}。
  const overrides = (form.denoisePresetParams && form.denoisePresetParams[preset]) || {}
  return p.pipeline.map((stage, i) => {
    const out = { ...stage }
    let ov = overrides[i]
    if (typeof ov === 'number') ov = { agg: ov }
    if (ov && typeof ov === 'object') {
      if (ov.agg != null && 'agg' in out) out.agg = ov.agg
      for (const k of EXPERT_KEYS) if (ov[k] != null) out[k] = ov[k]
    }
    return out
  })
}

// 训练参数序列化器：把表单值转成后端 customParams.training 用的字段。
// @param form 表单值，字段名见 trainConstants.js 的 REBUILD_PARAM_DEFAULTS。
// @returns {object} 训练参数字段。数值字段取不到值时用这里的兜底数，
//   batch_size 与 learning_rate 保留 'auto' 与 'default' 两个字面量交后端解释。
function buildTrainingParams(form) {
  const _vers = (Array.isArray(form.modelVersions) && form.modelVersions.length)
    ? form.modelVersions : [form.modelVersion || 'v2'];
  return {
    version: _vers[0] || 'v2',
    versions: _vers,
    gpt_epochs: Number(form.gptEpochs) || 8,
    sovits_epochs: Number(form.sovitsEpochs) || 25,
    batch_size: form.batchSize === 'auto' ? 'auto' : (Number(form.batchSize) || 'auto'),
    learning_rate: form.learningRate === 'default' ? 'default' : (Number(form.learningRate) || 'default'),
    // S1 高级项
    seed: form.s1Seed ?? 1234,
    // S1 每 4 个 epoch 存一次（8 % 4 == 0），S2 每 5 个存一次（25 % 5 == 0），
    // 最后一个排定的 epoch 正好落在检查点上。save_every_n_epoch 保留是为了兼容
    // 旧配方与差异比对逻辑。
    save_every_n_epoch: form.s1SaveEvery ?? 4,
    s1_save_every_n_epoch: form.s1SaveEvery ?? 4,
    s2_save_every_n_epoch: form.s2SaveEvery ?? 5,
    precision: form.s1Precision || '16-mixed',
    gradient_clip: form.s1GradClip ?? 1.0,
    lr: form.s1Lr ?? 0.01,
    lr_init: form.s1LrInit ?? 0.00001,
    lr_end: form.s1LrEnd ?? 0.0001,
    warmup_steps: form.s1Warmup ?? 2000,
    decay_steps: form.s1Decay ?? 40000,
    max_sec: form.s1MaxSec ?? 54,
    num_workers: form.s1NumWorkers ?? 4,
    max_eval_sample: form.s1MaxEval ?? 8,
    // S2 高级项
    s2_seed: form.s2Seed ?? 1234,
    log_interval: form.s2LogInterval ?? 100,
    eval_interval: form.s2EvalInterval ?? 500,
    fp16_run: form.s2Fp16 !== false,
    lr_decay: form.s2LrDecay ?? 0.999875,
    segment_size: form.s2SegmentSize ?? 20480,
    c_mel: form.s2CMel ?? 45,
    c_kl: form.s2CKl ?? 1.0,
    text_low_lr_rate: form.s2TextLowLr ?? 0.4,
    grad_ckpt: !!form.s2GradCkpt,
  }
}

// 切片参数序列化器：表单值转成后端切片步骤用的字段。
// @returns {object} min_duration_sec / max_duration_sec / silence_threshold_db /
//   min_silence_sec。取不到值时用这里的兜底数。
function buildSliceParams(form) {
  return {
    min_duration_sec: Number(form.sliceMinSec) || 3,
    max_duration_sec: Number(form.sliceMaxSec) || 15,
    silence_threshold_db: Number(form.sliceSilenceDb) || -40,
    min_silence_sec: Number(form.sliceMinSilenceSec) || 0.5,
  }
}

// 语音识别参数序列化器：表单值转成后端 ASR 步骤用的字段。
// @returns {{engine: string, model_size: string, precision: string}}
//   三个值原样传出，不在这里校验，也不填默认值。
function buildAsrParams(form) {
  return { engine: form.asrEngine, model_size: form.asrModelSize, precision: form.asrPrecision }
}

function _pick(obj, keys) { const o = {}; for (const k of keys) o[k] = obj[k]; return o; }

// 各步骤参数的规范快照，用来判断进入续跑之后用户改了什么。
// 键与流水线步骤一一对应，比较方式是逐项 JSON 相等。
// 某一步的参数变了，那一步以及它下游的步骤都要重跑。
// @param form 表单值。
// @returns {object} 键为 denoise / slice / asr / train_s1 / train_s2，每项是该步骤的
//   参数加上开关字段 on。比较时含 on，所以关掉一个步骤也算改动。
function buildStepParams(form) {
  const t = buildTrainingParams(form);
  return {
    denoise: { pipeline: resolveVocalPipeline(form), on: !!form.denoise },
    slice: { ...buildSliceParams(form), on: form.slice !== false },
    asr: { ...buildAsrParams(form), on: form.asr !== false },
    train_s1: { ..._pick(t, S1_PARAM_KEYS), on: form.trainS1 !== false },
    train_s2: { ..._pick(t, S2_PARAM_KEYS), on: form.trainS2 !== false },
  };
}

// 把当前的步骤参数与进入续跑时的快照逐项比对。
// @returns {Set<string>} 参数有变化的步骤键集合。
function changedStepSet(live, snap) {
  const s = new Set();
  if (!live || !snap) return s;
  for (const k of Object.keys(live)) {
    if (JSON.stringify(live[k]) !== JSON.stringify(snap[k])) s.add(k);
  }
  return s;
}

// buildTrainingParams/buildSliceParams/buildAsrParams 的逆运算：把归档任务存下的参数
// 转回 form.* 字段，续跑时显示的就是原来的设置，可以继续调整。
// @param archive 归档任务记录。参数分五处存放：customParams.training、
//   customParams.steps.{slice,asr,denoise}.params 与 customParams.stepOptions。
// @returns {object} 表单字段，键与 form.* 的字段同名。归档里没有的字段不会出现在
//   结果里，由表单自身的默认值兜底。
function archiveToForm(archive) {
  const out = {};
  const cp = archive.customParams || {};
  const so = archive.stepOptions || {};
  const t = cp.training || {};
  const sp = (cp.steps && cp.steps.slice && cp.steps.slice.params) || {};
  const ap = (cp.steps && cp.steps.asr && cp.steps.asr.params) || {};
  const dp = (cp.steps && cp.steps.denoise && cp.steps.denoise.params) || {};

  if (archive.voiceId) out.voiceName = archive.voiceId;
  if (archive.language) out.language = archive.language;
  if (archive.inputDir) out.inputDir = archive.inputDir;

  if (so.denoise != null) out.denoise = so.denoise;
  if (so.slice != null) out.slice = so.slice;
  if (so.asr != null) out.asr = so.asr;
  if (so.copyRaw != null) out.copyRaw = so.copyRaw;
  if (so.keepRawB4Extraction != null) out.keepRawB4Extraction = !!so.keepRawB4Extraction;
  if (so.train_s1 != null || so.train != null) out.trainS1 = (so.train_s1 ?? so.train) !== false;
  if (so.train_s2 != null || so.train != null) out.trainS2 = (so.train_s2 ?? so.train) !== false;
  if (so.pauseAfterAsr != null) out.preprocessReview = !!so.pauseAfterAsr;
  if (so.pauseAfterDenoise != null) out.pauseAfterDenoise = !!so.pauseAfterDenoise;

  if (Array.isArray(t.versions) && t.versions.length) { out.modelVersions = t.versions; out.modelVersion = t.versions[0]; }
  else if (t.version) { out.modelVersion = t.version; out.modelVersions = [t.version]; }
  if (t.gpt_epochs != null) out.gptEpochs = t.gpt_epochs;
  if (t.sovits_epochs != null) out.sovitsEpochs = t.sovits_epochs;
  if (t.batch_size != null) out.batchSize = t.batch_size;
  if (t.learning_rate != null) out.learningRate = t.learning_rate;
  if (t.seed != null) out.s1Seed = t.seed;
  if (t.s1_save_every_n_epoch != null) out.s1SaveEvery = t.s1_save_every_n_epoch;
  else if (t.save_every_n_epoch != null) out.s1SaveEvery = t.save_every_n_epoch;
  if (t.s2_save_every_n_epoch != null) out.s2SaveEvery = t.s2_save_every_n_epoch;
  if (t.precision != null) out.s1Precision = t.precision;
  if (t.gradient_clip != null) out.s1GradClip = t.gradient_clip;
  if (t.lr != null) out.s1Lr = t.lr;
  if (t.lr_init != null) out.s1LrInit = t.lr_init;
  if (t.lr_end != null) out.s1LrEnd = t.lr_end;
  if (t.warmup_steps != null) out.s1Warmup = t.warmup_steps;
  if (t.decay_steps != null) out.s1Decay = t.decay_steps;
  if (t.max_sec != null) out.s1MaxSec = t.max_sec;
  if (t.num_workers != null) out.s1NumWorkers = t.num_workers;
  if (t.max_eval_sample != null) out.s1MaxEval = t.max_eval_sample;
  if (t.s2_seed != null) out.s2Seed = t.s2_seed;
  if (t.log_interval != null) out.s2LogInterval = t.log_interval;
  if (t.eval_interval != null) out.s2EvalInterval = t.eval_interval;
  if (t.fp16_run != null) out.s2Fp16 = t.fp16_run !== false;
  if (t.lr_decay != null) out.s2LrDecay = t.lr_decay;
  if (t.segment_size != null) out.s2SegmentSize = t.segment_size;
  if (t.c_mel != null) out.s2CMel = t.c_mel;
  if (t.c_kl != null) out.s2CKl = t.c_kl;
  if (t.text_low_lr_rate != null) out.s2TextLowLr = t.text_low_lr_rate;
  if (t.grad_ckpt != null) out.s2GradCkpt = !!t.grad_ckpt;

  if (sp.min_duration_sec != null) out.sliceMinSec = sp.min_duration_sec;
  if (sp.max_duration_sec != null) out.sliceMaxSec = sp.max_duration_sec;
  if (sp.silence_threshold_db != null) out.sliceSilenceDb = sp.silence_threshold_db;
  if (sp.min_silence_sec != null) out.sliceMinSilenceSec = sp.min_silence_sec;

  if (ap.engine != null) out.asrEngine = ap.engine;
  if (ap.model_size != null) out.asrModelSize = ap.model_size;
  if (ap.precision != null) out.asrPrecision = ap.precision;

  // 降噪参数：还原管线（或把旧格式的 {model} 字符串转成管线），并以「自定义」链
  // 写回表单，续跑时显示的正是原来的分离流程，且可以继续编辑。
  if (Array.isArray(dp.pipeline) && dp.pipeline.length) {
    out.denoisePipeline = dp.pipeline;
    out.denoisePreset = 'custom';
    out.denoiseAdvUnlocked = true;
  } else if (dp.model != null) {
    const legacy = String(dp.model) === 'mdx-net' ? 'HP2' : dp.model;
    out.denoisePipeline = [{ model: legacy, agg: AGG_DEFAULT }];
    out.denoisePreset = 'custom';
    out.denoiseAdvUnlocked = true;
    out.denoiseModel = dp.model;
  }

  return out;
}

export {
  resolveVocalPipeline,
  buildTrainingParams,
  buildSliceParams,
  buildAsrParams,
  _pick,
  buildStepParams,
  changedStepSet,
  archiveToForm,
}
