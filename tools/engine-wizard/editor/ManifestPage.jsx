import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import ManifestForm from './ManifestForm'
import SaveBar from './SaveBar'
import Diagnostics from './Diagnostics'
import PanelPreview from './PanelPreview'

// 名片编辑页：左表单右实时预览，SaveBar 跨两栏吸底常驻。
// 布局用项目现成的 .workspace-grid > .workspace-left + .workspace-right，
// 视图切换用 .ref-tabs + .ref-tab(.active)，不另造类名。
// 窄屏下 .workspace-right 的 sticky 由项目自己降级成单列。

export default function ManifestPage ({
  manifest, spec, text, err, setText, onManifest, diag, loading, onSaved, checkpointsPath,
}) {
  const { t } = useT()
  const [view, setView] = React.useState('form')

  // text 是 manifest 的纯派生：只有「切进 JSON 视图」这一刻现算，
  //   之后就是用户手里的编辑缓冲。
  //   不用 useEffect 同步：那会形成 manifest→text→manifest 的回环。
  //   只在「之前没编过」(text===null) 时才覆盖，编过就保留缓冲。
  const switchTo = (v) => {
    if (v === 'json' && text === null) {
      setText(JSON.stringify(manifest || {}, null, 2))
    }
    setView(v)
  }

  return (
    // SaveBar 用内联 sticky 定位，一次性布局定位是样式铁律允许的唯一 inline 场景。
    <div className="workspace-grid">
      <div className="workspace-left">
        <div className="ref-tabs">
          <button type="button"
            className={`ref-tab${view === 'form' ? ' active' : ''}`}
            onClick={() => switchTo('form')}>
            {t('Form', '填表')}
          </button>
          <button type="button"
            className={`ref-tab${view === 'json' ? ' active' : ''}`}
            onClick={() => switchTo('json')}>
            JSON
          </button>
        </div>

        {view === 'form'
          ? <ManifestForm manifest={manifest || {}} spec={spec} onChange={onManifest}
            checkpointsPath={checkpointsPath} />
          : (
            // JSON 逃生口直接用项目的 `textarea.control`。
            // text 为 null（还没切进来过）时用 manifest 现算兜底，
            //   React 的 value={null} 是非受控输入，切视图时会闪。
            <textarea className="control" style={{ minHeight: 320 }}
              value={text ?? JSON.stringify(manifest || {}, null, 2)}
              onChange={(e) => setText(e.target.value)} />
            )}

        {err && view === 'json' && (
          <div className="msg msg-danger">{err}</div>
        )}
      </div>

      <div className="workspace-right">
        {/* props 名必须是 result：组件签名是 ({ result, loading })，
             传成 diag= 的话诊断面板永远不显示 */}
        <Diagnostics result={diag} loading={loading} />
        {manifest
          ? <PanelPreview manifest={manifest} />
          : (
            <div className="empty-state">
              <div className="es-title">
                {t('Nothing to preview yet', '还没有可预览的内容')}
              </div>
              <div className="es-sub">
                {t('Fill in the form on the left to see the preview.',
                  '在左侧填表，右侧会实时显示界面。')}
              </div>
            </div>
            )}
      </div>

      {/* SaveBar：跨左右两栏 sticky bottom，永远可见。
          跨两栏做法：sticky 容器放在 workspace-grid 之后、独立成行，
            position:sticky + bottom:0 ⇒ 滚动到底部时吸底常驻。
          不放进左栏或右栏内部：那会让它只跟着那一栏滚。 */}
      <div style={{
        gridColumn: '1 / -1',
        position: 'sticky',
        bottom: 0,
        zIndex: 5,
        background: 'var(--panel)',
        borderTop: '1px solid var(--border)',
        padding: '8px 0',
        marginTop: 4,
      }}>
        <SaveBar manifest={manifest || {}} diag={diag} onSaved={onSaved} />
      </div>
    </div>
  )
}
