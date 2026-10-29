// NodeDetailPanel.jsx — 流程图节点详情面板
//
// 从 TrainingTab.jsx 搬出的纯渲染块：流程图里点开某个步骤后展开的配置区。
// 每个步骤（人声提取 / 切片 / ASR / S1 / S2 / 预处理 / 打包 / 发布）
// 各有各的开关与参数，此处按 selectedNode 分派。
import { SliceParamFields, AsrParamFields, TrainParamFields } from './ParamCols'
import { VocalExtractionPanel } from './VocalExtractionPanel'
import { Select } from '../common/Select'
import { useT } from '../../lib/i18n'

export function NodeDetailPanel({
  selectedNode,
  status,
  editable,
  form,
  setForm,
  setField,
  applySlicePreset,
  onClose,
  askConfirm,
  closeConfirm,
  onMissingChange,
  download,
  onDownloadChange,
  onStartDownload,
}) {
  const { t: tr } = useT()

  if (!selectedNode) return null
  const stepSt = status?.steps?.[selectedNode]?.status
  const stBadge = stepSt && (
    <span className={`badge ${stepSt === 'completed' ? 'badge-ok' : stepSt === 'running' ? 'badge-accent' : stepSt === 'failed' ? 'badge-danger' : 'badge-neutral'}`}>{stepSt}</span>
  )

  const NODE_LABELS = {
    denoise: tr('Vocal Extraction', '人声提取'), slice: tr('Slicing', '切片'), asr: tr('ASR Transcription', 'ASR 转写'),
    preprocess: tr('Preprocess', '预处理'), train_s1: tr('S1 Training (GPT)', 'S1 训练 (GPT)'), train_s2: tr('S2 Training (SoVITS)', 'S2 训练 (SoVITS)'),
    finalize: tr('Finalize', '打包完成'), promote: tr('Publish', '发布'),
  }

  let body = null
  if (selectedNode === 'denoise') {
    body = <VocalExtractionPanel
      form={form}
      setForm={setForm}
      setField={setField}
      askConfirm={askConfirm}
      closeConfirm={closeConfirm}
      onMissingChange={onMissingChange}
      download={download}
      onDownloadChange={onDownloadChange}
      onStartDownload={onStartDownload}
    />
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
        <p style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', marginTop: -2, marginBottom: 8 }}>
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
          : <p style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>{tr('S1 (GPT) fine-tuning is turned off — this step will be skipped.', 'S1 (GPT) 微调已关闭：此步骤将被跳过。')}</p>}
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
          : <p style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>{tr('S2 (SoVITS) fine-tuning is turned off — this step will be skipped.', 'S2 (SoVITS) 微调已关闭：此步骤将被跳过。')}</p>}
      </>
    );
  } else if (selectedNode === 'preprocess') {
    body = (
      <>
        <p style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)' }}>{tr('Extracts text tokens and audio features required for training.', '提取训练所需的文本 token 与音频特征。')}</p>
        <label className="toggle-row" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={form.preprocessReview !== false && form.preprocessReview}
                 onChange={e => setField('preprocessReview', e.target.checked)} />
          {tr('Pause after ASR for manual proofreading', 'ASR 之后暂停以进行人工校对')}
        </label>
        <p className="field-hint" style={{ marginTop: 4 }}>
          {tr('When enabled the pipeline stops right after transcription so the recognised text and pronunciation can be corrected before preprocessing/training continue.',
              '启用后，流程会在转写完成后立即停止，以便在继续预处理 / 训练之前修正识别出的文本和读音。')}
        </p>
      </>
    );
  } else if (selectedNode === 'finalize') {
    body = <p style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)' }}>{tr('Packages the trained checkpoints and reference audio into a voice asset. No configuration needed.', '将训练好的 checkpoint 与参考音频打包成一个音色资源。无需配置。')}</p>;
  } else if (selectedNode === 'promote') {
    body = (
      <>
        <p style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', marginBottom: 12 }}>{tr(
          <>Publishes the finished voice into <code>assets/</code> so it becomes selectable on the Generate page.</>,
          <>将完成的音色发布到 <code>assets/</code>，使其可在 Generate 页面中选择。</>)}</p>
        <label className="toggle-row">
          <input type="checkbox" checked={!!form.keepStaging}
                 onChange={e => setField('keepStaging', e.target.checked)} />
          {tr('Keep task workspace after publish', '发布后保留任务工作区')}
        </label>
        <p className="msg msg-warn" style={{ marginTop: 4, color: 'var(--warning)' }}>
          {tr(
            <>By default this task&rsquo;s staging workspace (<code>.staging/&lt;taskId&gt;</code> — the
            intermediate preprocessing features and checkpoints) is <strong>permanently deleted</strong> once
            the voice is published, since the finished asset no longer needs it. Enable this only to
            <strong>keep</strong> <strong>keep</strong> those intermediates for inspection or debugging. It will
            count against the available disk space.</>,
            <>默认情况下，本任务的暂存工作区（<code>.staging/&lt;taskId&gt;</code>，内含中间预处理特征与 checkpoint）
            会在音色发布后被<strong>永久删除</strong>，因为完成的资源已不再需要它。只有想<strong>保留</strong>
            这些中间产物用于检查或调试时才开启。它会占用磁盘空间。</>)}
        </p>
        <p className="field-hint">
          {tr(
            <>The retained workspace is <strong>never</strong> reused by later tasks — it lives only so it
            can be inspected. Delete it later from the Train page&rsquo;s cache manager when no longer needed.</>,
            <>保留的工作区<strong>绝不会</strong>被后续任务复用：仅供检查之用。不再需要时，可在 Train 页面的缓存管理器中删除。</>)}
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
          <button className="btn btn-sm" onClick={onClose}>{tr('Close', '关闭')}</button>
        </div>
      </div>
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
        {body}
      </fieldset>
    </div>
  )
}
