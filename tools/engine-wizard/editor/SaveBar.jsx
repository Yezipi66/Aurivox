import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// 存盘栏：把名片的存盘动作摆在编辑页底部，含存盘路径、状态徽标、存盘按钮与结果。
// 状态全部从 manifest 与诊断结果推导：能不能存看有没有硬错，会不会覆盖看目录里有没有同名名片。
// 样式用项目现成的 .summary-bar 与 .badge-*，不新造类名。

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

  // 状态徽标：还没扫描（call 段既没绑定也没参数）、已自动填 N 项。
  // 全部从 manifest 现有字段推导，不做跨组件状态提升：
  // 已填项数 = call.bind 里三个槽位填上的个数 + call.args 的条目数。
  // 扫描中的状态在 CliGenPanel 那边，这里拿不到，也不推断。
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
        {/* 存盘路径 */}
        <code>{`engines/${id || '<id>'}/manifest.json`}</code>
        {willCreate && (
          <span className="badge badge-info">
            {t('will create the folder', '将新建目录')}
          </span>
        )}
        {exists && (
          <span className="badge badge-warn">{t('already exists', '已存在')}</span>
        )}
        {/* 状态徽标：还没扫描 / 已自动填 N 项 */}
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

        {/* 有硬错时禁用存盘按钮并说明原因，按钮不消失：
            消失的话使用者找不到存盘入口，也不知道为什么存不了。 */}
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

      {/* 有硬错时列出具体哪几条，最多显示 5 条 */}
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

      {/* 存盘结果 */}
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
