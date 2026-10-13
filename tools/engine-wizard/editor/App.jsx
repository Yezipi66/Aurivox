import React from 'react'
import Pipeline from './Pipeline'
import ManifestPage from './ManifestPage'
import StepPrepare from './StepPrepare'
import StepDeps from './StepDeps'
import { StepModels } from './StepsExtra'
import { StepVerify } from './StepVerify'
import { STEPS, stepDone } from './steps'
import { useT, LangToggle } from '../../../web/src/lib/i18n'
// ⭐ 2026-10-12 Owner 裁决「统一重构持久化」：向导的持久化收敛到这一个模块。
//   · 持久段（localStorage）= 用户输入与选择 + 当前展开哪一步
//   · 会话段（sessionStorage）= 探测结果与各步瞬态（键含 id 与 url）
//   ⛔ 完成状态（对勾）一段都不存：它由 GET /wizard/install-state 按真实产物判。
import { loadPersist, savePersist, loadPage, savePage,
  loadSession, saveSession, purgeOrphanKeys } from './useInstallSession'

// ============================================================================
//  向导骨架 —— 层级照 web/src/components/train/TrainingTab.jsx 的 renderNodeDetail()
//
//  ⛔ 「展开」⛔ 不等于「五步同时渲染」：只渲染page 指向的那一步。
//    之前那版用条件渲染 + 右下角「下一步」，两处同时出问题：
//    ① 两套导航互相打架 —— 卡片管跳转、下一步管推进，而「下一步」
//       只在第 1 步存在，第 2~5 步一个都没有。
//    ② 条件渲染让组件卸载 ⇒ 挂在里面的局部 state 一次导航就归零。
//  ✅ 现在：流程条是唯一导航。点一下展开那一步，再点收起。
//     ⛔ 不实现「下一步」—— 流程条之外的第二条导航路径一律不加。
//  ⭐ 第 1 步自己的内容全部铺开：「展开」说的是这一步内部不许再套盒子，
//    不是五步同时挂在屏幕上。
//
//  ⭐ 所有类都借自web/src/styles.css，本文件不定义任何容器：
//    .workspace-container  居中容器 max-width:1400px
//    .section / .section-hdr      顶栏
//    .pipe-map / -step / -dot / -label / -seg  流程条
//    .node-detail / -hdr / -title选中步骤的详情框
//    .btn / .btn-sm / .badge / .field-hint        控件
//
//  ⛔ 本文件不许出现任何具体引擎名。
// ============================================================================

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

  // ---- 名片：**唯一真相**是 manifest ----
  // ⭐ 为什么不能再让 text 和 manifest 双向同步（A4 竞态）：
  //   旧写法有两处写同一个 state：① text 防抖 300ms 后 setManifest；
  //   ② onManifest 里 setManifest + setText。切 Form/JSON 视图时，
  //   text 停在旧值把 manifest 冲掉，用户刚填的内容就丢了。
  // ✅ 现在：manifest 是唯一真相，text 只在 JSON 视图里当**编辑缓冲**，
  //   且只走 text→manifest 一个方向（单向，⛔ 不写回 text ⇒ 不会循环）。
  const [manifest, setManifest] = React.useState(null)
  // ⭐ text 的初值故意是 null：null = 「还没进过 JSON 视图」。
  //   这样切到 JSON 时能分辨「用户没编辑过」（用 manifest 现算）
  //   和「用户编过」（保留缓冲）。⛔ 用一个字符串占位不行，
  //   那个占位符会被当成用户输入写回 manifest。
  const [text, setText] = React.useState(null)
  const [err, setErr] = React.useState(null)

  // ---- JSON 逃生口：**只** text → manifest，300ms 防抖 ----
  // ⛔ 这里绝不 setText —— manifest 变了也不回写 text，
  //   否则用户正在编辑的 JSON 会被半途替换。
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
    // ⭐ 空名片（还没开始建，比如没有 id）不校验 —— 刚点进来就对着一张
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

  // ---- 向导状态：**必须**活在 App 这一层
  //   ⛔ 不许下沉到各Step 组件的局部 state —— 组件卸载即状态归零，
  //     而卸载是导航的正常结果。判据：导航往返后克隆区仍在。
  //
  //  ⭐ 2026-10-12 拆两段（Owner 裁决「统一重构持久化」）：
  //    wz     = 持久段（localStorage）：用户输入与选择，⛔ 不放探测结果
  //    prep   = 会话段（sessionStorage）：探测结果 res/probe/plan/cloneRes
  //            键含 id 与 url ⇒ 换 URL 或换引擎 ⇒ 旧的自动失效（防串号）
  const [wz, setWzRaw] = React.useState(loadPersist)
  const persistedUrl = wz.repoUrl || wz.url || ''
  // 会话段只在「id + url 都定了」之后才有意义 —— 都是空的时候读出来也是空。
  const [prep, setPrep] = React.useState(() => loadSession(wz.id, persistedUrl) || {})

  // 写持久段（⛔ 只写用户输入与选择；探测结果走 saveSession）
  const setWz = (updater) => setWzRaw((cur) => {
    const next = typeof updater === 'function' ? updater(cur) : updater
    savePersist(next)
    return next
  })

  // ⭐ 换 URL / 换引擎 ⇒ 会话段的键变了 ⇒ 必须整段丢掉，⛔ 不许把上一个
  //   仓库的探测结果显示给这一个（真机踩过的串号）。判据：URL 一变就清空。
  const lastStamp = React.useRef(null)
  React.useEffect(() => {
    const stamp = String(wz.id || '') + '|' + persistedUrl
    const first = lastStamp.current === null
    lastStamp.current = stamp
    // 首帧：useState 初始值已经读过正确的会话段，⛔ 不要再覆盖一次
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

  // ---- ⭐ 完成状态：**只由真实产物判**（GET /wizard/install-state）
  //   ⛔ 不读 localStorage 里的 facts —— 那些一刷新就没了，而且「点过什么」
  //      不等于「装好了」。判据见 core/installState.js 与 steps.js 的 stepDone。
  const [facts, setFacts] = React.useState({})
  const reloadFacts = React.useCallback(() => {
    if (!wz.id) { setFacts({}); return }
    let alive = true
    fetch(`/wizard/install-state?id=${encodeURIComponent(wz.id)}`)
      .then((r) => r.json())
      .then((j) => { if (alive && j && j.ok && j.steps_done) setFacts(j.steps_done) })
      .catch(() => { /* 端点调不通 ⇒ 一个勾都没有，⛔ 不猜 */ })
    return () => { alive = false }
  }, [wz.id])
  React.useEffect(reloadFacts, [reloadFacts])

  // 老的 addFacts 两类用法分开：
  //   · 克隆成功 —— 产物此刻真在盘上，本地即时反馈
  //   · 名片保存成功 —— 重新问端点，⛔ 不让前端自己写「做完了」
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

  // ⭐ 孤儿键一次性清理（Owner 浏览器里有 tf.v1.wizard.repo，代码里没人读）
  //   读一次就删，⛔ 不留长期清理代码。
  React.useEffect(() => { purgeOrphanKeys() }, [])

  // ⭐ 门槛说明的显隐（克隆未完成时点了第 2~5 步 ⇒ 说明为什么点不开）
  const [gateMsg, setGateMsg] = React.useState(false)

  const step = STEPS.find((x) => x.key === page)
  const title = step ? (lang === 'zh' ? step.label[1] : step.label[0]) : ''
  // 完成状态由真实产物判定（steps.js 的 stepDone），⛔ 不看用户点过什么
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

      {/* ---- 流程条：点一下展开那一步，再点收起 ---- */}
      <Pipeline done={done} selected={page}
        onSelect={(k, locked) => {
          // ⭐ 门槛：克隆未完成时后面四步不可点，点给人话说明
          //   ⛔ 不是点进去一片空（Owner 2026-10-12 裁决）
          if (locked && k !== page) { setGateMsg(true); return }
          setGateMsg(false)
          setPage((cur) => (cur === k ? null : k))
        }} />

      {/* ---- 门槛说明：为什么现在点不开第 2~5 步 ---- */}
      {gateMsg && page !== 'prepare' && (
        <div className="msg msg-info">
          {t('The repository is not cloned yet. Finish step 1 to continue: '
            + 'the remaining steps work on the cloned engine directory.',
            '仓库尚未克隆完成。请先完成第 1 步，后续步骤都在克隆下来的引擎目录上进行。')}
        </div>
      )}

      {/* ---- 展开的那一步：项目的 .node-detail 详情框 -------------
          ⭐ 外壳照抄 TrainingTab.jsx:2338-2350 的 renderNodeDetail()：
            .node-detail > .node-detail-hdr(.node-detail-title + 徽标/按钮) > fieldset
          ⭐ 状态徽标用项目的 .badge。⛔ 不再套任何自造的容器。*/}
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
                // ⛔ 只 setManifest，⛔ 绝不 setText —— 那正是 A4 的竞态来源：
                //   表单改一次就写回 text，切到 JSON 视图时旧 text 又把
                //   manifest 冲掉。text 只在切视图时由 ManifestPage 现算。
                onManifest={(m) => { setManifest(m); setErr(null) }}
                diag={vresult} loading={vloading}
                onSaved={() => addFacts({ manifestSaved: true })} />
            )}
            {page === 'verify' && (
              // ⛔ 不传 state/onChange：第 5 步尚未实现，
              //   且⛔ 不上报 verified（旧实现会一进入就自动跑校验并置
              //   verified=true，而 stepDone 判的就是它 ⇒ 这一步凭空变成对勾）。
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
