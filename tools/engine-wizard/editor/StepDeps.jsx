import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { IconPencil } from '../../../web/src/components/common/Icons'
import { RiskUnlock } from './Pipeline'
import { UndoClone } from './UndoClone'
import { loadSession, saveSession } from './useInstallSession'

// 向导第 2 步：给这台引擎装 Python 依赖。
// 本机检测、装法与将要执行的命令都来自 /wizard/env 的计划（execute:false）；
// 真正执行时读同一端点的 SSE 流，进度与日志逐条显示。
// 会话状态存在 sessionStorage，键含引擎 id 与仓库 URL：刷新不丢，换 URL 即失效。

const VERDICT = {
  match: { mark: '✓', en: 'Matches this machine', zh: '与本机匹配' },
  mismatch: { mark: '!', en: 'Does not match this machine', zh: '与本机不匹配' },
  unknown: { mark: '?', en: 'Cannot determine', zh: '无法判断' },
}

// 与 core/installChoices.js 的 specName 同一口径（PEP 503 名字归一）
function pkgName (spec) {
  return String(spec || '').split(/[<>=!~\[;@\s]/)[0].trim().toLowerCase().replace(/[-_.]+/g, '-')
}

/**
 * 按包名找出后端算好的那条最终 spec。
 *
 * 为什么界面要问后端要：pill 上显示的那条 spec 必须与真正装进去的那条一致。
 *   界面自己拿「上游原文 + 手写版本」拼一条出来，会与后端写进清单副本的那条
 *   分叉（约束形式不同：上游写 >= 的时候，界面拼出来的是 ==，
 *   而后端保留上游的约束形式）。两处显示不一致 ⇒ 使用者看到的不是装进去的。
 *
 * @param {string[]} specs 后端返回的最终 spec 列表（没选版本时是上游原文）
 * @param {string} name 包名（归一化后）
 * @param {string} fallback 找不到时用它（上游原文那条）
 * @returns {string} 该包最终要装的那条 spec
 */
function finalSpec (specs, name, fallback) {
  const key = pkgName(name)
  const hit = (specs || []).find((s) => pkgName(s) === key)
  return hit || fallback
}

/**
 * 把一条 spec 拆成三段：包名与约束、版本号、其余（注释 / marker）。
 *
 * 为什么拆：pill 上要显示的是整条 spec，而笔要改的只是版本号那一段。
 *   不拆的话，笔旁边的控件就得把版本号再显示一遍 ⇒ 同一个版本号出现两次，
 *   两处还可能不一致（一个是上游原文，一个是手写值）。
 *
 * @param {string} spec 一条 spec
 * @returns {{head:string, version:string, tail:string}}
 *   head：包名与约束（`einops==` / `einops>=` / `einops`）
 *   version：版本号（`0.8.1`；上游没钉时是空串）
 *   tail：其余部分（marker、注释）
 */
function splitSpec (spec) {
  const s = String(spec || '').trim()
  const m = s.match(
    /^([A-Za-z0-9._-]+\s*(?:\[[^\]]*\])?\s*(?:[<>=!~]{1,3})?)\s*([0-9][0-9A-Za-z]*(?:[.\-][0-9A-Za-z]+)*(?:\.\*)?)?(.*)$/s)
  if (!m) return { head: s, version: '', tail: '' }
  return { head: m[1] || '', version: m[2] || '', tail: m[3] || '' }
}

// 从一条 spec 里取出声明的版本号。
//   einops==0.8.1 ⇒ 0.8.1；einops>=0.8.1 ⇒ 0.8.1（区间取下界那一端）；
//   einops ⇒ 空串（上游没钉版本）。
function declaredVersion (spec) {
  return splitSpec(spec).version
}

// 点「安装」时该怎么走。
//
// 纯函数：输入当前状态，输出「要不要先弹窗」与「执行时带什么参数」。
//   规则：探测出「上游钉的 torch 版本在本机后端上不可用」且使用者还没答过 ⇒ 先弹窗；
//   答过了（true / false）⇒ 直接按那个答案执行，不再拦。
//
/**
 * 点「安装」时该怎么走。
 *
 * @param {object|null} suggestion 后端探测的结论
 * @param {boolean|null} answered 使用者的回答（null = 还没问过）
 * @returns {{ask:boolean, upgradeTorch:boolean, torchSuggestion:object|null}}
 *
 * 三种情况：
 *   ① 上游钉的版本不可用，且这个后端上有可替换的版本
 *      ⇒ 问使用者要不要升级。接受 ⇒ 装建议版本；取消 ⇒ 不装。
 *   ② 上游钉的版本不可用，但换 torch 版本也解决不了
 *      （这个后端在本机 Python 上一个轮子都没有）
 *      ⇒ 照样要问，但只能问「装不装」，不给假的升级选项。
 *   ③ 没能确认（网络不通、index 抓不到）
 *      ⇒ 也问，但要说清「只是没确认」。使用者可以选择照原样装，
 *      这一路不是「不可用」，所以照原样装是允许的。
 *   ④ 上游钉的版本可用 ⇒ 直接装，不问。
 */
function installDecision (suggestion, answered) {
  const unusable = !!(suggestion && suggestion.ok === false)
  const hasVersion = !!(suggestion && suggestion.suggested)
  if (unusable && answered === null) {
    return {
      ask: true,
      // 只有真有可替换的版本时，「升级」这条路才存在。
      upgradeTorch: false,
      torchSuggestion: suggestion,
    }
  }
  return {
    ask: false,
    upgradeTorch: answered === true && hasVersion,
    torchSuggestion: suggestion || null,
  }
}

export {
  installDecision, TorchUpgradeDialog, PackageGroups, SpecPill, VersionSelect,
  declaredVersion, splitSpec, finalSpec,
}

