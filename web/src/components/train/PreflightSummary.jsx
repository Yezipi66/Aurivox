// PreflightSummary.jsx — 训练前检查摘要
//
// 从 TrainingTab.jsx 搬出：把当前表单状态翻译成一眼能看懂的摘要。
// 三行分别是输出路径、微调规模、预处理步骤，外加三类提示：
// 底模缺失门控、两步微调都关掉的提醒、小显存一次性提醒。
import { useT } from '../../lib/i18n'

export function PreflightSummary({
  form,
  proposedId,
  selVersions,
  baseModelStatus,
  showLowVram,
  cuda,
  onDismissLowVram,
}) {
  const { t: tr } = useT()

  return (
    <>
      <div className="preflight">
        <div className="pf-row">
          <span className="pf-key">{tr('Output', '输出')}</span>
          <span className="pf-val pf-path">{proposedId ? `assets/${proposedId}/` : 'assets/<auto-id>/'}</span>
          <span className="field-note">{tr('ⓘ ID allocated by the server at creation', 'ⓘ ID 由服务器在创建时分配')}</span>
        </div>
        <div className="pf-row">
          <span className="pf-key">{tr('Tune', '微调')}</span>
          <span className="pf-chips">
            {form.trainS1 !== false && (
              <span className="pf-chip">GPT (S1) · {form.gptEpochs ?? 8}ep · save every {form.s1SaveEvery ?? 4}ep</span>
            )}
            {form.trainS2 !== false && selVersions.map(v => (
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
                  <>⚠ <strong>{v.version}</strong> 的底模缺失（{(v.criticalMissing || []).join(' + ')}）：该版本已被阻止
                  （否则只会产生电流噪声）。请运行：{' '}</>)}
                <code>python download_models.py --set {String(v.version).toLowerCase()}</code>
              </div>
            : <div key={v.version} className="msg msg-warn" style={{ marginTop: 10 }}>
                ⚠ <strong>{v.version}</strong>: {(v.missing || []).includes('sv')
                  ? tr('speaker-vector (SV) model missing — training will run but without SV enhancement', 'speaker-vector（SV）模型缺失，训练仍会进行，但没有 SV 增强')
                  : tr('a preferred base model is missing; training will fall back to a lower-quality base', '缺少一个更优的底模；训练将回退到质量较低的底模')}. {tr('Run:', '请运行：')}{' '}
                <code>python download_models.py --set {String(v.version).toLowerCase()}</code>
              </div>
        ))}
      {form.trainS1 === false && form.trainS2 === false && (
        <p className="msg msg-warn" style={{ marginTop: 10 }}>{tr('Neither S1 nor S2 is enabled (both pipeline steps off) — this run will only preprocess (slice / ASR) and publish reference audio.',
          'S1 和 S2 都未启用（两个流程步骤均已关闭）：本次运行只会做预处理（切片 / ASR）并发布参考音频。')}</p>
      )}

      {/* One-time low-VRAM (≤4GB) advisory. We never auto-shrink batch_size —
          the user decides; this only points them at the control. */}
      {showLowVram && (
        <div className="msg msg-warn" style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 10, background: 'rgba(255,193,7,0.12)', border: '1px solid rgba(255,193,7,0.35)' }}>
          <span style={{ fontSize: 16, lineHeight: 1.2 }}>⚠️</span>
          <div style={{ flex: 1, fontSize: 12.5 }}>
            检测到显存较小的 GPU（{cuda?.device_name || 'GPU'} · {cuda?.vram_gb}GB）。微调可能因显存不足（OOM）而失败，
            建议<strong>手动把 Batch Size 调小</strong>（如 1–2）后再开始。该提醒只显示一次。
          </div>
          <button className="btn btn-sm" onClick={onDismissLowVram}>确认</button>
        </div>
      )}
    </>
  )
}
