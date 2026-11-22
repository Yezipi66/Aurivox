// 接入流程第 1 步：解析链接 → 只读探测 → 克隆到 engines/<id>/。
// 目录名的唯一来源：链接推出来的名字（folderName.js），可被手写或从已有目录里选中覆盖。
//   state.id 不作来源：旧 id 会让「解析新仓库、克隆与完成状态仍在旧目录」。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import Select from '../../../web/src/components/common/Select'
import { RiskUnlock } from './Pipeline'
import { UndoClone } from './UndoClone'
import { folderName } from './folderName'
import { cloneDone, canUndoClone } from './prepareState'
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
 * 链接框失焦时，焦点落到这些控件上就不代劳读取。
 *
 * 它们是这一步里的操作入口（读取、克隆、目录名下拉、清除目录、撤销、下一步），
 *   每一个自己都有动作。失焦再补一次读取，会和那个动作抢同一条请求：
 *   点了克隆却先跑起一次读取、点了下一步却在跳转的同一瞬间发请求。
 * 换句话说，这里是「自动读取」的第一个出口：只对真正的空白点击生效。
 */
const AUTO_READ_SKIP = 'button, a, input, select, textarea, [role="button"]'

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

export default function StepPrepare ({ state, facts, factsId, onChange, onDone, onNext, prep, onPrep, onUndone, engineDirs }) {
  const { t } = useT()
  const [url, setUrl] = React.useState(state.url || '')
  // 目录名留空 = 跟随链接：框里显示的是链接推出来的灰字，换链接名字就跟着换。
  //   手写、或在下拉里选一台已有引擎，才把这个值固定下来（固定是可见的：框里有字）。
  //   不从持久段恢复：旧名字留在框里时，解析新仓库不会覆盖它，
  //   于是「解析的是新仓库、克隆与完成状态仍是旧目录」。
  const [idInput, setIdInput] = React.useState('')
  // 候选清单 = engines/ 下已有的目录，供「复用已有引擎」；新名字不在此列，直接手写。
  //   与其余四步共用 App 持有的那一份，克隆完成后由外层统一刷新，不各自取。
  const res = prep.res || null
  const probe = prep.probe || null
  const plan = prep.plan || null
  const cloneRes = prep.cloneRes || null
  const [busy, setBusy] = React.useState('')
  const [unlocked, setUnlocked] = React.useState(false)

  // 输入框里此刻的值（同步副本）。异步请求返回时要判「期间链接有没有被改」：
  //   自动读取让这种迟到变成常态，迟到的那次结果不许回写。
  const urlRef = React.useRef(url)
  // busy 的同步副本：state 要到下一帧才更新，失焦与点击落在同一瞬间时判不出来。
  const busyRef = React.useRef('')
  // 读取序号：中止或重新发起之后，旧那一次的响应一律丢弃。
  const probeSeq = React.useRef(0)
  const abortRef = React.useRef(null)
  // 「已停止读取」：读取被主动中止后，状态行要说明发生过什么，而不只是回到未读取。
  const [readStopped, setReadStopped] = React.useState(false)

  // 上次解析成功时链接框里的值，用于判「使用者是否改了链接」；必须在 res 之后声明（TDZ）。
  const lastResolved = (res && res.input) || ''

  // 只认「对应当前输入框」的那份 res：res 是上次解析的产物，换过链接就过期
  //   （input 是解析时的输入）。命令区、项目信息区、克隆、目录名、路径都从
  //   这一个值取，显示与克隆同源，不会出现「命令是上一个仓库、信息是当前仓库」。
  //   与当前输入不一致时（null）让界面回到未解析状态，等失焦或回车重新解析。
  const resForCur = (res && res.input === url) ? res : null

  // 只写一个 patch：函数式更新拿到最新值，分开写同一帧会互相覆盖。
  // setRes 不再单独列出：res 的写入都走 onPrep（resolve 里要同时清 probe，
  //   单独 setRes 表达不了这种成组写，删掉免得误用）。
  // key 是会话段的键（目录名 + 地址）：解析途中目录名会从空变成真名，
  //   不指定键时结果会写进一个随即被丢弃的键，界面表现为「读到了又变回没读」。
  const patch = (k, v, key) => onPrep((w) => ({ ...w, [k]: v }), key)
  const setProbe = (v, key) => patch('probe', v, key)
  const setPlan = (v, key) => patch('plan', v, key)
  const setCloneRes = (v, key) => patch('cloneRes', v, key)

  /**
   * 发一个 POST 请求，把失败也变成可读的结论。
   *
   * 失败分两类，都要在这里收口，不允许让异常冒出去：
   *   ① 网络层失败（连接被拒、DNS 失败、请求超时）⇒ fetch 抛。
   *   ② 响应不是 JSON（服务端返回 HTML 错误页、网关返回纯文本）⇒ r.json() 抛。
   * 这两类过去会让调用方的 setBusy('') 执行不到 ⇒ 界面停在「正在读…」，
   *   而且一个字的错误提示都没有 ⇒ 使用者看不出出了什么事。
   *
   * 判据放在 editor/postJson.js（可单测），这里只做转发。
   */
  const post = (path_, body, opts) => postJson(path_, body, undefined, opts)

  // 不填目录名时的默认值 = 仓库根链接的最后一段。state.id 不作来源（旧 id 会造成双 id）。
  // 这一行同时喂给克隆请求、命令文案、目标路径与风险文案。
  const autoId = (resForCur && resForCur.ok && resForCur.repo) || guessRepoFromUrl(url)
  const curId = folderName({ typed: idInput, suggested: autoId })

  // ① 解析（本地，不联网），紧接着做一次只读探测
  const resolve = async () => {
    busyRef.current = 'link'
    setBusy('link')
    try {
      // 不带 id：目录名只由链接与输入框决定。把输入框的值回传，后端会把它原样还回来，
      //   改名之后克隆的目标就停在上一个仓库。
      const j = await post('/wizard/resolve', { url })
      // 期间链接被改过（失焦自动读取让这种迟到很常见）⇒ 这次解析作废。
      //   不作废就会把输入框改回旧链接、并把旧仓库的 id 写回父组件。
      if (urlRef.current !== url) return null
      // 解析失败（链接不合法、服务未能启动）⇒ 如实报出来，不往下走。
      if (!j.ok) {
        onPrep((w) => ({ ...w, res: { ...j, input: url } }), { url })
        return null
      }
      const resolvedName = folderName({ typed: idInput, suggested: j.id })
      // 后端已把 /tree/... /blob/... 剥掉，界面必须反映截断后的仓库根：
      //   输入框与 wz.url 若还留原始链接，显示的是带尾巴的 URL，
      //   克隆/探测却用截断后的，显示与实际使用不一致。
      const resolvedUrl = j.url || url
      // 这份结果的归属键：目录名就用这次解析出来的名字。
      //   不指定键时写入方会用「当前渲染里的目录名」，而它此刻还是空的或上一台的。
      const key = { id: resolvedName, url: resolvedUrl }
      // 读取不在这里自动跑：它是 readRepo 的动作（失焦自动一次，或按钮显式一次）。
      //   解析只做本地 URL 规范化与目录名推断，不联网；「仓库在不在」交给后面那步回答，
      //   解析成功就顺带探一次会让「读取仓库信息」这个动作说不清是哪一次。
      onPrep((w) => ({ ...w, res: { ...j, input: resolvedUrl }, probe: null }), key)
      if (j.ok) {
        // 推导值只出现在 placeholder 里，不写进输入框：一旦写进去，它就和「人写的」
        //   分不开了，换链接时再也不会跟着变（克隆落到旧目录的那条路径）。
        urlRef.current = resolvedUrl
        if (resolvedUrl !== url) setUrl(resolvedUrl)
        onChange({ url: resolvedUrl, id: resolvedName, repoUrl: j.url, cloneUrl: j.cloneUrl })
        // 目录已存在时这一步会变成「复用」，要提前告诉使用者，
        // 等使用者点了「下一步」才说就来不及了。
        // 这次请求只读（execute 不带 ⇒ 只出计划，不动盘、不联网）。
        try {
          const p = await post('/wizard/clone', {
            id: resolvedName, cloneUrl: j.cloneUrl,
          })
          // 同上：期间换了链接就不再写这份计划（它属于上一个仓库）。
          if (urlRef.current === resolvedUrl) setPlan(p, key)
        } catch (e) { /* 查不到就按普通克隆走，不阻断 */ }
      }
      // 返回这次的归属（地址 + 目录名）：紧接着的探测要用它写同一份会话段。
      return key
    } finally {
      // 这一行必须在 finally 里：请求失败时也要把「正在读…」撤掉，
      //   否则界面会永远停在那个提示上，而使用者看不到任何原因。
      busyRef.current = ''
      setBusy('')
    }
  }

  // ② 探测（只读，不写盘）
  //   中止与迟到都收在这里：abortRef 让「停止读取」能立刻拿回界面，
  //   probeSeq 让已经作废的那一次不许回写状态。
  //   key = { url, id }：这次读的地址与它归属的目录名，由 readRepo 交进来
  //   （解析会顺手把 /tree/... 剥掉，读旧串会白跑一趟）。
  const doProbe = async (key) => {
    const at = key.url
    const mySeq = ++probeSeq.current
    const ctl = new AbortController()
    abortRef.current = ctl
    busyRef.current = 'probe'
    setBusy('probe'); setProbe(null); setReadStopped(false)
    try {
      // 读取针对「使用者此刻在输入框里看到的地址」。
      //   不要退到 state.repoUrl：它是持久段里上一次解析的产物，换了链接
      //   就过期，留着会让「输入 A 却读取 B」。
      const j = await post('/wizard/probe', { url: at }, { signal: ctl.signal })
      // 换过链接 / 被中止 / 又发了一次 ⇒ 这次结果已经无对象，不写进界面。
      if (mySeq !== probeSeq.current || urlRef.current !== at) return
      if (j && j.code === 'ABORTED') return
      // 带上这次读的地址：界面只认与当前输入同源的那份（见 probeCur）。
      setProbe({ ...j, at }, key)
    } finally {
      // 这一行必须在 finally 里：请求失败时也要把「正在读…」撤掉，
      //   否则界面会永远停在那个提示上，而使用者看不到任何原因。
      // 只有仍是「最新那次」才有权撤掉状态：被中止或被顶替的那次不许动 busy。
      if (mySeq === probeSeq.current) {
        abortRef.current = null
        busyRef.current = ''
        setBusy('')
      }
    }
  }

  // 停止读取：自动读取与手动读取都要能中止。
  //   一次读取要等一个远端往返，网络半通时会一直转；没有出口时使用者只能刷新页面，
  //   而刷新会把已经填好的链接与目录名一起丢掉。
  const stopRead = () => {
    // 先让序号前进：在途那一次的响应回来时序号已不匹配，不会回写状态。
    probeSeq.current += 1
    const c = abortRef.current
    abortRef.current = null
    if (c) c.abort()
    busyRef.current = ''
    setBusy('')
    setReadStopped(true)
  }

  // ② 读取仓库：贴完链接就能点，不需要先让输入框失焦。
  //   解析是本地规范化（不联网），探测才读远端；解析不合法就停在错误提示上，
  //   不拿一个不合法的地址去探测（那只会多一条 404 的噪音）。
  //   解析与读取合成一步，按钮在输入框一有内容时就出现：
  //   新用户贴完链接能直接看到该点哪儿。
  const readRepo = async () => {
    // 一次只跑一条读取：失焦自动读与按钮点击可能落在同一瞬间（state 还没更新）。
    if (busyRef.current) return
    // 这是一次新的读取：上一次的「已停止读取」到这里作废，否则解析那一段
    //   状态行还挂着「已停止读取」，看起来像这次点击没有生效。
    setReadStopped(false)
    // 当前输入已经解析过 ⇒ 直接读它；否则先解析，用解析出来的地址与目录名去读。
    let key = (resForCur && resForCur.ok)
      ? { id: curId, url: urlRef.current }
      : null
    if (!key) {
      let got = null
      try { got = await resolve() } catch { got = null }
      if (!got) return
      key = got
    }
    await doProbe(key)
  }

  // 离开链接框 = 点一次「读取仓库信息」。
  //   自动动作必须留好出口，否则它从帮手变成绊脚石。三个出口：
  //   ① 焦点落到本步里的控件上就不代劳（见 AUTO_READ_SKIP）：那些控件自己有动作；
  //   ② 同一条链接只自动读一次（已解析过就交给按钮）：否则失败之后每次点空白
  //      都重试一遍，红色错误会一直挂在屏幕上；
  //   ③ 读取期间按钮变成「停止读取」，随时可以中止（见 stopRead）。
  const onUrlBlur = (e) => {
    const rt = e.relatedTarget
    if (rt && typeof rt.closest === 'function' && rt.closest(AUTO_READ_SKIP)) return
    if (done || busyRef.current || !url.trim() || resForCur) return
    readRepo()
  }

  // ③ 克隆（这一步才写盘）
  // curId 是唯一的 id 来源；写成 id: idInput || state.id 会在输入框空时退化到旧 id。
  const doClone = async (execute) => {
    // 克隆结果的归属键：目录名可能在这一步才真正定下来（解析前它是空的）。
    const key = { id: curId, url: urlRef.current }
    busyRef.current = 'clone'
    setBusy('clone'); setCloneRes(null)
    // 目录名为空时在这里拦下，否则只会看到 Node 内核报错而非「请填写目录名」。
    if (!curId) {
      setCloneRes({ ok: false, code: 'MISSING_ID',
        error: t('Fill in the directory name first.',
          '请先填写目录名。'),
        errorZh: '请先填写目录名：它会成为 engines/ 下的文件夹名。' })
      busyRef.current = ''
      setBusy('')
      return
    }
    try {
      // cloneUrl 从顶部那份 resForCur 取（只认对应当前输入框的 res）：
      //   用过期 res 的 cloneUrl（或持久段里残留的 state.cloneUrl）去克隆，
      //   会把上一个仓库拉进当前目录。两者都与当前输入不一致时，让后端
      //   报「请先解析链接」，不猜一个。
      const cloneUrl = (resForCur && resForCur.cloneUrl) || ''
      // 与文案、只读预览用同一个 curId：后端按它算 engines/<id>，
      // 前端不另拼一份。
      const j = await post('/wizard/clone', { id: curId, cloneUrl, execute })
      if (j.ok && j.steps) setPlan(j, key)
      setCloneRes(j, key)
      if (j.ok && execute) {
        // 写回 id：使用者改过目录名时，第 2/3 步要拿到刚克隆用的那个。
        //   不写 cloned：完成状态由端点读盘判，持久段里没有它的位置。
        // id 一并交给 onDone：App 那边要立刻重问完成状态，而 onChange 的
        //   setState 是异步的，紧接着同步调用会读到上一个渲染的旧 id（空）。
        onChange({ id: curId })
        onDone && onDone(curId)
      }
    } finally { busyRef.current = ''; setBusy('') }
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
  // 清除目录同样不可撤回：点一次只进入确认态，再点一次才删。
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const removeDir = async () => {
    setRemoving(true)
    try {
      const j = await post('/wizard/clone/remove', { id: curId })
      if (j.ok) {
        // 目录清掉了 ⇒ 之前的失败结果作废，重新解析一遍拿到新状态。
        setCloneRes(null)
        onPrep((w) => ({ ...w, cloneRes: null }))
        if (resForCur && resForCur.ok) await resolve()
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
  const enginesDir = (resForCur && resForCur.enginesDir) || null
  const pathSep = (resForCur && resForCur.pathSep) || null
  const fullEngineDir = (enginesDir && pathSep && curId)
    ? enginesDir + pathSep + curId
    : null

  // 第 1 步完成 = 后端判的「目录已克隆」，键是 steps_done.prepare。
  //   facts 的键与 core/installState.js 的 steps 逐字相同，只有
  //   prepare/env/models/manifest/verify 五个，没有 cloned。
  //   用 facts.cloned 会恒为 undefined ⇒ done 恒 false ⇒ 克隆完成后
  //   「撤销克隆 / 下一步」永远不会出现，使用者被卡在第 1 步。
  const done = cloneDone({ facts, factsId, curId })
  // 只认「读的就是当前这个地址」的那份探测结果。
  //   prep 里的 probe 会随持久段恢复（旧记录没有 at 字段，按当前地址算），
  //   而换链接时 onChange 已把它清掉；这里再对一次地址，迟到的结果就没有位置了。
  const probeCur = (probe && (probe.at == null || probe.at === url)) ? probe : null
  const meta = (probeCur && probeCur.meta) || null

  // 读取状态（给卡片底部那个手动按钮用）。
  //   判据不能用 ok：解析是纯本地的（不联网，地址写错也返回 ok），
  //   探测对 404 同样返回 ok:true，真正的信号在 probe.notes 里。
  //   「够不够得到这个仓库」只看 meta 里有没有真读到东西。
  const readSomething = !!(meta && (meta.packageName || meta.requiresPython
    || meta.srcRoot || meta.license || (meta.dependencies && meta.dependencies.found)))
  // 解析与探测都算「正在读取」：解析是本地的一次往返，界面在这段时间里
  //   也要说同一句话，否则点完按钮到探测开始之间会出现一段没有反馈的空档。
  const sniffStatus = (busy === 'probe' || busy === 'link')
    ? t('Reading…', '正在读取…')
    : readStopped
      ? t('Reading stopped', '已停止读取')
      : !probeCur
        // 还没读：把「离开链接框会自动读一次」写在状态里。自动动作不告知时，
        //   使用者无法判断它有没有跑、跑的是哪一次的地址。
        ? (resForCur
            ? t('Not read yet', '尚未读取')
            : t('Not read yet (reads once when you leave the link box)',
              '尚未读取（离开链接框时会自动读取一次）'))
        : readSomething
          ? t('Repository information read', '已读取仓库信息')
          : t('No repository information read', '未读取到仓库信息')

  return (
    /* 第一步全部铺开：一个连续区域，从上到下直接排。
       外层这行内联样式取自 TrainingTab.jsx 的 TrainingTab() 外层：
         display:flex / flexDirection:column / gap:8
       不再套 .preflight、不再套 .form-narrow、不再套任何盒子。 */
    <div className="wz-stack">

      {/* 两个输入框，一行。
          目录名留空 = 取仓库根最后一段（tree/main 会被剥掉），框里以灰字显示。
          读取由三处触发，走的是同一条 readRepo：失焦离开链接框（等价于点一次读取）、
          回车、右侧按钮。焦点落到本步的控件上时失焦不代劳（AUTO_READ_SKIP），
          读取期间随时可以「停止读取」。*/}
      <div className="form-grid">
        <div className="field">
          <label className="field-label" htmlFor="wz-repo-url">
            {t('GitHub link', 'GitHub 项目链接')}
          </label>
          <input id="wz-repo-url" className="control" type="text" value={url}
            placeholder="https://github.com/owner/name"
            onChange={(e) => {
              setUrl(e.target.value)
              // 同步副本：在途的读取回来时要判「期间有没有换过链接」。
              urlRef.current = e.target.value
              // 换链接 ⇒ 目录名回到「跟随」：旧名字属于上一个仓库，
              //   留着它，克隆会落进那台引擎的目录（同名目录已有内容时变成复用）。
              setIdInput('')
              // 每次输入都写回父组件：否则收起、展开这一步时链接就没了
              // （state 只在解析成功时才被写入，见 resolve() 里的 onChange）。
              // 写回父组件的是原始输入，不含解析产物
              // （res/probe/cloneUrl 仍只在解析成功时写）。
              // repoUrl/cloneUrl 一起清：换了一个链接，之前解析出的上游地址就是旧的。
              //   若留着，读取（doProbe 读 state.repoUrl）与克隆（doClone 读
              //   state.cloneUrl）会用上一个仓库的值，出现「输入 A 却读取/克隆 B」，
              //   而 B 恰好没有依赖清单时，就表现为「这个仓库没有声明依赖」。
              onChange({ url: e.target.value, repoUrl: '', cloneUrl: '' })
              // 只在真的变了时才清结果；
              // 只清这四个键，别整体替换 prep（会把别的键一起抹掉）
              if (e.target.value !== lastResolved) {
                onPrep((w) => ({ ...w, res: null, probe: null, plan: null, cloneRes: null }))
              }
            }}
            // 回车与按钮走同一条路（解析 + 探测）：两处行为不一致时，
            //   回车会被当成「已经探过了」，而实际只做了本地解析。
            onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !busy) readRepo() }}
            // 点到空白（焦点离开到页面本体）= 点一次「读取仓库信息」。
            //   焦点落到本步的控件上时不代劳：那些控件自己有动作，
            //   在这里再补一次读取只会和它抢同一条请求。
            onBlur={onUrlBlur} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="wz-engine-id">
            {t('Folder name', '目录名')}
          </label>
          {/* 下拉 + 文本框同一套外观：框里能直接写新名字，也能从清单里选一台已有引擎。
              留空 = 跟随链接（灰字就是接下来会用的那个名字）。 */}
          <Select className="control" editable value={idInput}
            placeholder={autoId || 'auto'}
            inputProps={{ id: 'wz-engine-id' }}
            onChange={(e) => setIdInput(e.target.value)}>
            <option value="">{t('— follow the link —', '跟随链接')}</option>
            {(engineDirs || []).filter((d) => d.id && !d.id.startsWith('_')).map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}{d.manifestPresent ? '' : `（${t('no manifest yet', '尚无名片')}）`}
              </option>
            ))}
          </Select>
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
          + 'is used as the id when the manifest is written in step 4. '
          + 'Leave it empty to follow the link; pick one from the list to reuse an '
          + 'existing engine.',
          '请粘贴仓库根地址，指向仓库内文件或目录的地址无效。'
          + '该目录名将作为 engines/ 下的文件夹名，并在第 4 步写入 Manifest 时用作 id。'
          + '留空即跟随链接中的仓库名；从下拉里选一台已有引擎，表示复用它的目录。'
          + '离开链接框时会自动读取一次仓库信息，也可以随时点右侧按钮重读。')}
      </p>

      {/* 解析进行中的提示不在这里另开一行：下面那行状态已经把「正在读取…」
          说了一遍（sniffStatus 同时覆盖解析与探测），同一件事说两遍会让人
          以为是两件事。 */}

      {/* 告知「我们把你的链接改了」：不是错误，是修正
          （文案查表，不走后端的中文句子）*/}
      {resForCur && resForCur.ok && resForCur.noteCode && (
        <p className="plan-warn" style={{ margin: 0 }}>
          {errText({ code: resForCur.noteCode, params: resForCur.noteParams }, t)}
        </p>
      )}

      {resForCur && !resForCur.ok && (
        <div className="msg msg-danger">
          {errText(resForCur, t)}
          {resForCur.example && (
            <div className="field-hint">
              {t('Example:', '例如：')} <code>{resForCur.example}</code>
            </div>
          )}
        </div>
      )}

      {/* 读取状态与读取按钮常驻一行，不再等到「读到东西」才出现。
          状态先回答「读没读」，按钮文字再说明下一次点它会做什么。
          读取期间这个按钮换成「停止读取」：读取要等远端往返，没有出口时
          使用者只能刷新页面，而刷新会把填好的链接与目录名一起丢掉。 */}
      {!done && !!url.trim() && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="field-hint" style={{ margin: 0 }}>{sniffStatus}</span>
          <span style={{ flex: 1 }} />
          {busy === 'probe' ? (
            <button className="btn btn-sm" type="button" onClick={stopRead}>
              {t('Stop reading', '停止读取')}
            </button>
          ) : (
            <button className="btn btn-sm" type="button"
              disabled={busy === 'link'}
              onClick={readRepo}>
              {busy === 'link'
                ? t('Reading…', '正在读取…')
                : readSomething
                  ? t('Re-read repository info', '重新读取')
                  : t('Read repository info', '读取仓库信息')}
            </button>
          )}
        </div>
      )}

      {/* 项目信息（只读，不写盘）。只在读取成功后显示：没读取时读不到任何信息，
          摆一排「—」占位只会让人觉得仓库是空的；「读取到了才显示具体信息」
          与实际操作顺序一致：先确认仓库在不在、能否读到，再继续下一步。
          标题用使用者的视角（「项目信息」），不用平台视角
            （「仓库自己声明了什么」讲的是上游，不是使用者要知道的）。
          此区域不摆命令：命令由下面的克隆步骤给出，那才是真命令。
          读取（及读取失败后的重试）是右下角那个按钮的专属动作。*/}
      {resForCur && resForCur.ok && readSomething && (
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
          {probeCur && probeCur.note && (
            <p className="plan-warn" style={{ margin: 0 }}>{t(probeCur.note, probeCur.noteZh)}</p>
          )}
        </>
      )}

      {/* 命令区：把这一步真正会执行的事情逐条摆出来，不只挑 git clone 那一条。
          判据（与第 2 步同一条）：这里列的必须与后端计划里的逐字相同。
          读取时已经取过一份只读计划（/wizard/clone 不带 execute），所以这里直接
            渲染 planForCur.steps，不另拼一份命令：另拼的那份会与后端漂移，
            使用者看到的就不是真正要跑的那条。
          目录已存在时后端返回的是「复用」，没有命令要跑，这一区自然为空。*/}
      {resForCur && resForCur.ok && readSomething && !done && !reused
        && planForCur && Array.isArray(planForCur.steps) && planForCur.steps.length > 0 && (
        <div className="plan-kv" style={{ rowGap: 'var(--sp-4)' }}>
          <span className="pk">{t('Commands', '命令')}</span>
          <span className="pv">
            {planForCur.steps.map((st, i) => {
              // gitignore 那一步没有命令行：它写的是 .gitignore，不是跑一条命令。
              const argv = Array.isArray(st.argv) && st.argv.length > 0
                ? st.argv.map(String).join(' ') : ''
              const note = st.whyZh || st.why || ''
              return (
                <div key={st.kind || i} style={{ marginTop: i > 0 ? 'var(--sp-6)' : 0 }}>
                  {argv && <code>{argv}</code>}
                  {note && (
                    <div className="field-hint" style={{ margin: 0 }}>
                      {argv ? '# ' : ''}{t(st.why, st.whyZh)}
                    </div>
                  )}
                </div>
              )
            })}
          </span>
        </div>
      )}

      {/* 克隆结果提示：与命令区同一条件下显示，两者说的是同一件事的两种状态。 */}
      {resForCur && resForCur.ok && readSomething && !done && (
        <>
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
                  onClick={() => {
                    if (!confirmRemove) { setConfirmRemove(true); return }
                    setConfirmRemove(false)
                    removeDir()
                  }}>
                  {removing
                    ? t('Removing…', '正在清除…')
                    : (confirmRemove
                        ? t('Click again to delete', '再点一次，确认清除')
                        : t('Remove directory and retry', '清除该目录并重试'))}
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
            {/* 读取成功后、未克隆：克隆靠右下。
                读取与重新读取在上方那一行常驻，这里不再摆第二处：
                同一动作摆两处时，使用者会以为是两件事。
                克隆中时旁边出现红色的「取消」。*/}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary btn-sm" type="button"
                // 目录名为空时按钮禁用：不许拿旧 id 顶，也不许发空请求
                disabled={busy === 'clone' || !curId}
                onClick={() => doClone(true)}>
                {busy === 'clone'
                  ? t('Cloning…', '正在克隆…')
                  : t('Clone', '克隆')}
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

      {/* 克隆完成：右下角 [撤销克隆] [下一步]。
          下一步只负责跳到第 2 步（安装依赖），不再克隆；克隆已经完成了。
          跳转是使用者自己的决定，不自动跳（onDone 不再 setPage）。
          撤销克隆删掉 engines/<id>/ 整棵，回到第 1 步重来。*/}
      {resForCur && resForCur.ok && done && (
        <>
          <div className="msg msg-info">
            {reused
              ? t('Using the existing directory engines/' + curId + '/.',
                  'engines/' + curId + '/ 已存在，沿用现有内容。')
              : t('Cloned into engines/' + curId + '/.',
                  '已克隆到 engines/' + curId + '/。')}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center',
            justifyContent: 'flex-end', marginTop: 12 }}>
            {canUndoClone(cloneRes, curId) && <UndoClone engineId={curId} target={fullEngineDir} onUndone={(removedId) => {
              // 目录没了 ⇒ 第 1 步的完成状态作废：清掉失败结果（cloneRes），
              // 并让 App 重新读完成状态（facts 由端点判，撤销后 prepare 应为 false）。
              // 不写 wz.cloned：完成状态只由端点判，持久段里没有它的位置。
              setCloneRes(null)
              onPrep((w) => ({ ...w, cloneRes: null }))
              onUndone && onUndone(removedId || curId)
            }} />}
            <button className="btn btn-primary btn-sm" type="button"
              onClick={onNext}>
              {t('Next', '下一步')}
            </button>
          </div>
        </>
      )}

      {/* 探测过程的原话：读不到默认分支、HTTP_404 之类都在这。
          这是判断「仓库在不在」唯一可见的信号，不摆出来就等于没探。*/}
      {probeCur && Array.isArray(probeCur.notes) && probeCur.notes.length > 0 && (
        <div className="msg msg-warn" style={{ marginTop: 8 }}>
          {probeCur.notes.map((n, i) => (
            <div key={i}>{typeof n === 'string' ? n : String(n)}</div>
          ))}
        </div>
      )}
    </div>
  )
}
