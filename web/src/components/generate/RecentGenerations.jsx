// RecentGenerations.jsx — 最近生成列表
//
// 从 GenerateTab.jsx 搬出：历史生成记录的列表与每条的操作
// （在文件管理器中显示、重新载入设置、立即重跑、删除）。
// 条目里的位名与引擎名全部来自后端存下的名片，不在这里写死。
import { API_BASE } from '../../lib/api'
import { fmtRecentTime } from '../../lib/pathText'
import { langLabel } from '../../lib/langOptions'
import { refBasename } from '../../lib/refAudio'
import { describeGeneration } from '../../lib/modelPickers.pure.js'
import { Player } from '../common/Player'
import { IconFolder, IconPlay, IconRerun, IconTrash } from '../common/Icons'
import { SeedBadge, SeedInline } from './GenerateBits'
import { useT } from '../../lib/i18n'

export function GenerationResult({ result }) {
  if (!result || !result.audio_url) return null
  return (
    <div className="section">
      <div className="section-hdr">
        <span>{result.split ? (result.concat ? `Combined (${result.segments?.length} segments)` : `Segments (${result.segments?.length})`) : 'Result'}</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {result.silence_ms !== undefined && <span style={{ fontSize: 11, color: 'var(--muted)' }}>silence: {result.silence_ms}ms | {result.concat_method || ''}</span>}
          <SeedBadge seed={result.seed} />
        </span>
      </div>
      <div className="section-body">
        <Player src={`${API_BASE}${result.audio_url}`} bounds={result.segment_bounds} duration={result.duration} />
        <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
          <a href={`${API_BASE}${result.audio_url}`} download style={{ color: 'var(--accent)', fontSize: 13 }}>Download WAV</a>
        </div>
        {result.warning && <div className="msg msg-warn" style={{ marginTop: 8 }}>{result.warning}</div>}
      </div>
    </div>
  )
}

export function RecentGenerations({
  recent,
  showAll,
  onShowAll,
  onClearHistory,
  onCleanAll,
  onReveal,
  onReload,
  onRerun,
  onDelete,
  loading,
}) {
  const { t } = useT()

  return (
    <div className="section">
      <div className="section-hdr">
        <span>Recent Generations</span>
        {recent.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            {/* 两个按钮的差别是「只清列表」和「连文件一起删」，而 Clean All
                听起来和 Clear History 是一档的。按确认框里已经在用的词命名。 */}
            <button className="btn btn-sm btn-ghost" onClick={onClearHistory}>Clear history</button>
            <button className="btn btn-sm btn-danger" onClick={onCleanAll}>Delete all files</button>
          </div>
        )}
      </div>
      <div className="section-body">
        {recent.length === 0 ? (
          <div className="empty-state" style={{ padding: 16 }}>
            <div className="es-sub" style={{ marginBottom: 0 }}>{t('Generated audio will appear here.', '生成的音频将显示在这里。')}</div>
          </div>
        ) : (
          (showAll ? recent : recent.slice(0, 5)).map(item => (
            <div key={item.id} className="recent-row">
              <div className="rr-main">
                <div className="rr-text" title={item.text}>{item.text || '(empty)'}</div>
                <div className="rr-meta">
                  {item.voice} · {langLabel(item.lang)}
                  {describeGeneration(item) ? ` · ${describeGeneration(item)}` : ''}
                  {item.segments > 1 ? ` · ${item.segments} seg` : ''}
                  {refBasename(item) ? ` · ref ${refBasename(item)}` : ''} · {fmtRecentTime(item.createdAt)}
                  {(item.seed ?? item.params?.seed) !== undefined && (item.seed ?? item.params?.seed) !== null && (item.seed ?? item.params?.seed) !== -1 && (
                    <> · <SeedInline seed={item.seed ?? item.params?.seed} /></>
                  )}
                </div>
                <div style={{ marginTop: 6 }}><Player src={`${API_BASE}${item.audio_url}`} size="sm" bounds={item.segment_bounds} duration={item.duration} /></div>
              </div>
              <div className="rr-actions">
                <button className="icon-btn" title={t('Show in file explorer', '在文件资源管理器中显示')} onClick={() => onReveal(item)}><IconFolder size={15} /></button>
                <button className="icon-btn" title={t('Reload these settings into the editor (voice, model, language, reference, text and all parameters) without generating', '将这些设置重新载入编辑器（音色、模型、语言、参考、文本及所有参数），但不生成')} onClick={() => onReload(item)} disabled={loading}><IconRerun size={15} /></button>
                <button className="icon-btn" title={t('Rerun now with the original settings', '使用原始设置立即重新生成')} onClick={() => onRerun(item)} disabled={loading}><IconPlay size={14} /></button>
                <button className="icon-btn icon-btn-danger" title={t('Delete this audio', '删除此音频')} onClick={() => onDelete(item)}><IconTrash size={15} /></button>
              </div>
            </div>
          ))
        )}
        {recent.length > 5 && !showAll && (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <button className="btn btn-sm btn-ghost" onClick={onShowAll}>
              {t(`Show more (${recent.length - 5} items)`, `显示更多（还有 ${recent.length - 5} 条）`)}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
