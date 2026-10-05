import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { RiskUnlock } from './Pipeline'

// ============================================================================
//  STEP PREPARE —— 第 1 步：链接 → 探测 → 克隆
// ============================================================================

/**
 * ⭐ 从链接里猜项目名 —— 目录名留空时用它做灰字预览。
 *
 * ⛔⛔ **必须是仓库根的最后一段**：
 *   别人常复制 https://github.com/o/r/tree/main 这样的链接 ——
 *   所以只取 github.com 后面的 owner/repo 两段里的第二段。
 *   ⛔ 这只用于填空时的预览；真 id 永远来自 resolve 端点（它有完整校验）。
 */
/**
 * 后端错误的**双语文案表** —— 键名 = 后端的 code。
 *
 * ⛔ 文案只说三件事：缺什么、正确的样子是什么、下一步做什么。
 *   ⛔ 不解释平台的设计原则（「只认 GitHub」「平台不替你猜」）——
 *     那是内部规则，用户要的是「这个框该怎么填」。
 *   ⛔ 不出现内部路径（registry.js:83 / docs/ROOT_LAYOUT.md 之类）。
 * ⛔ 文案住前端，不住后端：core/resolve.js 只回 { code, params }。
 *   否则切到英文时后端仍是中文句子，而 {res.error} 会原样渲染。
 *   判据：新增错误时先在 core 放 code，再来这里加两行。
 */
const ERR_TEXT = {
  // 不是错误，是「我们把你的链接改了」的告知
  TRIMMED_TAIL: [
    'The link ended in "/{tail}". Only the repository root is used.',
    '已去除链接末尾的 “/{tail}”，改用仓库根地址。'],
  EMPTY_LINK: [
    'No link yet.', '尚未填写链接。'],
  NO_OWNER: [
    'Missing the repository name. A link looks like github.com/owner/name.',
    '缺少仓库名。链接格式为 github.com/用户名/仓库名。'],
  NOT_GITHUB: [
    'Only GitHub links are supported. {host} cannot be cloned here. Paste the GitHub address instead.',
    '仅支持 GitHub 链接，{host} 无法克隆。请改用 GitHub 仓库地址。'],
  NO_REPO: [
    'Missing the repository name. "{owner}" is the account; the link needs github.com/owner/name.',
    '缺少仓库名。"{owner}" 为用户名，链接格式为 github.com/用户名/仓库名。'],
  UNKNOWN_TAIL: [
    'Cannot read "{tail}" in this link. Paste the repository home page.',
    '无法识别链接中的 "{tail}"。请粘贴仓库首页地址。'],
  EMPTY: [
    'The folder name cannot be empty.', '目录名不能为空。'],
  WHITESPACE: [
    'The folder name has leading or trailing spaces. It must match the folder exactly.',
    '目录名前后含有空格，必须与文件夹名完全一致。'],
  RESERVED_PREFIX: [
    'The folder name cannot start with "{prefix}".', '目录名不能以 "{prefix}" 开头。'],
  ILLEGAL_CHAR: [
    'The folder name contains characters a folder name cannot hold: {chars}',
    '目录名含有不能放进文件夹名的字符：{chars}'],
  RESERVED_NAME: [
    '"{name}" is reserved by the platform — pick another name.',
    '"{name}" 是平台保留的目录名，换一个。'],
}

/** 取后端错误的文案。查不到就退回它自带的 error（兜底，不是常规路径）。 */
function errText (res, t) {
  if (!res) return ''
  const row = ERR_TEXT[res.code]
  if (!row) return res.error || ''
  const pr = res.params || {}
  return t(row[0], row[1]).replace(/\{(\w+)\}/g, (m, k) => (pr[k] != null ? pr[k] : m))
}

