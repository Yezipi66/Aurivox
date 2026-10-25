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

// 向导骨架照 web/src/components/train/TrainingTab.jsx 的 renderNodeDetail()：
//   只渲染 page 指向的那一步；流程条是唯一导航。
//  「展开」指该步骤内部不再套盒子，不是五步同时渲染。
//   所有类都借自 web/src/styles.css，不在这里定义任何容器。

/**
 * 问完成状态时该用哪个引擎 id。
 *
 * 克隆刚完成时 `wz.id` 的 setState 还没生效，此刻读闭包里的 `wz.id`
 * 拿到的是**上一个渲染的旧值**（刚进向导时是空）⇒ 请求会带空 id，
 * 后端返回空结果 ⇒ 流程条一个勾都不亮。
 *
 * 所以调用方把「刚克隆用的那个 id」显式传进来，优先用它。
 *
 * @param {string} idArg 调用方传的 id（刚克隆完时传它）
 * @param {string} stateId 当前 state 里的 id
 * @returns {string|null} 要用的 id；两个都没有则 null
 */
function factsQueryId (idArg, stateId) {
  return idArg || stateId || null
}

export { factsQueryId }

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
  // 权重落盘的相对路径（相对项目根）。第 3 步写盘到这里，第 4 步的名片
  //   runtime.checkpoints 填的也是这个值：两处同源，改一处不会出现「下好了却找不到」。
  //   路径由后端算（core/checkpointsPath.js），前端不自己拼。
  const [checkpointsPath, setCheckpointsPath] = React.useState(null)
  // id 可由调用方传入：刚克隆完时 wz.id 的 setState 还没生效，
  //   读闭包里的旧值会拿到空 id，一个勾都不亮。
  const reloadFacts = React.useCallback((idArg) => {
    const id = factsQueryId(idArg, wz.id)
    if (!id) { setFacts({}); setCheckpointsPath(null); return }
    let alive = true
    fetch(`/wizard/install-state?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        if (j && j.ok && j.steps_done) setFacts(j.steps_done)
        setCheckpointsPath((j && j.checkpoints_path) || null)
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
    if (!manifestEngineId) { setCheckpointsPath(null); return }
    let alive = true
    fetch(`/wizard/install-state?id=${encodeURIComponent(manifestEngineId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        setCheckpointsPath((j && j.checkpoints_path) || null)
      })
      .catch(() => { if (alive) setCheckpointsPath(null) })
    return () => { alive = false }
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

  const [gateMsg, setGateMsg] = React.useState(false)

  const step = STEPS.find((x) => x.key === page)
  const title = step ? (lang === 'zh' ? step.label[1] : step.label[0]) : ''
  // 完成状态由真实产物判定（steps.js 的 stepDone），不看用户点过什么
  const isDone = !!step && done[step.key]

  return (
    <div className="wz-root workspace-container">

      {/* ---- 顶栏：项目的 section 三件套（照 TrainingTab 的骨架）---- */}
      <div className="section">
        <div className="section-hdr">
          <h2>{t('Engine Wizard', '安装向导')}</h2>
          <LangToggle />
        </div>
      </div>

      {/* ---- 流程条 ---- */}
      <Pipeline done={done} selected={page}
        onSelect={(k, locked) => {
          // 克隆未完成时后面四步不可点。
          if (locked && k !== page) { setGateMsg(true); return }
          setGateMsg(false)
          setPage((cur) => (cur === k ? null : k))
        }} />

      {/* ---- 门槛说明 ---- */}
      {gateMsg && page !== 'prepare' && (
        <div className="msg msg-info">
          {t('The repository is not cloned yet. Finish step 1 to continue: '
            + 'the remaining steps work on the cloned engine directory.',
            '仓库尚未克隆完成。请先完成第 1 步，后续步骤都在克隆下来的引擎目录上进行。')}
        </div>
      )}

      {/* ---- 展开的那一步：.node-detail 详情框，外壳照 NodeDetailPanel.jsx 的 NodeDetailPanel() ---- */}
      {page && (
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

          <fieldset style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
            {page === 'prepare' && (
              <StepPrepare state={wz} facts={facts}
                onChange={(v) => setWz((w) => ({ ...w, ...v }))}
                onDone={(clonedId) => {
                  reloadFacts(clonedId)
                  // 克隆完成 ⇒ 直接进第 2 步：使用者刚做完的事就是下一步要做的事，
                  // 让他自己再点一次流程条上的「安装依赖」是多余的。
                  setPage('env')
                }}
                prep={prep} onPrep={patchPrep} />
            )}
            {page === 'env' && (
              <StepDeps state={{ ...wz, manifest: manifest || {} }}
                prep={prep}
                onFixId={(id) => setWz((w) => (w.id === id ? w : { ...w, id }))}
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
            {page === 'manifest' && (
              <ManifestPage manifest={manifest} spec={spec}
                text={text} err={err} setText={setText}
                // 只 setManifest，绝不 setText：manifest 是唯一真相，text 由它派生；两边互相回写会出竞态。
                onManifest={(m) => { setManifest(m); setErr(null) }}
                diag={vresult} loading={vloading}
                onSaved={reloadFacts}
                checkpointsPath={checkpointsPath} />
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
  )
}
