// AUTO-EXTRACTED from TrainingTab.jsx (pure mechanical, zero logic change).
import { useT } from '../../lib/i18n'
import { Select } from '../common/Select'
import { NumField, TextField, SelectField } from '../common/Fields'
import {
  ASR_MODEL_SIZES,
  ASR_PRECISIONS,
  S1_PRECISIONS,
  S2_PRECISIONS,
} from './trainConstants'

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
          <option value="auto">{t('Auto (Faster Whisper)', '自动 (Faster Whisper)')}</option>
          <option value="faster-whisper">Faster Whisper</option>
          <option value="funasr">{t('FunASR (zh/yue — better Chinese)', 'FunASR (中文/粤语，中文更准)')}</option>
        </Select>
        {form.asrEngine === 'funasr' && (
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
            {t('FunASR (Paraformer + VAD + punctuation) matches the official pipeline for Chinese and adds punctuation. It only applies to zh/yue — other languages use Faster Whisper. If FunASR fails, it automatically falls back to Faster Whisper.',
              'FunASR（Paraformer + VAD + 标点）与官方一致，中文更准并自带标点。仅对中文/粤语生效，其他语言仍用 Faster Whisper。FunASR 若失败会自动回退到 Faster Whisper。')}
          </p>
        )}
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
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>{t('SoVITS Version(s) — one model trained per checked version', 'SoVITS 版本：每勾选一个版本训练一个模型')}</label>
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
        <summary className="expert-summary">{t('Expert Parameters — GPT-SoVITS internals', '专家参数：GPT-SoVITS 内部设置')}</summary>
        <div className="msg msg-danger expert-warning">
          <strong>{t('⚠ Expert Parameters.', '⚠ 专家参数。')}</strong> {t('Changing these can make training unstable, waste hours of GPU time, or produce a worse model. Most users should never touch them. Defaults are tuned for an 8GB GPU.',
            '修改这些参数可能导致训练不稳定、浪费数小时 GPU 时间，或训练出更差的模型。大多数用户不应改动它们。默认值针对 8GB 显存 GPU 调优。')}
        </div>
        <label className="toggle-row expert-unlock">
          <input type="checkbox" checked={!!form.expertUnlocked} onChange={e => setField('expertUnlocked', e.target.checked)} />
          {t('I understand the risks — let me edit expert parameters', '我了解风险，允许我编辑专家参数')}
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

export {
  SliceParamFields,
  AsrParamFields,
  S1BasicCol,
  S2BasicCol,
  S1ExpertCol,
  S2ExpertCol,
  TrainParamFields,
}
