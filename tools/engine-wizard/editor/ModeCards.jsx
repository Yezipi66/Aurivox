import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { writeSubcommand } from './entryChoiceField'

// 多形态引擎的一次接入：当前名片保持尽量全的形态，另可把若干模式单独接成名片。
// 派生名片沿用基础名片的 runtime、models 与 parameters，环境和权重不复制。
// 哪些模式要单独接、每个模式的命令行长什么样，都由人在这里确认，不替人猜。

function argvTextFor (manifest, sub) {
  const next = writeSubcommand(manifest || {}, sub)
  return (((next && next.call && next.call.argv) || []).join(' '))
}

export default function ModeCards ({ manifest, onDone }) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [modes, setModes] = React.useState(null)
  const [rows, setRows] = React.useState({})
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const [overwrite, setOverwrite] = React.useState(false)

  const baseId = (manifest && manifest.id) || ''
  React.useEffect(() => {
    setModes(null); setRows({}); setResult(null); setErr(null)
  }, [baseId])

  const readModes = async () => {
    if (!manifest || !manifest.id) return
    setBusy(true); setErr(null); setResult(null)
    try {
      const r = await fetch('/wizard/cli-args', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: manifest.id,
          python: (manifest.runtime && manifest.runtime.python) || undefined }),
      })
      const j = await r.json()
      if (!j || !j.ok) { setErr((j && j.error) || t('Scan failed', '扫描未完成')); return }
      const list = (j.subcommands || []).filter((s) => s && s !== '(root)')
      const next = {}
      for (const sub of list) {
        next[sub] = {
          on: false,
          id: `${manifest.id}-${sub}`,
          label: `${manifest.label || manifest.id} ${sub}`,
          argv: argvTextFor(manifest, sub),
          ref: false,
        }
      }
      setModes(list)
      setRows(next)
    } catch (e) {
      setErr(String(e.message || e))
    } finally { setBusy(false) }
  }

  const patch = (sub, key, value) => {
    setRows((cur) => ({ ...cur, [sub]: { ...(cur[sub] || {}), [key]: value } }))
  }

  const picked = (modes || []).filter((s) => rows[s] && rows[s].on)
  const buildPayload = (dryRun) => ({
    base: manifest,
    variants: picked.map((sub) => ({
      id: rows[sub].id,
      label: rows[sub].label,
      argv: String(rows[sub].argv || '').trim().split(/\s+/).filter(Boolean),
      requires_reference_audio: !!rows[sub].ref,
    })),
    overwrite: !!overwrite,
    dryRun: !!dryRun,
  })

  const generate = async (dryRun) => {
    if (picked.length === 0) return
    setBusy(true); setErr(null); setResult(null)
    try {
      const r = await fetch('/wizard/cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPayload(dryRun)),
      })
      const j = await r.json()
      setResult(j)
      if (j && j.ok && !dryRun && typeof onDone === 'function') onDone(j)
    } catch (e) {
      setErr(String(e.message || e))
    } finally { setBusy(false) }
  }

  return (
    <div className="section">
      <div className="section-hdr">
        <button type="button" className="btn btn-sm"
          onClick={() => setOpen((v) => !v)}>
          {t('Mode cards', '按模式生成名片')}
        </button>
        <span className="field-hint">
          {t('One full card stays as it is; selected modes become additional cards sharing the same environment and weights.',
            '当前这张名片保持尽量全的形态；勾选的模式会另生成名片，共用同一份环境和权重。')}
        </span>
      </div>
      {open && (
        <div className="section-body">
          <div className="msg msg-info">
            {t('Save the base card first. Each extra card keeps runtime, models and parameters from it; only the id, label, command line and the reference-audio declaration change.',
              '请先保存基础名片。派生名片继承它的环境、权重与参数，只改引擎 id、名称、命令行和是否需要参考音频。')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-sm" disabled={busy || !baseId}
              onClick={readModes}>
              {t('Read available modes', '读取可用模式')}
            </button>
            <span className="field-hint">
              {modes === null
                ? t('Modes come from the scanned subcommands.', '模式来自扫描到的子命令。')
                : t('Found ' + modes.length + ' modes.', '读到 ' + modes.length + ' 个模式。')}
            </span>
          </div>

          {modes !== null && modes.length > 0 && (
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>{t('Use', '选用')}</th>
                  <th>{t('Mode', '模式')}</th>
                  <th>{t('Engine id', '引擎 id')}</th>
                  <th>{t('Label', '名称')}</th>
                  <th>{t('Command line', '命令行')}</th>
                  <th>{t('Needs reference audio', '需要参考音频')}</th>
                </tr>
              </thead>
              <tbody>
                {modes.map((sub) => {
                  const row = rows[sub] || {}
                  return (
                    <tr key={sub}>
                      <td>
                        <input type="checkbox" checked={!!row.on}
                          onChange={(e) => patch(sub, 'on', e.target.checked)} />
                      </td>
                      <td>{sub}</td>
                      <td><input className="control" value={row.id || ''}
                        onChange={(e) => patch(sub, 'id', e.target.value)} /></td>
                      <td><input className="control" value={row.label || ''}
                        onChange={(e) => patch(sub, 'label', e.target.value)} /></td>
                      <td><input className="control" value={row.argv || ''}
                        onChange={(e) => patch(sub, 'argv', e.target.value)} /></td>
                      <td>
                        <input type="checkbox" checked={!!row.ref}
                          onChange={(e) => patch(sub, 'ref', e.target.checked)} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {modes !== null && modes.length > 0 && (
            <div className="field-hint">
              {t('Batch and validation subcommands are usually not single-utterance entries. Review the command line before generating.',
                '批量与校验类子命令通常不是单次合成入口，生成前请核对命令行。')}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-sm" disabled={busy || picked.length === 0}
              onClick={() => generate(true)}>
              {t('Preview', '预览')}
            </button>
            <button type="button" className="btn btn-sm btn-primary"
              disabled={busy || picked.length === 0}
              onClick={() => generate(false)}>
              {t('Generate ' + picked.length + ' cards', '生成 ' + picked.length + ' 张名片')}
            </button>
            <label className="field-hint" style={{ margin: 0 }}>
              <input type="checkbox" checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)} />
              {' '}{t('Allow overwriting existing cards', '允许覆盖已有名片')}
            </label>
          </div>

          {err && <div className="msg msg-danger" style={{ marginTop: 8 }}>{err}</div>}
          {result && (
            <div style={{ marginTop: 8 }}>
              {(result.results || []).map((r) => (
                <div key={r.id} style={{ marginBottom: 4 }}>
                  <span className={`badge ${r.ok ? 'badge-ok' : 'badge-danger'}`}>
                    {r.ok ? t('OK', '已生成') : (r.code || t('Failed', '未生成'))}
                  </span>
                  {' '}{r.id}{r.path ? ' ' + r.path : ''}
                  {!r.ok && (r.error ? ' ' + r.error : '')}
                </div>
              ))}
              {result.code && !result.results && (
                <div className="msg msg-warn">{result.code} {result.error || ''}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
