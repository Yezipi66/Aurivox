import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// ============================================================================
//  SAVE BAR —— 存盘
//
//    三件事，按用户的真实需要排：
//   1. **能不能存** —— 先看有没有错，有错就不给存（但如实说为什么）
//   2. **会存到哪** —— 把完整路径摆出来，不让人猜
//   3. **会不会覆盖** —— 已存在时明确问一次，不静默覆盖
//
//    用**项目的** .summary-bar（就是项目给「一行摘要 + 徽标 + 按钮」准备的：
//   flex-wrap / gap 8 / surface + border + radius-md），
//       不再自造 .sv-bar/.sv-path/.sv-blocked/.sv-result。
//
//      纪律：不许出现任何具体引擎名。
// ============================================================================

export default function SaveBar ({ manifest, diag, onSaved }) {
  const { t } = useT()
  const [installed, setInstalled] = React.useState([])
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [confirmOverwrite, setConfirmOverwrite] = React.useState(false)

  React.useEffect(() => {
    fetch('/wizard/installed').then((r) => r.json())
      .then((j) => setInstalled(j.engines || []))
      .catch(() => { /* 拿不到就不显示「已存在」的提示 */ })
  }, [])

  const hasErrors = diag && diag.summary && diag.summary.errors > 0
  const id = manifest && manifest.id
  const exists = !!installed.find((e) => e.id === id)
  const willCreate = !!id && !exists

  //   第 6 章 SaveBar 5 态可视（P3 补，基于 manifest 可推导的信息）：
  //   ① 待扫描 —— call 段还没绑定/参数（bind 空且 args 空）
  //   ② 已自动填 N 项 —— call.bind 有槽位或 call.args 有条目（扫描自动填的标志）
  //   ③ 可保存 —— 有 id 且无硬错
  //   ④ 硬错阻断 —— hasErrors（见下方红条）
  //   ⑤ 扫描中 —— 需 CliGenPanel 的 busy 状态（跨组件），  不在此推断，标遗留。
  //   只从 manifest 现有字段推导，  不做跨组件状态提升（避免动 ManifestForm/
  //    ManifestPage 三处结构、引入回归）。bind 三槽位 + args 条数 = 自动填了多少。
  const call = (manifest && manifest.call) || {}
  const bindSlots = Object.keys(call.bind || {}).filter((k) => call.bind[k])
  const argCount = Object.keys(call.args || {}).length
  const filledCount = bindSlots.length + argCount
  const notScanned = !call.kind || (bindSlots.length === 0 && argCount === 0)

  const save = async (overwrite) => {
    setBusy(true); setResult(null)
    try {
      const r = await fetch('/wizard/save', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest, overwrite, allowCreateDir: true }),
      })
      const j = await r.json()
      setResult(j)
      if (j.ok && onSaved) onSaved(j)
    } catch (e) {
      setResult({ ok: false, error: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="summary-bar">
        {/* ---- 会存到哪 ---- */}
        <code>{`engines/${id || '<id>'}/manifest.json`}</code>
        {willCreate && (
          <span className="badge badge-info">
            {t('will create the folder', '将新建目录')}
          </span>
        )}
        {exists && (
          <span className="badge badge-warn">{t('already exists', '已存在')}</span>
        )}
        {/*   第 6 章 5 态徽标：待扫描 / 已自动填 N 项。
              只用平台 .badge-*，不新增 class。 */}
        {id && notScanned && (
          <span className="badge badge-neutral">
            {t('not scanned yet', '还没扫描')}
          </span>
        )}
        {id && !notScanned && filledCount > 0 && (
          <span className="badge badge-ok">
            {t(`${filledCount} auto-filled`, `已自动填 ${filledCount} 项`)}
          </span>
        )}
        <span style={{ flex: 1 }} />

        {/* ---- 存 ----
              第 6 章：有硬错时**禁用保存 + 说明原因**，  不是让按钮消失。
              旧代码 hasErrors 时整块按钮 null（消失），用户找不到存盘入口
              也不知道为什么 —— 现在是灰置禁用 + 下方红条说明。 */}
        {!hasErrors && exists && !confirmOverwrite
          ? (
            <>
              <button className="btn btn-sm btn-danger" type="button"
                disabled={busy} onClick={() => save(true)}>
                {t('Overwrite', '覆盖')}
              </button>
              <button className="btn btn-sm" type="button"
                onClick={() => setConfirmOverwrite(false)}>
                {t('Cancel', '取消')}
              </button>
            </>
            )
          : (
            <button className="btn btn-sm btn-primary" type="button"
              disabled={busy || !id || hasErrors} onClick={() => save(false)}
              title={hasErrors
                ? t('Fix the errors below first', '先修完下面的错误再存')
                : undefined}>
              {busy ? t('Saving…', '正在存…') : t('Save manifest', '存盘')}
            </button>
            )}
      </div>

      {/*   有错误：整块 msg-danger 列出具体哪几条（  不再横挤在顶栏，像第二步那样占整行）*/}
      {hasErrors && (
        <div className="msg msg-danger" style={{ marginTop: 6 }}>
          <strong>{t(`${diag.summary.errors} problem(s) must be fixed before saving:`,
            `还有 ${diag.summary.errors} 处问题，修完才能存：`)}</strong>
          {((diag.diagnostics || []).filter((d) => d.level === 'error').slice(0, 5)).map((d, i) => {
            const where = d.section || d.field || (d.index !== undefined ? `parameters[${d.index}]` : '')
            return (
              <div key={i} style={{ marginTop: 4 }}>
                {where ? <code>{where}</code> : null}{where ? ' — ' : ''}{d.message}
              </div>
            )
          })}
        </div>
      )}

      {/* ---- 结果 ---- */}
      {result && (
        <div className={`msg ${result.ok ? 'msg-info' : 'msg-danger'}`}>
          {result.ok
            ? (
              <>
                {t('Saved', '已保存')} · <code>{result.path}</code>{' '}
                {result.createdDir && (
                  <span className="badge badge-info">{t('folder created', '已创建目录')}</span>
                )}
                {result.replaced && (
                  <span className="badge badge-warn">{t('overwritten', '已覆盖')}</span>
                )}
              </>
              )
            : (
              <>
                <b>{t('Not saved', '未保存')}</b> · {result.error}
                {result.code === 'EXISTS' && (
                  <button className="btn btn-sm" type="button"
                    style={{ marginLeft: 8 }}
                    onClick={() => setConfirmOverwrite(true)}>
                    {t('Overwrite instead', '改为覆盖')}
                  </button>
                )}
              </>
              )}
        </div>
      )}
    </>
  )
}