function guessRepoFromUrl (raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const m = s.match(/github\.com\/[^/?#]+\/([^/?#]+)/i)
  if (m) return m[1].replace(/\.git$/i, '')
  const m2 = s.match(/^[\w.-]+\/([\w.-]+)$/)          // owner/repo
  return m2 ? m2[1] : ''
}

export default function StepPrepare ({ state, facts, onChange, onDone, prep, onPrep }) {
  const { t } = useT()
  const [url, setUrl] = React.useState(state.url || '')
  const [idInput, setIdInput] = React.useState(state.id || '')
  // ⭐ 这四份结果**住在 App 那层**（prep），⛔ 不是本组件的局部 state ——
  //   否则切走步骤再切回来就全没了（实测复现，见 App.jsx）。
  const res = prep.res || null
  const probe = prep.probe || null
  const plan = prep.plan || null
  const cloneRes = prep.cloneRes || null
  const [busy, setBusy] = React.useState('')
  const [unlocked, setUnlocked] = React.useState(false)

  // ⭐ 上次**解析成功**时链接框里是什么 —— 用来判「用户是不是改了链接」
  //   ⛔ 必须在 res 之后声明（写反了 ⇒ TDZ：Cannot access 'res'，整页白屏）
  const lastResolved = (res && res.input) || ''

  // ⚠⚠⚠ **只写一个 patch** —— setRes/setProbe/… 只是名字不同的同一入口。
  //   四个闭包拿的是**同一帧的 prep 快照** ⇒ 分开写会把前一个抹回 null
  //   （实测：probe 成功、res:null ⇒ 整块不渲染）。
  // ⛔ 原来写的是 `onPrep({ ...prep, [k]: v })` —— 闭包里的 prep
  //   是**这一帧的快照**，⛔ 同一帧里连续写两次（resolve 先写 res、
  //   探测再写 probe）后写的会把先写的覆盖掉（实测 probe 有、res 是 null）。
  // ✅ 函数式更新拿到的是最新值，⛔ 与帧无关。
  const patch = (k, v) => onPrep((w) => ({ ...w, [k]: v }))
  const setRes = (v) => patch('res', v)
  const setProbe = (v) => patch('probe', v)
  const setPlan = (v) => patch('plan', v)
  const setCloneRes = (v) => patch('cloneRes', v)

  const post = async (path_, body) => {
    const r = await fetch(path_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.json()
  }

  // ---- ① 解析（⛔ 本地，不联网）+ 紧接着只读探测 ----
  const resolve = async () => {
    setBusy('link')
    const j = await post('/wizard/resolve', { url, id: idInput || undefined })
    // ⛔ res 与 probe 一起写，一次到位（分两次写会让探测结果被覆盖）
    //   ⚠ 必须打 /wizard/probe —— 它返回 meta（包名/命令/依赖清单）；
    //     ⛔ /wizard/deps 返回的是 deps，没有 meta。
    let probeJ = null
    if (j.ok) {
      try { probeJ = await post('/wizard/probe', { url: j.url }) }
      catch (e) { /* 探测失败不阻断 —— 克隆那步照样能看 */ }
    }
    onPrep((w) => ({ ...w, res: { ...j, input: url }, probe: probeJ }))
    if (j.ok) {
      // ⭐ 用户没自己填目录名 ⇒ 用解析出来的（别覆盖成空）
      if (!idInput.trim()) setIdInput(j.id)
      onChange({ url, id: (idInput.trim() || j.id), repoUrl: j.url, cloneUrl: j.cloneUrl })
    }
    setBusy('')
  }

  // ---- ② 探测（⛔ 只读，不写盘）----
  const doProbe = async () => {
    setBusy('probe'); setProbe(null)
    const j = await post('/wizard/probe',
      { url: state.repoUrl || (res && res.url) || url })
    setProbe(j)
    setBusy('')
  }

  // ---- ③ 克隆（⚠ 这一步才写盘）----
  const doClone = async (execute) => {
    setBusy('clone'); setCloneRes(null)
    try {
      // ⚠ cloneUrl ⛔ 同时从两处取：父组件的 wz 和本组件的解析结果 res。
      //   只读 props 的话，解析刚完成时那一帧拿到的还是空的
      //   （实测：计划里出现 `git clone ''`）。
      const cloneUrl = (res && res.cloneUrl) || state.cloneUrl
      const j = await post('/wizard/clone', {
        id: idInput || state.id, cloneUrl, execute,
      })
      if (j.ok && j.steps) setPlan(j)
      setCloneRes(j)
      if (j.ok && execute) { onChange({ cloned: true }); onDone && onDone() }
    } finally { setBusy('') }
  }

  // ⭐ 不填目录名时的默认值 = 仓库根链接的最后一段
  const autoId = (res && res.ok && res.repo) || guessRepoFromUrl(url)
  // ⭐⭐⭐ 目标目录由**后端**给（resolve 返回的 targetDir）
  //
  // ⛔⛔ 前端曾经自己拼：window.location.pathname 撕 + 硬编码 '/' 分隔符。
  //   ⛔ 硬编码 '/' **只在 Linux/mac 上成立**，Windows 上路径是反斜杠 ⇒ 拼出来是错的
  //   ⛔ 打包分发后目录可能被挪走（lib/paths.js 支持 AURIVOX_APP_DIR 覆盖），
  //      前端永远算不对，只有后端算得对
  // ⛔ 最根本：前端不该知道文件系统长什么样
  // ⛔ 拿不到就退回相对路径 —— ⛔ 绝不显示成空的或假的绝对路径
  //
  // ⛔ 命令与目标路径**必须同源**，否则两者会自相矛盾。
  //   两个曾经出错的形状：
  //   ① 用一次解析的快照 —— 用户改目录名时命令跟着变、文案停在旧值，
  //      界面上同时出现新旧两个目录名。
  //   ② 拿不到时回落成相对路径 ⇒ 那句「目标：」里的路径凭空消失。
  // ✅ 目标路径实时算：后端给 enginesDir（绝对）+ pathSep（该平台的分隔符），
  //   前端只 + 目录名 ⇒ 与输入框永远同值、永远同步、没有空档期。
  //   ⛔ 拿不到 enginesDir ⇒ ⛔ 不显示路径（宁可不显示，不显示错的）。
  //   ⛔ 分隔符由后端给：Windows 是 \、Linux/macOS 是 / —— ⛔ 前端不猜。
  //   判据：改目录名时，命令与目标路径必须一起变。
  const curId = (idInput || autoId || '').trim()
  const enginesDir = (res && res.enginesDir) || null
  const pathSep = (res && res.pathSep) || null
  const relEngineDir = `engines/${curId}/`
  const fullEngineDir = (enginesDir && pathSep && curId)
    ? enginesDir + pathSep + curId
    : null

const done = facts && facts.cloned === true
  const meta = (probe && probe.meta) || null

  return (
    /* ⭐⭐⭐ **第一步全部铺开** —— 一个连续区域，从上到下直接排。
       ⛔ 外层这行内联样式就是 TrainingTab.jsx:2355 的原话：
         display:flex / flexDirection:column / gap:8
       ⛔ 不再套 .preflight、不再套 .form-narrow、不再套任何盒子。 */
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* ── 两个输入框，一行 ─────────────────────────────
          ⭐ 目录名留空 = 自动取**仓库根**最后一段（tree/main 会被剥掉）
          ⭐ 解析跟着失焦 / 回车自动跑，⛔ 不需要「下一步」*/}
      <div className="form-grid">
        <div className="field">
          <label className="field-label" htmlFor="wz-repo-url">
            {t('GitHub link', 'GitHub 项目链接')}
          </label>
          <input id="wz-repo-url" className="control" type="text" value={url}
            placeholder="https://github.com/owner/name"
            onChange={(e) => {
              setUrl(e.target.value)
              // ⛔ 只在**真的变了**时才清结果；
              //   ⛔⛔ 只清这四个键，别整体替换 prep（会把别的键一起抹掉）
              if (e.target.value !== lastResolved) {
                onPrep((w) => ({ ...w, res: null, probe: null, plan: null, cloneRes: null }))
              }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !res) resolve() }}
            onBlur={() => { if (url.trim() && !res) resolve() }} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="wz-engine-id">
            {t('Folder name', '目录名')}
          </label>
          <input id="wz-engine-id" className="control" type="text"
            value={idInput} placeholder={autoId || 'auto'}
            onChange={(e) => setIdInput(e.target.value)} />
          {/* ⛔ 去掉这里的 engines/<name>/ 预览。
              ⛔ 目录名下面已经有一行说明在讲「目录名就是名片里的 id」，
                 再挂一个路径预览是**同一件事说两遍**，而且
                 「目标 / 命令」那行会把真实的完整命令给出（更准）。
                 ⇒ 那个路径信息在这一步**一次都不该出现两次**。 */}
        </div>
      </div>

      <p className="field-hint" style={{ margin: 0 }}>
        {t('Paste the repository root link — a link to a file or folder inside it '
          + 'is rejected. The directory name is what the manifest id must match '
          + 'word for word, so changing it later means renaming the folder.',
          '请粘贴仓库根地址，指向仓库内文件或目录的地址无效。'
          + '目录名必须与 Manifest 的 id 完全一致。')}
      </p>

      {busy === 'link' && (
        <p className="field-hint" style={{ margin: 0 }}>{t('Reading…', '正在读…')}</p>
      )}

            {/* ⭐ 告知「我们把你的链接改了」—— ⛔ 不是错误，是修正
          （文案查表，不走后端的中文句子）*/}
      {res && res.ok && res.noteCode && (
        <p className="plan-warn" style={{ margin: 0 }}>
          {errText({ code: res.noteCode, params: res.noteParams }, t)}
        </p>
      )}

{res && !res.ok && (
        <div className="msg msg-danger">
          {errText(res, t)}
          {res.example && (
            <div className="field-hint">
              {t('Example:', '例如：')} <code>{res.example}</code>
            </div>
          )}
        </div>
      )}

      {/* ── 项目信息（⛔ 只读，不写盘）────────────────────────────
          ⛔ 标题用使用者的视角（「项目信息」），不用平台视角
            （「仓库自己声明了什么」讲的是上游，不是使用者要知道的）。
          ⛔ 这一块不摆命令：命令由下面的克隆步骤给出，那才是真命令。
          ⛔ 不解释平台为何不代选装法 —— 那是内部裁决，与使用者无关。
          ⛔ 不放「重读」按钮：解析跟着失焦自动跑，探测结果刷新页面就在。*/}
      {res && res.ok && (
        <>
          <div className="layer-label">{t('Project information', '项目信息')}</div>
          <div className="plan-kv">
            <span className="pk">{t('Package', '包名')}</span>
            <span className="pv">{(meta && meta.packageName) || '—'}</span>
            <span className="pk">{t('Dependency file', '依赖清单')}</span>
            <span className="pv">
              {(meta && meta.dependencies && meta.dependencies.note) || '—'}
            </span>
            <span className="pk">{t('Python', 'Python')}</span>
            <span className="pv">{(meta && meta.requiresPython) || '—'}</span>
            <span className="pk">{t('License', '许可证')}</span>
            <span className="pv">{(meta && meta.license) || '—'}</span>
          </div>
          {probe && probe.note && (
            <p className="plan-warn" style={{ margin: 0 }}>{probe.note}</p>
          )}
        </>
      )}

      {/* ── 下一步（⚠ 这一步才写盘）──────────────────────────────
          ⛔ 标题说「下一步会发生什么」，不说实现步骤（「克隆」）——
            使用者关心的是流程往前走，不是内部动作名。
          ⛔ 这里给**真正的 git clone 命令**，⛔ 不只显示 engines/<name>/
            这个目录名：只给目录名看不出要跑什么、也不知道会拉多少。
          ⛔ 不放「看计划」按钮：命令已经摆在上面，再点一次看同一份是多余的。
          判据：这一块里的命令必须与真正要跑的那条逐字相同。*/}
      {res && res.ok && (
        <>
          <div className="plan-kv">
            <span className="pk">{t('Command', '命令')}</span>
            <span className="pv">
              <code>
                {`git clone ${(res && res.cloneUrl) || ''} engines/${curId}`}
              </code>
            </span>
          </div>

          {/* ⭐ vars：把项目名和**完整路径**喂给风险文案
              （⛔ 原来只说「写进 engines/」，而那目录里已经有好几个引擎了，
                用户分不清这一步要动的是哪一个）*/}
          <RiskUnlock stepKey="prepare" unlocked={unlocked} onUnlock={setUnlocked}
            vars={{
              name: autoId || idInput || t('<name>', '<项目名>'),
              path: fullEngineDir || t('(computing…)', '（正在计算…）'),
            }}>
            <button className="btn btn-primary btn-sm" type="button"
              disabled={busy === 'clone'} onClick={() => doClone(true)}>
              {t('Next', '下一步')}
            </button>
          </RiskUnlock>

          {cloneRes && !cloneRes.ok && (
            <div className="msg msg-danger">{cloneRes.error}</div>
          )}
          {done && (
            <div className="msg msg-info">
              {t('Cloned into engines/' + (idInput || autoId) + '/.',
                '已克隆到 engines/' + (idInput || autoId) + '/。')}
            </div>
          )}
        </>
      )}
    </div>
  )
}
