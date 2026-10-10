import React from 'react'
import Pipeline from './Pipeline'
import ManifestPage from './ManifestPage'
import StepPrepare from './StepPrepare'
import StepDeps from './StepDeps'
import { StepModels } from './StepsExtra'
import { StepVerify } from './StepVerify'
import { STEPS, stepDone } from './steps'
import { useT, LangToggle } from '../../../web/src/lib/i18n'
// ⚠ 这里**只**给「当前打开的是哪一步」用持久化（page）。
//   ⛔ 链接、目录名、解析结果一律**不持久化** —— 残留的旧目录名
//     会派生出对不上的命令和路径。
import { usePersistentState } from '../../../web/src/usePersistentState'

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
  const [wz, setWz] = usePersistentState('wizard.wz',
    { url: '', id: '', cloneUrl: '', repoUrl: '' }, {
      rehydrate: (v) => ({ url: '', id: '', cloneUrl: '', repoUrl: '', ...v }),
    })
  const [facts, setFacts] = React.useState({})
  const [prep, setPrep] = React.useState({})

  const addFacts = (patch) => setFacts((f) => ({ ...f, ...patch }))
  const done = Object.fromEntries(
    STEPS.map((st) => [st.key, stepDone(st.key, facts)]))

  // 当前展开的是哪一步。⛔ 全部向导状态只有 page 持久化：
  //   链接、目录名、解析结果一律不持久化 —— 残留的旧目录名会派生出
  //   对不上的命令和路径。
  const [page, setPage] = usePersistentState('wizard.step', 'prepare')

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
        onSelect={(k) => setPage((cur) => (cur === k ? null : k))} />

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
                prep={prep} onPrep={setPrep} />
            )}
            {page === 'env' && (
              <StepDeps state={{ ...wz, manifest: manifest || {} }} />
            )}
            {page === 'models' && (
              <StepModels state={wz} onChange={addFacts}
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
