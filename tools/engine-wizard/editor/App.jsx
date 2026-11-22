// 名片编辑器（引擎安装向导）的顶层组件：持有向导状态，只渲染 page 指向的那一步。
// manifest 是唯一真相，text 只在 JSON 视图当编辑缓冲（单向 text → manifest）；
// 完成状态由 GET /wizard/install-state 返回的真实产物判定，不读 localStorage。
import React from 'react'
import Pipeline from './Pipeline'
import Stage from './Stage'
import StepCard from './StepCard'
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
  // 切换目标引擎的唯一入口：2、3、4、5 步都走这一条，语义一致。
  //   只改 id 不够：App 级名片（第 4 步的编辑对象）不跟 wz.id 走，而
  //   manifestEngineId 优先取 manifest.id，换目标后第 4 步还会停在上一台，
  //   保存也写回上一台的目录。所以名片要一起换成新引擎的空壳。
  //   不在这里读盘上的名片：一台引擎只有一张名片，读它是使用者的动作，
  //   替他读掉等于把「读取 / 创建名片」这一步藏起来。
  //   text/err 同时归零：JSON 视图的编辑缓冲不清，旧名片会借防抖分支回来。
  const switchEngine = (nextId) => {
    if (!nextId || nextId === wz.id) return
    setWz((cur) => ({ ...cur, id: nextId }))
    setManifest((cur) => manifestForEngineSwitch(cur, nextId, nextId))
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

  // 写会话段。会话键是「目录名 + 地址」，而第 1 步在解析途中会把目录名从空变成真名：
  //   解析刚读出来的结果如果只按当前这一对写，就会写进一个随即被丢弃的键
  //   （现象是「读到了，紧接着又变回没读」，再点一次才正常）。
  //   所以写入方可以指定键；不指定时才用当前这一对。
  const patchPrep = (updater, key) => setPrep((cur) => {
    const next = typeof updater === 'function' ? updater(cur) : updater
    saveSession((key && key.id) || wz.id, (key && key.url) || persistedUrl, {
      res: next.res, probe: next.probe, plan: next.plan, cloneRes: next.cloneRes,
    })
    return next
  })

  // ---- 完成状态只由真实产物判（GET /wizard/install-state），不读 localStorage ----
  // 按引擎分开存：234 是三个独立的接入子，每台都有自己的完成状态。
  //   切回一台时立刻显示它自己那份，不拿上一台的快照顶上，也不等新请求回来。
  const [factsById, setFactsById] = React.useState({})
  const facts = factsById[wz.id] || {}
  // factsId 仍要传给第 1 步的 cloneDone 守卫：那份判据要求「问来的 id」与目录名同源。
  //   现在 map 的键就是来源 id，取当前引擎的键即是。
  const factsId = wz.id || null
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
    if (!id) { setCheckpointsPath(null); setModelFiles(null); return }
    let alive = true
    fetch(`/wizard/install-state?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        // 只写这一台的槽：另一台的完成状态不受影响，切回去时还在。
        if (j && j.ok && j.steps_done) {
          setFactsById((cur) => ({ ...cur, [id]: j.steps_done }))
        }
        setCheckpointsPath((j && j.checkpoints_path) || null)
        // 清单与「按哪个 id 问来的」一起存：换引擎时清掉 models 的那一个渲染
        //   会拿着上一台的清单，带着 id 才能被 shouldFillModelsRequired 挡住。
        setModelFiles({ id, files: Array.isArray(j && j.model_files) ? j.model_files : [] })
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
        setModelFiles({
          id: manifestEngineId,
          files: Array.isArray(j && j.model_files) ? j.model_files : [],
        })
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
        const files = Array.isArray(j && j.model_files) ? j.model_files : []
        // 与 reloadFacts 同形状：清单带 id，调用方仍拿数组本身。
        setModelFiles({ id, files })
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

  // 第 4、5 步各自持有 Stage，步骤大框要由它们自己渲染；这里把大框头需要的
  // 三件事按「固定那一步」算好传下去，不使用当前 page 的 title/isDone：
  //   四、五步常驻，切走时 page 会指向别的步骤，用当前值会让隐藏的框头跟着换标题。
  const frameOf = (key) => {
    const s = STEPS.find((x) => x.key === key)
    return {
      title: s ? (lang === 'zh' ? s.label[1] : s.label[0]) : '',
      done: !!done[key],
      onClose: () => setPage(null),
    }
  }

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

  // ---- 五步常驻，切页只换显隐，不卸载 ----
  // 条件渲染（page === 'env' && <StepDeps/>）在切走时会把整个子树卸载：
  //   组件内的进度、SSE 订阅、日志尾巴、滚动位置一起归零，回来只能靠
  //   「先写进会话段、挂载时再读回来」补，补不齐就是丢进度。
  // 改成首次进入才挂载、之后一直留着、非当前步 display:none：
  //   状态留在组件里，不需要任何一份快照与重连。
  // 挂载集合只增不减；切换引擎不是靠卸载，各组件自己的 [id] 依赖会重读。
  const [visited, setVisited] = React.useState(() => (page ? [page] : []))
  React.useEffect(() => {
    if (!page) return
    setVisited((cur) => (cur.includes(page) ? cur : [...cur, page]))
  }, [page])
  const mounted = (key) => visited.includes(key)
  // display:none 而不是不渲染：子树保留，定时器、SSE、输入框内容都还在。
  const shown = (key) => (page === key ? undefined : { display: 'none' })
  // 1、2、3 步共用同一个详情框（标题、逃生口、外框都是共用的），
  //   所以按「这三步是否有一个在用」决定整个框的显隐。
  const BASIC_KEYS = ['prepare', 'env', 'models']
  const basicMounted = BASIC_KEYS.some(mounted)
  const basicShown = BASIC_KEYS.includes(page) ? undefined : { display: 'none' }

  return (
    // 外层不套 .workspace-container：五步的内容区统一走全宽 Stage，
    //   中栏内容各自用 .wz-stage-main-inner 对齐 1400px 的大容器。
    //   顶栏与流程条仍留在共用的居中容器里。
    // 底部留白统一交给 .wz-stage-main 的内边距，不再按步分别挂：
    //   sticky 抽屉的可吸附范围不能被 stage 底部的额外留白截断。
    <div className="wz-root">
      {/* 断线提示的落点：占文档流，出现在页面最顶部；内容随它整体下移，互不遮盖。 */}
      <div id="wz-conn-slot" />
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
      {mounted('manifest') && (
        <div className="wz-manifest-shell" style={shown('manifest')}>
          <ManifestPage manifest={manifest} spec={spec} frame={frameOf('manifest')}
            text={text} err={err} setText={setText}
            // 只 setManifest，绝不 setText：manifest 是唯一真相，text 由它派生；两边互相回写会出竞态。
            onManifest={(m) => { setManifest(m); setErr(null) }}
            // 第 4 步的引擎下拉与逃生口走同一条切换：2 到 5 步语义一致。
            onPickEngineTarget={switchEngine}
            // 引擎清单五步共用 App 这一份：克隆、切换、保存后一次 reload 全线同步，
            //   不各自取一次导致「别处认得、这里认不得」。
            dirs={engineDirs} onDirsReload={reloadDirs}
            diag={vresult} loading={vloading}
            // 保存回调传的是保存结果对象，不是引擎 id。这里忽略它，按刚保存的那台重读；
            //   直接把对象交给 reloadFacts 会拿去查 install-state?id=%5Bobject%20Object%5D。
            onSaved={() => reloadFacts(manifestEngineId || wz.id)}
            checkpointsPath={checkpointsPath}
            modelFiles={modelFiles}
            onRefreshInstall={refreshInstall}
            engineState={engineState} />
        </div>
      )}

      {/* 第 5 步像第 4 步一样走独立全宽骨架：Stage 的抽屉是 100vh 的 sticky 边条，
          塞进 .node-detail 小卡片会撑破。逃生口移到中栏顶部，五步都能切引擎。 */}
      {mounted('verify') && (
        <div style={shown('verify')}>
          <StepVerify id={wz.id} frame={frameOf('verify')}
            escape={<EngineEscapeHatch id={wz.id} dirs={engineDirs}
              onSwitch={switchEngine} domId="wz-escape-pick-verify" />} />
        </div>
      )}

      {/* ---- 1、2、3 步与 4、5 步共用同一个 Stage 骨架 ----
          五步都是「页面 + 内容区」：顶栏与流程条在上，下面挂一个 Stage。
          1–3 步不挂左右抽屉（left/right 都不传），只留中栏，是一张单列表单；
          4 步挂满三栏，5 步只挂右抽屉。边条是按需挂的，不是某几步的专属结构。
          三步各自常驻，靠 shown/basicShown 换显隐，不卸载。 */}
      {basicMounted && (
      <div style={basicShown}>
      <Stage
        center={
          <div className="wz-stage-main-inner">
        <StepCard title={title} done={isDone} onClose={() => setPage(null)}>
          {/* ---- 每一步的逃生口 ----
              五步不再互相锁：锁的判据是「第 1 步完成」，而完成状态由真实产物判，
                它与界面上看到的不一致时人会被卡在第 1 步，且无从自救。
              改成每步在这里选「操作哪一台」：默认落在刚克隆的那台（wz.id），
                也可以直接挑 engines/ 下的任意目录。切换即全局重定向。
              第 1 步同样放一个：这一步也能复用 engines/ 下已有的目录。 */}
          <EngineEscapeHatch id={wz.id} dirs={engineDirs} onSwitch={switchEngine} />

          <fieldset style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
            <div style={shown('prepare')}>
              {mounted('prepare') && (<StepPrepare state={wz} facts={facts} factsId={factsId}
                engineDirs={engineDirs}
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
                prep={prep} onPrep={patchPrep} />)}
            </div>
            <div style={shown('env')}>
              {mounted('env') && (<StepDeps state={{ ...wz, manifest: manifest || {} }}
                prep={prep}
                onFixId={(id) => setWz((w) => (w.id === id ? w : { ...w, id }))}
                onReload={() => reloadFacts()}
                onUndone={() => {
                  // 撤销克隆 ⇒ 目录没了 ⇒ 回到第 1 步重来。
                  // 不写 wz.cloned：完成状态只由端点读盘判，持久段里没有它的位置。
                  reloadFacts()
                  setPage('prepare')
                }} />)}
            </div>
            <div style={shown('models')}>
              {mounted('models') && (<StepModels state={wz} onChange={reloadFacts}
                prep={prep}
                onFixId={(id) => setWz((w) => (w.id === id ? w : { ...w, id }))}
                weightsPath={facts.checkpoints_path}
                probe={prep.probe || null} />)}
            </div>
                </fieldset>
        </StepCard>
          </div>
        }
      />
      {/* ---- 右下角：当前操作的常驻状态 ----
          五步共用同一份事实（wz.id / page / done），切引擎之后不必猜
          「现在操作哪台、走到哪步、这一步做完了没有」。
          这里的「切换」是逃生口：焦点跳到本步顶部的引擎下拉。 */}
      {page && (
        <div role="status" aria-live="polite"
          style={{
            position: 'fixed', right: 'var(--sp-16)', bottom: 'var(--sp-12)',
            zIndex: 'var(--z-overlay)',
            display: 'flex', alignItems: 'center', gap: 'var(--sp-8)',
            flexWrap: 'wrap', maxWidth: 620,
            padding: 'var(--sp-6) var(--sp-10)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface)', border: '1px solid var(--border)',
            fontSize: 'var(--fs-12)', color: 'var(--text)',
          }}>
          <span className="field-hint" style={{ margin: 0 }}>
            {t('Working on', '正在操作')}
          </span>
          <code>{wz.id || t('no engine', '未选定')}</code>
          <span className="field-hint" style={{ margin: 0 }}>·</span>
          <span>{title}</span>
          <span className="field-hint" style={{ margin: 0 }}>·</span>
          <span>{isDone ? t('Done', '已完成') : t('In progress', '进行中')}</span>
          <button className="btn btn-sm" type="button"
            onClick={() => {
              const el = document.getElementById('wz-escape-pick')
              if (el) { el.focus(); el.scrollIntoView({ block: 'center' }) }
            }}>
            {t('Switch', '切换')}
          </button>
        </div>
      )}

      </div>
      )}

      {/* ---- 收起态：点 Close 之后别是一片空白；同样走 Stage 骨架 ---- */}
      {!page && (
        <Stage
          center={
            <div className="wz-stage-main-inner">
              <StepCard
                title={t('Nothing open', '当前没有展开的步骤')}
                action={
                  <button className="btn btn-sm" type="button" onClick={() => setPage('prepare')}>
                    {t('Open step 1', '打开第 1 步')}
                  </button>
                }>
                <p className="field-hint" style={{ margin: 0 }}>
                  {t('Collapsed. Select a step above to continue configuring.',
                    '已收起。选择上方任一步骤即可继续配置。')}
                </p>
              </StepCard>
            </div>
          }
        />
      )}
    </div>
  )
}
