import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import ManifestForm from './ManifestForm'
import Diagnostics from './Diagnostics'
import PanelPreview from './PanelPreview'
import Stage from './Stage'
import EngineScanZone from './EngineScanZone'
import EngineIdentity from './EngineIdentity'
import { computeAutoFill } from './scanAutofill'

// 名片编辑页：左边条、中栏、右边条，三根平级的骨头，铺满整个页面宽度。
//
// 左边条里是扫到的参数，中栏是当前名片内容，右边条里是当前项目的前端预览。
// 左右两根边条默认收成 32px 的窄边，只露一个方向箭头；点一下滑出成抽屉，
// 两根边条都 sticky 在视口里，跟着页面滚动。右边条还能放大到平台前端的宽度。
// 中栏内容对齐平台的大容器（max-width 1400px）。
//
// 没有吸底的存盘栏：选引擎 / 扫描或读取 / 保存都在中栏顶部的身份条上。
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
  // 哪边的抽屉开着。默认两边都收着：
  //   第 4 步进来时左边还没扫过参数、右边还没选引擎，
  //   两个空盒子摆在首屏上只是噪音。点边条上的箭头才滑出来。
  const [drawer, setDrawer] = React.useState({ left: false, right: false })
  const toggleDrawer = (key) => setDrawer((prev) => ({ ...prev, [key]: !prev[key] }))

  // ---- 扫描状态 ----
  const [scan, setScan] = React.useState(null)       // /wizard/discover 的完整返回
  const [group, setGroup] = React.useState('')        // 当前分组
  const [busy, setBusy] = React.useState(false)       // 扫描中
  const [scanErr, setScanErr] = React.useState(null)  // 扫描错误
  const [selected, setSelected] = React.useState(null) // 左栏选中的参数
  const [autofill, setAutofill] = React.useState(null) // 扫描认出的槽位与候选
  // 拖进来时类型是猜的那些参数名：中栏那一行的类型下拉标黄，提醒人确认。
  //   只是界面状态，不写进名片。
  const [guessed, setGuessed] = React.useState(() => new Set())

  // 换引擎：上一台的扫描结果全部作废。
  const engineKey = (manifest && manifest.id) || ''
  React.useEffect(() => {
    setScan(null); setGroup(''); setSelected(null); setAutofill(null); setScanErr(null)
    setGuessed(new Set())
  }, [engineKey])

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
      // 扫到了就把左边条打开：参数是这一步接下来要拖的东西。
      setDrawer((prev) => ({ ...prev, left: true }))
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

  // 拖进来一个参数：类型是猜的就记下来，中栏那一行要提醒确认。
  const onParamDropped = (param, name) => {
    if (!param || !name) return
    setGuessed((prev) => {
      const next = new Set(prev)
      if (param.kind_certain) next.delete(name)
      else next.add(name)
      return next
    })
  }
  const onTypeConfirmed = (name) => {
    setGuessed((prev) => { const next = new Set(prev); next.delete(name); return next })
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
    <div className="wz-manifest-layout">
      <Stage
        open={drawer}
        onToggle={toggleDrawer}
        left={
          <EngineScanZone
            params={params} selected={selected}
            onSelect={setSelected} onDragStart={onDragStart}
            groups={(scan && scan.groups) || []} group={group}
            onGroupChange={setGroup}
            busy={busy} err={scanErr} />
        }
        center={
          <div className="wz-stage-main-inner">
            {/* 身份条在最上面：选引擎、扫描或读取、路径、保存，一行说完。 */}
            <EngineIdentity
              manifest={manifest || {}} onChange={onManifest}
              facts={engineState}
              onScan={doScan} scanBusy={busy} scanned={!!scan}
              diag={diag} onSaved={onSaved} />

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
                autofill={autofill} selectedParam={selected}
                guessed={guessed} onParamDropped={onParamDropped}
                onTypeConfirmed={onTypeConfirmed} />
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
          <div className="wz-drawer-stack">
            {/* 预览在前：右边条是「当前项目的前端预览」这一栏，
                诊断是附带的说明，不该把首屏占住。 */}
            {manifest
              ? <PanelPreview manifest={manifest} />
              : (
                // 还没选引擎时右边条是空的。空的时候画一个空态就够了，
                // 不必再套一层带栏头的 .section：
                // 边条自己就是这栏的入口，栏头里的收起按钮是多余的。
                <div className="section">
                  <div className="section-body">
                    <div className="empty-state">
                      <div className="es-title">
                        {t('Nothing to preview yet', '还没有可预览的内容')}
                      </div>
                      <div className="es-sub">
                        {t('Pick an engine to see the preview.',
                          '选一台引擎，这里会实时显示界面。')}
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

    </div>
  )
}
