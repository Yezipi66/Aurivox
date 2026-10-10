import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// ============================================================================
//  SAVE BAR —— 存盘
//
//  ⭐ 三件事，按用户的真实需要排：
//   1. **能不能存** —— 先看有没有错，有错就不给存（但如实说为什么）
//   2. **会存到哪** —— 把完整路径摆出来，不让人猜
//   3. **会不会覆盖** —— 已存在时明确问一次，不静默覆盖
//
//  ⭐ 用**项目的** .summary-bar（就是项目给「一行摘要 + 徽标 + 按钮」准备的：
//   flex-wrap / gap 8 / surface + border + radius-md），
//   ⛔⛔ 不再自造 .sv-bar/.sv-path/.sv-blocked/.sv-result。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
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
        <span style={{ flex: 1 }} />

        {/* ---- 存 ---- */}
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
          : !hasErrors
            ? (
              <button className="btn btn-sm btn-primary" type="button"
                disabled={busy || !id} onClick={() => save(false)}>
                {busy ? t('Saving…', '正在存…') : t('Save manifest', '存盘')}
              </button>
              )
            : null}
      </div>

      {/* ⭐ 有错误：整块 msg-danger 列出具体哪几条（⛔ 不再横挤在顶栏，像第二步那样占整行）*/}
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
