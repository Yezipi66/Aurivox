import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import ManifestForm from './ManifestForm'
import SaveBar from './SaveBar'
import Diagnostics from './Diagnostics'
import PanelPreview from './PanelPreview'
import ThreeZone from './ThreeZone'
import EngineScanZone from './EngineScanZone'
import EngineIdentity from './EngineIdentity'
import { computeAutoFill } from './scanAutofill'

// 名片编辑页：三栏。
//
// 左栏是扫到的参数，中栏是当前名片内容，右栏是当前项目的前端预览。
// 三栏都能收起。SaveBar 跨栏吸底常驻。
//
// 视图切换（填表 / JSON）留在中栏里：JSON 是名片的同一份内容的另一种写法，
// 不是第四栏。切到 JSON 时中栏的内容换掉，左栏与右栏不动。
//
// 扫描状态在这一层持有：左栏要显示扫到的参数，中栏要显示自动填的结果，
// 右栏要跟着名片的每一次改动实时更新。三者共用一份名片，改一处三处同步。

export default function ManifestPage ({
  manifest, spec, text, err, setText, onManifest, diag, loading, onSaved, checkpointsPath,
  engineState,
}) {
  const { t } = useT()
  const [view, setView] = React.useState('form')
  // 哪几栏收起了。存在这一层（不在 ThreeZone 里）：
  //   收起按钮在内容自己的 .section-hdr 上，内容需要知道收起了没有，
  //   才能把按钮画成「▾ 收起」还是「▸ 展开」。
  const [collapsed, setCollapsed] = React.useState({ left: false, right: false })
  const toggleZone = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

  // ---- 扫描状态 ----
  const [scan, setScan] = React.useState(null)       // /wizard/discover 的完整返回
  const [group, setGroup] = React.useState('')        // 当前分组
  const [busy, setBusy] = React.useState(false)       // 扫描中
  const [scanErr, setScanErr] = React.useState(null)  // 扫描错误
  const [selected, setSelected] = React.useState(null) // 左栏选中的参数
  const [autofill, setAutofill] = React.useState(null) // 扫描认出的槽位与候选

  // 扫描到的参数按当前分组过滤。没有分组时给全部。
  const scanned = (scan && scan.params) || []
  const params = group ? scanned.filter((p) => p.group === group) : scanned

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

  // 扫描：调 /wizard/discover 自动探测形态，扫出参数表，
  // 同时把能对应的填进名片 call 段。
  //
  // 已有名片的引擎：自动填只填空缺，不覆盖名片里已有的内容。
  // 名片里原有的 call.args 原样保留，扫到的参数只是列在左栏让用户自己挑。
  const doScan = async () => {
    const id = (manifest && manifest.id) || ''
    if (!id) return
    setBusy(true); setScanErr(null)
    try {
      const r = await fetch('/wizard/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const j = await r.json()
      if (!j.ok) { setScanErr(j.error || `HTTP ${r.status}`); return }
      setScan(j)
      const inferGroups = (j.groups || []).filter((s) => /synth|infer|tts|generate|call/i.test(s))
      const picked = inferGroups[0] || (j.groups || [])[0] || ''
      setGroup(picked)
      const pickedParams = (j.params || []).filter((p) => !picked || p.group === picked)
      const result = computeAutoFill(pickedParams, (manifest && manifest.call) || null)
      if (result) {
        const next = { ...manifest, call: result.call }
        if (!next.id && id) next.id = id
        if (!next.label && id) next.label = id
        if (next.contract_version === undefined) next.contract_version = 2
        onManifest(next)
        setAutofill({ matched: result.matched, argList: result.argList })
      } else {
        setAutofill({ matched: null, argList: [] })
      }
    } catch (e) { setScanErr(e.message) } finally { setBusy(false) }
  }

  // 左栏拖拽开始：把参数放进 dataTransfer，中栏的落点读它。
  const onDragStart = (e, param) => {
    e.dataTransfer.setData('text/plain', JSON.stringify(param))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    // 容器用 .wz-manifest-layout（editor.css），不用项目的 .workspace-grid：
    // .workspace-grid 自己就是两列 grid（minmax(0,1fr) 380px），
    // 三栏容器放进去会被塞进它的第一列 ⇒ 中栏只剩 958px 里的 302px，
    // 剩下那一大片是右栏的空位。三个栏自己排版，不需要外层再来一列。
    // SaveBar 跨栏 sticky bottom，永远可见。
    <div className="wz-manifest-layout">
      <ThreeZone
        collapsed={collapsed}
        onToggle={toggleZone}
        left={
          <EngineScanZone
            params={params} selected={selected}
            onSelect={setSelected} onDragStart={onDragStart}
            groups={(scan && scan.groups) || []} group={group}
            onGroupChange={setGroup}
            busy={busy} err={scanErr} onScan={doScan}
            canScan={!!((manifest && manifest.id) || '')}>
            <button className="btn btn-sm btn-ghost" type="button"
              onClick={() => toggleZone('left')}
              title={t('Collapse', '收起')}
              aria-label={t('Collapse the parameters column', '收起参数栏')}
              aria-expanded={true}>
              ▾
            </button>
          </EngineScanZone>
        }
        center={
          <div className="workspace-left">
            {/* 身份条在最上面：这是哪台引擎的名片、平台现在知道它什么状况。 */}
            <EngineIdentity
              manifest={manifest || {}} onChange={onManifest}
              facts={engineState} />

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
                checkpointsPath={checkpointsPath}
                autofill={autofill} selectedParam={selected} />
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
        }
        right={
          <div className="workspace-right">
            {/* 预览在前：右栏是「当前项目的前端预览」这一栏，
                诊断是附带的说明，不该把首屏占住。 */}
            {manifest
              ? <PanelPreview manifest={manifest}>
                <button className="btn btn-sm btn-ghost" type="button"
                  onClick={() => toggleZone('right')}
                  title={t('Collapse', '收起')}
                  aria-label={t('Collapse the preview column', '收起预览栏')}
                  aria-expanded={true}>
                  ▾
                </button>
              </PanelPreview>
              : (
                // 还没选引擎时右栏是空的，但空栏也要有栏头与收起按钮：
                // 三栏的收起入口得在同一处，不能因为内容空了就少一个。
                // 栏头与有预览时长得一样（.section + .section-hdr）。
                <div className="section">
                  <div className="section-hdr">
                    <h2>{t('Preview', '预览')}</h2>
                    <button className="btn btn-sm btn-ghost" type="button"
                      onClick={() => toggleZone('right')}
                      title={t('Collapse', '收起')}
                      aria-label={t('Collapse the preview column', '收起预览栏')}
                      aria-expanded={true}>
                      ▾
                    </button>
                  </div>
                  <div className="section-body">
                    <div className="empty-state">
                      <div className="es-title">
                        {t('Nothing to preview yet', '还没有可预览的内容')}
                      </div>
                      <div className="es-sub">
                        {t('Pick an engine on the left to see the preview.',
                          '在左侧选一台引擎，右侧会实时显示界面。')}
                      </div>
                    </div>
                  </div>
                </div>
                )}
            {/* props 名必须是 result：组件签名是 ({ result, loading })，
                 传成 diag= 的话诊断面板永远不显示 */}
            <Diagnostics result={diag} loading={loading} />
          </div>
        } />

      {/* SaveBar：跨栏 sticky bottom，永远可见。
          跨栏做法：sticky 容器放在三栏之后、独立成行，
            position:sticky + bottom:0 ⇒ 滚动到底部时吸底常驻。
          不放进任何一栏内部：那会让它只跟着那一栏滚。 */}
      <div className="wz-savebar-row">
        <SaveBar manifest={manifest || {}} diag={diag} onSaved={onSaved} />
      </div>
    </div>
  )
}
