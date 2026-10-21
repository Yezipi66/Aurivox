import { useState } from 'react'
import { useT } from '../../lib/i18n'
import { API_BASE, api } from '../../lib/api'
import { basename, fmtRecentTime } from '../../lib/format'
import { IconFolder, IconTrash } from '../common/Icons'
import { Player } from '../common/Player'

// One recorded comparison batch (a single "Generate All"). Collapsible; shows
// each member's reference + seed + inline player, so you can tell exactly which
// audios were compared together and how many the batch produced.
function CompareBatchCard({ batch, onDeleted, onReveal }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const complete = batch.count >= (batch.total || batch.count)
  const deleteBatch = async () => {
    setBusy(true)
    for (const m of batch.members) {
      await api(`/api/outputs/${encodeURIComponent(m.id)}?source=comparerefs`, { method: 'DELETE' })
    }
    setBusy(false)
    onDeleted?.()
  }
  return (
    <div className="cmp-batch">
      <div className="cmp-batch-hdr" onClick={() => setOpen(o => !o)}>
        <span className="cmp-batch-caret">{open ? '▾' : '▸'}</span>
        <span className="cmp-batch-count">{batch.count}{batch.total && batch.total !== batch.count ? ` / ${batch.total}` : ''} {t(`audio${batch.count === 1 ? '' : 's'}`, '个音频')}</span>
        <span className="cmp-batch-label" title={batch.label}>{batch.label || t('(voice default text)', '（音色默认文本）')}</span>
        {!complete && <span className="cmp-batch-partial" title={t('Some members were deleted or failed', '部分成员已被删除或生成失败')}>{t('partial', '不完整')}</span>}
        <span className="cmp-batch-time">{fmtRecentTime(batch.createdAt)}</span>
        <button className="icon-btn icon-btn-danger" title={t('Delete every audio in this batch', '删除该批次中的所有音频')}
          onClick={(e) => { e.stopPropagation(); deleteBatch() }} disabled={busy}><IconTrash size={14} /></button>
      </div>
      {open && (
        <div className="cmp-batch-body">
          {batch.members.map((m, i) => (
            <div key={m.id} className="cmp-batch-member">
              <div className="cmp-batch-member-main">
                <span className="cmp-batch-idx">#{(m.batch_seq ?? i) + 1}</span>
                <span className="cmp-batch-ref" title={m.ref_audio || t('auto reference', '自动参考')}>{m.ref_audio ? basename(m.ref_audio) : t('auto ref', '自动参考')}</span>
                {(m.seed !== undefined && m.seed !== null && m.seed !== -1) && <span className="cmp-batch-seed">seed {m.seed}</span>}
                <button className="icon-btn" title={t('Show in file explorer', '在文件资源管理器中显示')}
                  onClick={() => onReveal?.(m.id)}><IconFolder size={13} /></button>
              </div>
              {m.audio_url && <div style={{ marginTop: 4 }}><Player src={`${API_BASE}${m.audio_url}`} size="sm" bounds={m.segment_bounds} duration={m.duration} /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export { CompareBatchCard }
