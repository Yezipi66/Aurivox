// 名片编辑器（引擎安装向导）的顶层组件：持有向导状态，只渲染 page 指向的那一步。
// manifest 是唯一真相，text 只在 JSON 视图当编辑缓冲（单向 text → manifest）；
// 完成状态由 GET /wizard/install-state 返回的真实产物判定，不读 localStorage。
import React from 'react'
import Pipeline from './Pipeline'
import ManifestPage from './ManifestPage'
import StepPrepare from './StepPrepare'
import StepDeps from './StepDeps'
import { StepModels } from './StepsExtra'
import { StepVerify } from './StepVerify'
import { STEPS, stepDone } from './steps'
import { useT, LangToggle } from '../../../web/src/lib/i18n'
// 持久段（localStorage）= 用户输入与选择 + 展开步骤；
//   会话段（sessionStorage）= 探测结果；完成状态由 GET /wizard/install-state 判定。
import { loadPersist, savePersist, loadPage, savePage,
  loadSession, saveSession, purgeOrphanKeys } from './useInstallSession'
import { factsQueryId } from './factsQueryId'
import { useEngineDirs } from './useEngineDirs'
import EngineEscapeHatch from './EngineEscapeHatch'
import { manifestForEngineSwitch } from './manifestAutoFill'

// 向导骨架照 web/src/components/train/TrainingTab.jsx 的 renderNodeDetail()：
//   只渲染 page 指向的那一步；流程条是唯一导航。
//  「展开」指该步骤内部不再套盒子，不是五步同时渲染。
//   所有类都借自 web/src/styles.css，不在这里定义任何容器。

// factsQueryId（问完成状态时该用哪个引擎 id）在 editor/factsQueryId.js：
// 这个文件是组件模块，而 vite 的 react 插件要求组件模块只导出组件，
// 导出普通函数会坏掉 Fast Refresh（改这个文件变成整页 reload）。

