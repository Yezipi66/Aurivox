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

  return (
    <div className="workspace-grid">
      <div className="workspace-left">
        <div className="ref-tabs">
          <button type="button"
            className={`ref-tab${view === 'form' ? ' active' : ''}`}
            onClick={() => setView('form')}>
            {t('Form', '填表')}
          </button>
          <button type="button"
            className={`ref-tab${view === 'json' ? ' active' : ''}`}
            onClick={() => setView('json')}>
            JSON
          </button>
        </div>

        {view === 'form'
          ? (
            <>
              <ManifestForm manifest={manifest || {}} spec={spec} onChange={onManifest} />
              {/* ⭐ SaveBar 移到表单**最下面**：填的时候不被打断，填完滚到底
                  才看到「还有几处问题 + 存盘」，是自然的收尾。⛔ 不再放顶部
                  一进来就甩红错误。 */}
              <SaveBar manifest={manifest || {}} diag={diag} onSaved={onSaved} />
            </>
            )
          : (
            // JSON 逃生口直接用项目的 `textarea.control`
            // （styles.css 里 `textarea.control` 已给好 padding/resize/行高）。
            // ⛔ 之前自造的 .ed-json 是白底非等宽字体，那个框在深色页面上
            //   是纯白的，非常刺眼。
            <textarea className="control" style={{ minHeight: 320 }}
              value={text} onChange={(e) => setText(e.target.value)} />
            )}

        {err && view === 'json' && (
          <div className="msg msg-danger">{err}</div>
        )}
        {/* JSON 视图也要能存盘（SaveBar 同样在最下面）*/}
        {view === 'json' && (
          <SaveBar manifest={manifest || {}} diag={diag} onSaved={onSaved} />
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
    </div>
  )
}
