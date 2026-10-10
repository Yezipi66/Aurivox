import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import ManifestForm from './ManifestForm'
import SaveBar from './SaveBar'
import Diagnostics from './Diagnostics'
import PanelPreview from './PanelPreview'

// ============================================================================
//  MANIFEST PAGE —— 名片那步（**独立的二级页面**）
//
//  ⭐ 左表单 + 右实时预览，**两栏必须真并排** ⛔
//    用的是**项目现成**的 .workspace-grid > .workspace-left + .workspace-right
//    （GenerateTab.jsx 就是这个组合：左主区 + 右栏 sticky），
//    ⛔ 不再自造 .ed-cols/.ed-left/.ed-right（那两个是前任发明的，
//      而且 .workspace-right 的 sticky 在窄屏下项目自己会降级成单列）。
//
//  ⭐ 视图切换（填表 / JSON）用项目的 .ref-tabs + .ref-tab(.active)
//    （项目里就是给「两组内容切一组」用的：切片 / 原始音频）。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

export default function ManifestPage ({
  manifest, spec, text, err, setText, onManifest, diag, loading, onSaved,
}) {
  const { t } = useT()
  const [view, setView] = React.useState('form')

  // ⭐ text 是 manifest 的**纯派生**：只有「切进 JSON 视图」这一刻现算，
  //   之后就是用户手里的编辑缓冲。
  //   ⛔ 不用 useEffect 同步：那会形成 manifest→text→manifest 的回环，
  //   正是 A4 竞态的成因。切视图是一个**事件**，就在点击里算。
  //   ⛔ 只在「之前没编过」(text===null) 时才覆盖，编过就保留缓冲。
  const switchTo = (v) => {
    if (v === 'json' && text === null) {
      setText(JSON.stringify(manifest || {}, null, 2))
    }
    setView(v)
  }

  return (
    // ⭐ 第 6 章布局：左右分栏不变（左表单右预览），SaveBar 改 sticky bottom
    //   永远可见。workspace-grid 的列宽由 styles.css 定（左自适应 + 右 380px
    //   ≈ 40%），⛔ 不再自造比例。SaveBar 用内联 sticky 定位（一次性布局
    //   定位是样式铁律允许的唯一 inline 场景）。
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
          ? <ManifestForm manifest={manifest || {}} spec={spec} onChange={onManifest} />
          : (
            // JSON 逃生口直接用项目的 `textarea.control`
            // （styles.css 里 `textarea.control` 已给好 padding/resize/行高）。
            // ⛔ 之前自造的 .ed-json 是白底非等宽字体，那个框在深色页面上
            //   是纯白的，非常刺眼。
            // ⭐ text 为 null（还没切进来过）时用 manifest 现算兜底 ——
            //   ⛔ React 的 value={null} 是非受控输入，切视图时会闪。
            <textarea className="control" style={{ minHeight: 320 }}
              value={text ?? JSON.stringify(manifest || {}, null, 2)}
              onChange={(e) => setText(e.target.value)} />
            )}

        {err && view === 'json' && (
          <div className="msg msg-danger">{err}</div>
        )}
      </div>

      <div className="workspace-right">
        {/* ⛔⛔ props 名必须是 result —— 之前传的是 diag=，
             组件签名却是 ({ result, loading }) ⇒ 诊断面板**永远不显示** */}
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

      {/* ⭐⭐ SaveBar —— 跨左右两栏 sticky bottom，**永远可见**。
          原来埋在表单最底，用户填完要滚 7 屏回去才能存（RFC 第 6 章）。
          ⚠ 跨两栏做法：sticky 容器放在 workspace-grid 之后、独立成行，
            position:sticky + bottom:0 ⇒ 滚动到底部时吸底常驻。
          ⛔ 不放进左栏或右栏内部 —— 那会让它只跟着那一栏滚。 */}
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