export default function StepDeps ({ state, prep, onFixId, onUndone }) {
  const { t, lang } = useT()
  const engineId = state.id
  const url = state.repoUrl || ''
  // 会话段里的解析结果比持久段更贴近「用户此刻在装哪台」：换 URL 后持久段还有旧值，
  // 会话段已经失效。两者不一致时以会话段为准，并把持久段一起纠正过来。
  const sessionId = (prep && prep.res && prep.res.id) || ''
  React.useEffect(() => {
    if (sessionId && sessionId !== state.id && onFixId) onFixId(sessionId)
  }, [sessionId, state.id])
  const targetId = sessionId || engineId

  // 从会话段恢复状态（sessionStorage，刷新不丢、关 tab 丢、换 URL 失效）。
  //   懒初始化而不是 useEffect：首帧就要用恢复值，否则第 1 帧会把旧值覆盖回默认值再写盘，
  //   恢复就白做了。
  const saved = React.useMemo(
    () => loadSession(targetId, url), [targetId, url])

  const [plan, setPlan] = React.useState(saved?.depsPlan || null)
  const [showNormal, setShowNormal] = React.useState(saved?.showNormal || false)
  const [backend, setBackend] = React.useState(saved?.backend || null)
  const [result, setResult] = React.useState(saved?.depsResult || null)
  const [preview, setPreview] = React.useState(saved?.depsPreview || null)
  const [unlocked, setUnlocked] = React.useState(saved?.unlocked || false)
  const [skipped, setSkipped] = React.useState(saved?.skipped || [])
  // 使用者为某些包选定的版本（包名⇒版本号）。空对象表示「都按上游声明的装」。
  const [versionOverrides, setVersionOverrides] = React.useState(saved?.versionOverrides || {})
  const [busy, setBusy] = React.useState(false)
  const [live, setLive] = React.useState(null)   // 瞬态，不持久化
  const [tail, setTail] = React.useState([])      // 瞬态，不持久化
  const [progress, setProgress] = React.useState(saved?.depsProgress || null)
  // 使用者是否接受「把 torch 升到本机后端上可用版本」这条建议。
  //   null = 还没问（点安装时弹窗问）；true/false = 已答。
  const [upgradeTorch, setUpgradeTorch] = React.useState(saved?.upgradeTorch ?? null)
  // 后端探测出的建议（上游钉的版本在本机后端上不可用时给出）。
  //   单独存：计划请求要用它，但计划结果本身也会带它 ⇒ 放在一起会绕成循环依赖。
  const [suggestion, setSuggestion] = React.useState(saved?.torchSuggestion || null)
  // 取消函数（run() 里挂上，finally 里摘掉）。用 ref 不用 state：
  //   它是「这一次执行」的动作，不是界面状态，进了 state 会触发多余渲染。
  const cancelRef = React.useRef(null)

  // 保存到会话段。瞬态状态（busy / live / tail）不持久化。
  //   键含 id 与 url ⇒ 换任一个，写到的都是另一段会话，不会污染旧的。
  React.useEffect(() => {
    if (!targetId) return
    saveSession(targetId, url, {
      depsPlan: plan, showNormal, backend, unlocked,
      depsResult: result, depsPreview: preview, depsProgress: progress, skipped,
      upgradeTorch, torchSuggestion: suggestion, versionOverrides,
    })
  }, [targetId, url, plan, showNormal, backend, unlocked, result, preview, progress, skipped, upgradeTorch, suggestion, versionOverrides])

  const isSkipped = (spec) => skipped.includes(pkgName(spec))
  const toggleSkip = (spec) => {
    const n = pkgName(spec)
    if (!n || busy) return
    setSkipped((xs) => (xs.includes(n) ? xs.filter((x) => x !== n) : [...xs, n]))
  }

  // 选版本：空字符串表示「按上游声明的装」，把这一项从覆盖表里去掉。
  const setVersion = (name, ver) => {
    const n = pkgName(name)
    if (!n || busy) return
    setVersionOverrides((xs) => {
      const next = { ...xs }
      const v = String(ver || '').trim()
      if (!v) delete next[n]
      else next[n] = v
      return next
    })
  }

  // 点「安装」：若探测出「上游钉的 torch 版本在本机后端上不可用」，
  //   先弹窗问要不要升级。取消 ⇒ 不装（使用者自己想办法）。
  //   弹窗只问一次：答过之后（upgradeTorch 有值）不再拦。
  const [askUpgrade, setAskUpgrade] = React.useState(false)
  //   使用者取消后的说明。取消是「知道了，但这次不装」，
  //   界面上要有一句交代，不能点了没反应。
  const [upgradeDeclined, setUpgradeDeclined] = React.useState(false)
  const onInstallClick = () => {
    const d = installDecision(suggestion, upgradeTorch)
    if (d.ask) { setAskUpgrade(true); setUpgradeDeclined(false); return }
    run({ upgradeTorch: d.upgradeTorch, torchSuggestion: d.torchSuggestion })
  }
  const answerUpgrade = (accept) => {
    setAskUpgrade(false)
    setUpgradeTorch(accept)
    if (accept) {
      setUpgradeDeclined(false)
      // 有可替换的版本 ⇒ 走升级路线（后端会跳过 torch 系、从后端 index 装建议版本）。
      // 没有可替换的版本 ⇒ 照原样装上游声明的版本：
      //   此时不能传 upgradeTorch=true，后端会报「没有提出可用的 Torch 版本」。
      const hasVersion = !!(suggestion && suggestion.suggested)
      run({
        upgradeTorch: hasVersion,
        torchSuggestion: hasVersion ? suggestion : null,
      })
      return
    }
    // 取消 ⇒ 不装：使用者可以改后端、改排除项，或自己装。
    //   但要说清楚「这次什么都没装」，不能点了取消就没下文。
    setUpgradeDeclined(true)
  }

  const reload = async () => {
    if (!url) return
    try {
      const r = await fetch('/wizard/deps', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      setPlan(await r.json())
    } catch (e) { setPlan({ ok: false, error: e.message }) }
  }

  // 只清记录，不删源码，也不删已装依赖（那是另一回事）。
  const resetThisStep = async () => {
    if (!targetId) return
    try {
      await fetch('/wizard/reset-progress', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: targetId, section: 'env' }),
      })
    } catch (e) { /* 端点不通 ⇒ 记录还在，不当成已清 */ }
  }
  React.useEffect(() => {
    if (url && !plan) reload() /* eslint-disable-line */
  }, [url])

  const d = plan && plan.ok ? plan.deps : null
  const hw = plan ? plan.hardware : null

  // 计划态：进入页面就取一次不执行的计划。execute:false ⇒ 后端只出计划不执行。
  //   upgradeTorch 一起传：接受升级后，计划要反映出「跳过 torch 系 + 装建议版本」两步。
  //   建议不放在依赖里：它来自计划的响应，放进去会自己触发自己 ⇒ 无限请求。
  //   用 ref 存最新的一份，闭包里读得到又不参与依赖。
  const suggestionRef = React.useRef(suggestion)
  suggestionRef.current = suggestion
  React.useEffect(() => {
    if (!targetId) return
    let alive = true
    // 走升级路线的前提是「真有可替换的版本」。
    //   没有可替换的版本时不能传 upgradeTorch=true，
    //   后端会报「没有提出可用的 Torch 版本」而整个计划失败。
    const hasVersion = !!(suggestionRef.current && suggestionRef.current.suggested)
    const useUpgrade = upgradeTorch === true && hasVersion
    fetch('/wizard/env', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: targetId, manifest: state.manifest || {}, execute: false,
        backend, exclude: skipped,
        upgradeTorch: useUpgrade,
        // 已经接受升级时不再回传：建议已经在本地存着（suggestionRef）。
        torchSuggestion: useUpgrade ? null : suggestionRef.current,
        versionOverrides,
      }),
    }).then((r) => r.json())
      .then((j) => {
        if (!alive) return
        setPreview(j)
        // 后端探测到的建议存下来：弹窗要读它，执行请求也要回传它。
        //   探到「可用」时不带建议字段 ⇒ 清掉旧的那份，避免拿过期建议去问。
        if (j && j.torchSuggestion) setSuggestion(j.torchSuggestion)
        else if (upgradeTorch !== true) setSuggestion(null)
      })
      .catch(() => { if (alive) setPreview(null) })
    return () => { alive = false }
  }, [targetId, backend, skipped.join('\n'), upgradeTorch, JSON.stringify(versionOverrides)])
  const canSkip = !(preview && preview.choices && preview.choices.supported === false)

  React.useEffect(() => {
    if (hw && backend === null) setBackend(hw.recommended)
  }, [hw])

  // 只在执行中更新；执行结束后保持最后的状态，让用户看到结果。

  // 读 SSE 流。用 fetch 加 ReadableStream，axios 无法读取流。
  // 不能等 r.json()：那会把流缓冲到最后才一次性返回。
  const run = async (opts = {}) => {
    setBusy(true); setResult(null); setTail([]); setLive({ stage: 'start' })
    try {
      const resp = await fetch('/wizard/env', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: state.id, manifest: state.manifest || {}, execute: true, backend,
          exclude: skipped,
          upgradeTorch: opts.upgradeTorch === true,
          torchSuggestion: opts.torchSuggestion || null,
          versionOverrides,
        }),
      })
      if (!resp.ok) { setResult({ ok: false, error: 'HTTP ' + resp.status }); return }
      // 取消：打取消端点，让服务端杀掉那个进程（进程树）。
      //   只断前端的流不杀进程，那只是看不见它在运行。
      const cancel = async () => {
        try {
          await fetch('/wizard/env/cancel', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: state.id }),
          })
        } catch (e) { /* 端点不通时后端仍会照 done 事件如实报 */ }
      }
      cancelRef.current = cancel
      // resp.body 是 ReadableStream：逐块读，按 \n\n 切 SSE 事件
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let finalResult = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const dataLine = raw.split('\n').find((l) => l.startsWith('data: '))
          if (!dataLine) continue
          let ev
          try { ev = JSON.parse(dataLine.slice(6)) } catch (e) { continue }
          if (ev && typeof ev === 'object') {
            if ('i' in ev && 'total' in ev) {
              setLive({ stage: 'step', i: ev.i + 1, total: ev.total, argv: ev.argv })
            } else if ('text' in ev) {
              setLive((s) => ({ ...(s || {}), stage: 'line', err: ev.err }))
              setTail((t) => [...t.slice(-39), ev.text])
            } else if ('name' in ev && ('downloaded' in ev || 'total' in ev)) {
              setProgress({ name: ev.name, downloaded: ev.downloaded || 0, total: ev.total || 0 })
            } else if ('ok' in ev || 'stepsRun' in ev || 'error' in ev) {
              finalResult = ev
            }
          }
        }
      }
      // 流结束了：最后的 done 事件是完整结果
      setResult(finalResult || { ok: false, error: '连接中断，未收到完成事件' })
    } catch (e) {
      setResult({ ok: false, error: e.message })
    } finally {
      cancelRef.current = null
      setBusy(false)
    }
  }

  if (!plan) {
    return (
      <div className="msg msg-info" style={{ marginBottom: 0 }}>
        {t('The repository is not available yet. Complete step 1 to continue.',
          '仓库尚未就绪。完成第 1 步后可继续。')}
      </div>
    )
  }

  if (!plan.ok) {
    return (
      <>
        <div className="msg msg-danger">{t(plan.error, plan.errorZh)}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-sm" type="button" onClick={reload}>
            {t('Retry', '重试')}
          </button>
        </div>
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* 本机检测结果与推荐的安装后端。 */}
      {hw && (
        <div className="msg msg-info">
          <b>{t('This machine', '本机')}：</b>
          {hw.gpus && hw.gpus.length
            ? hw.gpus.map((g) => g.name).join('；')
            : t('no recognisable GPU', '没有可识别的 GPU')}
          {' → '}{t('recommended', '推荐')}{' '}
          <b>{backendOf(hw.options, hw.recommended)}</b>
          {hw.reason && <div className="field-hint">{t(hw.reason, hw.reasonZh)}</div>}
          {hw.caveat && <div className="field-hint">⚠ {t(hw.caveat, hw.caveatZh)}</div>}
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t('Several GB are downloaded and it takes a while. If it stops midway, '
              + 'run this step again — the download continues from the breakpoint '
              + 'and already-downloaded wheels are kept. If you cancel it, the '
              + 'environment is left partial: the next run removes it and rebuilds '
              + 'it, and the downloaded wheels are still reused.',
              '需下载数 GB，耗时较长。若中途停止，重新执行本步骤会从断点续传，'
              + '已下载的依赖不会重下。若中途取消，环境会停在不完整状态：'
              + '下次执行会先删掉它再重建，已下载的依赖包仍会复用。')}
          </p>
        </div>
      )}

      {/* 与显卡相关的依赖包，三态：匹配、不匹配、无法判断。 */}
      {d && d.torch.count > 0 && (
        <div className="preflight" style={{ marginTop: 0 }}>
          <div className="layer-label">
            {t('GPU-related packages', '与 GPU 相关的包')}
          </div>
          {/* t() 只接两个参数（web/src/lib/i18n.jsx 的 LangProvider 里 t = (en, zh)），
               传三个 ⇒ 第二段英文被当中文返回。 */}
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t('These packages only run on this kind of graphics card. '
              + 'Other cards need a different Torch build.',
              '这些包只能在这种显卡上使用。更换显卡后需要安装其他版本的 Torch。')}
          </p>
          {d.torch.packages.map((r) => {
            const V = VERDICT[r.verdict] || VERDICT.unknown
            const off = isSkipped(r.spec)
            const name = pkgName(r.spec)
            // 整行是「切换是否安装这个包」的点击区，
            //   所以行内的笔必须自己断掉冒泡，否则点笔等于把它设为不安装。
            const rowClick = (e) => {
              if (e && e.stopPropagation) e.stopPropagation()
              if (canSkip) toggleSkip(r.spec)
            }
            const rowKey = (e) => {
              if (!canSkip) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleSkip(r.spec)
              }
            }
            // pill 上显示的那条 spec：后端算好的最终那条。
            const spec = finalSpec(preview && preview.specs, name, r.spec)
            return (
              <div key={r.name} className="pf-row"
                role={canSkip ? 'button' : undefined}
                tabIndex={canSkip ? 0 : undefined}
                title={canSkip ? t('Click to toggle whether this package is installed',
                  '点击切换是否安装此包') : undefined}
                onClick={canSkip ? rowClick : undefined}
                onKeyDown={canSkip ? rowKey : undefined}
                style={{ cursor: canSkip ? 'pointer' : undefined, opacity: off ? 0.5 : undefined }}>
                <span className="badge badge-sym">{off ? '–' : V.mark}</span>
                <span className="pf-val">
                  <SpecPill
                    name={name}
                    spec={spec}
                    value={(versionOverrides || {})[name] || ''}
                    onChange={(v) => setVersion(name, v)}
                    t={t}
                    disabled={busy}
                    editable={!off && canSkip}
                  />
                </span>
                <span className="field-hint" style={{ marginTop: 0 }}>
                  {off ? t('Not installed', '不安装') : (lang === 'zh' ? V.zh : V.en)}
                </span>
                {!off && r.why && <span className="pf-warn">{t(r.why, r.whyZh)}</span>}
              </div>
            )
          })}
        </div>
      )}

      {/* 安装后端：全部选项都列出来，推荐值只是默认值。 */}
      {hw && hw.options && (
        <div className="field">
          <label className="field-label" htmlFor="wz-backend">
            {t('Install with', '安装命令')}
          </label>
          <select id="wz-backend" className="control"
            value={backend || ''} onChange={(e) => setBackend(e.target.value)}>
            {hw.options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
                {o.key === hw.recommended
                  ? (lang === 'zh' ? '（推荐）' : ' (recommended)') : ''}
                {' — '}{t(o.for, o.forZh)}
              </option>
            ))}
          </select>
          <p className="field-hint">
            {t('This is a recommendation. Every option is listed below; if the '
              + 'wheel pinned upstream cannot use this GPU, pick another one, '
              + 'or install Torch afterwards.',
              '此处为推荐值，全部选项列于下方。若上游锁定的 wheel 与本机显卡'
              + '不匹配，可改选其他后端，或自行安装 Torch。')}
          </p>
        </div>
      )}

      {preview && preview.ok === false && preview.code === 'BACKEND_NO_INDEX' && (
        <div className="msg msg-danger">{t(preview.error, preview.errorZh)}</div>
      )}

      {/* 将要执行的命令来自 preview（execute:false 的计划），不是 plan。 */}
      {preview && preview.ok && (preview.env_command || []).length > 0 && (
        <div className="field">
          <label className="field-label" htmlFor="wz-cmd">
            {t('Command to run', '将要执行的命令')}
          </label>
          <div className="rc-cmd" id="wz-cmd">
            <div className="rc-cmd-body">
              <code>{(preview.env_command || []).join(' ')}</code>
            </div>
          </div>
          {preview.whatToDo && (
            <p className="field-hint" style={{ marginTop: 0 }}>
              {t(preview.whatToDo, preview.whatToDoZh)}
            </p>
          )}
          {preview.stepsRun && preview.stepsRun.length > 0 && (
            <div className="preflight" style={{ marginTop: 6 }}>
              {preview.stepsRun.map((s) => (
                <div key={s.n} className="pf-row">
                  <span className="badge badge-sym">{s.ok ? '✓' : '✗'}</span>
                  <span className="pf-val pf-val-grow"><code>{s.argv.join(' ')}</code></span>
                  <span className={`pf-warn-end ${s.ok ? 'pf-status-ok' : 'pf-status-fail'}`}>
                    {s.ok ? t('done', '完成') : t('failed', '失败')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 锁文件的后端与本机不一致，主命令之后还要再装一次 torch。
          主命令已带 --no-install-package torch（照锁装其余、跳过 torch），
          这一段显示的是装 torch 那一步，不重复主命令。
          数据来自 preview（进入页面时取的 execute:false 计划），
          不是 plan（/wizard/deps 从 GitHub 拉 lock）。 */}
      {preview && preview.alternative && (
        <div className="field">
          <label className="field-label" htmlFor="wz-alt">
            {t('Then install Torch for this machine', '然后安装本机适用的 Torch')}
          </label>
          <div className="rc-cmd" id="wz-alt">
            <div className="rc-cmd-body">
              <code>{preview.alternative.then.join(' ')}</code>
            </div>
          </div>
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t(preview.alternative.why, preview.alternative.whyZh)}
          </p>
        </div>
      )}

      {/* torch 版本与本机后端不一致：提前说清，不等装到一半才炸。
          装依赖那一步失败时，uv 的报错是「No solution found when resolving
          dependencies」，看不出真因是 torch 版本与后端/ABI 不匹配。
          两种不可用都要显示：① 这个后端上有可替换的版本（可以问要不要升级）；
          ② 这个后端在本机 Python 上一个轮子都没有（换版本也解决不了）。 */}
      {suggestion && suggestion.ok === false && (
        <div className="msg msg-warning">
          <b>{suggestion.suggested
            ? t('The Torch version pinned by the upstream is not available on this machine',
              '上游锁定的 Torch 版本在本机不可用')
            : t('Torch cannot be installed on this backend',
              '这个后端上装不了 Torch')}</b>
          <div className="field-hint" style={{ marginTop: 4 }}>
            {suggestion.suggested
              ? t(`The upstream declares Torch version ${suggestion.declared}, but that version has no `
                + `wheel on the ${backendOf(hw && hw.options, backend)} backend. `
                + `Version ${suggestion.suggested} is available there.`,
                `上游声明 Torch 版本为 ${suggestion.declared}，而该版本在`
                + `${backendOf(hw && hw.options, backend)} 后端上`
                + `没有适配的 wheel。`
                + `该后端上可用的版本是 ${suggestion.suggested}。`)
              : t(`The upstream declares Torch version ${suggestion.declared}, and the `
                + `${backendOf(hw && hw.options, backend)} backend has no wheel for `
                + `it at all. No other version fits either, `
                + `so there is nothing to switch to.`,
                `上游声明 Torch 版本为 ${suggestion.declared}，而`
                + `${backendOf(hw && hw.options, backend)} 后端上`
                + `没有适配的 wheel，`
                + `也没有别的版本能适配，没有可替换的版本。`)}
          </div>
          {upgradeTorch === null && !suggestion.suggested && (
            <div className="field-hint" style={{ marginTop: 4 }}>
              {t('Pressing Install will ask whether to install anyway.',
                '点「安装」时会询问是否继续。')}
            </div>
          )}
          {upgradeTorch === true && suggestion.suggested && (
            <div className="field-hint" style={{ marginTop: 4 }}>
              {t(`Torch will be installed at version ${suggestion.suggested}.`,
                `Torch 将以版本 ${suggestion.suggested} 安装。`)}
            </div>
          )}
          {upgradeTorch === false && (
            <div className="field-hint" style={{ marginTop: 4 }}>
              {upgradeDeclined
                ? t('The upgrade was declined and nothing was installed. Choose another '
                  + 'backend, use a different Python version, or install Torch yourself.',
                  '已拒绝升级，这次什么都没装。可以改选其他后端、换 Python 版本，'
                  + '或自行安装 Torch。')
                : t('The upgrade was declined. Installing continues with the upstream version, '
                  + 'which is expected to fail on this machine.',
                  '已拒绝升级。安装会继续用上游那个版本，在本机预计会失败。')}
            </div>
          )}
        </div>
      )}

      {/* 与显卡无关的依赖包：只显示个数，展开后列出。 */}
      {d && d.normal.count > 0 && (
        <div className="collapsible">
          <div className="collapsible-hdr" onClick={() => setShowNormal(!showNormal)}>
            <span>{t('Other packages', '其它包')}</span>
            <span className="field-hint" style={{ marginTop: 0 }}>
              {showNormal ? '▾' : '▸'} {d.normal.count}
              {d.normal.packages.some(isSkipped)
                ? t(` (${d.normal.packages.filter(isSkipped).length} skipped)`,
                  `（${d.normal.packages.filter(isSkipped).length} 个不安装）`)
                : ''}
            </span>
          </div>
          {showNormal && (
            <div className="collapsible-body">
              <p className="field-hint" style={{ marginTop: 0 }}>
              {t('No graphics-card-specific packages. The same command'
                + ' works on every machine.',
                '不含与显卡相关的依赖包，所有机器使用同一条安装命令。')}
              </p>
              <PackageGroups packages={d.normal.packages} isSkipped={isSkipped}
                onToggle={canSkip ? toggleSkip : null}
                versionOverrides={versionOverrides}
                onVersion={canSkip ? setVersion : null}
                specs={preview && preview.specs}
                t={t}
                disabled={busy} />
            </div>
          )}
        </div>
      )}

      {canSkip ? (
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('All packages are installed by default. Click a package to exclude it; click again to restore it.',
            '默认安装全部依赖。点击某个包可设为不安装，再次点击恢复。')}
        </p>
      ) : (
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('The install method is declared by the Manifest, so individual packages cannot be excluded.',
            '安装方式由 Manifest 指定，无法单独排除依赖。')}
        </p>
      )}
      {canSkip && skipped.length > 0 && (
        <div className="msg msg-warning">
          {t('Excluded packages are not installed in this engine\'s environment, even when another package depends on them. '
            + 'If the engine needs them at runtime, the check in step 5 will fail.',
            '设为不安装的包不会装进该引擎的环境，即使其他包依赖它们。'
            + '若引擎运行时需要这些包，第 5 步的检查将会失败。')}
        </div>
      )}

      {/* 实时进度：执行期间显示。 */}
      {busy && (
        <div className="preflight" style={{ marginTop: 0 }}>
          <div className="layer-label">
            {progress
              ? t(`Downloading ${progress.name} (${fmtBytes(progress.downloaded)})`,
                  `正在下载 ${progress.name}（${fmtBytes(progress.downloaded)}）`)
              : live && live.stage === 'step'
                ? t(`Step ${live.i}/${live.total}`, `第 ${live.i}/${live.total} 步`)
                : t('Running…', '执行中…')}
          </div>
          {progress && (
            <div className="pf-row">
              <span className="badge badge-sym" aria-hidden="true" />
              <span className="pf-val">
                <code>{progress.name}</code>
                <span className="field-hint" style={{ marginTop: 0 }}>
                  {fmtBytes(progress.downloaded)}{progress.total > 0 ? ` / ${fmtBytes(progress.total)}` : ''}
                </span>
              </span>
            </div>
          )}
          {live && live.stage === 'step' && (
            <div className="pf-row">
              <span className="badge badge-sym">▶</span>
              <span className="pf-val"><code>{live.argv}</code></span>
            </div>
          )}
          {/* 进度条：有字节进度时按字节显示，有总步数时按步数显示，单步时用不确定动画。 */}
          {progress && progress.total > 0 ? (
            <div className="wz-progress">
              <div className="wz-progress-bar"
                style={{ width: `${Math.round((progress.downloaded / progress.total) * 100)}%` }} />
            </div>
          ) : live && live.total > 1 ? (
            <div className="wz-progress">
              <div className="wz-progress-bar"
                style={{ width: `${Math.round(((live.i - 1) / live.total) * 100) + (live.stage === 'line' ? 100 / live.total : 0)}%` }} />
            </div>
          ) : (
            <div className="wz-progress wz-progress-indeterminate">
              <div className="wz-progress-bar" />
            </div>
          )}
          {tail.length > 0 && (
            <div className="rc-cmd-body" style={{ marginTop: 4, maxHeight: 160, overflowY: 'auto' }}>
              <pre style={{ margin: 0, fontSize: 'var(--fs-12)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {tail.join('\n')}
              </pre>
            </div>
          )}
          {/* 取消按钮：只在执行期间显示。
              它杀的是服务端那个进程，不是只让前端不再显示。
              红色：终止一个已经开始的操作，且环境会停在不完整状态。 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-danger" type="button"
              disabled={!cancelRef.current}
              onClick={() => cancelRef.current && cancelRef.current()}>
              {t('Cancel', '取消')}
            </button>
            <span className="field-hint">
              {t('Stops the download on the server. The engine environment is left '
                + 'partial; re-running rebuilds it.',
                '会停掉服务器上正在进行的下载。引擎环境会停在不完整状态；'
                + '重新执行本步骤会先重建它。')}
            </span>
          </div>
        </div>
      )}

      {/* 取消是用户自己的选择，不是失败：用 info 不用 danger。
          步骤列表里那一条取消的步骤照实标叉号（它确实没完成），
          但结论要说「已取消」，不让用户以为装失败了。 */}
      {result && result.code === 'INSTALL_CANCELLED' && (
        <div className="msg msg-info">
          {t(result.error, result.errorZh)}
          {result.note && <div className="field-hint">{t(result.note, result.noteZh)}</div>}
        </div>
      )}

      {result && !result.ok && result.code !== 'INSTALL_CANCELLED' && (
        <div className="msg msg-danger">
          {t(result.error, result.errorZh)}
          {result.note && <div className="field-hint">{t(result.note, result.noteZh)}</div>}
        </div>
      )}

      {result && result.stepsRun && result.stepsRun.length > 0 && (
        <div className="preflight">
          {result.stepsRun.map((s) => (
            <div key={s.n} className="pf-row">
              <span className="badge badge-sym">{s.ok ? '✓' : '✗'}</span>
              <span className="pf-val pf-val-grow">
                {t(`Step ${s.n}/${s.of}`, `第 ${s.n}/${s.of} 步`)}
                {' '}<code>{s.argv.join(' ')}</code>
              </span>
              <span className={`pf-warn-end ${s.ok ? 'pf-status-ok' : 'pf-status-fail'}`}>
                {s.ok ? t('done', '完成') : t('failed', '失败')}
              </span>
              {!s.ok && s.output && (
                <div className="rc-cmd-body" style={{ marginTop: 4 }}>
                  <code>{String(s.output).slice(0, 2000)}</code>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {result && result.ok && result.note && (
        <div className="msg msg-info">{t(result.note, result.noteZh)}</div>
      )}

      {/* 三个按钮一行，从左到右：从头重装本步、撤销克隆、安装（主操作靠最右）。
          两个按钮的说明放在按钮行下方的分隔线里，竖排作引注。
          RiskUnlock 自己就是「提示 + 勾选 + 按钮」三块，
            不能再把三块各自塞成并排的列（那会把提示拆成并排的两列）。 */}
      <RiskUnlock stepKey="env" unlocked={unlocked} onUnlock={setUnlocked}>
        {/* RiskUnlock 把 children 放进 .confirm-actions（flex 行，右对齐），
            所以这里给一个撑满宽度的子节点：
            上面一行按钮（主操作靠最右），下面一块引注。 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          width: '100%',
        }}>
          <div style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            justifyContent: 'flex-end',
          }}>
            {/* 从头重装本步：只清「哪些步骤算做完了」这份记录
                （.wizard-install.json 的 env 段），
                不删引擎目录里的源码，也不删已装依赖。 */}
            {!busy && (
              <button className="btn btn-sm" type="button"
                onClick={() => resetThisStep()}>
                {t('Reinstall this step from the start', '从头重装本步')}
              </button>
            )}

            {/* 撤销克隆：克隆完成后向导直接跳到第 2 步，
                所以这条路也得在这儿给一份：
                使用者在这儿才真正看到「下一步该做什么」，想反悔时手边要有路。 */}
            {!busy && targetId && (
              <UndoClone engineId={targetId} onUndone={() => {
                if (onUndone) onUndone()
              }} />
            )}

            <button className="btn btn-primary btn-sm" type="button"
              disabled={busy} onClick={onInstallClick}>
              {busy ? t('Installing…', '正在安装…') : t('Install', '安装')}
            </button>
          </div>

          {/* 按钮的引注：分隔线之下。
              分隔线贯穿整个容器宽度，左右各留一点边距。
              说明竖排，与上面三个按钮一一对应。 */}
          {!busy && (
            <div style={{
              paddingTop: 8,
              borderTop: '1px solid var(--border)',
              marginLeft: 8,
              marginRight: 8,
            }}>
              <div className="field-hint" style={{ maxWidth: 560 }}>
                {t('Reinstall this step from the start: clears the record of finished '
                  + 'steps in this step only. Source code and installed packages are kept, '
                  + 'and cached wheels are reused.',
                  '从头重装本步：只清除本步的已完成记录。源码与已安装的依赖保留，'
                  + '已下载的依赖包会复用。')}
              </div>
              {targetId && (
                <div className="field-hint" style={{ maxWidth: 560, marginTop: 4 }}>
                  {t('Undo clone: removes the cloned engine directory and returns to step 1.',
                    '撤销克隆：删除刚克隆下来的引擎目录，回到第 1 步。')}
                </div>
              )}
            </div>
          )}
        </div>
      </RiskUnlock>
      {askUpgrade && suggestion && suggestion.ok === false && (
        <TorchUpgradeDialog
          suggestion={suggestion}
          backendLabel={backendOf(hw && hw.options, backend)}
          onAccept={() => answerUpgrade(true)}
          onDecline={() => answerUpgrade(false)}
        />
      )}
    </div>
  )
}

// 升级 Torch 的确认弹窗。
// 形态复用主界面的 .modal-overlay / .modal-card（web/src/styles.css 里已有）。
// 两条路都给：接受 ⇒ 按建议版本装；取消 ⇒ 不装，由使用者自己决定。
function TorchUpgradeDialog ({ suggestion, backendLabel, onAccept, onDecline }) {
  const { t } = useT()
  const hasVersion = !!(suggestion && suggestion.suggested)
  // 没有可替换的版本 = 这个后端 + 这个 Python 的组合没有官方轮子
  //   （reason = no-wheel-for-this-python）。换 torch 版本解决不了，
  //   所以只如实说明，不给「装 Torch X」那个按钮。
  const noVersion = !hasVersion
  return (
    <div className="modal-overlay" onClick={onDecline}>
      <div className="modal-card confirm-card"
        style={{ maxWidth: 520, padding: 20 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="confirm-hdr">
          <span>
            {noVersion
              ? t('Torch is not available on this backend',
                '这个后端上装不了 Torch')
              : t('Upgrade Torch?', '升级 Torch？')}
          </span>
        </div>
        <div className="confirm-body">
          {noVersion ? (
            <>
              <p style={{ marginTop: 0 }}>
                {t(`The upstream declares Torch version ${suggestion.declared}, and the ${backendLabel} `
                  + `backend has no wheel for it at all. `
                  + `Installing the upstream version as declared will fail.`,
                  `上游声明 Torch 版本为 ${suggestion.declared}，而 ${backendLabel} 后端上`
                  + `没有适配的 wheel。`
                  + `照上游声明的版本安装会失败。`)}
              </p>
              <p>
                {t('No other Torch version fits either, so there is nothing '
                  + 'to switch to. Choose another backend, use a different Python version, '
                  + 'or install Torch yourself.',
                  `也没有别的版本能适配，没有可替换的版本。`
                  + `可以改选其他后端、换 Python 版本，或自行安装 Torch。`)}
              </p>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>
                {t(`The upstream declares Torch version ${suggestion.declared}, but that version has no `
                  + `wheel on the ${backendLabel} backend. `
                  + `Installing the upstream version as declared will fail.`,
                  `上游声明 Torch 版本为 ${suggestion.declared}，而该版本在 ${backendLabel} 后端上`
                  + `没有适配的 wheel。`
                  + `照上游声明的版本安装会失败。`)}
              </p>
              <p>
                {t(`Version ${suggestion.suggested} is available on that backend. `
                  + `The upstream version is left aside, and Torch is installed at `
                  + `${suggestion.suggested} from the official ${backendLabel} index.`,
                  `该后端上可用的版本是 ${suggestion.suggested}。`
                  + `上游那个版本会被跳过，改从 ${backendLabel} 官方 index 安装 `
                  + `${suggestion.suggested}。`)}
              </p>
            </>
          )}
        </div>
        <div className="confirm-actions">
          <button className="btn btn-sm" type="button" onClick={onDecline}>
            {t('Cancel', '取消')}
          </button>
          {hasVersion ? (
            <button className="btn btn-sm btn-primary" type="button" onClick={onAccept}>
              {t(`Install Torch ${suggestion.suggested}`, `安装 Torch ${suggestion.suggested}`)}
            </button>
          ) : (
            // 没有可替换的版本：照原样装也是一个选择（由使用者承担结果）。
            <button className="btn btn-sm btn-primary" type="button" onClick={onAccept}>
              {t('Install anyway', '照原样装')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function fmtBytes (n) {
  if (!n || n <= 0) return '0B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return n.toFixed(n >= 100 ? 0 : 1) + units[i]
}

function backendOf (options, key) {
  const o = (options || []).find((x) => x.key === key)
  return o ? o.label : key
}

/**
 * pill 里的一条 spec：包名与约束、版本号、笔、其余。
 *
 * 为什么要这个组件：pill 上那一条 spec 与笔是同一件事的两面
 *   （笔改的就是这条 spec 里的版本号）。分开放会出现两个毛病：
 *   ① 版本号显示两遍（pill 一遍、笔旁边一遍），两处还可能不一致；
 *   ② 笔跑到 pill 外面，看起来像管别的东西。
 *   所以 pill 与笔必须一起渲染。
 *
 * 未编辑态时整条 spec 是一个连续的 <code>：
 *   拆成「头 + 版本」两个元素的话，DOM 文本就不连续了
 *   （复制粘贴会断，元素之间的缝隙也会让眼睛看到断开的地方）。
 *
 * @param {object} props
 *   name 包名（归一化后）
 *   spec 最终要装的那条 spec（后端给的）
 *   value 当前覆盖的版本（空串表示按上游声明的装）
 *   onChange 改完回调（版本号；空串表示回到上游声明）
 *   editable 是否可编辑
 *   pillProps pill 自己要的属性（点击切换是否安装等）
 */
function SpecPill ({ name, spec, value, onChange, t, disabled, editable = true, pillProps }) {
  const parts = splitSpec(spec)
  // 手写的版本优先：改了之后 pill 上要立刻看到改后的那个号。
  const shown = value || parts.version
  // 编辑态：只有版本号那一位变成输入框。
  //   头（包名与约束）与尾（marker / 注释）照旧显示。
  const [editing, setEditing] = React.useState(false)

  // 点笔不许冒泡到整行：整行是「切换是否安装这个包」的点击区，
  //   笔一点就冒泡 ⇒ 点笔等于把这个包设为不安装。
  const stop = (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
  }
  const startEdit = (e) => {
    stop(e)
    setEditing(true)
  }

  const body = editing
    ? (
      <span className="pkg-version">
        <code>{parts.head}</code>
        <VersionSelect
          name={name}
          version={shown}
          onChange={onChange}
          t={t}
          disabled={disabled}
          onCancelEdit={() => setEditing(false)}
        />
        {parts.tail ? <code>{parts.tail}</code> : null}
      </span>
    )
    : (
      <code>{parts.head}{shown}{parts.tail}</code>
    )

  return (
    <span {...(pillProps || {})}>
      {body}
      {editable && !editing && (
        <button type="button" className="icon-btn pkg-pencil" disabled={disabled}
          aria-label={t(`Change the version of ${name}`, `修改 ${name} 的版本`)}
          title={t(`Change the version of ${name}`, `修改 ${name} 的版本`)}
          onPointerDown={stop}
          onClick={startEdit}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') stop(e) }}>
          <IconPencil size={13} />
        </button>
      )}
    </span>
  )
}

/**
 * 编辑态下的版本号输入框。
 *
 * 形态：pill 里，包名与约束照旧显示，版本号那一位变成输入框，
 *   右边一个取消按钮。
 *
 * 为什么是「铅笔 + 手写」而不是下拉框：
 *   下拉框里的每个选项都是平台给出的候选，而候选意味着平台替使用者挑版本。
 *   版本本是上游声明的事，平台手上没有「这个包有哪些版本」这份事实，
 *   列出来的每个非上游版本都是平台编的。所以这里只留一个手写入口。
 *
 * 为什么只管版本号那一段：pill 上要显示的是整条 spec，而版本号本来
 *   就在那条 spec 里面。这个组件要是再显示一遍整条 spec，
 *   同一个版本号就出现两次（一个是上游原文，一个是手写值），
 *   两处还会不一致。所以调用方负责头与尾，这里只负责版本号。
 *
 * @param {object} props
 *   name 包名（归一化后）
 *   version 当前显示的版本号（后端给的那条 spec 里拆出来的）
 *   onChange 改完回调（版本号；空串表示回到上游声明）
 *   t 翻译函数
 *   disabled 不可用时置灰
 *   onCancelEdit 取消编辑（回到只读态）
 */
function VersionSelect ({ name, version, onChange, t, disabled, onCancelEdit }) {
  const current = version || ''
  const [draft, setDraft] = React.useState(current)

  React.useEffect(() => {
    setDraft(current)
  }, [current])

  // 点这里不许冒泡到整行：整行是「切换是否安装这个包」的点击区。
  const stop = (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
  }

  const cancel = (e) => {
    stop(e)
    setDraft(current)
    onChange(current)
    if (onCancelEdit) onCancelEdit(e)
  }

  return (
    <span className="pkg-version">
      <input className="control" type="text" value={draft} autoFocus
        placeholder={t('Version number', '版本号')}
        aria-label={t(`Version number of ${name}`, `${name} 的版本号`)}
        disabled={disabled}
        onPointerDown={stop}
        onClick={stop}
        onChange={(e) => {
          setDraft(e.target.value)
          onChange(e.target.value.trim())
        }}
        onBlur={() => {
          // 清空输入 = 回到上游声明的版本。
          if (!draft.trim()) onChange('')
          if (onCancelEdit) onCancelEdit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.currentTarget.blur() }
          if (e.key === 'Escape') { cancel(e) }
        }} />
      <button type="button" className="icon-btn pkg-pencil" disabled={disabled}
        aria-label={t('Cancel', '取消')}
        title={t('Cancel', '取消')}
        onPointerDown={stop}
        onClick={cancel}>
        ×
      </button>
    </span>
  )
}

function PackageGroups ({ packages, isSkipped, onToggle, versionOverrides, onVersion, specs, t, disabled }) {
  const on = packages.filter((p) => !isSkipped(p))
  const off = packages.filter((p) => isSkipped(p))
  const row = (p, dim) => {
    const name = pkgName(p)
    // pill 上显示的那条 spec：后端算好的最终那条（与真正装进去的一致）。
    //   后端没给（还没重新算计划）时退回上游原文。
    const spec = finalSpec(specs, name, p)
    // pill 本身是「切换是否安装这个包」的点击区。
    //   笔在 pill 里面 ⇒ 笔自己的点击必须断掉冒泡（VersionSelect 里做了），
    //   否则点笔等于把这个包设为不安装。
    const pillProps = {
      className: 'pf-chip',
      role: onToggle ? 'button' : undefined,
      tabIndex: onToggle ? 0 : undefined,
      onClick: onToggle ? () => onToggle(p) : undefined,
      onKeyDown: onToggle
        ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(p) }
        }
        : undefined,
      style: { cursor: onToggle ? 'pointer' : undefined },
    }
    return (
      <div key={p} className="pkg-row" style={dim ? { opacity: 0.5 } : undefined}>
        {onVersion
          ? (
            // 笔在 pill 里面：版本号是 pill 内容的一部分，笔是改它的入口。
            //   设为不安装的包不给笔：它根本不装，给它版本号没有意义。
            <SpecPill
              name={name}
              spec={spec}
              value={(versionOverrides || {})[name] || ''}
              onChange={(v) => onVersion(name, v)}
              t={t}
              disabled={disabled || dim}
              editable={!dim}
              pillProps={pillProps}
            />
          )
          : (
            <span {...pillProps}><code>{spec}</code></span>
          )}
      </div>
    )
  }
  // 两个分区一直都在：全部安装时「不安装」那栏写明没有不安装的包，
  //   全部不安装时「安装」那栏写明没有要安装的包。
  //   过去只在一半被排除时才显示这两个标题 ⇒ 使用者看到的分组会随点击而变，
  //   看不出这两个分区本来就在。
  return (
    <>
      <div className="layer-label">{t('Packages to install', '要安装的包')}</div>
      {on.length > 0
        ? <div className="pf-chips">{on.map((p) => row(p, false))}</div>
        : <p className="field-hint" style={{ marginTop: 0 }}>
          {t('No package will be installed.', '没有要安装的包。')}
        </p>}
      <div className="layer-label">{t('Packages not to install', '设为不安装的包')}</div>
      {off.length > 0
        ? <div className="pf-chips">{off.map((p) => row(p, true))}</div>
        : <p className="field-hint" style={{ marginTop: 0 }}>
          {t('No package is excluded.', '没有设为不安装的包。')}
        </p>}
    </>
  )
}
