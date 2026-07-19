// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef } from 'react'
import { Select } from '../common/Select'
import { usePersistentState } from '../../usePersistentState'
import { api } from '../../lib/api'
import { PronPanel } from '../pron/PronProofing'
import { ConfirmDialog } from '../common/Dialogs'
import { NumField, TextField, SelectField } from '../common/Fields'
import { IconTrash } from '../common/Icons'
import { basename } from '../../lib/format'
import { useT } from '../../lib/i18n'

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

// Which buildTrainingParams() keys belong to S1 (GPT) vs S2 (SoVITS). Shared keys
// (version/versions/batch_size/learning_rate) affect both, so they are attributed to
// the EARLIER step (train_s1) — changing them re-runs from S1, which also re-runs S2.
const S1_PARAM_KEYS = ['version', 'versions', 'batch_size', 'learning_rate',
  'gpt_epochs', 'seed', 'save_every_n_epoch', 's1_save_every_n_epoch', 'precision', 'gradient_clip',
  'lr', 'lr_init', 'lr_end', 'warmup_steps', 'decay_steps', 'max_sec', 'num_workers', 'max_eval_sample'];
const S2_PARAM_KEYS = ['sovits_epochs', 's2_save_every_n_epoch', 's2_seed', 'log_interval', 'eval_interval', 'fp16_run',
  'lr_decay', 'segment_size', 'c_mel', 'c_kl', 'text_low_lr_rate', 'grad_ckpt'];

function _pick(obj, keys) { const o = {}; for (const k of keys) o[k] = obj[k]; return o; }

