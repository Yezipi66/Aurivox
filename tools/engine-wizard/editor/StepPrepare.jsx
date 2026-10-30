// 接入流程第 1 步：解析链接 → 只读探测 → 克隆到 engines/<id>/。
// 目录名的唯一来源：输入框 + 仓库名（folderName.js）。state.id 不作来源。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { RiskUnlock } from './Pipeline'
import { UndoClone } from './UndoClone'
import { folderName } from './folderName'
import { postJson } from './postJson'

/** 从链接里推断项目名：目录名留空时做灰字预览；真正的 id 来自 resolve 端点。 */
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
    '"{name}" 是平台保留的目录名，请改用其他目录名。'],
  // 请求本身未走通（服务未能启动、连接被拒、响应不是 JSON）。
  // 这两种过去会让界面停在「正在读…」且不显示任何原因。
  REQUEST_FAILED: [
    'Could not reach the platform service ({path}). Check that it is running, then try again.',
    '无法连接平台服务（{path}）。请检查平台服务是否在运行，然后重试。'],
  BAD_RESPONSE: [
    'The platform service ({path}) returned a response that is not JSON (HTTP {status}). '
      + 'Check that it is running normally, then try again.',
    '平台服务（{path}）返回的不是 JSON 响应（HTTP {status}）。'
      + '请检查平台服务是否正常，然后重试。'],
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

  // 上次解析成功时链接框里的值，用于判「使用者是否改了链接」；必须在 res 之后声明（TDZ）。
  const lastResolved = (res && res.input) || ''

  // 只写一个 patch：函数式更新拿到最新值，分开写同一帧会互相覆盖。
  const patch = (k, v) => onPrep((w) => ({ ...w, [k]: v }))
  const setRes = (v) => patch('res', v)
  const setProbe = (v) => patch('probe', v)
  const setPlan = (v) => patch('plan', v)
  const setCloneRes = (v) => patch('cloneRes', v)

  /**
   * 发一个 POST 请求，把失败也变成可读的结论。
   *
   * 失败分两类，都要在这里收口，不允许让异常冒出去：
   *   ① 网络层失败（连接被拒、DNS 失败、请求超时）⇒ fetch 抛。
   *   ② 响应不是 JSON（服务端返回 HTML 错误页、网关返回纯文本）⇒ r.json() 抛。
   * 这两类过去会让调用方的 `setBusy('')` 执行不到 ⇒ 界面停在「正在读…」，
   *   而且一个字的错误提示都没有 ⇒ 使用者看不出出了什么事。
   *
   * 判据放在 editor/postJson.js（可单测），这里只做转发。
   */
  const post = (path_, body) => postJson(path_, body)

  // 不填目录名时的默认值 = 仓库根链接的最后一段。state.id 不作来源（旧 id 会造成双 id）。
  // 这一行同时喂给克隆请求、命令文案、目标路径与风险文案。
  const autoId = (res && res.ok && res.repo) || guessRepoFromUrl(url)
  const curId = folderName({ typed: idInput, suggested: autoId })

  // ① 解析（本地，不联网），紧接着做一次只读探测
  const resolve = async () => {
    setBusy('link')
    try {
      // 留空时后端的 id 参数故意不给，避免旧 id 顶上来找回上次引擎的目录名。
      const j = await post('/wizard/resolve', {
        url, id: (idInput.trim() || undefined),
      })
      // 解析失败（链接不合法、服务未能启动）⇒ 如实报出来，不往下走。
      if (!j.ok) {
        onPrep((w) => ({ ...w, res: { ...j, input: url } }))
        return
      }
      // 必须打 /wizard/probe（返回 meta）；/wizard/deps 只返回 deps。
      //   探测失败不阻断：克隆那步照样能看。
      let probeJ = null
      try { probeJ = await post('/wizard/probe', { url: j.url }) } catch (e) { /* 探测失败不阻断 */ }
      const resolvedName = folderName({ typed: idInput, suggested: j.id })
      onPrep((w) => ({ ...w, res: { ...j, input: url }, probe: probeJ }))
      if (j.ok) {
        if (!idInput.trim()) setIdInput(j.id)
        onChange({ url, id: resolvedName, repoUrl: j.url, cloneUrl: j.cloneUrl })
        // 目录已存在时这一步会变成「复用」，要提前告诉使用者，
        // 等使用者点了「下一步」才说就来不及了。
        // 这次请求只读（execute 不带 ⇒ 只出计划，不动盘、不联网）。
        try {
          const p = await post('/wizard/clone', {
            id: resolvedName, cloneUrl: j.cloneUrl,
          })
          setPlan(p)
        } catch (e) { /* 查不到就按普通克隆走，不阻断 */ }
      }
    } finally {
      // 这一行必须在 finally 里：请求失败时也要把「正在读…」撤掉，
      //   否则界面会永远停在那个提示上，而使用者看不到任何原因。
      setBusy('')
    }
  }

  // ② 探测（只读，不写盘）
  const doProbe = async () => {
    setBusy('probe'); setProbe(null)
    try {
      const j = await post('/wizard/probe',
        { url: state.repoUrl || (res && res.url) || url })
      setProbe(j)
    } finally {
      setBusy('')
    }
  }

  // ③ 克隆（这一步才写盘）
  // curId 是唯一的 id 来源；写成 `id: idInput || state.id` 会在输入框空时退化到旧 id。
  const doClone = async (execute) => {
    setBusy('clone'); setCloneRes(null)
    // 目录名为空时在这里拦下，否则只会看到 Node 内核报错而非「请填写目录名」。
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
      // 与文案、只读预览用同一个 curId：后端按它算 engines/<id>，
      // 前端不另拼一份。
      const j = await post('/wizard/clone', { id: curId, cloneUrl, execute })
      if (j.ok && j.steps) setPlan(j)
      setCloneRes(j)
      if (j.ok && execute) {
        // 写回 id：使用者改过目录名时，第 2/3 步要拿到刚克隆用的那个。
        //   不写 cloned：完成状态由端点读盘判，持久段里没有它的位置。
        // id 一并交给 onDone：App 那边要立刻重问完成状态，而 onChange 的
        //   setState 是异步的，紧接着同步调用会读到上一个渲染的旧 id（空）。
        onChange({ id: curId })
        onDone && onDone(curId)
      }
    } finally { setBusy('') }
  }

  // ④ 目标目录已有内容 ⇒ 复用，不重新克隆
  // 后端在目录非空时不再拦：重新克隆要删掉使用者已经装好的环境与权重，
  // 而平台没有断点续传。所以这里把上游关系告诉使用者，让使用者知道手上这份是什么。
  // 复用状态从 plan 读：解析完就做了一次只读检查，结果在 plan 里，
  // 不必等使用者点了「下一步」才说。
  // plan 是持久化的（sessionStorage），改了链接或目录名之后它可能还是上一次的
  // ⇒ 只认「跟当前目录名对得上」的那份，否则当没有。
  const planForCur = (plan && plan.id && plan.id === curId) ? plan : null
  const reused = !!(planForCur && planForCur.state === 'reused')
  const upstream = (planForCur && planForCur.upstream) || null
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

  // 目标目录由后端给（enginesDir + pathSep），前端不推断文件系统路径。
  // 拿不到 enginesDir ⇒ 不显示路径，不显示空的或假的绝对路径。
  // 命令与目标路径同源：改目录名时两者必须一起变。
  const enginesDir = (res && res.enginesDir) || null
  const pathSep = (res && res.pathSep) || null
  const relEngineDir = `engines/${curId}/`
  const fullEngineDir = (enginesDir && pathSep && curId)
    ? enginesDir + pathSep + curId
    : null

