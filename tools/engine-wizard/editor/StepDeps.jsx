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

  React.useEffect(() => {
    if (hw && backend === null) setBackend(hw.recommended)
  }, [hw])

  const run = async () => {
    setBusy(true); setResult(null)
    try {
      const r = await fetch('/wizard/env', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: state.id, manifest: state.manifest || {}, execute: true, backend,
        }),
      })
      setResult(await r.json())
    } catch (e) {
      setResult({ ok: false, error: e.message })
    } finally { setBusy(false) }
  }

  if (!plan) {
    return (
      <div className="msg msg-info" style={{ marginBottom: 0 }}>
        {t('Clone the repository first.',
          '需要先把仓库克隆下来')}
      </div>
    )
  }

  if (!plan.ok) {
    return (
      <>
        <div className="msg msg-danger">{plan.error}</div>
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
          {hw.reason && <div className="field-hint">{hw.reason}</div>}
          {hw.caveat && <div className="field-hint">⚠ {hw.caveat}</div>}
        </div>
      )}

      {/* ---- ② torch 系：三态 ---- */}
      {d && d.torch.count > 0 && (
        <div className="preflight" style={{ marginTop: 0 }}>
          <div className="layer-label">
            {t('GPU-related packages', '与 GPU 相关的包')}
          </div>
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t('These only run on this kind of graphics card. Other cards need',
              'a different Torch build.',
              '这些包只能在这种显卡上用。换成别的显卡，就要装另一个版本的 Torch。')}
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
                {r.why && <span className="pf-warn">{r.why}</span>}
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
                {' — '}{o.for}
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
        {t('Several GB are downloaded and it takes a while. If it fails halfway, '
          + 'delete the engine folder and run this step again.',
          '需下载数 GB，耗时较长。若中途失败，请删除引擎目录后重新执行本步骤。')}
      </p>

      {result && !result.ok && (
        <div className="msg msg-danger">
          {result.error}
          {result.note && <div className="field-hint">{result.note}</div>}
        </div>
      )}
      {result && result.ok && result.note && (
        <div className="msg msg-info">{result.note}</div>
      )}
    </div>
  )
}

function backendOf (options, key) {
  const o = (options || []).find((x) => x.key === key)
  return o ? o.label : key
}
