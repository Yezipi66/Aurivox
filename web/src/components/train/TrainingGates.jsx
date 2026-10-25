// TrainingGates.jsx — 训练前置门控与遮罩弹窗
//
// 从 TrainingTab.jsx 搬出：开始训练前的几道确认。
// G1：没勾 S1/S2，只跑切片 / ASR，跳过 preprocess。
// G2：开了训练但没勾 ASR，没有转写预处理会失败。提醒并留宽限期让用户自备 .list。
// 另外两个是整页遮罩弹窗：id 已存在（覆盖确认）与没有 NVIDIA GPU（CPU 训练确认）。
import { ConfirmDialog } from '../common/Dialogs'
import { useT } from '../../lib/i18n'

export function TrainingGates({
  gate,
  gateGraceSec,
  setGateGraceSec,
  onConfirmGate,
  onCancelGate,
  overwriteConfirm,
  onCancelOverwrite,
  onConfirmOverwrite,
  noGpuConfirm,
  noGpuAck,
  setNoGpuAck,
  onCancelNoGpu,
  onProceedWithoutGpu,
}) {
  const { t: tr } = useT()

  return (
    <>
      {/* No-GPU pre-flight: CPU fine-tuning is allowed but must be acknowledged. */}
      {/* 门控 G1：未开启 S1/S2，只跑切片/ASR，跳过 preprocess。 */}
      <ConfirmDialog
        open={gate?.type === 'g1'}
        icon={<span style={{ fontSize: 'var(--fs-18)' }}>ⓘ</span>}
        title={tr('No fine-tuning steps selected', '未选择微调步骤')}
        confirmLabel={tr('Continue (skip preprocess)', '继续（跳过预处理）')}
        onConfirm={onConfirmGate}
        onCancel={onCancelGate}
        message={
          <div style={{ fontSize: 'var(--fs-13)', lineHeight: 1.6 }}>
            {tr(
              'Neither S1 (GPT) nor S2 (SoVITS) training is enabled. This run will only slice / transcribe (with optional proofreading); the three preprocess steps will be skipped since there is nothing to train.',
              '未启用 S1 (GPT) 或 S2 (SoVITS) 训练。本次将只执行切片 / 转写（含可选人工校对），由于没有要训练的模型，将跳过 preprocess 三步。')}
          </div>
        }
      />

      {/* 门控 G2/G3：训练开启但未勾 ASR，强提醒不阻断 + 宽限期投放自备 .list。 */}
      <ConfirmDialog
        open={gate?.type === 'g2'}
        danger
        icon={<span style={{ fontSize: 'var(--fs-18)' }}>⚠️</span>}
        title={tr('ASR is not enabled', '未启用 ASR')}
        confirmLabel={tr('Continue anyway', '仍然继续')}
        onConfirm={onConfirmGate}
        onCancel={onCancelGate}
        message={
          <div style={{ fontSize: 'var(--fs-13)', lineHeight: 1.6 }}>
            <p style={{ marginTop: 0 }}>
              {tr(
                'Training is enabled but ASR is off, so no transcript will be produced. Without a transcript, preprocessing will fail — unless you supply your own.',
                '已启用训练但未勾选 ASR，本次不会生成转写。若没有转写，预处理会失败，除非自备转写。')}
            </p>
            <p>
              {tr(
                'Before preprocessing, the system will wait for the seconds below so you can copy your file into the staging folder (its absolute path is printed in the logs).',
                '在预处理前，系统会等待下面设定的秒数，留出时间把文件复制进暂存目录（其绝对路径会打印在日志中）。')}
            </p>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>
              {tr(
                'Rule: a .list overrides segments.json; or drop segments.json directly. Provide only one.',
                '规则：放 .list 会覆写 segments.json；或直接放 segments.json。二者只放其一。')}
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span>{tr('Grace period (seconds)', '宽限期（秒）')}</span>
              <input type="number" className="control" min={0} max={600} value={gateGraceSec}
                     onChange={e => setGateGraceSec(e.target.value)}
                     style={{ width: 90 }} />
            </label>
          </div>
        }
      />

      {/* Overwrite confirmation: target voice id already exists on disk. */}
      {overwriteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={onCancelOverwrite}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 360, maxWidth: 460,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <span style={{ fontWeight: 600, fontSize: 'var(--fs-14)' }}>Overwrite Existing Voice?</span>
            </div>
            <p style={{ fontSize: 'var(--fs-13)', color: 'var(--text)', marginBottom: 8 }}>
              The id <strong>{overwriteConfirm.existingId}</strong> already belongs to{' '}
              <strong>&ldquo;{overwriteConfirm.existingDisplay}&rdquo;</strong>.
            </p>
            <p style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', marginBottom: 16 }}>
              Training will publish into <code>assets/{overwriteConfirm.existingId}/</code> and
              permanently replace the models and references of that voice. This cannot be undone.
              If you meant to keep both, cancel and give this one a different name.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={onCancelOverwrite}>Cancel</button>
              <button className="btn btn-sm btn-danger" onClick={onConfirmOverwrite}>Overwrite &amp; Train</button>
            </div>
          </div>
        </div>
      )}

      {noGpuConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={onCancelNoGpu}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 380, maxWidth: 480,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>🐢</span>
              <span style={{ fontWeight: 600, fontSize: 'var(--fs-14)' }}>未检测到 NVIDIA GPU</span>
            </div>
            <p style={{ fontSize: 'var(--fs-13)', color: 'var(--text)', marginBottom: 8 }}>
              当前设备没有可用的 CUDA GPU。微调将在 <strong>CPU</strong> 上运行，
              可能<strong>耗时数小时甚至数十倍</strong>，且<strong>人声分离（UVR5）不可用</strong>。
            </p>
            <p style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', marginBottom: 14 }}>
              推理不受影响，可正常在 CPU 上使用。若只是想生成语音，无需在此训练。
            </p>
            <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-13)', marginBottom: 16 }}>
              <input type="checkbox" checked={noGpuAck} onChange={e => setNoGpuAck(e.target.checked)} />
              我知道 CPU 微调会非常慢，仍要继续
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={onCancelNoGpu}>取消</button>
              <button className="btn btn-sm btn-primary" disabled={!noGpuAck} onClick={onProceedWithoutGpu}>仍要开始</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
