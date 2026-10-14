import React from 'react'
import Pipeline from './Pipeline'
import ManifestPage from './ManifestPage'
import StepPrepare from './StepPrepare'
import StepDeps from './StepDeps'
import { StepModels } from './StepsExtra'
import { StepVerify } from './StepVerify'
import { STEPS, stepDone } from './steps'
import { useT, LangToggle } from '../../../web/src/lib/i18n'
// 向导持久化收敛到本模块：持久段（localStorage）= 用户输入与选择 + 展开步骤；
//   会话段（sessionStorage）= 探测结果；完成状态由 GET /wizard/install-state 判定。
import { loadPersist, savePersist, loadPage, savePage,
  loadSession, saveSession, purgeOrphanKeys } from './useInstallSession'

// 向导骨架照 web/src/components/train/TrainingTab.jsx 的 renderNodeDetail()：
//   只渲染 page 指向的那一步；流程条是唯一导航。
//  「展开」指该步骤内部不再套盒子，不是五步同时渲染。
//   所有类都借自 web/src/styles.css，本文件不定义任何容器。

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
  const reloadFacts = React.useCallback(() => {
    if (!wz.id) { setFacts({}); return }
    let alive = true
    fetch(`/wizard/install-state?id=${encodeURIComponent(wz.id)}`)
      .then((r) => r.json())
      .then((j) => { if (alive && j && j.ok && j.steps_done) setFacts(j.steps_done) })
      .catch(() => { /* 端点调不通 ⇒ 一个勾都没有，不猜 */ })
    return () => { alive = false }
  }, [wz.id])
  React.useEffect(reloadFacts, [reloadFacts])

  // 克隆成功：本地即时反馈；名片保存成功：重新问端点。
  const addFacts = (patch) => {
    if (!patch || typeof patch !== 'object') return
    if (patch.cloned === true) { setFacts((f) => ({ ...f, cloned: true })); return }
    if (patch.manifestSaved === true) reloadFacts()
  }

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

      {/* ---- 展开的那一步：.node-detail 详情框，外壳照 TrainingTab.jsx:2338-2350 ---- */}
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
                onDone={() => addFacts({ cloned: true })}
                prep={prep} onPrep={patchPrep} />
            )}
            {page === 'env' && (
              <StepDeps state={{ ...wz, manifest: manifest || {} }}
                prep={prep}
                onFixId={(id) => setWz((w) => (w.id === id ? w : { ...w, id }))} />
            )}
            {page === 'models' && (
              <StepModels state={wz} onChange={addFacts}
                prep={prep}
                onFixId={(id) => setWz((w) => (w.id === id ? w : { ...w, id }))}
                probe={prep.probe || null} />
            )}
            {page === 'manifest' && (
              <ManifestPage manifest={manifest} spec={spec}
                text={text} err={err} setText={setText}
                // 只 setManifest，绝不 setText（A4 竞态来源）。
                onManifest={(m) => { setManifest(m); setErr(null) }}
                diag={vresult} loading={vloading}
                onSaved={() => addFacts({ manifestSaved: true })} />
            )}
            {page === 'verify' && (
              // 不传 state/onChange：第 5 步尚未实现，且不上报 verified。
              <StepVerify />
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
