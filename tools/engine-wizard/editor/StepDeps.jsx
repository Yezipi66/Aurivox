import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { RiskUnlock } from './Pipeline'

// ============================================================================
//  STEP DEPS —— 第 2 步：读依赖 → 列出要装什么 → 用户选 → 才装
//
//  ⭐⭐ 这个页面只回答一个问题：**现在要装哪些包？**
//
//  ⭐ 三块，排版抄项目的 .preflight 那一档
//    （.preflight + .layer-label + .pf-row/.pf-key/.pf-val/.pf-warn/.pf-chips）：
//
//   ① 普通依赖        「其他直接同步就行」—— ⛔ 不逐个列，只给个数 + 可展开
//   ② torch 系（单独）三态：跟得上 / 不是给这台机器的 / 看不出来
//   ③ 装法选择        所有后端都摆出来（推荐 ≠ 决定）
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

/**
 * Torch 后端与本机的匹配结论 —— 三个可判定的状态。
 *
 * ⛔ 不写「对得上」「看不出来」这类对话里的说法：界面要的是可判定的结论。
 * ⛔ 状态只有三个，⛔ 不把「无法判断」混进「不匹配」——
 *   「读不出来」与「读出来是不匹配」要采取不同的动作。
 * ⛔ mark 用符号（✓ ! ?）是因为它要放进表格第一列，
 *   ⛔ 符号旁边永远跟着完整文字，不靠符号表意。
 */
const VERDICT = {
  match: { mark: '✓', en: 'Matches this machine', zh: '与本机匹配' },
  mismatch: { mark: '!', en: 'Does not match this machine', zh: '与本机不匹配' },
  unknown: { mark: '?', en: 'Cannot determine', zh: '无法判断' },
}

export default function StepDeps ({ state }) {
  const { t, lang } = useT()
  // ⛔ 数据自己取，不靠 App 往下传 —— 那条链路对不上。
  const [plan, setPlan] = React.useState(null)
  const [showNormal, setShowNormal] = React.useState(false)
  const [backend, setBackend] = React.useState(null)
  const [unlocked, setUnlocked] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)

  const url = state.repoUrl || ''
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
  React.useEffect(() => {
    if (url && !plan) reload() /* eslint-disable-line */
  }, [url])

  const d = plan && plan.ok ? plan.deps : null
  const hw = plan ? plan.hardware : null

  // ⭐⭐ 计划态：进入页面就取一次**不执行**的计划。
  //   ⛔ 上一版只在点「安装」后才有 result，而 alternative 在 result 里
  //   ⇒ 用户看计划时看不到第二条命令，那正是它该出现的地方。
  //   ⛔ execute: false ⇒ 后端只出计划不执行（平台只验不建）。
  const [preview, setPreview] = React.useState(null)
  const engineId = state.id
  React.useEffect(() => {
    if (!engineId) return
    let alive = true
    fetch('/wizard/env', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: engineId, manifest: state.manifest || {}, execute: false,
      }),
    }).then((r) => r.json())
      .then((j) => { if (alive) setPreview(j) })
      .catch(() => { if (alive) setPreview(null) })
    return () => { alive = false }
  }, [engineId])

  React.useEffect(() => {
    if (hw && backend === null) setBackend(hw.recommended)
  }, [hw])

  // ⭐⭐ 实时安装状态 —— 进度条 / 当前步骤 / 最近输出
  //   ⛔ 只在执行中更新；done 之后保持最后状态让用户看到结果。
  const [live, setLive] = React.useState(null)   // {stage:'step'|'line', i, total, argv, text, err}
  const [tail, setTail] = React.useState([])      // 最近 N 行输出
  const [progress, setProgress] = React.useState(null) // 字节进度 {name, downloaded, total}

  // ⛔ 读 SSE 流。fetch + ReadableStream（axios 读不了流）。
  //   ⛔ 不能等 r.json() —— 那会把流缓冲到最后才一次性返回。
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
      // ⛔ resp.body 是 ReadableStream —— 逐块读，按 \n\n 切 SSE 事件
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
    } finally { setBusy(false) }
  }

  if (!plan) {
    // ⛔ 陈述当前状态 + 下一步，⛔ 不写「需要先…」这类客服式引导
    //   （「需要」是在解释为什么不能做，而 canStart 已经拦住了，解释给人听没有意义）
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
        </div>
      )}

      {/* ---- ② torch 系：三态 ---- */}
      {d && d.torch.count > 0 && (
        <div className="preflight" style={{ marginTop: 0 }}>
          <div className="layer-label">
            {t('GPU-related packages', '与 GPU 相关的包')}
          </div>
          {/* ⛔⛔ t() 只有两个参数（i18n.jsx:44 `t = (en, zh)`）。
               这里曾传三个 ⇒ 第二段英文被当中文返回，
               中文界面上直接显示 "a different Torch build."（实测截图）。 */}
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

      {/* ---- ⭐ 执行计划：把真正要跑的命令**摆出来** ----
          ⛔ 过去界面上只有「选哪个后端」的下拉，⛔ 没有任何地方显示
          「将要执行的命令是什么」⇒ 用户点安装前看不到要跑什么。
          ⛔ 命令来自 preview（execute:false 的计划），⛔ 不是 plan。*/}
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
          ⛔ 主命令已带 --no-install-package torch（照锁装其余、跳过 torch），
             这一块显示的是**装 torch 那一步**，⛔ 不重复主命令。
          ⚠️ 数据来自 **preview**（进入页面时取的 execute:false 计划），
             ⛔ 不是 plan（/wizard/deps 从 GitHub 拉 lock）。*/}
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

      {/* ---- 执行：显式解锁（照 TrainingTab 的 expert-unlock）----
          ⚠ RiskUnlock 自己就是「提示 + 勾选 + 按钮」三块，
            ⛔ 不能再塞进一个 flex 行里（那会把提示拆成并排的两列）。*/}
      <RiskUnlock stepKey="env" unlocked={unlocked} onUnlock={setUnlocked}>
        <button className="btn btn-primary btn-sm" type="button"
          disabled={busy} onClick={run}>
          {busy ? t('Installing…', '正在装…') : t('Install', '安装')}
        </button>
      </RiskUnlock>
      <p className="field-hint" style={{ marginTop: 0 }}>
        {t('Several GB are downloaded and it takes a while. If it stops midway, '
          + 'run this step again — the download continues from the breakpoint '
          + 'and already-downloaded wheels are kept.',
          '需下载数 GB，耗时较长。若中途停止，重新执行本步骤会从断点续传，'
          + '已下载的依赖不会重下。')}
      </p>

      {/* ---- ⭐ 实时进度：busy 时显示 ---- */}
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
              <span className="badge badge-sym">⬇</span>
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
        </div>
      )}

      {result && !result.ok && (
        <div className="msg msg-danger">
          {t(result.error, result.errorZh)}
          {result.note && <div className="field-hint">{t(result.note, result.noteZh)}</div>}
        </div>
      )}
      {/* ⭐ 逐步结果：⛔ 过去只显示一段 note，⛔ 看不出「跑到第几步、
          每步各自的输出」—— 装依赖要几十分钟，只有这一步才能让人知道进度。*/}
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
