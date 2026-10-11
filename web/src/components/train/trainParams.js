// AUTO-EXTRACTED from TrainingTab.jsx (pure mechanical, zero logic change).
import {
  VOCAL_PRESET_BY_ID,
  EXPERT_KEYS,
  AGG_DEFAULT,
  S1_PARAM_KEYS,
  S2_PARAM_KEYS,
} from './trainConstants'

// Resolve the concrete pipeline the backend should run, from the current form.
// Presets clone their template (so per-preset param edits persist on the form);
// `custom` uses the user-built chain. Returns [] when off/empty.
function resolveVocalPipeline(form) {
  if (!form.denoise) return []
  const preset = form.denoisePreset || 'bgm'
  // Custom AND saved presets both edit the same working buffer (denoisePipeline);
  // selecting a saved preset seeds the buffer from it, and "Update preset" writes it
  // back — so what runs is always the (possibly edited) buffer. Fall back to the
  // stored preset only if the buffer is somehow empty (e.g. restored config).
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
  // Overlay user-tuned params stored per preset stage on form.denoisePresetParams.
  // A stage override is an object {agg?, tta?, ...}; a legacy number means {agg}.
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

// --- serialisers (single source of truth for the customParams shape) ---
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
    // S1 advanced
    seed: form.s1Seed ?? 1234,
    // Patch #10: S1 saves every 4 epochs (8 % 4 == 0), S2 every 5 (25 % 5 == 0),
    // so the final scheduled epoch always lands on a checkpoint. `save_every_n_epoch`
    // is kept for backward compatibility with older recipes / the diff logic.
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
    // S2 advanced
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

function buildSliceParams(form) {
  return {
    min_duration_sec: Number(form.sliceMinSec) || 3,
    max_duration_sec: Number(form.sliceMaxSec) || 15,
    silence_threshold_db: Number(form.sliceSilenceDb) || -40,
    min_silence_sec: Number(form.sliceMinSilenceSec) || 0.5,
  }
}

function buildAsrParams(form) {
  return { engine: form.asrEngine, model_size: form.asrModelSize, precision: form.asrPrecision }
}

function _pick(obj, keys) { const o = {}; for (const k of keys) o[k] = obj[k]; return o; }

// Canonical per-step parameter snapshot used to detect what the user changed after
// entering resume. Keys mirror the pipeline steps; comparison is a plain JSON diff.
// A change to a step's group means that step (and everything downstream) must re-run.
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

// Diff a live step-params object against the snapshot taken when resume started.
// Returns the set of step keys whose params changed.
function changedStepSet(live, snap) {
  const s = new Set();
  if (!live || !snap) return s;
  for (const k of Object.keys(live)) {
    if (JSON.stringify(live[k]) !== JSON.stringify(snap[k])) s.add(k);
  }
  return s;
}

// Reverse of buildTrainingParams/buildSliceParams/buildAsrParams: turn an archived
// task's saved params back into form.* fields so a resumed run shows the ORIGINAL
// settings, ready to tweak. Best-effort — unknown fields fall back to form defaults.
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

  // step toggles
  if (so.denoise != null) out.denoise = so.denoise;
  if (so.slice != null) out.slice = so.slice;
  if (so.asr != null) out.asr = so.asr;
  if (so.copyRaw != null) out.copyRaw = so.copyRaw;
  if (so.keepRawB4Extraction != null) out.keepRawB4Extraction = !!so.keepRawB4Extraction;
  if (so.train_s1 != null || so.train != null) out.trainS1 = (so.train_s1 ?? so.train) !== false;
  if (so.train_s2 != null || so.train != null) out.trainS2 = (so.train_s2 ?? so.train) !== false;
  if (so.pauseAfterAsr != null) out.preprocessReview = !!so.pauseAfterAsr;
  if (so.pauseAfterDenoise != null) out.pauseAfterDenoise = !!so.pauseAfterDenoise;

  // training params
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

  // slice params
  if (sp.min_duration_sec != null) out.sliceMinSec = sp.min_duration_sec;
  if (sp.max_duration_sec != null) out.sliceMaxSec = sp.max_duration_sec;
  if (sp.silence_threshold_db != null) out.sliceSilenceDb = sp.silence_threshold_db;
  if (sp.min_silence_sec != null) out.sliceMinSilenceSec = sp.min_silence_sec;

  // asr params
  if (ap.engine != null) out.asrEngine = ap.engine;
  if (ap.model_size != null) out.asrModelSize = ap.model_size;
  if (ap.precision != null) out.asrPrecision = ap.precision;

  // denoise params — restore the pipeline (or coerce a legacy {model} string) and
  // reflect it back into the form as the "custom" chain so a resumed run shows the
  // ORIGINAL separation exactly, editable.
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