export default function App () {
  const { t, lang } = useT()

  // ---- 字段规格（表单照它长）----
  const [spec, setSpec] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    fetch('/wizard/spec').then((r) => r.json()).then((j) => {
      if (alive && j && j.sections) setSpec(j)
    }).catch(() => { /* 后端没起：只留 JSON 视图 */ })
    return () => { alive = false }
  }, [])

  // ---- 名片：manifest 是唯一真相，text 只在 JSON 视图当编辑缓冲（单向 text→manifest）----
  const [manifest, setManifest] = React.useState(null)
  // text 初值 null = 「还没进过 JSON 视图」，用于分辨「用户没编辑过」和「用户编过」。
  const [text, setText] = React.useState(null)
  const [err, setErr] = React.useState(null)

  // ---- JSON 逃生口：只 text → manifest，300ms 防抖；manifest 变了不回写 text ----
  React.useEffect(() => {
    if (text === null) return          // 没进过 JSON 视图：不解析
    const h = setTimeout(() => {
      try { setManifest(JSON.parse(text)); setErr(null) }
      catch (e) { setErr(e.message) }
    }, 300)
    return () => clearTimeout(h)
  }, [text])

  // ---- 实时检查（走向导自己的中间件，不碰平台 /api）----
  const [vresult, setVresult] = React.useState(null)
  const [vloading, setVloading] = React.useState(false)
  React.useEffect(() => {
    // 空名片（还没开始建，比如没有 id）不校验：刚点进来就对着一张
    //   空名片报「缺 runtime」纯是增加心理负担。等用户真填了（有 id）再验。
    if (!manifest || !manifest.id) { setVresult(null); setVloading(false); return }
    let alive = true
    setVloading(true)
    fetch('/wizard/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
    }).then((r) => r.json()).then((j) => {
      if (alive) setVresult(j)
    }).catch(() => {}).finally(() => { if (alive) setVloading(false) })
    return () => { alive = false }
  }, [manifest])

  // ---- 向导状态必须活在 App 这一层（组件卸载即状态归零）----
  // wz = 持久段（localStorage）：用户输入与选择；prep = 会话段（sessionStorage）：探测结果。
  const [wz, setWzRaw] = React.useState(loadPersist)
  const persistedUrl = wz.repoUrl || wz.url || ''
  // 会话段只在「id + url 都定了」之后才有意义：都是空的时候读出来也是空。
  const [prep, setPrep] = React.useState(() => loadSession(wz.id, persistedUrl) || {})

  // 写持久段（只写用户输入与选择；探测结果走 saveSession）
  const setWz = (updater) => setWzRaw((cur) => {
    const next = typeof updater === 'function' ? updater(cur) : updater
    savePersist(next)
    return next
  })

  // ---- 逃生口：直接指定对 engines/ 下的哪一台操作 ----
  // 流程条不再锁步骤（锁的判据是「第 1 步完成」，而完成状态由真实产物判，
  //   它与界面上看到的不一致时人会被卡在第 1 步且无从自救）。
  //   改成让使用者自己挑目录：完成状态、权重路径、会话段都以 wz.id 为键。
  const { dirs: engineDirs, reload: reloadDirs } = useEngineDirs()
  // 只换 id：第 4 步的 EngineIdentity 用它同步全局目标
  //   （那一路自己管名片的清换，且要求人点「读取参数」才读盘）。
  const pickEngine = (id) => setWz((cur) => ({ ...cur, id: id || '' }))
  // 逃生口的提交：换目标引擎，并把界面状态按新引擎重读一遍。
  //   只改 id 不够：App 级名片（第 4 步的编辑对象）不跟 wz.id 走，而
  //   manifestEngineId 优先取 manifest.id，换目标后第 4 步还会停在上一台，
  //   保存也写回上一台的目录。所以名片要一起换：盘上已有就按盘上的来，
  //   没有就用换引擎清段给一个干净的空壳。
  //   text/err 同时归零：JSON 视图的编辑缓冲不清，旧名片会借防抖分支回来。
  const switchEngine = async (nextId) => {
    if (!nextId || nextId === wz.id) return
    setWz((cur) => ({ ...cur, id: nextId }))
    let fromDisk = null
    try {
      const r = await fetch(`/wizard/manifest/${encodeURIComponent(nextId)}`)
      const j = await r.json()
      if (r.ok && j && j.manifest) fromDisk = j.manifest
    } catch (e) { /* 端点调不通 ⇒ 退到清干净的空壳，不阻碍切换 */ }
    if (fromDisk) setManifest(fromDisk)
    else setManifest((cur) => manifestForEngineSwitch(cur, nextId, nextId))
    // JSON 编辑缓冲与解析错误一起归零：不然旧内容会借 300ms 防抖回来
    setText(null)
    setErr(null)
    // 操作记录按新引擎重读：完成状态（流程条绿勾）与引擎目录清单
    reloadFacts(nextId)
    reloadDirs()
  }

  // 换 URL / 换引擎 ⇒ 会话段键变了 ⇒ 整段丢掉，防止串号。
  const lastStamp = React.useRef(null)
  React.useEffect(() => {
    const stamp = String(wz.id || '') + '|' + persistedUrl
    const first = lastStamp.current === null
    lastStamp.current = stamp
    // 首帧：useState 初始值已经读过正确的会话段，不要再覆盖一次
    if (first) return
    setPrep(loadSession(wz.id, persistedUrl) || {})
  }, [wz.id, persistedUrl])

  const patchPrep = (updater) => setPrep((cur) => {
    const next = typeof updater === 'function' ? updater(cur) : updater
    saveSession(wz.id, persistedUrl, {
      res: next.res, probe: next.probe, plan: next.plan, cloneRes: next.cloneRes,
    })
    return next
  })

  // ---- 完成状态只由真实产物判（GET /wizard/install-state），不读 localStorage ----
  const [facts, setFacts] = React.useState({})
  // facts 是「按哪个 id 问来的」。第 1 步的完成状态必须与界面上的目录名同源：
  //   只比 facts.prepare 会把一台旧引擎的状态显示在新仓库上。
  const [factsId, setFactsId] = React.useState(null)
  // 权重落盘的相对路径（相对项目根）。第 3 步写盘到这里，第 4 步的名片
  //   runtime.checkpoints 填的也是这个值：两处同源，改一处不会出现「下好了却找不到」。
  //   路径由后端算（core/checkpointsPath.js），前端不自己拼。
  const [checkpointsPath, setCheckpointsPath] = React.useState(null)
  // 第 3 步实际下到盘上的模型文件清单（相对 checkpoints，正斜杠）。
  //   第 4 步的 models.required 自动填就照这份清单：下过什么声明什么，
  //   不靠猜。由后端随 install-state 一起送来，前端不自己列目录。
  const [modelFiles, setModelFiles] = React.useState(null)
  // 第 4 步要显示的现状：第 2 步的环境与第 3 步的权重。
  //   权重是三态（齐了 / 缺了 / 说不出来），布尔装不下 ⇒ 单独存。
  //   第 2 步与第 3 步和第 4 步是并行的，所以这两个状态会自己变，
  //   第 4 步开着不动也能看到第 3 步下完了没有。
  const [engineState, setEngineState] = React.useState({ env: null, models: null })
  // id 可由调用方传入：刚克隆完时 wz.id 的 setState 还没生效，
  //   读闭包里的旧值会拿到空 id，一个勾都不亮。
  const reloadFacts = React.useCallback((idArg) => {
    const id = factsQueryId(idArg, wz.id)
    setFactsId(id || null)
    if (!id) { setFacts({}); setCheckpointsPath(null); setModelFiles(null); return }
    let alive = true
    fetch(`/wizard/install-state?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        if (j && j.ok && j.steps_done) setFacts(j.steps_done)
        setCheckpointsPath((j && j.checkpoints_path) || null)
        setModelFiles(Array.isArray(j && j.model_files) ? j.model_files : null)
        const st = j && j.steps
        setEngineState({
          env: st && st.env ? st.env.done : null,
          models: st && st.models ? st.models.ready : null,
        })
      })
      .catch(() => { /* 端点调不通 ⇒ 一个勾都没有，不猜 */ })
    return () => { alive = false }
  }, [wz.id])
  React.useEffect(reloadFacts, [reloadFacts])

  // 第 4 步的名片可以编辑的引擎，不一定是第 1 步克隆的那一台：
  //   左栏的统一入口能选 engines/ 下的任意一台。
  // 名片里的 runtime.checkpoints 要跟着「正在编辑的那台」走，
  //   否则换成另一台时，权重路径还指着上一台。
  // 判据：manifest.id 定了就用它，没定才回落到 wz.id。
  const [manifestEngineId, setManifestEngineId] = React.useState(null)
  React.useEffect(() => {
    const id = (manifest && manifest.id) || wz.id || null
    setManifestEngineId(id)
  }, [manifest && manifest.id, wz.id])

  React.useEffect(() => {
    if (!manifestEngineId) { setCheckpointsPath(null); setModelFiles(null); return }
    let alive = true
    fetch(`/wizard/install-state?id=${encodeURIComponent(manifestEngineId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        setCheckpointsPath((j && j.checkpoints_path) || null)
        setModelFiles(Array.isArray(j && j.model_files) ? j.model_files : null)
        // 现状也跟着换引擎换：第 4 步编辑的这台可能不是第 1 步克隆的那台。
        const st = j && j.steps
        setEngineState({
          env: st && st.env ? st.env.done : null,
          models: st && st.models ? st.models.ready : null,
        })
      })
      .catch(() => { if (alive) { setCheckpointsPath(null); setModelFiles(null) } })
    return () => { alive = false }
  }, [manifestEngineId])

  // 点扫描那一刻重读盘上现状：页面加载时的快照会过时（权重刚下完、或第 3 步又下了
  //   一个仓库），拿旧快照生成 models.required 会出现「盘上 13 个、名片只声明 7 个」。
  //   返回最新的 model_files 供调用方直接用，不等下一次渲染。
  const refreshInstall = React.useCallback((idArg) => {
    const id = idArg || manifestEngineId
    if (!id) return Promise.resolve(null)
    return fetch(`/wizard/install-state?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        setCheckpointsPath((j && j.checkpoints_path) || null)
        const files = Array.isArray(j && j.model_files) ? j.model_files : null
        setModelFiles(files)
        const st = j && j.steps
        setEngineState({
          env: st && st.env ? st.env.done : null,
          models: st && st.models ? st.models.ready : null,
        })
        return files
      })
      .catch(() => null)
  }, [manifestEngineId])

  const done = Object.fromEntries(
    STEPS.map((st) => [st.key, stepDone(st.key, facts)]))

  // 当前展开的是哪一步（持久段：刷新后停在上次那一步）
  const [page, setPageState] = React.useState(loadPage)
  const setPage = (next) => {
    const v = typeof next === 'function' ? next(page) : next
    setPageState(v)
    savePage(v)
  }

  // 孤儿键一次性清理，不留长期清理代码。
  React.useEffect(() => { purgeOrphanKeys() }, [])

  const step = STEPS.find((x) => x.key === page)
  const title = step ? (lang === 'zh' ? step.label[1] : step.label[0]) : ''
  // 完成状态由真实产物判定（steps.js 的 stepDone），不看用户点过什么
  const isDone = !!step && done[step.key]

  return (
    // 外层不再整个套 .workspace-container：第 4 步的三栏要铺满页面宽度，
    //   套在 1400px 的居中容器里，边条就只能贴着主容器两边，
    //   左栏参数被挤窄、右栏预览放不到平台前端的尺寸。
    //   顶栏、流程条与其余四步照旧在容器里；第 4 步自己全宽，中栏内容再对齐容器。
    <div className="wz-root">
      <div className="workspace-container wz-root">

      {/* ---- 顶栏：项目的 section 三件套（照 TrainingTab 的骨架）---- */}
      <div className="section">
        <div className="section-hdr">
          <h2>{t('Engine Wizard', '安装向导')}</h2>
          <LangToggle />
        </div>
      </div>

      {/* ---- 流程条 ---- */}
      <Pipeline done={done} selected={page}
        onSelect={(k) => setPage((cur) => (cur === k ? null : k))} />

      </div>

      {/* ---- 第 4 步：名片页有自己的骨架，不套 .node-detail ----
          .node-detail 是平台训练页的详情框（紫色描边 + 圆角 + 底色）。
          第 4 步的骨架是三根平级的骨头（左边条 / 中栏 / 右边条），
          套进这个详情框里等于把页面骨架当卡片内容塞：
          边框套边框、圆角套圆角，页面还多出一层内缩。
          所以第 4 步直接进 .wz-stage，不经过 .node-detail。 */}
      {page === 'manifest' && (
        <div className="wz-manifest-shell">
          <ManifestPage manifest={manifest} spec={spec}
            text={text} err={err} setText={setText}
            // 只 setManifest，绝不 setText：manifest 是唯一真相，text 由它派生；两边互相回写会出竞态。
            onManifest={(m) => { setManifest(m); setErr(null) }}
            // 第 4 步的引擎下拉也驱动全局目标：换一台编辑 = 换一台设置，一台引擎贯穿全流程。
            onPickEngineTarget={pickEngine}
            diag={vresult} loading={vloading}
            onSaved={reloadFacts}
            checkpointsPath={checkpointsPath}
            modelFiles={modelFiles}
            onRefreshInstall={refreshInstall}
            engineState={engineState} />
        </div>
      )}

      {page !== 'manifest' && (
      <div className="workspace-container wz-root">
      {/* ---- 展开的那一步：.node-detail 详情框，外壳照 NodeDetailPanel.jsx 的 NodeDetailPanel() ---- */}
      {page && page !== 'manifest' && (
        <div className="node-detail">
          <div className="node-detail-hdr">
            <span className="node-detail-title">{title}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={`badge ${isDone ? 'badge-ok' : 'badge-neutral'}`}>
                {isDone ? t('Done', '已完成') : t('In progress', '进行中')}
              </span>
              <button className="btn btn-sm" type="button" onClick={() => setPage(null)}>
                {t('Close', '关闭')}
              </button>
            </div>
          </div>

          {/* ---- 每一步的逃生口（除第 1 步）----
              五步不再互相锁：锁的判据是「第 1 步完成」，而完成状态由真实产物判，
                它与界面上看到的不一致时人会被卡在第 1 步，且无从自救。
              改成每步在这里选「操作哪一台」：默认落在刚克隆的那台（wz.id），
                也可以直接挑 engines/ 下的任意目录。切换即全局重定向。 */}
          {page !== 'prepare' && (
            <div className="section">
              <div className="section-body">
                <EngineEscapeHatch id={wz.id} dirs={engineDirs} onSwitch={switchEngine} />
              </div>
            </div>
          )}

          <fieldset style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
            {page === 'prepare' && (
              <StepPrepare state={wz} facts={facts} factsId={factsId}
                onChange={(v) => setWz((w) => ({ ...w, ...v }))}
                onDone={(clonedId) => {
                  reloadFacts(clonedId)
                  // 克隆完成 ⇒ 下拉里要有刚克隆的那台：useEngineDirs 只在挂载时取一次，
                  // 不刷新的话第 2 步起逃生口里看不到刚克隆的引擎（状态一致性问题）。
                  reloadDirs()
                  // 不自动跳第 2 步：克隆完成后停在第 1 步，由第 1 步自己的「下一步」
                  // 按钮负责跳到「安装依赖」。克隆与跳转是两件事，自动跳会让使用者
                  // 来不及看到「已克隆」的确认，界面会与刚发生的操作脱节。
                }}
                onNext={() => setPage('env')}
                // 撤销克隆 ⇒ 目录没了 ⇒ 重新判完成状态（facts.prepare 变 false，
                // 「已克隆」区收起，回到命令区）。不跳页：第 1 步撤销后留在第 1 步重来。
                onUndone={(id) => reloadFacts(id)}
                prep={prep} onPrep={patchPrep} />
            )}
            {page === 'env' && (
              <StepDeps state={{ ...wz, manifest: manifest || {} }}
                prep={prep}
                onFixId={(id) => setWz((w) => (w.id === id ? w : { ...w, id }))}
                onReload={() => reloadFacts()}
                onUndone={() => {
                  // 撤销克隆 ⇒ 目录没了 ⇒ 回到第 1 步重来。
                  // 不写 wz.cloned：完成状态只由端点读盘判，持久段里没有它的位置。
                  reloadFacts()
                  setPage('prepare')
                }} />
            )}
            {page === 'models' && (
              <StepModels state={wz} onChange={reloadFacts}
                prep={prep}
                onFixId={(id) => setWz((w) => (w.id === id ? w : { ...w, id }))}
                probe={prep.probe || null} />
            )}
            {page === 'verify' && (
              <StepVerify id={wz.id} />
            )}
                </fieldset>
        </div>
      )}

      {/* ---- 收起态：点 Close 之后别是一片空白 ---- */}
      {!page && (
        <div className="node-detail">
          <div className="node-detail-hdr">
            <span className="node-detail-title">
              {t('Nothing open', '当前没有展开的步骤')}
            </span>
            <button className="btn btn-sm" type="button" onClick={() => setPage('prepare')}>
              {t('Open step 1', '打开第 1 步')}
            </button>
          </div>
          <p className="field-hint" style={{ margin: 0 }}>
            {t('Collapsed. Select a step above to continue configuring.',
              '已收起。选择上方任一步骤即可继续配置。')}
          </p>
        </div>
      )}
      </div>
      )}
    </div>
  )
}