// Canonical per-step parameter snapshot used to detect what the user changed after
// entering resume. Keys mirror the pipeline steps; comparison is a plain JSON diff.
// A change to a step's group means that step (and everything downstream) must re-run.
function buildStepParams(form) {
  const t = buildTrainingParams(form);
  return {
    denoise: { model: form.denoiseModel ?? null, on: !!form.denoise },
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

// Pipeline step order shared by the failure-resume UI (mirrors backend STEP_ORDER).
const FSTEP_ORDER = ['denoise', 'slice', 'asr', 'preprocess', 'train_s1', 'train_s2', 'finalize', 'promote'];

const FSTEP_LABELS = {
  denoise: 'Vocal extraction', slice: 'Slicing', asr: 'ASR', preprocess: 'Preprocess',
  train_s1: 'S1 (GPT)', train_s2: 'S2 (SoVITS)', finalize: 'Finalize', promote: 'Publish',
};

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
  if (so.train_s1 != null || so.train != null) out.trainS1 = (so.train_s1 ?? so.train) !== false;
  if (so.train_s2 != null || so.train != null) out.trainS2 = (so.train_s2 ?? so.train) !== false;
  if (so.pauseAfterAsr != null) out.preprocessReview = !!so.pauseAfterAsr;

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

  // denoise params
  if (dp.model != null) out.denoiseModel = dp.model;

  return out;
}

// --- shared field panels (rendered identically on both pages) ---
function SliceParamFields({ form, setField }) {
  const { t } = useT()
  return (
    <div className="param-grid">
      <NumField label={t('Min Duration (s)', '最短时长 (秒)')} value={form.sliceMinSec} onChange={v => setField('sliceMinSec', v)} min={1} max={30} />
      <NumField label={t('Max Duration (s)', '最长时长 (秒)')} value={form.sliceMaxSec} onChange={v => setField('sliceMaxSec', v)} min={1} max={60} />
      <NumField label={t('Silence Threshold (dB)', '静音阈值 (dB)')} value={form.sliceSilenceDb} onChange={v => setField('sliceSilenceDb', v)} min={-60} max={0} />
      <NumField label={t('Min Silence (s)', '最短静音 (秒)')} value={form.sliceMinSilenceSec} onChange={v => setField('sliceMinSilenceSec', v)} step={0.1} min={0.1} max={5} />
    </div>
  )
}

function AsrParamFields({ form, setField }) {
  const { t } = useT()
  return (
    <>
      <div className="field">
        <label className="field-label">{t('ASR Engine', 'ASR 引擎')}</label>
        <Select className="control" value={form.asrEngine} onChange={e => setField('asrEngine', e.target.value)}>
          <option value="auto">{t('Auto (by language)', '自动 (按语言)')}</option>
          <option value="faster-whisper">Faster Whisper</option>
        </Select>
      </div>
      {form.asrEngine !== 'funasr' && (
        <div className="param-grid" style={{ marginTop: 8 }}>
          <div className="field">
            <label className="field-label">{t('Model Size', '模型大小')}</label>
            <Select className="control" value={form.asrModelSize || 'large-v3-turbo'} onChange={e => setField('asrModelSize', e.target.value)}>
              {ASR_MODEL_SIZES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          <div className="field">
            <label className="field-label">{t('Precision', '精度')}</label>
            <Select className="control" value={form.asrPrecision || 'float16'} onChange={e => setField('asrPrecision', e.target.value)}>
              {ASR_PRECISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
        </div>
      )}
    </>
  )
}

// --- per-model training columns (single source of truth for S1 / S2 params) ---
function S1BasicCol({ form, setField }) {
  const { t } = useT()
  return (
    <div>
      <div className="node-col-title">S1 · GPT</div>
      <div className="param-grid">
        <NumField label={t('Epochs', '训练轮数 (epoch)')} value={form.gptEpochs} onChange={v => setField('gptEpochs', v)} min={1} max={100} />
        <TextField label={t('Batch Size (auto / number)', '批大小 (auto / 数字)')} value={form.batchSize} onChange={v => setField('batchSize', v)} />
        <NumField label={t('Save Every N Epochs', '每 N 轮保存一次')} value={form.s1SaveEvery ?? 4} onChange={v => setField('s1SaveEvery', v)} min={1} max={50} />
      </div>
    </div>
  )
}

function S2BasicCol({ form, setField }) {
  const { t } = useT()
  return (
    <div>
      <div className="node-col-title">S2 · SoVITS</div>
      <div className="param-grid">
        <NumField label={t('Epochs', '训练轮数 (epoch)')} value={form.sovitsEpochs} onChange={v => setField('sovitsEpochs', v)} min={1} max={100} />
        <NumField label={t('Save Every N Epochs', '每 N 轮保存一次')} value={form.s2SaveEvery ?? 5} onChange={v => setField('s2SaveEvery', v)} min={1} max={50} />
        <TextField label={t('Learning Rate (default / number)', '学习率 (default / 数字)')} value={form.learningRate} onChange={v => setField('learningRate', v)} />
        <NumField label={t('Eval Interval', '评估间隔')} value={form.s2EvalInterval ?? 500} onChange={v => setField('s2EvalInterval', v)} min={10} max={10000} />
        <SelectField label={t('Precision', '精度')} value={form.s2Fp16 === false ? 'fp32' : 'fp16'} onChange={v => setField('s2Fp16', v !== 'fp32')} options={S2_PRECISIONS} />
      </div>
    </div>
  )
}

function S1ExpertCol({ form, setField }) {
  return (
    <div>
      <div className="node-col-title">S1 · GPT</div>
      <div className="param-subgroup-title">General</div>
      <div className="param-grid">
        <NumField label="Seed" value={form.s1Seed ?? 1234} onChange={v => setField('s1Seed', v)} min={0} max={999999} />
        <SelectField label="Precision" value={form.s1Precision || '16-mixed'} onChange={v => setField('s1Precision', v)} options={S1_PRECISIONS} />
        <NumField label="Gradient Clip" value={form.s1GradClip ?? 1.0} onChange={v => setField('s1GradClip', v)} min={0.1} max={10} step={0.1} />
        <NumField label="Num Workers" value={form.s1NumWorkers ?? 4} onChange={v => setField('s1NumWorkers', v)} min={1} max={16} />
      </div>
      <div className="param-subgroup-title">LR Scheduler</div>
      <div className="param-grid">
        <NumField label="Peak LR" value={form.s1Lr ?? 0.01} onChange={v => setField('s1Lr', v)} min={0.0001} max={1} step={0.001} />
        <NumField label="LR Init" value={form.s1LrInit ?? 0.00001} onChange={v => setField('s1LrInit', v)} min={0.0000001} max={0.1} step={0.00001} />
        <NumField label="LR End" value={form.s1LrEnd ?? 0.0001} onChange={v => setField('s1LrEnd', v)} min={0.0000001} max={0.1} step={0.00001} />
        <NumField label="Warmup Steps" value={form.s1Warmup ?? 2000} onChange={v => setField('s1Warmup', v)} min={0} max={100000} />
        <NumField label="Decay Steps" value={form.s1Decay ?? 40000} onChange={v => setField('s1Decay', v)} min={1000} max={200000} />
      </div>
      <div className="param-subgroup-title">Data &amp; Eval</div>
      <div className="param-grid">
        <NumField label="Max Audio Sec" value={form.s1MaxSec ?? 54} onChange={v => setField('s1MaxSec', v)} min={1} max={300} />
        <NumField label="Max Eval Sample" value={form.s1MaxEval ?? 8} onChange={v => setField('s1MaxEval', v)} min={1} max={100} />
      </div>
    </div>
  )
}

function S2ExpertCol({ form, setField }) {
  return (
    <div>
      <div className="node-col-title">S2 · SoVITS</div>
      <div className="param-subgroup-title">General</div>
      <div className="param-grid">
        <NumField label="Seed" value={form.s2Seed ?? 1234} onChange={v => setField('s2Seed', v)} min={0} max={999999} />
        <NumField label="Log Interval" value={form.s2LogInterval ?? 100} onChange={v => setField('s2LogInterval', v)} min={1} max={10000} />
        <NumField label="Segment Size" value={form.s2SegmentSize ?? 20480} onChange={v => setField('s2SegmentSize', v)} min={1024} max={65536} />
        <label className="toggle-row" style={{ alignSelf: 'end', paddingBottom: 6 }}>
          <input type="checkbox" checked={!!form.s2GradCkpt} onChange={e => setField('s2GradCkpt', e.target.checked)} /> Gradient Checkpoint (save VRAM)
        </label>
      </div>
      <div className="param-subgroup-title">Learning Rate</div>
      <div className="param-grid">
        <NumField label="LR Decay" value={form.s2LrDecay ?? 0.999875} onChange={v => setField('s2LrDecay', v)} min={0.9} max={1} step={0.0001} />
        <NumField label="Text Low LR Rate" value={form.s2TextLowLr ?? 0.4} onChange={v => setField('s2TextLowLr', v)} min={0.01} max={1} step={0.01} />
      </div>
      <div className="param-subgroup-title">Loss Weights</div>
      <div className="param-grid">
        <NumField label="C Mel Loss" value={form.s2CMel ?? 45} onChange={v => setField('s2CMel', v)} min={1} max={100} />
        <NumField label="C KL Loss" value={form.s2CKl ?? 1.0} onChange={v => setField('s2CKl', v)} min={0.1} max={10} step={0.1} />
      </div>
    </div>
  )
}

// part: 's1' | 's2' | 'both'. Renders the same fields whether shown on the unified
// Training page (both) or on a single-model node/restore panel (s1 / s2).
function TrainParamFields({ form, setField, part = 'both', versionMode = 'single' }) {
  const { t } = useT()
  const expertLocked = !form.expertUnlocked
  const showS1 = part === 's1' || part === 'both'
  const showS2 = part === 's2' || part === 'both'
  const hint = part === 's1'
    ? ''
    : part === 's2'
      ? t('S2 (SoVITS) trains independently of S1 — it does not need the GPT checkpoint.',
          'S2 (SoVITS) 独立于 S1 训练，不需要 GPT checkpoint。')
      : t('S1 and S2 are independent steps.', 'S1 与 S2 是相互独立的步骤。')
  // When only one stage is shown it spans the full modal width → lay params out 4-up.
  const colsClass = part === 'both' ? 'node-cols' : 'node-cols node-cols-solo'
  return (
    <>
      <div className="layer-label">{t('Advanced Options', '高级选项')}</div>
      {/* Base model version(s). Only shown for the SoVITS (S2) stage — GPT is version-agnostic.
          versionMode='multi' (S2 pipeline node) → checkbox group → form.modelVersions[] (read B:
          one SoVITS trained per checked version). Otherwise a single select (asset rebuild). */}
      {showS2 && (versionMode === 'multi' ? (
        <div className="train-version-row" style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>{t('SoVITS Version(s) — one model trained per checked version', 'SoVITS 版本 — 每勾选一个版本训练一个模型')}</label>
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {[
              { v: 'v2', label: 'v2' },
              { v: 'v2Pro', label: 'v2Pro' },
              { v: 'v2ProPlus', label: 'v2ProPlus' },
            ].map(({ v, label }) => {
              const cur = (Array.isArray(form.modelVersions) && form.modelVersions.length)
                ? form.modelVersions : (form.modelVersion ? [form.modelVersion] : ['v2Pro']);
              const checked = cur.includes(v);
              const toggle = (on) => {
                const order = ['v2', 'v2Pro', 'v2ProPlus'];
                let next = on ? [...cur, v] : cur.filter(x => x !== v);
                next = order.filter(o => next.includes(o)); // 去重 + 规范排序
                if (!next.length) next = [v]; // 至少保留一个版本，禁止清空
                setField('modelVersions', next);
              };
              return (
                <label key={v} className="toggle-row" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={checked} onChange={e => toggle(e.target.checked)} />
                  {label}
                </label>
              );
            })}
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            {t('Each checked version trains its own SoVITS model in a single run. v2Pro / v2ProPlus need their own base + SV models (download_models.py); missing ones are reported below the pipeline before you start.',
               '每个勾选的版本会在一次运行中训练各自的 SoVITS 模型。v2Pro / v2ProPlus 需要各自的 base + SV 模型 (download_models.py)；缺失的模型会在开始前于流程下方列出。')}
          </p>
        </div>
      ) : (
        <div className="train-version-row" style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>{t('Base Model Version', 'Base 模型版本')}</label>
          <Select className="control" value={form.modelVersion || 'v2'} onChange={e => setField('modelVersion', e.target.value)}>
            <option value="v2">{t('v2 — general base (s2G2333k)', 'v2 — 通用 base (s2G2333k)')}</option>
            <option value="v2Pro">{t('v2Pro — needs v2Pro base + SV model', 'v2Pro — 需要 v2Pro base + SV 模型')}</option>
            <option value="v2ProPlus">{t('v2ProPlus — needs v2ProPlus base + SV model', 'v2ProPlus — 需要 v2ProPlus base + SV 模型')}</option>
          </Select>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            {t('v2Pro / v2ProPlus need their own base + SV models (download_models.py). Missing base models are reported below the pipeline before you start.',
               'v2Pro / v2ProPlus 需要各自的 base + SV 模型 (download_models.py)。缺失的 base 模型会在开始前于流程下方列出。')}
          </p>
        </div>
      ))}
      <div className={colsClass}>
        {showS1 && <S1BasicCol form={form} setField={setField} />}
        {showS2 && <S2BasicCol form={form} setField={setField} />}
      </div>
      {hint && <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>{hint}</p>}

      <details className="expert-block" style={{ marginTop: 14 }}>
        <summary className="expert-summary">{t('Expert Parameters — GPT-SoVITS internals', '专家参数 — GPT-SoVITS 内部设置')}</summary>
        <div className="msg msg-danger expert-warning">
          <strong>{t('⚠ Expert Parameters.', '⚠ 专家参数。')}</strong> {t('Changing these can make training unstable, waste hours of GPU time, or produce a worse model. Most users should never touch them. Defaults are tuned for an 8GB GPU.',
            '修改这些参数可能导致训练不稳定、浪费数小时 GPU 时间，或训练出更差的模型。大多数用户不应改动它们。默认值针对 8GB 显存 GPU 调优。')}
        </div>
        <label className="toggle-row expert-unlock">
          <input type="checkbox" checked={!!form.expertUnlocked} onChange={e => setField('expertUnlocked', e.target.checked)} />
          {t('I understand the risks — let me edit expert parameters', '我了解风险 — 允许我编辑专家参数')}
        </label>
        <fieldset disabled={expertLocked} className="expert-fields" style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
          <div className={colsClass}>
            {showS1 && <S1ExpertCol form={form} setField={setField} />}
            {showS2 && <S2ExpertCol form={form} setField={setField} />}
          </div>
        </fieldset>
      </details>
    </>
  )
}

const LANGUAGES = [
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese (Mandarin)' },
  { code: 'en', label: 'English' },
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
    hintZh: '使用你自己的参数——可在下方各流程步骤中任意修改。',
    fields: null },
]

// Slicing preset field values, shared by the Slicing-step preset dropdown and the
// Input Type convenience mapping.
const SLICE_PRESET_VALUES = {
  default:    { sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5 },
  aggressive: { sliceMinSec: 2, sliceMaxSec: 10, sliceSilenceDb: -34, sliceMinSilenceSec: 0.3 },
  longer:     { sliceMinSec: 5, sliceMaxSec: 25, sliceSilenceDb: -45, sliceMinSilenceSec: 0.8 },
}

// Input types — frontend-only convenience. Maps the source-audio character to the
// preprocessing toggles (denoise / slice). All map to form.* fields that already exist.
//
// BACKEND-PENDING (Phase 4): this is a preset mapping, NOT content-aware detection.
// "Standard" applies the default preprocessing; it does not inspect the audio. True
// automatic input detection (and per-input-type dedicated algorithms beyond the single
// UVR5 denoise + single slicer2 the backend ships today) require a backend preflight
// scan. Tracked in PHASE2_REPORT.md → "Phase 4 backend dependencies".
const INPUT_TYPES = [
  { key: 'auto',  label: 'Standard (default)',  hint: 'Default preprocessing: slice + transcribe.',
    hintZh: '默认预处理：切片 + 转写。',
    fields: { denoise: false, slice: true, asr: true } },
  { key: 'clean', label: 'Clean voice clips',  hint: 'Already-clean recordings; no denoise.',
    hintZh: '已经干净的录音；不做降噪。',
    fields: { denoise: false, slice: true, asr: true } },
  { key: 'long',  label: 'Long raw recording', hint: 'One long take; slice into clips before training.',
    hintZh: '单条长录音；训练前先切成小片段。',
    fields: { denoise: false, slice: true, asr: true }, slicePreset: 'aggressive' },
  { key: 'noisy', label: 'Noisy / mixed audio', hint: 'Has music/noise; extract vocals first.',
    hintZh: '含音乐/噪声；先提取人声。',
    fields: { denoise: true, slice: true, asr: true } },
]

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

// Clickable pipeline map — doubles as navigation (click a node to configure it)
// and as live status (during a run the node reflects /api/train/status state).
function PipelineMap({ statusSteps, enabledMap, selectedNode, onSelect, readOnly }) {
  const { t, lang } = useT()
  return (
    <div className={`pipe-map ${readOnly ? 'readonly' : ''}`} role="list">
      {TRAIN_STEPS.map((s, i) => {
        let st
        const off = enabledMap && enabledMap[s.key] === false
        if (statusSteps && statusSteps[s.key]) st = statusSteps[s.key].status || 'pending'
        else st = off ? 'skipped' : 'pending'
        const glyph = st === 'completed' ? '\u2713' : st === 'running' ? '\u25CF' : st === 'failed' ? '\u2717' : st === 'skipped' ? '\u2013' : i + 1
        const isSel = selectedNode === s.key
        // The connector segment to the LEFT of this node turns green once the
        // previous step has completed, so the rail reads as a progress bar.
        const prevDone = i > 0 && statusSteps && statusSteps[TRAIN_STEPS[i - 1].key] &&
          statusSteps[TRAIN_STEPS[i - 1].key].status === 'completed'
        return (
          <button
            type="button"
            role="listitem"
            className={`pipe-step ${isSel ? 'selected' : ''} ${off ? 'disabled-step' : ''} ${readOnly ? 'readonly' : ''}`}
            key={s.key}
            onClick={readOnly ? undefined : () => onSelect(isSel ? null : s.key)}
            title={readOnly ? (lang === 'zh' ? s.labelZh : s.label) : t('Click to configure this step', '点击以配置此步骤')}
          >
            {i > 0 && <span className={`pipe-seg ${prevDone ? 'done' : ''}`} aria-hidden="true" />}
            <span className={`pipe-dot ${st}`}>{glyph}</span>
            <span className={`pipe-label ${st === 'running' ? 'running' : ''}`}>{lang === 'zh' ? s.labelZh : s.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// Live lightweight-pipeline panel for an in-flight Rebuild/Restore on the Assets
// page. Reuses the same PipelineMap (read-only) so the repair flow reads exactly
// like the formal training flow — irrelevant steps show greyed/skipped, the
// active step pulses, and a failure surfaces the exact step + error message.
function RebuildProgress({ job, onDismiss }) {
  if (!job) return null
  const stepLabel = (k) => (TRAIN_STEPS.find(s => s.key === k) || {}).label || k
  const failed = job.phase === 'failed'
  const done = job.phase === 'done'
  const scanning = job.phase === 'scanning'
  let statusText, statusCls
  if (failed) { statusText = `Failed at ${stepLabel(job.failedStep)}`; statusCls = 'error' }
  else if (done) { statusText = 'Rebuild complete — assets rescanned.'; statusCls = 'success' }
  else if (scanning) { statusText = 'Rebuild finished — rescanning assets…'; statusCls = 'info' }
  else { statusText = job.currentStep ? `Running: ${stepLabel(job.currentStep)}…` : 'Starting…'; statusCls = 'info' }
  return (
    <div className={`rebuild-progress ${failed ? 'is-failed' : ''}`}>
      <div className="rp-hdr">
        <span className="rp-title">
          {failed ? '\u2717' : done ? '\u2713' : '\u25CF'} {failed ? 'Rebuild failed' : done ? 'Rebuild done' : 'Rebuilding'} · {job.id}
        </span>
        {(failed || done) && (
          <button className="btn btn-sm btn-ghost" onClick={onDismiss}>Dismiss</button>
        )}
      </div>
      <PipelineMap statusSteps={job.steps} readOnly />
      <div className={`rp-status msg-${statusCls}`}>{statusText}</div>
      {failed && job.error && (
        <pre className="rp-error">{job.error}</pre>
      )}
    </div>
  )
}

// Live logs viewer with auto-scroll / pause / copy / clear (Part 2)
function LiveLogs({ logs }) {
  const [autoScroll, setAutoScroll] = useState(true)
  const boxRef = useRef(null)
  useEffect(() => {
    if (autoScroll && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [logs, autoScroll])
  const copy = () => {
    const txt = (logs || []).map(l => `[${new Date(l.time).toLocaleTimeString()}] ${l.message}`).join('\n')
    try { navigator.clipboard?.writeText(txt) } catch { /* ignore */ }
  }
  return (
    <div className="section">
      <div className="section-hdr">
        <span>Live Logs</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => setAutoScroll(v => !v)}>{autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}</button>
          <button className="btn btn-sm" onClick={copy} disabled={!logs || logs.length === 0}>Copy</button>
        </div>
      </div>
      <div className="section-body">
        {(!logs || logs.length === 0) ? (
          <div className="empty-state" style={{ padding: 16 }}>
            <div className="es-sub" style={{ marginBottom: 0 }}>Logs will appear here after training starts.</div>
          </div>
        ) : (
          <div className="log-view" ref={boxRef}>
            {logs.map((log, i) => (
              <div key={i} className={`log-line ${log.level || ''}`}>
                <span className="log-ts">[{new Date(log.time).toLocaleTimeString()}]</span>{log.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// P6: manual proofreading panel shown while the pipeline is paused after ASR.
// Loads the recognised .list, lets the user correct text/pronunciation per line,
// then saves + resumes (or resumes without changes).
// PG: per-line reading proofing inside the ASR review. Reuses the shared PronPanel
// so the user can, right after ASR, both fix the transcript text AND correct
// polyphonic/kana/phoneme readings — saving them to the personal lexicon
// (data/pron_lexicon/{lang}.json), which the g2p layer applies on the next
// training/inference run. Overrides are per-line and transient; only the lexicon
// save persists (that's the closed loop; see PG-1a).
function AsrRowProof({ text, lang, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  const [overrides, setOverrides] = useState({})
  return (
    <div className="arr-proof">
      <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => setOpen(o => !o)}>
        {open ? 'Hide reading proofing' : 'Proof reading'}
      </button>
      {open && (
        <PronPanel text={text} setText={onChange} lang={lang} overrides={overrides} setOverrides={setOverrides} layout="wide" />
      )}
    </div>
  )
}

function AsrReviewPanel({ taskId, onResumed, lang }) {
  const [rows, setRows] = useState(null);
  const [listName, setListName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    api(`/api/train/review/${taskId}`).then(r => {
      if (dead) return;
      if (r.ok) { setRows(r.data.rows || []); setListName(r.data.listName || ''); }
      else setErr(r.data?.error || 'Failed to load review list');
      setLoading(false);
    }).catch(e => { if (!dead) { setErr(String(e)); setLoading(false); } });
    return () => { dead = true; };
  }, [taskId]);

  const setText = (idx, val) => setRows(rs => rs.map(r => r.index === idx ? { ...r, text: val } : r));

  const save = async () => {
    setBusy(true); setErr(null); setMsg(null);
    const r = await api(`/api/train/review/${taskId}`, { method: 'POST', body: { rows } });
    setBusy(false);
    if (r.ok) setMsg(`Saved ${r.data.saved} line(s).`);
    else setErr(r.data?.error || 'Save failed');
  };

  const resume = async () => {
    setBusy(true); setErr(null); setMsg(null);
    const r = await api(`/api/train/resume/${taskId}`, { method: 'POST', body: { rows } });
    setBusy(false);
    if (r.ok) { setMsg('Resumed.'); if (onResumed) onResumed(); }
    else setErr(r.data?.error || 'Resume failed');
  };

  return (
    <div className="asr-review">
      <div className="asr-review-hdr">
        <span>Proofread transcription{listName ? ` · ${listName}` : ''}</span>
        <span className="muted">{rows ? `${rows.length} lines` : ''}</span>
      </div>
      {loading && <div className="msg">Loading transcript…</div>}
      {err && <div className="msg msg-error">{err}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}
      {rows && rows.length > 0 && (
        <div className="asr-review-list">
          {rows.map(r => (
            <div className="asr-review-row" key={r.index}>
              <div className="arr-path" title={r.audio_path}>{basename(r.audio_path) || r.audio_path}</div>
              <textarea className="arr-text" rows={1} value={r.text}
                        disabled={busy}
                        onChange={e => setText(r.index, e.target.value)} />
              <AsrRowProof text={r.text} lang={lang || 'ja'} disabled={busy}
                           onChange={val => setText(r.index, val)} />
            </div>
          ))}
        </div>
      )}
      {rows && rows.length === 0 && <div className="msg msg-warn">The transcript is empty.</div>}
      <div className="asr-review-ftr">
        <button className="btn btn-sm" disabled={busy || loading} onClick={save}>Save corrections</button>
        <button className="btn btn-sm btn-primary" disabled={busy || loading} onClick={resume}>
          {busy ? 'Working…' : 'Save & resume pipeline'}
        </button>
      </div>
    </div>
  );
}

function TrainingTab({ voices, loadVoices, activeTaskId, setActiveTaskId, trainPrefill, setTrainPrefill, health }) {
  const { t: tr } = useT()
  const [form, setForm] = usePersistentState('train.form', {
    inputDir: '', language: 'ja', voiceName: '',
    preset: 'default', inputType: 'auto', expertUnlocked: false,
    denoise: false, slice: true, asr: true, copyRaw: true,
    trainS1: true, trainS2: true,
    preprocessReview: false,
    keepStaging: false,
    // Advanced params
    gptEpochs: 8, sovitsEpochs: 25, batchSize: 'auto', learningRate: 'default',
    sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5,
    asrEngine: 'auto', denoiseModel: 'mdx-net',
    asrModelSize: 'large-v3-turbo', asrPrecision: 'float16',
    modelVersion: 'v2Pro', modelVersions: ['v2Pro'], isHalf: true, inferDevice: 'cuda',
    // S1 advanced
    s1Seed: 1234, s1SaveEvery: 4, s2SaveEvery: 5, s1Precision: '16-mixed', s1GradClip: 1.0,
    s1Lr: 0.01, s1LrInit: 0.00001, s1LrEnd: 0.0001, s1Warmup: 2000, s1Decay: 40000,
    s1MaxSec: 54, s1NumWorkers: 4, s1MaxEval: 8,
    // S2 advanced
    s2Seed: 1234, s2LogInterval: 100, s2EvalInterval: 500, s2Fp16: true,
    s2LrDecay: 0.999875, s2SegmentSize: 20480, s2CMel: 45, s2CKl: 1.0,
    s2TextLowLr: 0.4, s2GradCkpt: false,
  });
  const [localTaskId, setLocalTaskId] = useState(null);
  const [status, setStatus] = useState(null);
  // Base-model availability for the selected training version (drives the gate warning).
  const [baseModelStatus, setBaseModelStatus] = useState(null);
  const _selVersions = (Array.isArray(form.modelVersions) && form.modelVersions.length)
    ? form.modelVersions : [form.modelVersion || 'v2'];
  const _selVersionsKey = _selVersions.join(',');
  useEffect(() => {
    let cancelled = false;
    api(`/api/models/status?versions=${encodeURIComponent(_selVersionsKey)}`)
      .then(r => { if (!cancelled && r.ok) setBaseModelStatus(r.data); })
      .catch(() => { if (!cancelled) setBaseModelStatus(null); });
    return () => { cancelled = true; };
  }, [_selVersionsKey]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null); // pipeline-map node being configured/inspected
  // Advanced - Common
  // (existing: temperature, topK, topP, repPenalty, splitMethod, speedFactor, seed)
  // Advanced - Advanced
  const [batchSize, setBatchSize] = useState(1);
  const [batchThreshold, setBatchThreshold] = useState(0.75);
  const [splitBucket, setSplitBucket] = useState(true);
  const [fragmentInterval, setFragmentInterval] = useState(0.3);
  const [parallelInfer, setParallelInfer] = useState(true);
  const [sampleSteps, setSampleSteps] = useState(32);
  const [superSampling, setSuperSampling] = useState(false);
  const [mediaType, setMediaType] = useState('wav');
  const [streamingMode, setStreamingMode] = useState(false);
  const [overlapLength, setOverlapLength] = useState(2);
  const [minChunkLength, setMinChunkLength] = useState(16);
  const pollRef = useRef(null);
  const failCountRef = useRef(0);
  // Overwrite confirmation when the target voice id already exists (409 guard).
  const [overwriteConfirm, setOverwriteConfirm] = useState(null); // { existingId, existingDisplay }

  // ── GPU pre-flight (advisory only — we never auto-tune params) ──────────────
  // No NVIDIA GPU → block the start behind an explicit acknowledgement (CPU
  // fine-tuning is punishingly slow and UVR5 is unavailable). Low-VRAM (≤4GB)
  // GPUs still work but risk OOM, so we warn ONCE (persisted) rather than nag.
  const cuda = health?.cuda; // { available, device_name, vram_gb } | undefined until health loads
  const [noGpuConfirm, setNoGpuConfirm] = useState(false);
  const [noGpuAck, setNoGpuAck] = useState(false);
  const [lowVramWarned, setLowVramWarned] = usePersistentState('train.lowVramWarned', false);
  const [showLowVram, setShowLowVram] = useState(false);
  useEffect(() => {
    // Fire the one-time low-VRAM notice only for a real ≤4GB CUDA device.
    if (cuda?.ready && cuda.available && typeof cuda.vram_gb === 'number' && cuda.vram_gb <= 4 && !lowVramWarned) {
      setShowLowVram(true);
    }
  }, [cuda?.available, cuda?.vram_gb, lowVramWarned]);
  const dismissLowVram = () => { setShowLowVram(false); setLowVramWarned(true); };

  // ── Failure-resume (哪里跌倒哪里爬起来) ──────────────────────────────────────
  // Cached failed/interrupted tasks the user can resume. Default-collapsed panel.
  const [recoverList, setRecoverList] = useState([]);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverLoading, setRecoverLoading] = useState(false);
  // Active recovery context once the user clicks "Resume".
  //   { sourceTaskId, failedStep, resumeStep, steps, hasInputDir }
  const [recovery, setRecovery] = useState(null);
  // Baseline step-params captured when resume begins; live form is diffed against it
  // so an upstream param change can auto-pull the restart point back (→ fork).
  const paramSnapshotRef = useRef(null);
  const [restartFailedStep, setRestartFailedStep] = useState(false);

  const loadRecoverable = () => {
    setRecoverLoading(true);
    api('/api/train/recoverable')
      .then(r => { if (r.ok) setRecoverList(r.data.tasks || []); })
      .catch(() => {})
      .finally(() => setRecoverLoading(false));
  };
  // Load the list whenever the page is idle (no active task) so it stays fresh.
  useEffect(() => { if (!activeTaskId && !localTaskId) loadRecoverable(); }, [activeTaskId, localTaskId]);

  // 用 props 中的 activeTaskId，但在 handleStart 后也写一份本地（启动时用）
  const taskId = activeTaskId || localTaskId;
  const isAwaitingReview = status?.status === 'awaiting_review';
  const isRunning = status?.status === 'running';
  const isFinished = status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status);
  const isInterrupted = status?.status === 'interrupted';

  // Fields owned by a training preset — editing any of them by hand means the
  // current values no longer match the named preset, so flip the label to "Custom".
  const PRESET_KEYS = ['gptEpochs', 'sovitsEpochs', 'batchSize', 's1SaveEvery', 's2SaveEvery', 's2GradCkpt', 's2Fp16'];

  // 便捷 form setter
  const setField = (key, val) => setForm(prev => {
    const next = { ...prev, [key]: val };
    if (PRESET_KEYS.includes(key) && prev.preset && prev.preset !== 'custom') {
      next.preset = 'custom';
    }
    return next;
  });

  // Consume a one-shot prefill handed over from the Assets "Rebuild" action:
  // fill in the input folder + voice name, then clear the signal so it fires once.
  useEffect(() => {
    if (!trainPrefill) return;
    setForm(prev => ({ ...prev, ...trainPrefill }));
    if (setTrainPrefill) setTrainPrefill(null);
  }, [trainPrefill]);

  // Slicing presets: convenience that fills the four slice fields (or disables slicing)
  const applySlicePreset = (name) => {
    if (name === 'none') { setField('slice', false); return; }
    const p = SLICE_PRESET_VALUES[name];
    if (p) setForm(prev => ({ ...prev, slice: true, ...p }));
  };

  // Training preset (default-view convenience): overwrite the training fields in one go.
  const applyPreset = (name) => {
    const p = TRAIN_PRESETS.find(x => x.key === name);
    if (!p) return;
    setForm(prev => ({ ...prev, preset: name, ...(p.fields || {}) }));
  };

  // Input type (default-view convenience): maps source-audio character to preprocessing toggles.
  const applyInputType = (name) => {
    const t = INPUT_TYPES.find(x => x.key === name);
    if (!t) return;
    const sliceVals = t.slicePreset ? SLICE_PRESET_VALUES[t.slicePreset] : null;
    setForm(prev => ({ ...prev, inputType: name, ...(t.fields || {}), ...(sliceVals || {}) }));
  };

  // 轮询训练状态 —— 有 taskId 就轮询，不依赖本地 training 布尔
  useEffect(() => {
    if (!taskId) return;
    let dead = false; // 标记任务已彻底消失，停止轮询
    const MAX_FAIL = 3;
    const poll = () => {
      if (dead) return;
      api(`/api/train/status/${taskId}`).then(r => {
        if (r.ok) {
          failCountRef.current = 0;
          setStatus(r.data);
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(r.data.status)) {
            if (r.data.status === 'completed') loadVoices();
          }
        } else if (r.status === 404) {
          // 任务已被清理（磁盘 journal 也删了），自愈回到表单
          dead = true;
          failCountRef.current = 0;
          setActiveTaskId(null);
          setLocalTaskId(null);
          setStatus(null);
          setLogs([]);
        } else {
          // 其他错误（5xx 等）计入失败计数
          failCountRef.current++;
          if (failCountRef.current >= MAX_FAIL) {
            dead = true;
            failCountRef.current = 0;
            setActiveTaskId(null);
            setLocalTaskId(null);
            setStatus(null);
            setLogs([]);
          }
        }
      }).catch(() => {
        // 网络错误也计入失败计数
        failCountRef.current++;
        if (failCountRef.current >= MAX_FAIL) {
          dead = true;
          failCountRef.current = 0;
          setActiveTaskId(null);
          setLocalTaskId(null);
          setStatus(null);
          setLogs([]);
        }
      });
      api(`/api/train/logs/${taskId}`).then(r => {
        if (r.ok) setLogs(r.data.logs || []);
      }).catch(() => {});
    };
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [taskId]);

  // "Restoring training state…" 超时兜底：10s 后仍无 status 则回退表单
  const restoreTimeoutRef = useRef(null);
  useEffect(() => {
    if (taskId && !status) {
      restoreTimeoutRef.current = setTimeout(() => {
        setActiveTaskId(null);
        setLocalTaskId(null);
        setStatus(null);
        setLogs([]);
      }, 10000);
    }
    return () => {
      if (restoreTimeoutRef.current) {
        clearTimeout(restoreTimeoutRef.current);
        restoreTimeoutRef.current = null;
      }
    };
  }, [taskId, status]);

  const submitTraining = async (overwrite) => {
    let cleanDir = form.inputDir.trim();
    if ((cleanDir.startsWith('"') && cleanDir.endsWith('"')) ||
        (cleanDir.startsWith("'") && cleanDir.endsWith("'"))) {
      cleanDir = cleanDir.slice(1, -1);
    }
    const steps = recovery
      ? buildRecoverySteps()
      : { denoise: form.denoise, slice: form.slice, asr: form.asr, copyRaw: form.copyRaw, train_s1: form.trainS1 !== false, train_s2: form.trainS2 !== false, pauseAfterAsr: !!form.preprocessReview, keepStaging: !!form.keepStaging };
    const recoveryFields = recovery
      ? (recoveryMode === 'modify'
          ? { forkFromTaskId: recovery.sourceTaskId }
          : { resumeTaskId: recovery.sourceTaskId, restartFailedStep: !!restartFailedStep })
      : {};
    const r = await api('/api/train/start', {
      method: 'POST',
      body: {
        displayName: form.voiceName.trim(),
        language: form.language,
        inputDir: cleanDir,
        overwrite: !!overwrite,
        ...recoveryFields,
        steps,
        customParams: {
          training: buildTrainingParams(form),
          steps: {
            slice: { params: buildSliceParams(form) },
            asr: { params: buildAsrParams(form) },
            denoise: { params: { model: form.denoiseModel } },
          },
        },
      },
    });
    // Existing-voice guard: server refuses without explicit overwrite. Surface a
    // confirm showing the DISPLAY NAME the id currently belongs to.
    if (!r.ok && r.status === 409 && r.data?.code === 'VOICE_EXISTS') {
      setOverwriteConfirm({ existingId: r.data.existingId, existingDisplay: r.data.existingDisplay });
      return;
    }
    if (!r.ok) throw new Error(r.data?.error || 'Failed to start training');
    setRecovery(null);
    paramSnapshotRef.current = null;
    setRestartFailedStep(false);
    setLocalTaskId(r.data.taskId);
    setActiveTaskId(r.data.taskId); // 写入持久化 + 触发 App 层重连
  };

  const handleStart = async () => {
    // In recovery mode the original audio folder is only needed when the rerun
    // starts at denoise/slice; later steps resume from cached products.
    const needsInput = !recovery || rerunStart === 'denoise' || rerunStart === 'slice';
    if (needsInput && !form.inputDir.trim()) {
      setError(recovery
        ? 'This resume restarts from denoise/slice, which needs the original audio folder. Please re-select it.'
        : 'Please select an audio folder');
      return;
    }
    if (!form.voiceName.trim()) { setError('Please enter a voice name'); return }
    // GPU pre-flight: when health has loaded and reports no CUDA device, block
    // behind an explicit acknowledgement instead of silently starting a CPU run.
    // (We only block on a definitive false; while health is still loading we let
    // it proceed rather than gate on unknown state.)
    if (cuda && cuda.ready && cuda.available === false) {
      setNoGpuAck(false);
      setNoGpuConfirm(true);
      return;
    }
    setError(null);
    setStatus(null);
    setLogs([]);
    try {
      await submitTraining(false);
    } catch (err) {
      setError(err.message);
    }
  }

  // Continue a fine-tune after the user acknowledged the no-GPU warning.
  const proceedWithoutGpu = async () => {
    setNoGpuConfirm(false);
    setError(null);
    setStatus(null);
    setLogs([]);
    try {
      await submitTraining(false);
    } catch (err) {
      setError(err.message);
    }
  }

  const confirmOverwriteTrain = async () => {
    setOverwriteConfirm(null);
    setError(null);
    try {
      await submitTraining(true);
    } catch (err) {
      setError(err.message);
    }
  }

  const handleCancel = async () => {
    if (!taskId) return;
    await api(`/api/train/cancel/${taskId}`, { method: 'POST' });
  };

  const handleReset = () => {
    setActiveTaskId(null);
    setLocalTaskId(null);
    setStatus(null);
    setLogs([]);
    setError(null);
  };

  // Enter recovery mode for a cached failed/interrupted task: prefill the form with
  // the original params and pin the rerun start to the failed step (Continue mode).
  const beginResume = (task) => {
    const patch = archiveToForm(task);
    setForm(prev => {
      const next = { ...prev, ...patch };
      // Snapshot the loaded params as the baseline for change detection.
      paramSnapshotRef.current = buildStepParams(next);
      return next;
    });
    setRecovery({
      sourceTaskId: task.id,
      failedStep: task.resumeStep || (task.failedAt && task.failedAt.step) || 'preprocess',
      resumeStep: task.resumeStep || (task.failedAt && task.failedAt.step) || 'preprocess',
      steps: task.steps || {},
      hasInputDir: !!task.inputDir,
      failedAt: task.failedAt || null,
    });
    setRestartFailedStep(false);
    setError(null);
    setRecoverOpen(false);
    setSelectedNode(null);
  };

  const cancelRecovery = () => {
    setRecovery(null);
    paramSnapshotRef.current = null;
    setRestartFailedStep(false);
    setError(null);
  };

  // Which upstream steps can be chosen as the rerun start: completed steps up to and
  // including the failed step. Moving earlier than the failed step ⇒ Modify/fork.
  const failedIdx = recovery ? FSTEP_ORDER.indexOf(recovery.failedStep) : -1;
  const resumeStepOptions = recovery
    ? FSTEP_ORDER.filter((s, i) => i <= failedIdx &&
        (s === recovery.failedStep || (recovery.steps[s] && recovery.steps[s].status === 'completed')))
    : [];
  // Detect which steps' params the user changed since resume began. A change to an
  // UPSTREAM step (before the failure point, and selectable/completed) can't be applied
  // by an in-place resume — its cached output would be reused, silently ignoring the
  // edit. So we auto-pull the restart point back to the earliest changed upstream step,
  // which turns the run into a fork (new task) and re-runs from there.
  const changedSteps = recovery ? changedStepSet(buildStepParams(form), paramSnapshotRef.current) : new Set();
  const earliestChangedStep = recovery
    ? (FSTEP_ORDER.find(s => changedSteps.has(s) && resumeStepOptions.includes(s)) || null)
    : null;
  const userResumeStep = recovery ? recovery.resumeStep : null;
  // Effective restart = the earlier of the user's chosen step and the earliest changed step.
  const rerunStart = recovery
    ? ((earliestChangedStep && FSTEP_ORDER.indexOf(earliestChangedStep) < FSTEP_ORDER.indexOf(userResumeStep))
        ? earliestChangedStep : userResumeStep)
    : null;
  const rerunIdx = recovery ? FSTEP_ORDER.indexOf(rerunStart) : -1;
  // A param change forced the fork (vs the user manually dragging the restart earlier).
  const forkByParamChange = !!(recovery && earliestChangedStep && FSTEP_ORDER.indexOf(earliestChangedStep) < failedIdx
    && FSTEP_ORDER.indexOf(earliestChangedStep) <= rerunIdx);
  // Continue = restart exactly at the failed step (in place, same task). Modify =
  // restart at an earlier completed step (fork → new task; only upstream products copied).
  const recoveryMode = recovery ? (rerunIdx < failedIdx ? 'modify' : 'continue') : null;
  const failedIsTrain = recovery && (recovery.failedStep === 'train_s1' || recovery.failedStep === 'train_s2');

  // Compute the step-enable overrides sent on a recovery run: upstream (< rerunStart)
  // is reused (enabled=false → backend marks completed & skips); rerunStart..end run,
  // respecting the user's own enable toggles for optional steps.
  const buildRecoverySteps = () => {
    const idx = FSTEP_ORDER.indexOf(rerunStart);
    const on = (k, formVal) => (FSTEP_ORDER.indexOf(k) >= idx) ? formVal : false;
    return {
      denoise: on('denoise', !!form.denoise),
      slice: on('slice', !!form.slice),
      asr: on('asr', !!form.asr),
      copyRaw: form.copyRaw,
      preprocess: on('preprocess', true),
      train_s1: on('train_s1', form.trainS1 !== false),
      train_s2: on('train_s2', form.trainS2 !== false),
      finalize: on('finalize', true),
      promote: on('promote', true),
      pauseAfterAsr: !!form.preprocessReview,
    };
  };

  const [clearMsg, setClearMsg] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const handleClearStaging = async () => {
    if (clearing) return;
    setCacheConfirm(false);
    setClearing(true);
    setClearMsg(null);
    try {
      const r = await api('/api/train/clear-staging', { method: 'POST' });
      if (!r.ok) throw new Error(r.data?.error || 'Failed to clean cache');
      const mb = (r.data.bytes / (1024 * 1024)).toFixed(1);
      const skipped = r.data.skipped ? `, ${r.data.skipped} running task(s) kept` : '';
      setClearMsg(`Cleaned ${r.data.removed} task workspace(s), freed ${mb} MB${skipped}. Published models and assets are untouched.`);
    } catch (err) {
      setClearMsg(`Clean failed: ${err.message}`);
    } finally {
      setClearing(false);
    }
  };

  const editable = !taskId; // inputs are editable only before a task starts

  // Option A: the input is a DISPLAY NAME (Chinese/Unicode allowed). The canonical
  // ASCII id is decoupled and allocated by the server, once, atomically at task
  // creation. We fetch a PROPOSED preview id here purely for display — it is
  // explicitly non-reserved and the final id may differ. A slug/display-name
  // collision NEVER implies overwrite; every new voice gets a distinct id.
  const displayName = (form.voiceName || '').trim();
  const [proposedId, setProposedId] = useState('');
  useEffect(() => {
    if (!displayName) { setProposedId(''); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await api('/api/assets/derive-id', { method: 'POST', body: { display_name: displayName } });
      if (!cancelled && r.ok && r.data) setProposedId(r.data.proposed_id || '');
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [displayName]);
  // Non-blocking notice: other voices already using this exact display name.
  const dupDisplay = displayName
    ? voices.filter(v => (v.display_name || v.id) === displayName)
    : [];
  const enabledSteps = [
    form.denoise && 'Vocal extraction',
    form.copyRaw && 'Copy to raw', form.slice && 'Slice', form.asr && 'ASR',
    'Preprocess', 'S1 (GPT)', 'S2 (SoVITS)', 'Finalize', 'Publish',
  ].filter(Boolean);

  const NODE_LABELS = {
    denoise: tr('Vocal Extraction', '人声提取'), slice: tr('Slicing', '切片'), asr: tr('ASR Transcription', 'ASR 转写'),
    preprocess: tr('Preprocess', '预处理'), train_s1: tr('S1 Training (GPT)', 'S1 训练 (GPT)'), train_s2: tr('S2 Training (SoVITS)', 'S2 训练 (SoVITS)'),
    finalize: tr('Finalize', '打包完成'), promote: tr('Publish', '发布'),
  };

  const renderNodeDetail = () => {
    if (!selectedNode) return null;
    const stepSt = status?.steps?.[selectedNode]?.status;
    const stBadge = stepSt && (
      <span className={`badge ${stepSt === 'completed' ? 'badge-ok' : stepSt === 'running' ? 'badge-accent' : stepSt === 'failed' ? 'badge-danger' : 'badge-neutral'}`}>{stepSt}</span>
    );
    let body = null;
    if (selectedNode === 'denoise') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.denoise} onChange={e => setField('denoise', e.target.checked)} />
            {tr('Enable vocal extraction', '启用人声提取')}
          </label>
          {form.denoise && (
            <div className="field">
              <label className="field-label">{tr('Model', '模型')}</label>
              <Select className="control" value={form.denoiseModel} onChange={e => setField('denoiseModel', e.target.value)}>
                <option value="mdx-net">HP2 (Vocal Remover)</option>
              </Select>
            </div>
          )}
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{tr('Extracts the vocal track (removes background music / instrumental) before slicing, using the UVR5 HP2 model (VR architecture). Off by default — only needed for noisy or mixed audio.',
            '在切片前使用 UVR5 HP2 模型（VR 架构）提取人声轨道（去除背景音乐 / 伴奏）。默认关闭——仅在音频含噪声或混音时才需要。')}</p>
        </>
      );
    } else if (selectedNode === 'slice') {
      // Invariant #5: an asset must end up with at least one kind of reference audio.
      // slice → slicer_opt/ ; copyRaw → raw/. Both off would publish an empty asset,
      // so unchecking one auto-forces the other on.
      const toggleSlice = (checked) => {
        setForm(f => ({ ...f, slice: checked, copyRaw: checked ? f.copyRaw : true }));
      };
      const toggleCopyRaw = (checked) => {
        setForm(f => ({ ...f, copyRaw: checked, slice: checked ? f.slice : true }));
      };
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.slice} onChange={e => toggleSlice(e.target.checked)} />
            {tr('Enable slicing', '启用切片')}
          </label>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.copyRaw} onChange={e => toggleCopyRaw(e.target.checked)} />
            {tr('Copy raw audio into the asset (keep originals as reference)', '将原始音频复制进资源（保留原始文件作为参考）')}
          </label>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: -2, marginBottom: 8 }}>
            {tr(
              <>At least one kind of reference audio is required: slicing or copied raw.
              Turning off “Copy raw” forces slicing on, and vice versa (otherwise the asset
              would have no reference audio). When slicing is off, ASR writes <code>raw_opt.list</code>.</>,
              <>至少需要一种参考音频：切片或复制的原始音频。关闭“复制原始音频”会强制开启切片，反之亦然
              （否则资源将没有参考音频）。切片关闭时，ASR 会写入 <code>raw_opt.list</code>。</>)}
          </p>
          <div className="field">
            <label className="field-label">{tr('Slicing preset', '切片预设')}</label>
            <Select className="control" onChange={e => applySlicePreset(e.target.value)} defaultValue="">
              <option value="" disabled>{tr('Choose a preset…', '选择一个预设…')}</option>
              <option value="default">{tr('Default', '默认')}</option>
              <option value="aggressive">{tr('More aggressive split', '更激进的切分')}</option>
              <option value="longer">{tr('Fewer, longer clips', '更少、更长的片段')}</option>
              <option value="none">{tr('Already sliced (no slicing)', '已切片（不再切片）')}</option>
            </Select>
          </div>
          {form.slice && (
            <div style={{ marginTop: 4 }}>
              <SliceParamFields form={form} setField={setField} />
            </div>
          )}
        </>
      );
    } else if (selectedNode === 'asr') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.asr} onChange={e => setField('asr', e.target.checked)} />
            {tr('Enable transcription (ASR)', '启用转写 (ASR)')}
          </label>
          {form.asr && <AsrParamFields form={form} setField={setField} />}
        </>
      );
    } else if (selectedNode === 'train_s1') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.trainS1 !== false} onChange={e => setField('trainS1', e.target.checked)} />
            {tr('Enable S1 (GPT) fine-tuning', '启用 S1 (GPT) 微调')}
          </label>
          {form.trainS1 !== false
            ? <TrainParamFields form={form} setField={setField} part="s1" />
            : <p style={{ fontSize: 11, color: 'var(--muted)' }}>{tr('S1 (GPT) fine-tuning is turned off — this step will be skipped.', 'S1 (GPT) 微调已关闭——此步骤将被跳过。')}</p>}
        </>
      );
    } else if (selectedNode === 'train_s2') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.trainS2 !== false} onChange={e => setField('trainS2', e.target.checked)} />
            {tr('Enable S2 (SoVITS) fine-tuning', '启用 S2 (SoVITS) 微调')}
          </label>
          {form.trainS2 !== false
            ? <TrainParamFields form={form} setField={setField} part="s2" versionMode="multi" />
            : <p style={{ fontSize: 11, color: 'var(--muted)' }}>{tr('S2 (SoVITS) fine-tuning is turned off — this step will be skipped.', 'S2 (SoVITS) 微调已关闭——此步骤将被跳过。')}</p>}
        </>
      );
    } else if (selectedNode === 'preprocess') {
      body = (
        <>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>{tr('Extracts text tokens and audio features required for training.', '提取训练所需的文本 token 与音频特征。')}</p>
          <label className="toggle-row" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={form.preprocessReview !== false && form.preprocessReview}
                   onChange={e => setField('preprocessReview', e.target.checked)} />
            {tr('Pause after ASR for manual proofreading', 'ASR 之后暂停以进行人工校对')}
          </label>
          <p className="field-hint" style={{ marginTop: 4 }}>
            {tr('When enabled the pipeline stops right after transcription so you can correct the recognised text and pronunciation before preprocessing/training continue.',
                '启用后，流程会在转写完成后立即停止，让你在继续预处理 / 训练之前修正识别出的文本和读音。')}
          </p>
        </>
      );
    } else if (selectedNode === 'finalize') {
      body = <p style={{ fontSize: 12, color: 'var(--muted)' }}>{tr('Packages the trained checkpoints and reference audio into a voice asset. No configuration needed.', '将训练好的 checkpoint 与参考音频打包成一个音色资源。无需配置。')}</p>;
    } else if (selectedNode === 'promote') {
      body = (
        <>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>{tr(
            <>Publishes the finished voice into <code>assets/</code> so it becomes selectable on the Generate page.</>,
            <>将完成的音色发布到 <code>assets/</code>，使其可在 Generate 页面中选择。</>)}</p>
          <label className="toggle-row">
            <input type="checkbox" checked={!!form.keepStaging}
                   onChange={e => setField('keepStaging', e.target.checked)} />
            {tr('Keep task workspace after publish', '发布后保留任务工作区')}
          </label>
          <p className="field-hint" style={{ marginTop: 4, color: 'var(--warning)' }}>
            {tr(
              <>By default this task&rsquo;s staging workspace (<code>.staging/&lt;taskId&gt;</code> — the
              intermediate preprocessing features and checkpoints) is <strong>permanently deleted</strong> once
              the voice is published, since the finished asset no longer needs it. Enable this only when you
              want to <strong>keep</strong> those intermediates for inspection or debugging. It will
              count against your disk space.</>,
              <>默认情况下，本任务的暂存工作区（<code>.staging/&lt;taskId&gt;</code>——中间预处理特征与 checkpoint）
              会在音色发布后被<strong>永久删除</strong>，因为完成的资源已不再需要它。只有当你想<strong>保留</strong>
              这些中间产物用于检查或调试时才开启。它会占用你的磁盘空间。</>)}
          </p>
          <p className="field-hint">
            {tr(
              <>The retained workspace is <strong>never</strong> reused by later tasks — it lives only so you
              can inspect it. Delete it later from the Train page&rsquo;s cache manager when you no longer need it.</>,
              <>保留的工作区<strong>绝不会</strong>被后续任务复用——它仅供你检查之用。不再需要时，可在 Train 页面的缓存管理器中删除它。</>)}
          </p>
        </>
      );
    }
    return (
      <div className="node-detail">
        <div className="node-detail-hdr">
          <span className="node-detail-title">{NODE_LABELS[selectedNode]}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {stBadge}
            <button className="btn btn-sm" onClick={() => setSelectedNode(null)}>{tr('Close', '关闭')}</button>
          </div>
        </div>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
          {body}
        </fieldset>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="section">
        <div className="section-hdr"><h2>Train New Voice</h2></div>
        <div className="section-body">
          {/* Recover a failed run — default-collapsed list of cached failed/interrupted
              tasks. "Resume" restores the pipeline and continues from the failure point. */}
          {!taskId && (
            <div className="recover-panel">
              <button type="button" className="recover-toggle" onClick={() => { const n = !recoverOpen; setRecoverOpen(n); if (n) loadRecoverable(); }}>
                <span className="recover-caret">{recoverOpen ? '▾' : '▸'}</span>
                {tr('Recover a failed run', '恢复失败的任务')}
                {recoverList.length > 0 && <span className="recover-count">{recoverList.length}</span>}
              </button>
              {recoverOpen && (
                <div className="recover-body">
                  {recoverLoading && <p className="field-hint">{tr('Loading…', '加载中…')}</p>}
                  {!recoverLoading && recoverList.length === 0 && (
                    <p className="field-hint">{tr('No failed or interrupted tasks in the cache. Everything is clean.', '缓存中没有失败或中断的任务。一切正常。')}</p>
                  )}
                  {!recoverLoading && recoverList.length > 0 && (
                    <table className="recover-table">
                      <thead>
                        <tr><th>{tr('Voice', '音色')}</th><th>{tr('Lang', '语言')}</th><th>{tr('Failed at', '失败于')}</th><th>{tr('Reason', '原因')}</th><th>{tr('When', '时间')}</th><th></th></tr>
                      </thead>
                      <tbody>
                        {recoverList.map(t => (
                          <tr key={t.id} className={recovery && recovery.sourceTaskId === t.id ? 'recover-row-active' : ''}>
                            <td>{t.voiceId || <span className="field-hint">—</span>}</td>
                            <td>{t.language || '—'}</td>
                            <td>
                              <span className="badge badge-danger">{FSTEP_LABELS[t.resumeStep] || t.resumeStep || t.status}</span>
                            </td>
                            <td className="recover-reason" title={t.failedAt && t.failedAt.reason || ''}>
                              {(t.failedAt && t.failedAt.reason) || (t.status === 'interrupted' ? tr('Interrupted', '已中断') : tr('Unknown', '未知'))}
                            </td>
                            <td className="recover-when">{t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}</td>
                            <td>
                              <button className="btn btn-sm btn-primary" onClick={() => beginResume(t)}
                                disabled={recovery && recovery.sourceTaskId === t.id}>
                                {recovery && recovery.sourceTaskId === t.id ? tr('Selected', '已选择') : tr('Resume', '恢复')}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="field-hint" style={{ marginTop: 6 }}>
                    {tr('Only failed / interrupted tasks appear here. Successful runs are cleaned up automatically after publishing.',
                        '这里只显示失败 / 中断的任务。成功的运行在发布后会被自动清理。')}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Essentials — one horizontal row so the page reads wide, not narrow */}
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
            <div className="essentials-grid">
              <div className="field">
                <label className="field-label">{tr('Display Name', '显示名称')} *</label>
                <input className="control" value={form.voiceName} onChange={e => setField('voiceName', e.target.value)} placeholder="例如：雷子 / MyVoice" />
                {displayName && (
                  <p className="field-hint">
                    {tr('Proposed ID:', '建议 ID：')} <code>{proposedId || '…'}</code>
                    <span className="field-note"> {tr('(finalized at creation — may differ)', '（在创建时最终确定——可能与此不同）')}</span>
                    {dupDisplay.length > 0 && (
                      <><br/><span className="pf-warn">{tr(
                        `ⓘ ${dupDisplay.length} existing voice${dupDisplay.length > 1 ? 's' : ''} already use this display name (id${dupDisplay.length > 1 ? 's' : ''}: ${dupDisplay.map(v => v.id).join(', ')}). A new distinct voice will be created.`,
                        `ⓘ 已有 ${dupDisplay.length} 个音色在使用该显示名称（id：${dupDisplay.map(v => v.id).join(', ')}）。将创建一个新的、独立的音色。`)}</span></>
                    )}
                  </p>
                )}
              </div>
              <div className="field">
                <label className="field-label">{tr('Language', '语言')} *</label>
                <Select className="control" value={form.language} onChange={e => setField('language', e.target.value)}>
                  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                </Select>
              </div>
              <div className="field">
                <label className="field-label">{tr('Audio Folder Path', '音频文件夹路径')} *</label>
                <input className="control" value={form.inputDir} onChange={e => setField('inputDir', e.target.value)} placeholder="e.g. D:\raw_audio\MyVoice" />
                <p className="field-hint">{tr('ⓘ Folder path only — point to a folder of audio files. If you have a single audio file, put it inside a folder first, then select that folder.',
                  'ⓘ 仅填文件夹路径——指向一个存放音频文件的文件夹。如果只有单个音频文件，请先把它放进一个文件夹，再选择该文件夹。')}</p>
              </div>
            </div>

            {/* Preset + Input Type — high-level, user-friendly defaults (Part 2).
                Both are frontend-only: they just fill existing form.* fields. */}
            <div className="preset-grid">
              <div className="field">
                <label className="field-label">{tr('Training Preset', '训练预设')}</label>
                <Select className="control" value={form.preset || 'default'} onChange={e => applyPreset(e.target.value)}>
                  {TRAIN_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                </Select>
                <p className="field-hint">{(() => { const p = TRAIN_PRESETS.find(p => p.key === (form.preset || 'default')) || {}; return tr(p.hint, p.hintZh) })()}</p>
                <p className="field-note">{tr('S1 adapts semantic rhythm and prosody and may overfit earlier on small datasets. S2 receives more training epochs for acoustic and timbre adaptation.',
                  'S1 学习语义层面的节奏与韵律，在小数据集上更容易过拟合。S2 使用更多训练 epoch 来适配音质与音色。')}</p>
                <p className="field-note">{tr('More training does not always produce better results. Keep earlier checkpoints and compare them before choosing a model.',
                  '训练更久不一定效果更好。请保留较早的 checkpoint，先对比再决定用哪个模型。')}</p>
              </div>
              <div className="field">
                <label className="field-label">{tr('Input Type', '输入类型')}</label>
                <Select className="control" value={form.inputType || 'auto'} onChange={e => applyInputType(e.target.value)}>
                  {INPUT_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </Select>
                <p className="field-hint">{(() => { const it = INPUT_TYPES.find(x => x.key === (form.inputType || 'auto')) || {}; return tr(it.hint, it.hintZh) })()}</p>
                <p className="field-note">{tr('ⓘ Preset mapping, not content detection — automatic input detection arrives with backend support.',
                  'ⓘ 这是预设映射，并非内容检测——自动输入检测将在后端支持后提供。')}</p>
              </div>
            </div>
          </fieldset>

          {/* Recovery banner — Continue (in place) vs Modify (fork → new task) */}
          {recovery && (
            <div className={`resume-banner ${recoveryMode === 'modify' ? 'resume-banner-fork' : 'resume-banner-continue'}`}>
              <div className="resume-banner-hdr">
                <span className="resume-banner-title">
                  {recoveryMode === 'modify' ? tr('↳ Resume as a NEW task (fork)', '↳ 作为新任务恢复（分叉）') : tr('↻ Resume in place', '↻ 原地恢复')}
                </span>
                <button className="btn btn-sm btn-ghost" onClick={cancelRecovery}>{tr('Exit resume', '退出恢复')}</button>
              </div>
              <p className="resume-banner-body">
                {recoveryMode === 'modify'
                  ? <>{forkByParamChange
                        ? tr(
                          <>You changed <strong>{FSTEP_LABELS[earliestChangedStep]}</strong> settings. That step runs <strong>before</strong> the failure point,
                           so its output must be regenerated — an in-place resume would reuse the old cache and silently ignore your change.
                           This therefore launches a <strong>brand-new task</strong> (fork) and re-runs from <strong>{FSTEP_LABELS[rerunStart]}</strong>.</>,
                          <>你修改了 <strong>{FSTEP_LABELS[earliestChangedStep]}</strong> 的设置。该步骤在失败点<strong>之前</strong>运行，
                           因此它的输出必须重新生成——原地恢复会复用旧缓存并悄悄忽略你的修改。
                           所以这里会启动一个<strong>全新任务</strong>（分叉），并从 <strong>{FSTEP_LABELS[rerunStart]}</strong> 重新运行。</>)
                        : tr(
                          <>You moved the restart point to an earlier, already-completed step (<strong>{FSTEP_LABELS[rerunStart]}</strong>).
                           Changing a completed step means it must be re-run, so this launches a <strong>brand-new task</strong> (fork).</>,
                          <>你把重启点移到了一个更早、已完成的步骤（<strong>{FSTEP_LABELS[rerunStart]}</strong>）。
                           修改已完成的步骤意味着必须重新运行，因此这里会启动一个<strong>全新任务</strong>（分叉）。</>)}
                     {' '}{tr(
                       <>Only the products of steps <strong>before {FSTEP_LABELS[rerunStart]}</strong> are copied to the new task — so make sure you have enough <strong>disk space</strong> for them.
                       The original failed task is kept untouched, and even if this fork succeeds it will publish as a NEW task, not a recovery of the old one.</>,
                       <>只有 <strong>{FSTEP_LABELS[rerunStart]} 之前</strong>步骤的产物会被复制到新任务——所以请确保有足够的<strong>磁盘空间</strong>。
                       原来的失败任务保持不变，即使这个分叉成功，它也会作为一个新任务发布，而不是对旧任务的恢复。</>)}</>
                  : tr(
                    <>Continuing failed task <code>{recovery.sourceTaskId}</code> from the <strong>{FSTEP_LABELS[recovery.failedStep]}</strong> step,
                     reusing everything before it. Same task, same workspace.
                     {recovery.failedAt && recovery.failedAt.reason && <><br/><span className="resume-reason">Why it failed: {recovery.failedAt.reason}</span></>}</>,
                    <>从 <strong>{FSTEP_LABELS[recovery.failedStep]}</strong> 步骤继续失败任务 <code>{recovery.sourceTaskId}</code>，
                     复用它之前的所有产物。同一任务，同一工作区。
                     {recovery.failedAt && recovery.failedAt.reason && <><br/><span className="resume-reason">失败原因：{recovery.failedAt.reason}</span></>}</>)}
              </p>
              <div className="resume-controls">
                <label className="field-label" style={{ margin: 0 }}>{tr('Restart from', '从此处重启')}</label>
                <Select className="control control-inline" value={rerunStart}
                        onChange={e => setRecovery(r => ({ ...r, resumeStep: e.target.value }))}>
                  {resumeStepOptions.map(s => (
                    <option key={s} value={s}>{FSTEP_LABELS[s]}{s === recovery.failedStep ? tr(' (failed step)', '（失败的步骤）') : tr(' (redo completed step)', '（重做已完成的步骤）')}</option>
                  ))}
                </Select>
                {recoveryMode === 'continue' && failedIsTrain && (
                  <label className="toggle-row" style={{ margin: 0 }}>
                    <input type="checkbox" checked={restartFailedStep} onChange={e => setRestartFailedStep(e.target.checked)} />
                    {tr('Restart this training from scratch (ignore saved checkpoint)', '从零重新开始本次训练（忽略已保存的 checkpoint）')}
                  </label>
                )}
              </div>
            </div>
          )}

          {/* Pipeline map — click a step to configure it (or inspect its status during a run) */}
          <div className="field" style={{ marginTop: 10 }}>
            <label className="field-label">{tr('Pipeline — click any step to configure', '流程 — 点击任意步骤进行配置')}</label>
            <PipelineMap
              statusSteps={status?.steps || (recovery ? recovery.steps : null)}
              enabledMap={recovery
                ? { denoise: rerunIdx <= 0 && form.denoise, slice: FSTEP_ORDER.indexOf('slice') >= rerunIdx && form.slice, asr: FSTEP_ORDER.indexOf('asr') >= rerunIdx && form.asr, train_s1: FSTEP_ORDER.indexOf('train_s1') >= rerunIdx && form.trainS1 !== false, train_s2: FSTEP_ORDER.indexOf('train_s2') >= rerunIdx && form.trainS2 !== false }
                : { denoise: form.denoise, slice: form.slice, asr: form.asr, train_s1: form.trainS1 !== false, train_s2: form.trainS2 !== false }}
              selectedNode={selectedNode}
              onSelect={setSelectedNode}
            />
          </div>
          {renderNodeDetail()}

          {/* Pre-flight summary — reflects live form.* values (advanced params edits flow
              through here too). Shows what is NOT already visible in the dropdowns / map. */}
          <div className="preflight">
            <div className="pf-row">
              <span className="pf-key">{tr('Output', '输出')}</span>
              <span className="pf-val pf-path">{proposedId ? `assets/${proposedId}/` : 'assets/<auto-id>/'}</span>
              <span className="field-note">{tr('ⓘ ID allocated by the server at creation', 'ⓘ ID 由服务器在创建时分配')}</span>
            </div>
            <div className="pf-row">
              <span className="pf-key">{tr('Fine-tune', '微调')}</span>
              <span className="pf-chips">
                {form.trainS1 !== false && (
                  <span className="pf-chip">GPT (S1) · {form.gptEpochs ?? 8}ep · save every {form.s1SaveEvery ?? 4}ep</span>
                )}
                {form.trainS2 !== false && _selVersions.map(v => (
                  <span key={v} className="pf-chip">SoVITS {v} · {form.sovitsEpochs ?? 25}ep · save every {form.s2SaveEvery ?? 5}ep</span>
                ))}
                {form.trainS1 === false && form.trainS2 === false && (
                  <span className="pf-chip pf-chip-off">{tr('none (safe pass)', '无（安全跳过）')}</span>
                )}
                {(form.trainS1 !== false || form.trainS2 !== false) && (
                  <span className="pf-chip pf-chip-meta">batch {form.batchSize || 'auto'}</span>
                )}
              </span>
            </div>
            <div className="pf-row">
              <span className="pf-key">{tr('Preprocess', '预处理')}</span>
              <span className="pf-chips">
                {form.denoise && <span className="pf-chip">Vocal Extract</span>}
                {form.slice && <span className="pf-chip">Slice</span>}
                {form.asr && <span className="pf-chip">ASR</span>}
                {!form.denoise && !form.slice && !form.asr && <span className="pf-chip pf-chip-off">{tr('none', '无')}</span>}
              </span>
            </div>
          </div>

          {/* Base-model gate feedback — reports EVERY selected SoVITS version (only when S2 will run).
              S1(GPT)/S2(SoVITS) enable toggles now live inside their pipeline nodes (like slice/ASR). */}
          {form.trainS2 !== false && baseModelStatus && Array.isArray(baseModelStatus.versions) &&
            baseModelStatus.versions.filter(v => !v.ok).map(v => (
              v.blocking
                ? <div key={v.version} className="msg msg-error" style={{ marginTop: 10 }}>
                    {tr(
                      <>⚠ Base models for <strong>{v.version}</strong> are missing ({(v.criticalMissing || []).join(' + ')}) — this
                      version is blocked (it would only produce electrical noise). Run:{' '}</>,
                      <>⚠ <strong>{v.version}</strong> 的底模缺失（{(v.criticalMissing || []).join(' + ')}）——该版本已被阻止
                      （否则只会产生电流噪声）。请运行：{' '}</>)}
                    <code>python download_models.py --set {String(v.version).toLowerCase()}</code>
                  </div>
                : <div key={v.version} className="msg msg-warn" style={{ marginTop: 10 }}>
                    ⚠ <strong>{v.version}</strong>: {(v.missing || []).includes('sv')
                      ? tr('speaker-vector (SV) model missing — training will run but without SV enhancement', 'speaker-vector（SV）模型缺失——训练仍会进行，但没有 SV 增强')
                      : tr('a preferred base model is missing; training will fall back to a lower-quality base', '缺少一个更优的底模；训练将回退到质量较低的底模')}. {tr('Run:', '请运行：')}{' '}
                    <code>python download_models.py --set {String(v.version).toLowerCase()}</code>
                  </div>
            ))}
          {form.trainS1 === false && form.trainS2 === false && (
            <p className="field-hint" style={{ marginTop: 10 }}>{tr('Neither S1 nor S2 is enabled (both pipeline steps off) — this run will only preprocess (slice / ASR) and publish reference audio.',
              'S1 和 S2 都未启用（两个流程步骤均已关闭）——本次运行只会做预处理（切片 / ASR）并发布参考音频。')}</p>
          )}

          {/* One-time low-VRAM (≤4GB) advisory. We never auto-shrink batch_size —
              the user decides; this only points them at the control. */}
          {showLowVram && (
            <div className="msg" style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 10, background: 'rgba(255,193,7,0.12)', border: '1px solid rgba(255,193,7,0.35)' }}>
              <span style={{ fontSize: 16, lineHeight: 1.2 }}>⚠️</span>
              <div style={{ flex: 1, fontSize: 12.5 }}>
                检测到显存较小的 GPU（{cuda?.device_name || 'GPU'} · {cuda?.vram_gb}GB）。微调可能因显存不足（OOM）而失败，
                建议<strong>手动把 Batch Size 调小</strong>（如 1–2）后再开始。该提醒只显示一次。
              </div>
              <button className="btn btn-sm" onClick={dismissLowVram}>知道了</button>
            </div>
          )}

          {error && <div className="msg msg-error" style={{ marginTop: 8 }}>{error}</div>}

          {!taskId && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={handleStart}
                disabled={form.trainS2 !== false && !!(baseModelStatus && baseModelStatus.anyBlocking)}
                title={form.trainS2 !== false && !!(baseModelStatus && baseModelStatus.anyBlocking)
                  ? tr('Some selected SoVITS versions are missing base models — run download_models.py for them first', '所选的部分 SoVITS 版本缺少底模——请先为它们运行 download_models.py')
                  : ''}>{recovery ? (recoveryMode === 'modify' ? 'Fork & Resume' : 'Resume Tuning') : 'Start Tuning'}</button>
              <button className="btn btn-ghost" onClick={() => setCacheConfirm(true)} disabled={clearing}
                title={tr('Delete finished task workspaces from the .staging cache (running tasks are never touched)', '从 .staging 缓存中删除已完成的任务工作区（运行中的任务永远不会被动到）')}>
                {clearing ? tr('Cleaning…', '清理中…') : 'Clean Cache'}
              </button>
              {clearMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{clearMsg}</span>}
            </div>
          )}

          <ConfirmDialog
            open={cacheConfirm}
            title={tr('Clean training cache', '清理训练缓存')}
            message={tr('Delete all finished task workspaces from the training cache (.staging)? Running tasks are never deleted. Your published models and assets are not affected.',
              '要从训练缓存（.staging）中删除所有已完成的任务工作区吗？运行中的任务永远不会被删除。你已发布的模型和资源不受影响。')}
            confirmLabel={tr('Clean cache', '清理缓存')}
            danger
            busy={clearing}
            icon={<IconTrash size={18} color="var(--danger)" />}
            onConfirm={handleClearStaging}
            onCancel={() => setCacheConfirm(false)}
          />

          {taskId && !status && (
            <div className="msg" style={{ marginTop: 10 }}>{tr('Restoring training state…', '正在恢复训练状态…')}</div>
          )}
          {taskId && status && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {status.status === 'completed' ? tr('Completed', '已完成')
                   : status.status === 'failed' ? tr('Failed', '失败')
                   : status.status === 'cancelled' ? tr('Cancelled', '已取消')
                   : status.status === 'interrupted' ? tr('Interrupted', '已中断')
                   : status.status === 'awaiting_review' ? tr('Awaiting proofreading', '等待校对')
                   : tr('Tuning…', '微调中…')}
                </span>
                {(isRunning || isAwaitingReview) && (
                  <button className="btn btn-sm btn-danger" onClick={handleCancel}>Cancel</button>
                )}
              </div>
              {isAwaitingReview && (
                <AsrReviewPanel taskId={taskId} lang={form.language} onResumed={() => setStatus(s => s ? { ...s, status: 'running' } : s)} />
              )}
              {isInterrupted && (
                <div className="msg msg-error" style={{ marginBottom: 8 }}>
                  {tr('Tuning was interrupted. Go Back, then use “Recover a failed run” to resume it from where it stopped.',
                      '微调被中断。请点击“返回”，然后用“恢复失败的任务”从中断处继续。')}
                </div>
              )}
              {isFinished && (
                <button className="btn btn-sm btn-primary" style={{ marginTop: 4 }} onClick={handleReset}>{tr('Back', '返回')}</button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Logs only appear once a task is running/finished — keeps the idle page clean */}
      {taskId && <LiveLogs logs={logs} />}

      {/* Overwrite confirmation: target voice id already exists on disk. */}
      {overwriteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setOverwriteConfirm(null)}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 360, maxWidth: 460,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Overwrite Existing Voice?</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
              The id <strong>{overwriteConfirm.existingId}</strong> already belongs to{' '}
              <strong>&ldquo;{overwriteConfirm.existingDisplay}&rdquo;</strong>.
            </p>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
              Training will publish into <code>assets/{overwriteConfirm.existingId}/</code> and
              permanently replace the models and references of that voice. This cannot be undone.
              If you meant to keep both, cancel and give this one a different name.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setOverwriteConfirm(null)}>Cancel</button>
              <button className="btn btn-sm btn-danger" onClick={confirmOverwriteTrain}>Overwrite &amp; Train</button>
            </div>
          </div>
        </div>
      )}

      {/* No-GPU pre-flight: CPU fine-tuning is allowed but must be acknowledged. */}
      {noGpuConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setNoGpuConfirm(false)}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 380, maxWidth: 480,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>🐢</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>未检测到 NVIDIA GPU</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
              当前设备没有可用的 CUDA GPU。微调将在 <strong>CPU</strong> 上运行，
              可能<strong>耗时数小时甚至数十倍</strong>，且<strong>人声分离（UVR5）不可用</strong>。
            </p>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              推理不受影响，可正常在 CPU 上使用。若只是想生成语音，无需在此训练。
            </p>
            <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16 }}>
              <input type="checkbox" checked={noGpuAck} onChange={e => setNoGpuAck(e.target.checked)} />
              我知道 CPU 微调会非常慢，仍要继续
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setNoGpuConfirm(false)}>取消</button>
              <button className="btn btn-sm btn-primary" disabled={!noGpuAck} onClick={proceedWithoutGpu}>仍要开始</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================
//  RESTORE ASSET MODAL
// ============================
// Secondary menu for dependency-driven asset repair. Instead of silently
// executing the backend's shortest path, this lets the user choose HOW to
// restore (re-slice vs. use raw as-is, transcribe or not, retrain or not) and
// tune the slice / training parameters that the chosen path will use. The
// backend planner stays authoritative: it re-plans on every option change
// (execute:false) so the live "Plan" preview always reflects what will run.
function RestoreModal({ id, displayName, onClose, onStarted }) {
  const { t: tr } = useT()
  const [state, setState] = useState(null)        // { R, S, L, Seg, M }
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState(null)
  // User intent (drives the planner)
  const [sliceChoice, setSliceChoice] = useState('noslice') // 'noslice' (raw is the source) | 'real' (re-slice)
  const [doAsr, setDoAsr] = useState(true)
  // S1 (GPT) and S2 (SoVITS) are independent — the user can retrain either, both, or
  // neither. Seeded from which weights are actually missing (state.Mg / state.Ms).
  const [trainS1, setTrainS1] = useState(false)
  const [trainS2, setTrainS2] = useState(false)
  const seeded = useRef(false)
  // Parameter overrides — share the exact same field set & panels as the Training
  // page, so the rebuild flow exposes every parameter the formal flow does.
  const [showSliceParams, setShowSliceParams] = useState(false)
  const [showAsrParams, setShowAsrParams] = useState(false)
  const [showTrainParams, setShowTrainParams] = useState(false)
  const [form, setForm] = useState({ ...REBUILD_PARAM_DEFAULTS })
  const setField = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const buildOpts = () => {
    const o = {
      reslice: sliceChoice === 'real',
      skipAsr: !doAsr,
      mode: (trainS1 || trainS2) ? 'full' : 'safe',
    }
    // Only send explicit per-model flags once we know a model is missing, so the
    // safe-mode deferral path (no modal) keeps its "confirm before training" behavior.
    if (state && !state.M) { o.trainS1 = trainS1; o.trainS2 = trainS2 }
    return o
  }

  // Assemble customParams shaped for the training pipeline. Only include the
  // sections whose stage actually runs, so we never override unrelated defaults.
  const buildParams = (stages) => {
    const params = {}
    const steps = {}
    if (stages.includes('slice') && sliceChoice === 'real') {
      steps.slice = { params: buildSliceParams(form) }
    }
    if (stages.includes('asr')) {
      steps.asr = { params: buildAsrParams(form) }
    }
    if (Object.keys(steps).length) params.steps = steps
    if (stages.includes('train_s1') || stages.includes('train_s2')) {
      params.training = buildTrainingParams(form)
    }
    return params
  }

  // Re-plan (dry run) whenever the intent options change so the preview stays truthful.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(null)
    api(`/api/assets/${id}/rebuild`, { method: 'POST', body: { execute: false, ...buildOpts() } })
      .then(r => {
        if (cancelled) return
        const data = r.data || {}
        setState(data.state || null)
        setPlan(data)
        if (!r.ok) setErr(data.error || 'Failed to plan rebuild')
        // Seed choices once from the backend's default shortest path.
        if (!seeded.current && data.state) {
          seeded.current = true
          if (!data.state.S) setSliceChoice(data.slice_mode === 'slice' ? 'real' : 'noslice')
          // Missing weights → arm retrain of ONLY the missing model(s) so the plan
          // shows the shortest path (reuse existing slices/ASR, train what's absent).
          if (data.state.Mg === false) setTrainS1(true)
          if (data.state.Ms === false) setTrainS2(true)
        }
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sliceChoice, doAsr, trainS1, trainS2])

  const submit = async () => {
    setSubmitting(true); setErr(null)
    try {
      const params = buildParams(plan?.stages || [])
      const r = await api(`/api/assets/${id}/rebuild`, {
        method: 'POST',
        body: { execute: true, ...buildOpts(), params },
      })
      if (r.ok) { onStarted(id, r.data); onClose() }
      else setErr(r.data?.error || 'Rebuild failed')
    } catch (e) { setErr(e.message) }
    finally { setSubmitting(false) }
  }

  const stages = plan?.stages || []
  const asrInPlan = stages.includes('asr')
  const asrForced = asrInPlan && !doAsr // backend forced it despite the toggle (e.g. retrain)
  const trainInPlan = stages.includes('train_s1') || stages.includes('train_s2')
  const realSliceInPlan = stages.includes('slice') && sliceChoice === 'real'
  const hasWork = stages.length > 0 || plan?.needs_segments
  const isNoop = !!plan?.noop

  const planLabel = loading ? tr('Computing…', '计算中…')
    : isNoop ? tr('Already complete — nothing to rebuild.', '已完整——无需重建。')
    : stages.length ? stages.join('  →  ')
    : plan?.needs_segments ? 'generateSegments'
    : tr('No steps for the selected options.', '当前所选选项没有需要执行的步骤。')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card restore-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">
          <div>
            <div className="modal-title">{tr('Restore Asset', '恢复资源')}</div>
            <div className="modal-subtitle">{displayName || id}</div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={submitting}>✕</button>
        </div>

        <p className="modal-desc">
          {tr('Choose how to rebuild the missing artifacts. The shortest safe path is preselected; existing models are always kept unless you opt into retraining.',
              '选择如何重建缺失的产物。已默认选中最短的安全路径；除非你主动选择重新训练，否则始终保留现有模型。')}
        </p>

        {/* Current asset state */}
        {state && (
          <div className="asset-state-row">
            {[['R', tr('Raw', '原始')], ['S', tr('Slices', '切片')], ['L', tr('Transcript', '转写文本')], ['Seg', tr('Segments', '分段')], ['Mg', 'GPT'], ['Ms', 'SoVITS']].map(([k, label]) => (
              <span key={k} className={`state-pip ${state[k] ? 'on' : 'off'}`}>
                <span className="state-pip-sym">{state[k] ? '✓' : '–'}</span>{label}
              </span>
            ))}
          </div>
        )}

        {/* Slicing choice — only meaningful when slices are missing */}
        {state && !state.S && state.R && (
          <div className="restore-group">
            <div className="restore-group-title">{tr('Slicing', '切片')}</div>
            <label className="radio-row">
              <input type="radio" name="slice" checked={sliceChoice === 'noslice'} onChange={() => setSliceChoice('noslice')} />
              <span>{tr('Use raw as reference audio', '使用原始音频作为参考音频')} <span className="hint">{tr('— fastest, no slicing; ASR writes raw_opt.list', '——最快，不切片；ASR 写入 raw_opt.list')}</span></span>
            </label>
            <label className="radio-row">
              <input type="radio" name="slice" checked={sliceChoice === 'real'} onChange={() => setSliceChoice('real')} />
              <span>{tr('Re-slice raw into clips', '将原始音频重新切成片段')} <span className="hint">{tr('— cleaner cuts, slower; forces re-transcribe', '——切分更干净，但更慢；会强制重新转写')}</span></span>
            </label>

            {/* Slice parameters — only when real slicing is selected */}
            {realSliceInPlan && (
              <div className="collapsible" style={{ marginTop: 10 }}>
                <div className="collapsible-hdr" onClick={() => setShowSliceParams(v => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{tr('Slice Parameters', '切片参数')}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showSliceParams ? '▲' : '▼'}</span>
                </div>
                {showSliceParams && (
                  <div className="collapsible-body" style={{ padding: 12 }}>
                    <SliceParamFields form={form} setField={setField} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ASR choice */}
        {state && (!state.L || !state.S) && (
          <div className="restore-group">
            <div className="restore-group-title">{tr('Transcribe (ASR)', '转写 (ASR)')}</div>
            <label className="toggle-row">
              <input type="checkbox" checked={doAsr || asrForced} disabled={asrForced} onChange={e => setDoAsr(e.target.checked)} />
              <span>
                {tr('Run ASR to (re)generate the transcript & segments', '运行 ASR 以（重新）生成转写文本与分段')}
                {asrForced && <span className="hint"> {tr('— required for the selected options', '——所选选项需要此步骤')}</span>}
                {!doAsr && !asrForced && <span className="hint-warn"> {tr('— skipped: reference-text-free', '——已跳过：不使用参考文本')}</span>}
              </span>
            </label>

            {/* ASR parameters — only when ASR actually runs */}
            {asrInPlan && (
              <div className="collapsible" style={{ marginTop: 10 }}>
                <div className="collapsible-hdr" onClick={() => setShowAsrParams(v => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{tr('ASR Parameters', 'ASR 参数')}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showAsrParams ? '▲' : '▼'}</span>
                </div>
                {showAsrParams && (
                  <div className="collapsible-body" style={{ padding: 12 }}>
                    <AsrParamFields form={form} setField={setField} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Retrain choice + training parameters — only when a weight is missing.
            S1 (GPT) and S2 (SoVITS) are independent steps, so each can be retrained
            on its own; the missing one is preselected. */}
        {state && !state.M && (
          <div className="restore-group">
            <div className="restore-group-title">{tr('Models', '模型')}</div>
            <label className="toggle-row">
              <input type="checkbox" checked={trainS1} onChange={e => setTrainS1(e.target.checked)} />
              <span>
                Train S1 (GPT)
                {state.Mg === false
                  ? <span className="hint-warn"> {tr('— missing', '——缺失')}</span>
                  : <span className="hint"> {tr('— already present, retrain to overwrite', '——已存在，重新训练将覆盖')}</span>}
              </span>
            </label>
            <label className="toggle-row">
              <input type="checkbox" checked={trainS2} onChange={e => setTrainS2(e.target.checked)} />
              <span>
                Train S2 (SoVITS)
                {state.Ms === false
                  ? <span className="hint-warn"> {tr('— missing', '——缺失')}</span>
                  : <span className="hint"> {tr('— already present, retrain to overwrite', '——已存在，重新训练将覆盖')}</span>}
              </span>
            </label>

            {trainInPlan && (
              <div className="collapsible" style={{ marginTop: 10 }}>
                <div className="collapsible-hdr" onClick={() => setShowTrainParams(v => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{tr('Training Parameters', '训练参数')}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showTrainParams ? '▲' : '▼'}</span>
                </div>
                {showTrainParams && (
                  <div className="collapsible-body" style={{ padding: 12 }}>
                    <TrainParamFields form={form} setField={setField}
                      part={trainS1 && trainS2 ? 'both' : trainS1 ? 's1' : 's2'} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Plan preview */}
        <div className="plan-preview">
          <div className="plan-preview-label">PLAN</div>
          <div className={`plan-preview-body ${loading ? 'muted' : ''}`}>{planLabel}</div>
          {(plan?.warnings || []).map((w, i) => (
            <div key={i} className="plan-warn">⚠ {w}</div>
          ))}
        </div>

        {err && <div className="msg msg-error" style={{ marginBottom: 10 }}>{err}</div>}

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-sm btn-primary" onClick={submit} disabled={submitting || loading || !hasWork || isNoop}>
            {submitting ? tr('Starting…', '启动中…') : (trainInPlan ? 'Rebuild & Train' : 'Restore')}
          </button>
        </div>
      </div>
    </div>
  )
}

export {
  RebuildProgress,
  TrainingTab,
  RestoreModal,
  // Patch #12 — reused by the Refinement modal so it exposes the exact same training
  // parameter fields / serialiser / defaults as the Training and Restore flows.
  TrainParamFields,
  buildTrainingParams,
  REBUILD_PARAM_DEFAULTS,
}
