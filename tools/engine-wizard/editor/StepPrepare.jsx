import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { RiskUnlock } from './Pipeline'
import { UndoClone } from './UndoClone'
// 目录名的唯一来源：输入框 + 仓库名。没有 state.id 这个来源。
import { folderName } from './folderName'

//  STEP PREPARE：第 1 步：链接 → 探测 → 克隆

/** 从链接里猜项目名：目录名留空时做灰字预览；真 id 永远来自 resolve 端点。 */
/** 后端错误的双语文案表：键名 = 后端 code；新增错误时先放 core，再来这里加两行。 */
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

/**
 * 许可证那一格：meta.license 是值字段（SPDX id 或 null）。
 * 读不出标识时用 licenseEvidence 事实字段说清楚，中文侧不许出现英文句子。
 */
function licenseText (meta, t) {
  if (!meta) return '—'
  if (meta.license) return meta.license
  if (meta.licenseEvidence === 'file-only' && meta.licenseFile) {
    return t(`License file ${meta.licenseFile} present, license type not read`,
      `仓库里有 ${meta.licenseFile} 文件，许可证类型未读出`)
  }
  return '—'
}

export default function StepPrepare ({ state, facts, onChange, onDone, prep, onPrep }) {
  const { t } = useT()
  const [url, setUrl] = React.useState(state.url || '')
  const [idInput, setIdInput] = React.useState(state.id || '')
  const res = prep.res || null
  const probe = prep.probe || null
  const plan = prep.plan || null
  const cloneRes = prep.cloneRes || null
  const [busy, setBusy] = React.useState('')
  const [unlocked, setUnlocked] = React.useState(false)

  // 上次解析成功时链接框里的值，用于判「用户是否改了链接」；必须在 res 之后声明（TDZ）。
  const lastResolved = (res && res.input) || ''

  // 只写一个 patch：函数式更新拿到最新值，分开写同一帧会互相覆盖。
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

  // 不填目录名时的默认值 = 仓库根链接的最后一段；没有 state.id 来源（旧 id 会造成双 id）。
  //   这一行同时喂给克隆请求 / 命令文案 / 目标路径 / 风险文案。
  const autoId = (res && res.ok && res.repo) || guessRepoFromUrl(url)
  const curId = folderName({ typed: idInput, suggested: autoId })

  // ---- ① 解析（本地，不联网）+ 紧接着只读探测 ----
  const resolve = async () => {
    setBusy('link')
    // 留空时后端的 id 参数故意不给，避免旧 id 顶上来找回上次引擎的目录名。
    const j = await post('/wizard/resolve', {
      url, id: (idInput.trim() || undefined),
    })
    // 必须打 /wizard/probe（返回 meta）；/wizard/deps 只返回 deps。
    let probeJ = null
    if (j.ok) {
      try { probeJ = await post('/wizard/probe', { url: j.url }) }
      catch (e) { /* 探测失败不阻断：克隆那步照样能看 */ }
    }
    const resolvedName = j.ok ? folderName({ typed: idInput, suggested: j.id }) : ''
    onPrep((w) => ({ ...w, res: { ...j, input: url }, probe: probeJ }))
    if (j.ok) {
      if (!idInput.trim()) setIdInput(j.id)
      onChange({ url, id: resolvedName, repoUrl: j.url, cloneUrl: j.cloneUrl })
    }
    setBusy('')
  }

  // ---- ② 探测（只读，不写盘）----
  const doProbe = async () => {
    setBusy('probe'); setProbe(null)
    const j = await post('/wizard/probe',
      { url: state.repoUrl || (res && res.url) || url })
    setProbe(j)
    setBusy('')
  }

  // ---- ③ 克隆（这一步才写盘）----
  // curId 是唯一的 id 来源；旧写法 `id: idInput || state.id` 会让输入框空时退化到旧 id。
  const doClone = async (execute) => {
    setBusy('clone'); setCloneRes(null)
    // 目录名为空 ⇒ 当场拦下，否则只会看到 Node 内核报错而非「请填写目录名」。
    if (!curId) {
      setCloneRes({ ok: false, code: 'MISSING_ID',
        error: t('Fill in the directory name first.',
          '请先填写目录名。'),
        errorZh: '请先填写目录名：它会成为 engines/ 下的文件夹名。' })
      setBusy('')
      return
    }
    try {
      // cloneUrl 同时从 res 和 state 取，只读 props 会在解析刚完成时拿到空值。
      const cloneUrl = (res && res.cloneUrl) || state.cloneUrl
      // 与文案/只读预览同一个 curId：后端按它算 engines/<id>，
      //   前端不另拼一份。
      const j = await post('/wizard/clone', { id: curId, cloneUrl, execute })
      if (j.ok && j.steps) setPlan(j)
      setCloneRes(j)
      if (j.ok && execute) {
        // 克隆成功时写回 id，否则用户改过目录名后第 2/3 步会拿到旧 id。
        onChange({ cloned: true, id: curId })
        onDone && onDone()
      }
    } finally { setBusy('') }
  }

  // ---- ④ 目标目录已存在 ⇒ 提供清除选项 ----
  // 后端拒绝往非空目录里克隆（git 的规矩），但拒绝不等于没有出路：
  //   给出「清除并重试」，使用者点一下就能重来，不用自己去文件系统里删。
  const dirNotEmpty = !!(cloneRes && !cloneRes.ok && cloneRes.code === 'DIR_NOT_EMPTY')
  const [removing, setRemoving] = React.useState(false)
  const removeDir = async () => {
    setRemoving(true)
    try {
      const j = await post('/wizard/clone/remove', { id: curId })
      if (j.ok) {
        // 目录清掉了 ⇒ 之前的失败结果作废，重新解析一遍拿到新状态。
        setCloneRes(null)
        onPrep((w) => ({ ...w, cloneRes: null }))
        if (res && res.ok) await resolve()
      } else {
        setCloneRes({ ok: false, code: j.code || 'REMOVE_FAILED', error: j.error || j.errorZh })
      }
    } catch (e) {
      setCloneRes({ ok: false, code: 'REMOVE_FAILED', error: (e && e.message) || String(e) })
    } finally { setRemoving(false) }
  }

  // 目标目录由后端给（enginesDir + pathSep），前端不猜文件系统路径。
  // 拿不到 enginesDir ⇒ 不显示路径，绝不显示空的或假的绝对路径。
  // 命令与目标路径同源：改目录名时两者必须一起变。
  const enginesDir = (res && res.enginesDir) || null
  const pathSep = (res && res.pathSep) || null
  const relEngineDir = `engines/${curId}/`
  const fullEngineDir = (enginesDir && pathSep && curId)
    ? enginesDir + pathSep + curId
    : null

const done = facts && facts.cloned === true
  const meta = (probe && probe.meta) || null

  return (
    /* 第一步全部铺开：一个连续区域，从上到下直接排。
       外层这行内联样式就是 TrainingTab.jsx:2355 的原话：
         display:flex / flexDirection:column / gap:8
       不再套 .preflight、不再套 .form-narrow、不再套任何盒子。 */
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* ── 两个输入框，一行 ─────────────────────────────
          目录名留空 = 自动取仓库根最后一段（tree/main 会被剥掉）
          解析跟着失焦 / 回车自动跑，不需要「下一步」*/}
      <div className="form-grid">
        <div className="field">
          <label className="field-label" htmlFor="wz-repo-url">
            {t('GitHub link', 'GitHub 项目链接')}
          </label>
          <input id="wz-repo-url" className="control" type="text" value={url}
            placeholder="https://github.com/owner/name"
            onChange={(e) => {
              setUrl(e.target.value)
              // 每次输入都写回父组件：否则收起/展开这一步时链接就没了
              //   （state 只在解析成功时才被写入，见 resolve()里的 onChange）。
              //   写回父组件的是原始输入，不含解析产物
              //   （res/probe/cloneUrl 仍只在解析成功时写）。
              onChange({ url: e.target.value })
              // 只在真的变了时才清结果；
              //   只清这四个键，别整体替换 prep（会把别的键一起抹掉）
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
          {/* 去掉这里的 engines/<name>/ 预览。
              目录名下面已经有一行说明在讲「目录名就是名片里的 id」，
                 再挂一个路径预览是同一件事说两遍，而且
                 「目标 / 命令」那行会把真实的完整命令给出（更准）。
                 ⇒ 那个路径信息在这一步一次都不该出现两次。 */}
        </div>
      </div>

      <p className="field-hint" style={{ margin: 0 }}>
        {t('Paste the repository root link — a link to a file or folder inside it '
          + 'is rejected. The directory name becomes the folder under engines/ and '
          + 'is used as the id when the manifest is written in step 4.',
          '请粘贴仓库根地址，指向仓库内文件或目录的地址无效。'
          + '该目录名将作为 engines/ 下的文件夹名，并在第 4 步写入 Manifest 时用作 id。')}
      </p>

      {busy === 'link' && (
        <p className="field-hint" style={{ margin: 0 }}>{t('Reading…', '正在读…')}</p>
      )}

            {/* 告知「我们把你的链接改了」：不是错误，是修正
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

      {/* ── 项目信息（只读，不写盘）────────────────────────────
          标题用使用者的视角（「项目信息」），不用平台视角
            （「仓库自己声明了什么」讲的是上游，不是使用者要知道的）。
          此区域不摆命令：命令由下面的克隆步骤给出，那才是真命令。
          不放「重读」按钮：解析跟着失焦自动跑，探测结果刷新页面就在。*/}
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
            <span className="pv">{licenseText(meta, t)}</span>
          </div>
          {probe && probe.note && (
            <p className="plan-warn" style={{ margin: 0 }}>{t(probe.note, probe.noteZh)}</p>
          )}
        </>
      )}

      {/* ── 下一步（这一步才写盘）──────────────────────────────
          标题说「下一步会发生什么」，不说实现步骤（「克隆」），
            使用者关心的是流程往前走，不是内部动作名。
          这里给真正的 git clone 命令，不只显示 engines/<name>/
            这个目录名：只给目录名看不出要跑什么、也不知道会拉多少。
          不放「看计划」按钮：命令已经摆在上面，再点一次看同一份是多余的。
          判据：此区域里的命令必须与真正要执行的那条逐字相同。*/}
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

          {cloneRes && !cloneRes.ok && !dirNotEmpty && (
            <div className="msg msg-danger">{cloneRes.error}</div>
          )}
          {dirNotEmpty && (
            <div className="msg msg-warn">
              {t('The target directory already exists and is not empty:',
                '目标目录已存在且不为空：')}
              <code>engines/{curId}/</code>
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-sm btn-danger" type="button"
                  disabled={removing || !curId}
                  onClick={removeDir}>
                  {removing
                    ? t('Removing…', '正在清除…')
                    : t('Remove directory and retry', '清除该目录并重试')}
                </button>
              </div>
            </div>
          )}
          {done && (
            <div className="msg msg-info">
              {t('Cloned into engines/' + curId + '/.',
                '已克隆到 engines/' + curId + '/。')}
            </div>
          )}

          {/* vars：把项目名和完整路径喂给风险文案
              （原来只说「写进 engines/」，而那目录里已经有好几个引擎了，
                用户分不清这一步要动的是哪一个）
              name/path 都取自 curId 这一个值 ⇒ 与上面那条命令同源。*/}
          <RiskUnlock stepKey="prepare" unlocked={unlocked} onUnlock={setUnlocked}
            vars={{
              name: curId || t('<name>', '<项目名>'),
              path: fullEngineDir || t('(computing…)', '（正在计算…）'),
            }}>
            {/* 三个按钮同一行，flex 里先出现的排左边：
                撤销克隆（仅克隆完成后）→ 下一步 → 取消（仅克隆进行中）。*/}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {done && (
                <UndoClone engineId={curId} onUndone={() => {
                  // 目录没了 ⇒ 第 1 步的完成状态作废，回到第 1 步重来。
                  setCloneRes(null)
                  onPrep((w) => ({ ...w, cloneRes: null }))
                  onChange({ cloned: false })
                }} />
              )}
              <button className="btn btn-primary btn-sm" type="button"
                // 目录名为空时按钮禁用：不许拿旧 id 顶，也不许发空请求
                disabled={busy === 'clone' || !curId}
                onClick={() => doClone(true)}>
                {busy === 'clone'
                  ? t('Cloning…', '正在克隆…')
                  : t('Next', '下一步')}
              </button>
              {/* 取消按钮：与「正在克隆」同一行、同一个 .btn 形状，
                  颜色改成红色（它终止的是一次已经开始的写盘操作）。 */}
              {busy === 'clone' && (
                <button className="btn btn-sm btn-danger" type="button"
                  onClick={async () => {
                    try {
                      await post('/wizard/clone/cancel', { id: curId })
                    } catch (e) { /* 取消失败不阻断，后端会安全网兜底 */ }
                  }}>
                  {t('Cancel', '取消')}
                </button>
              )}
            </div>
          </RiskUnlock>
        </>
      )}
    </div>
  )
}
