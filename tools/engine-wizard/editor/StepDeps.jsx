import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { RiskUnlock } from './Pipeline'
import { UndoClone } from './UndoClone'
import { loadSession, saveSession } from './useInstallSession'



const VERDICT = {
  match: { mark: '✓', en: 'Matches this machine', zh: '与本机匹配' },
  mismatch: { mark: '!', en: 'Does not match this machine', zh: '与本机不匹配' },
  unknown: { mark: '?', en: 'Cannot determine', zh: '无法判断' },
}

export default function StepDeps ({ state, prep, onFixId, onUndone }) {
  const { t, lang } = useT()
  const engineId = state.id
  const url = state.repoUrl || ''
  // prep.res 是本次会话的解析结果（换 URL 即失效），
  //   它比持久段更接近「用户此刻在装哪台」。
  //   两者不一致时以会话段为准，并把持久段一起纠正过来。
  const sessionId = (prep && prep.res && prep.res.id) || ''
  React.useEffect(() => {
    if (sessionId && sessionId !== state.id && onFixId) onFixId(sessionId)
  }, [sessionId, state.id])
  const targetId = sessionId || engineId

  // 从会话段恢复状态（sessionStorage，刷新不丢、关 tab 丢、换 URL 失效）
  //   懒初始化（useState 初值）而不是 useEffect：首帧就要用恢复值，
  //   否则第 1 帧会把旧值覆盖回默认值再写盘，恢复就白做了。
  const saved = React.useMemo(
    () => loadSession(targetId, url), [targetId, url])

  const [plan, setPlan] = React.useState(saved?.depsPlan || null)
  const [showNormal, setShowNormal] = React.useState(saved?.showNormal || false)
  const [backend, setBackend] = React.useState(saved?.backend || null)
  const [result, setResult] = React.useState(saved?.depsResult || null)
  const [preview, setPreview] = React.useState(saved?.depsPreview || null)
  const [unlocked, setUnlocked] = React.useState(saved?.unlocked || false)
  const [busy, setBusy] = React.useState(false)
  const [live, setLive] = React.useState(null)   // 瞬态，不持久化
  const [tail, setTail] = React.useState([])      // 瞬态，不持久化
  const [progress, setProgress] = React.useState(saved?.depsProgress || null)
  // 取消函数（run() 里挂上，finally 里摘掉）。用 ref 不用 state：
  //   它是「这一次执行」的动作，不是界面状态，进了 state 会触发多余渲染。
  const cancelRef = React.useRef(null)

  // 保存到会话段（排除瞬态状态：busy / live / tail 一段都不存）
  //   键含 id 与 url ⇒ 换任一个，写的都是另一段会话，不会污染旧的。
  React.useEffect(() => {
    if (!targetId) return
    saveSession(targetId, url, {
      depsPlan: plan, showNormal, backend, unlocked,
      depsResult: result, depsPreview: preview, depsProgress: progress,
    })
  }, [targetId, url, plan, showNormal, backend, unlocked, result, preview, progress])

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

  // 只清记录，不删源码、不删已装依赖（那是另一回事）。
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

  // 计划态：进入页面就取一次不执行的计划。
  //   execute: false ⇒ 后端只出计划不执行。
  React.useEffect(() => {
    if (!targetId) return
    let alive = true
    fetch('/wizard/env', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: targetId, manifest: state.manifest || {}, execute: false,
      }),
    }).then((r) => r.json())
      .then((j) => { if (alive) setPreview(j) })
      .catch(() => { if (alive) setPreview(null) })
    return () => { alive = false }
  }, [targetId])

  React.useEffect(() => {
    if (hw && backend === null) setBackend(hw.recommended)
  }, [hw])

  // 只在执行中更新；done 之后保持最后状态让用户看到结果。

  // 读 SSE 流。fetch + ReadableStream（axios 无法读取流）。
  // 不能等 r.json()：那会把流缓冲到最后才一次性返回。
  const run = async () => {
    setBusy(true); setResult(null); setTail([]); setLive({ stage: 'start' })
    try {
      const resp = await fetch('/wizard/env', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: state.id, manifest: state.manifest || {}, execute: true, backend,
        }),
      })
      if (!resp.ok) { setResult({ ok: false, error: 'HTTP ' + resp.status }); return }
      // 取消：打取消端点，让服务端杀掉那个进程（进程树）。
      //   断掉前端的流不杀进程，那只是看不见它在运行。
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

      {/* ---- 本机检测 ---- */}
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

      {/* ---- ② torch 系：三态 ---- */}
      {d && d.torch.count > 0 && (
        <div className="preflight" style={{ marginTop: 0 }}>
          <div className="layer-label">
            {t('GPU-related packages', '与 GPU 相关的包')}
          </div>
          {/* t() 只有两个参数（i18n.jsx:44 `t = (en, zh)`）。
               传三个 ⇒ 第二段英文被当中文返回。 */}
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t('These packages only run on this kind of graphics card. '
              + 'Other cards need a different Torch build.',
              '这些包只能在这种显卡上使用。更换显卡后需要安装其他版本的 Torch。')}
          </p>
          {d.torch.packages.map((r) => {
            const V = VERDICT[r.verdict] || VERDICT.unknown
            return (
              <div key={r.name} className="pf-row">
                <span className="badge badge-sym">{V.mark}</span>
                <span className="pf-val"><code>{r.spec}</code></span>
                <span className="field-hint" style={{ marginTop: 0 }}>
                  {lang === 'zh' ? V.zh : V.en}
                </span>
                {r.why && <span className="pf-warn">{t(r.why, r.whyZh)}</span>}
              </div>
            )
          })}
        </div>
      )}

      {/* ---- ③ 装法：全摆出来 ---- */}
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

      {/* ---- 命令来自 preview（execute:false 的计划），不是 plan ---- */}
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
                  <span className="pf-val"><code>{s.argv.join(' ')}</code></span>
                  <span className="field-hint" style={{ marginTop: 0 }}>
                    {s.ok ? t('done', '完成') : t('failed', '失败')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- 锁文件后端与本机不一致 ⇒ 主命令之后还有第②步 ----
          主命令已带 --no-install-package torch（照锁装其余、跳过 torch），
          此区域显示的是装 torch 那一步，不重复主命令。
          数据来自 preview（进入页面时取的 execute:false 计划），
          不是 plan（/wizard/deps 从 GitHub 拉 lock）。*/}
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

      {/* ---- ① 普通依赖：只给个数，可展开 ---- */}
      {d && d.normal.count > 0 && (
        <div className="collapsible">
          <div className="collapsible-hdr" onClick={() => setShowNormal(!showNormal)}>
            <span>{t('Other packages', '其它包')}</span>
            <span className="field-hint" style={{ marginTop: 0 }}>
              {showNormal ? '▾' : '▸'} {d.normal.count}
            </span>
          </div>
          {showNormal && (
            <div className="collapsible-body">
              <p className="field-hint" style={{ marginTop: 0 }}>
              {t('No graphics-card-specific packages. The same command'
                + ' works on every machine.',
                '不含与显卡相关的依赖包，所有机器使用同一条安装命令。')}
              </p>
              <div className="pf-chips">
                {d.normal.packages.map((p) => (
                  <span key={p} className="pf-chip"><code>{p}</code></span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- 实时进度：busy 时显示 ---- */}
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
          {/* 进度条：有字节进度时按字节显示，有总步数时按步数显示，单步时用不确定动画 */}
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
              <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {tail.join('\n')}
              </pre>
            </div>
          )}
          {/* 取消：只在真的 busy 时给。
              它杀的是服务端那个进程，不是只让前端不再显示。 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-sm" type="button"
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
          但结论要说「已取消」，不许让用户以为装失败了。 */}
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
              <span className="pf-val">
                {t(`Step ${s.n}/${s.of}`, `第 ${s.n}/${s.of} 步`)}
                {' '}<code>{s.argv.join(' ')}</code>
              </span>
              <span className={`pf-warn${s.ok ? '' : ''}`}>
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

      {/* ---- 执行：显式解锁 ----
          RiskUnlock 自己就是「提示 + 勾选 + 按钮」三块，
            不能再塞进一个 flex 行里（那会把提示拆成并排的两列）。*/}
      <RiskUnlock stepKey="env" unlocked={unlocked} onUnlock={setUnlocked}>
        <button className="btn btn-primary btn-sm" type="button"
          disabled={busy} onClick={run}>
          {busy ? t('Installing…', '正在安装…') : t('Install', '安装')}
        </button>
      </RiskUnlock>

      {/* ---- 撤销克隆 ----
          克隆完成后向导直接跳到第 2 步，所以这条路也得在这儿给一份：
            使用者在这儿才真正看到「下一步该做什么」，想反悔时手边要有路。*/}
      {!busy && targetId && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <UndoClone engineId={targetId} onUndone={() => {
            if (onUndone) onUndone()
          }} />
          <span className="field-hint">
            {t('Removes the cloned engine directory and returns to step 1.',
              '删除刚克隆下来的引擎目录，回到第 1 步。')}
          </span>
        </div>
      )}

      {/* ---- 从头重装本步 ----
          只清「哪些步骤算做完了」这份记录（.wizard-install.json 的 env 段），
          不删引擎目录里的源码、不删已装依赖。*/}
      {!busy && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-sm" type="button"
            onClick={() => resetThisStep()}>
            {t('Reinstall this step from the start', '从头重装本步')}
          </button>
          <span className="field-hint">
            {t('Clears the record of finished steps in this step only. Source code '
              + 'and installed packages are kept, and cached wheels are reused.',
              '只清除本步的已完成记录。源码与已安装的依赖保留，已下载的依赖包会复用。')}
          </span>
        </div>
      )}
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
