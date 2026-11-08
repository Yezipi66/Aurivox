// 名片编辑页：左欄参数池、中欄表单、右侧预览。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import ManifestForm from './ManifestForm'
import Diagnostics from './Diagnostics'
import PanelPreview from './PanelPreview'
import Stage from './Stage'
import EngineScanZone from './EngineScanZone'
import EngineIdentity from './EngineIdentity'
import { computeAutoFill } from './scanAutofill'
import { PARAM_MIME, dragLabelOf } from './paramDrop'
import { entryFileOf } from './entryChoiceField'
import { scopeParams } from './paramScope'

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
  modelFiles, onRefreshInstall, engineState, onPickEngineTarget,
}) {
  const { t } = useT()
  const [view, setView] = React.useState('form')
  // 哪边的抽屉开着。默认两边都收着：
  //   第 4 步进来时左边还没扫过参数、右边还没选引擎，
  //   两个空盒子摆在首屏上只是噪音。点边条上的箭头才滑出来。
  const [drawer, setDrawer] = React.useState({ left: false, right: false })
  const toggleDrawer = (key) => setDrawer((prev) => ({ ...prev, [key]: !prev[key] }))
  // 右侧预览抽屉是否全屏：提到这一层，全屏时让「检查结果」面板退出抽屉，
  // 抽屉里只留预览本身：全屏是为了按平台真实尺寸查看，不应被诊断条目挤占。
  const [rightFull, setRightFull] = React.useState(false)

  // ---- 扫描状态 ----
  const [scan, setScan] = React.useState(null)       // /wizard/discover 的完整返回
  const [group, setGroup] = React.useState('')        // 当前分组
  // 参数池是否列出推理入口之外的全部参数。默认只列入口内的，
  //   换引擎时回到默认：那一份收窄依据属于上一台引擎。
  const [poolAll, setPoolAll] = React.useState(false)
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
    setGuessed(new Set()); setPoolAll(false)
  }, [engineKey])

  // 扫描到的参数按当前分组过滤。没有分组时给全部。
  // 认出推理入口后先收窄到入口文件：训练、微调脚本的参数混在池子里时，
  //   真正属于推理的那十几个要在一百多个里翻。收窄的依据与数量摆在左栏，
  //   由使用者一键切回全量（见 EngineScanZone）。
  const scanned = (scan && scan.params) || []
  const entryCands = (scan && scan.entry_candidates) || []
  const entryForPool = entryFileOf(manifest || {}, entryCands) ||
    ((scan && scan.entry && scan.entry.file) || '')
  // 先按分组过滤再收窄：左栏那句「只列出 N 个」必须与下面真正列出来的条数一致。
  //   两步都是筛选，顺序换过来结果相同，但数量与列表对得上才对得上人的理解。
  const grouped = group ? scanned.filter((p) => p.group === group) : scanned
  const scope = scopeParams(grouped, entryForPool)
  const pool = poolAll ? grouped : scope.params
  const params = pool

  // 左栏哪张卡已经落进名片：它的名字进了 call.args、成了某个槽位的开关（bind 的值），
  //   或已经出现在 argv 里。只用来把卡弱化，不阻止再次拖动：
  //   同一个参数可能同时喂两个槽位（正文与参考文本），也可能拖错格后要拖走。
  const usedParam = (p) => {
    if (!p) return false
    const c = (manifest && manifest.call) || {}
    if ((p.source || 'cli') === 'python') {
      const declared = Array.isArray(manifest && manifest.parameters) ? manifest.parameters : []
      return declared.some((x) => x && x.name === p.name)
    }
    if (c.args && c.args[p.name]) return true
    const bindVals = Object.values(c.bind || {})
    if (bindVals.some((v) => v && v === p.target)) return true
    return Array.isArray(c.argv) && c.argv.includes(p.target)
  }

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
  // 扫描要跨一次 await：回来时用这个读最新名片，不用闭包里点按钮那一刻的旧值。
  const latestManifest = React.useRef(manifest)
  latestManifest.current = manifest
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
      // 反射器剔掉的 bind 槽位候选（text / output_path / output_dir）：不在 params 里，
      //   但认 call.bind 的槽位靠的就是这些名字。传进去，output_path 才填得出来。
      const bindCands = j.bind_candidates || []
      // 入口嗅探结果：填进 call.argv 的模块名与子命令。为 null 时 argv 里留占位符，
      //   由使用者自己填（扫不出入口的引擎仍然要能配）。
      const entryPick = j.entry || null
      // 可选能力的嗅探建议（音频类输入 / 多权重位 / 输出格式）。只作建议，
      //   名片里已经写了的声明一律不覆盖，见下面写回那一段。
      const declareHints = j.declare_hints || null
      // 扫描回来时名片可能已经变了（等结果期间的代填、使用者的编辑）：
      //   读最新名片算匹配结果，写回也基于最新值合并，不拿点按钮那一刻的快照整份写回。
      const latest = latestManifest.current || {}
      if ((latest.id || '') !== id) return          // 等结果期间换了引擎：这次扫描作废
      // 点扫描这一刻重读盘上现状：页面加载时的快照会过时（权重刚下完、或第 3 步又下了
      //   一个仓库），拿旧快照生成 models.required，会出现「盘上 13 个、只声明 7 个」。
      let files = modelFiles
      try {
        const fresh = onRefreshInstall ? await onRefreshInstall(id) : null
        if (Array.isArray(fresh)) files = fresh
      } catch (e) { /* 读不到就用手上这份，不阻断扫描 */ }
      const result = computeAutoFill(pickedParams, latest.call || null, bindCands, entryPick, id, declareHints, files)
      if (result) {
        onManifest((cur) => {
          const base = cur || {}
          if ((base.id || '') !== id) return cur
          const merged = computeAutoFill(pickedParams, base.call || null, bindCands, entryPick, id, declareHints, files) || result
          const next = { ...base, call: merged.call }
          // 运行设备这类参数的值来自请求体，host 只认 params.call_time 白名单里的键。
          //   不写进去，请求里带了也会被静默丢弃：命令行上看不到，也不报错。
          //   写了 parameters 的新版名片，params 是平台派生的，不能自己写一份。
          if (base.parameters === undefined && merged.callTime && merged.callTime.length) {
            const params = { ...(base.params || {}) }
            const cur = Array.isArray(params.call_time) ? params.call_time : []
            const add = merged.callTime.filter((k) => !cur.includes(k))
            if (add.length) {
              params.call_time = [...cur, ...add]
              next.params = params
            }
          }
          if (!next.label && id) next.label = id
          if (next.contract_version === undefined) next.contract_version = 2
          // 顶层声明只补空缺：多权重位与输出格式是使用者可改的决定，
          //   已经写过的那份不拿扫描建议覆盖。
          const patch = merged.manifestPatch || {}
          if (base.weights === undefined && Array.isArray(patch.weights) && patch.weights.length) {
            next.weights = patch.weights
          }
          if (base.output_formats === undefined && Array.isArray(patch.output_formats) && patch.output_formats.length) {
            next.output_formats = patch.output_formats
          }
          return next
        })
        // confidence 与 matched 同一趟扫描算出来，界面靠它把自动填值分成确定 / 推测两档。
        setAutofill({ matched: result.matched, argList: result.argList,
          notes: result.notes || [], confidence: result.confidence || null })
      } else {
        setAutofill({ matched: null, argList: [], notes: [], confidence: null })
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
    // 跟着光标走的那块文字读 text/plain：放命令行上的写法（--emotion-vector），
    //   不放 JSON。整条参数放自定义类型，落点从那里读。
    e.dataTransfer.setData('text/plain', dragLabelOf(param))
    e.dataTransfer.setData(PARAM_MIME, JSON.stringify(param))
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
        full={rightFull}
        onFull={setRightFull}
        left={
          <EngineScanZone
            params={params} selected={selected} used={usedParam}
            onSelect={setSelected} onDragStart={onDragStart}
            groups={(scan && scan.groups) || []} group={group}
            onGroupChange={setGroup}
            scope={{ basis: scope.basis, outside: scope.outside,
              shown: scope.params.length, total: grouped.length }}
            listAll={poolAll} onListAll={setPoolAll}
            busy={busy} err={scanErr} />
        }
        center={
          <div className="wz-stage-main-inner wz-stack">
            {/* 身份条在最上面：选引擎、扫描或读取、路径、保存，一行说完。 */}
            <EngineIdentity
              manifest={manifest || {}} onChange={onManifest}
              facts={engineState}
              onScan={doScan} scanBusy={busy} scanned={!!scan}
              diag={diag} onSaved={onSaved}
              onEngineTarget={onPickEngineTarget}
              viewSwitch={
                <div className="wz-view-switch">
                  <button type="button"
                    className={`chip${view === 'form' ? ' chip-on' : ''}`}
                    onClick={() => switchTo('form')}>
                    {t('Form', '填表')}
                  </button>
                  <button type="button"
                    className={`chip${view === 'json' ? ' chip-on' : ''}`}
                    onClick={() => switchTo('json')}>
                    JSON
                  </button>
                </div>
              } />

            {/* 扫描过程的说明：认出了哪个入口、依据是什么、有没有同名冲突。
                这些只回传在 autofill.notes 里，不摆出来就等于没说。 */}
            {Array.isArray(autofill && autofill.notes) && autofill.notes.length > 0 && (
              <div className="msg msg-warn" style={{ marginTop: 8 }}>
                {autofill.notes.map((n, i) => (
                  <div key={i}>{typeof n === 'string' ? n : t(n.en, n.zh)}</div>
                ))}
              </div>
            )}

            {view === 'form'
              ? <ManifestForm manifest={manifest || {}} spec={spec} onChange={onManifest}
                checkpointsPath={checkpointsPath}
                modelFiles={modelFiles}
                autofill={autofill} selectedParam={selected}
                entryCandidates={scan && scan.entry_candidates}
                guessed={guessed} onParamDropped={onParamDropped}
                onTypeConfirmed={onTypeConfirmed} />
              : (
                // JSON 逃生口直接用项目的 textarea.control。
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
                        {t('Nothing to preview yet', '暂无可预览的内容')}
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
                 传成 diag= 的话诊断面板永远不显示。
                 全屏（rightFull）时只留预览，检查结果面板退出抽屉：
                 全屏是按平台真实尺寸看预览，不应被诊断条目挤占。 */}
            {!rightFull && <Diagnostics result={diag} loading={loading} />}
          </div>
        } />

    </div>
  )
}