const done = facts && facts.cloned === true
  const meta = (probe && probe.meta) || null

  // 嗅探状态（给卡片底部那个手动按钮用）。
  //   判据不能用 ok：解析是纯本地的（不联网，地址写错也返回 ok），
  //   探测对 404 同样返回 ok:true，真正的信号在 probe.notes 里。
  //   「够不够得到这个仓库」只看 meta 里有没有真读到东西。
  const readSomething = !!(meta && (meta.packageName || meta.requiresPython
    || meta.srcRoot || meta.license || (meta.dependencies && meta.dependencies.found)))
  const sniffStatus = busy === 'probe'
    ? t('Sniffing…', '正在嗅探…')
    : !probe
      ? t('Not sniffed yet', '尚未嗅探')
      : readSomething
        ? t('Repository reachable', '够得到这个仓库')
        : t('Nothing readable from this repository', '这个仓库读不到东西')

  return (
    /* 第一步全部铺开：一个连续区域，从上到下直接排。
       外层这行内联样式取自 TrainingTab.jsx 的 TrainingTab() 外层：
         display:flex / flexDirection:column / gap:8
       不再套 .preflight、不再套 .form-narrow、不再套任何盒子。 */
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* 两个输入框，一行。
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
              // 每次输入都写回父组件：否则收起、展开这一步时链接就没了
              // （state 只在解析成功时才被写入，见 resolve() 里的 onChange）。
              // 写回父组件的是原始输入，不含解析产物
              // （res/probe/cloneUrl 仍只在解析成功时写）。
              onChange({ url: e.target.value })
              // 只在真的变了时才清结果；
              // 只清这四个键，别整体替换 prep（会把别的键一起抹掉）
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
        <p className="field-hint" style={{ margin: 0 }}>{t('Reading…', '正在读取…')}</p>
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

      {/* 项目信息（只读，不写盘）。
          标题用使用者的视角（「项目信息」），不用平台视角
            （「仓库自己声明了什么」讲的是上游，不是使用者要知道的）。
          此区域不摆命令：命令由下面的克隆步骤给出，那才是真命令。
          重嗅探的按钮在卡片底部：那里在解析成功之前也看得到，
            而「仓库到底在不在」恰恰是解析成功之前最该回答的问题。*/}
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

      {/* 下一步（这一步才写盘）。
          标题说「下一步会发生什么」，不说实现步骤（「克隆」），
            使用者关心的是流程往前走，不是内部动作名。
          这里给真正的 git clone 命令，不只显示 engines/<name>/
            这个目录名：只给目录名看不出要跑什么、也不知道会拉多少。
          不放「看计划」按钮：命令已经摆在上面，再点一次看同一份是多余的。
          判据：此区域里的命令必须与真正要执行的那条逐字相同。*/}
      {res && res.ok && (
        <>
          {/* 命令区：复用时没有命令要跑。
              复用是这一次的常态（目录已经在了），摆一条不会执行的 git clone
                会让使用者以为下一步会去拉一遍。*/}
          {!reused && (
            <div className="plan-kv">
              <span className="pk">{t('Command', '命令')}</span>
              <span className="pv">
                <code>
                  {`git clone ${(res && res.cloneUrl) || ''} engines/${curId}`}
                </code>
              </span>
            </div>
          )}

          {cloneRes && !cloneRes.ok && !dirNotEmpty && (
            <div className="msg msg-danger">{cloneRes.error}</div>
          )}
          {dirNotEmpty && (
            // 黄色：这是「目录已存在」这个状况的提醒，
            // 危险的是下面那个按钮（它会删掉目录里的全部内容）。
            <div className="msg msg-warn">
              {t('The target directory already exists and is not empty:',
                '目标目录已存在且不为空：')}
              <code>engines/{curId}/</code>
              <div style={{ marginTop: 8 }}>
                {/* 红色：删掉该目录下的全部内容，不可撤回。 */}
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
          {reused && (
            <div className={upstream && upstream.match === 'different' ? 'msg msg-warn' : 'msg msg-info'}>
              {upstream && upstream.match === 'same' && (
                <>
                  {t('This directory was cloned from the same upstream, so it is reused '
                    + 'as it is. The upstream may have newer commits; the local copy is '
                    + 'what the environment and the weights were installed against.',
                    '该目录来自同一个上游，直接复用。'
                    + '上游可能已有更新的提交，本地这份是环境与权重所对应的版本。')}
                  {planForCur.git && planForCur.git.head && (
                    <div className="field-hint">
                      {t('Local copy', '本地版本')}：
                      <code>{planForCur.git.head}</code>
                      {planForCur.git.branch ? <> · {planForCur.git.branch}</> : null}
                    </div>
                  )}
                </>
              )}
              {upstream && upstream.match === 'different' && (
                <>
                  {t('This directory came from a different upstream, so it is reused '
                    + 'as it is. Check that this is the engine to be installed.',
                    '该目录来自另一个上游，仍按原样复用。'
                    + '请确认这就是要装的引擎。')}
                  <div className="field-hint">
                    {t('Local origin', '本地来源')}：<code>{upstream.local}</code>
                    <br />
                    {t('Requested upstream', '请求的上游')}：<code>{upstream.upstream}</code>
                  </div>
                </>
              )}
              {(!upstream || upstream.match === 'unknown') && (
                <>
                  {t('This directory already has content, so it is reused as it is. '
                    + 'The platform cannot tell which upstream it came from.',
                    '该目录里已经有内容，直接复用。'
                    + '平台无从判断来源。')}
                </>
              )}
            </div>
          )}
          {done && !reused && (
            <div className="msg msg-info">
              {t('Cloned into engines/' + curId + '/.',
                '已克隆到 engines/' + curId + '/。')}
            </div>
          )}

          {/* vars：把项目名和完整路径喂给风险文案。
              只说「写进 engines/」时使用者分不清这一步要动的是哪一个，
              那目录里已经有好几个引擎了。
              name/path 都取自 curId 这一个值 ⇒ 与上面那条命令同源。*/}
          <RiskUnlock stepKey="prepare" unlocked={unlocked} onUnlock={setUnlocked}
            vars={{
              name: curId || t('<name>', '<项目名>'),
              path: fullEngineDir || t('(computing…)', '（正在计算…）'),
              // 复用时那句文案要跟着改：说「会克隆到哪」就与实际做的事不符了。
              reuse: reused,
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

      {/* 嗅探仓库（手动，卡片右下角）。
          为什么要有这个手动按钮：解析是纯本地的（不联网），地址写错它照样说 ok；
            探测对 404 也返回 ok:true，真正的信号在 probe.notes 里，而 notes
            以前从来没渲染过，于是仓库不存在时界面只停在一个「进行中」，
            使用者既看不到原因，也没法自己再探一次。
          手动触发 + 把状态与探测原话摆出来，「现在到底认出了什么」才一眼可见。
          它在 res.ok 之外：解析成功之前恰恰最需要回答「仓库在不在」。*/}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
        gap: 8, marginTop: 12 }}>
        <span className="field-hint" style={{ margin: 0 }}>{sniffStatus}</span>
        <button className="btn btn-sm" type="button"
          disabled={busy === 'probe' || !url.trim()}
          onClick={doProbe}>
          {busy === 'probe'
            ? t('Sniffing…', '正在嗅探…')
            : t('Sniff repository', '嗅探仓库')}
        </button>
      </div>

      {/* 探测过程的原话：读不到默认分支、HTTP_404 之类都在这。
          这是判断「仓库在不在」唯一可见的信号，不摆出来就等于没探。*/}
      {probe && Array.isArray(probe.notes) && probe.notes.length > 0 && (
        <div className="msg msg-warn" style={{ marginTop: 8 }}>
          {probe.notes.map((n, i) => (
            <div key={i}>{typeof n === 'string' ? n : String(n)}</div>
          ))}
        </div>
      )}
    </div>
  )
}
