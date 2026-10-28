import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { useInstalled } from './useInstalled'
import { useEngineDirs } from './useEngineDirs'
import { useSaveManifest } from './useSaveManifest'
import { manifestForEngineSwitch } from './manifestAutoFill'

// 名片身份条：中栏最上面一行，第 4 步的全部动作都在这一行。
//
//   [引擎 ▾]  [扫描参数 | 读取参数]  engines/<id>/manifest.json            [保存]
//
// 动作按钮只有一个，文字随状态变：
//   没名片的引擎           ⇒ 「扫描参数」：从源码里扫出参数，进左栏。
//   有名片、还没读进来      ⇒ 「读取参数」：把磁盘上这份名片读进表单。
//   读进来之后             ⇒ 回到「扫描参数」：有了名片里的 call.module / runtime.python，
//                            python 反射这时才扫得动（/wizard/discover 依赖它们）。
// 路径在名片「就位」之后才出现：读取成功，或新引擎扫过一次。
//   在那之前显示路径只是在说一个还不存在的东西。
// 保存在最右边，取代原来页面底部那条存盘栏。
//
// 平台填的是「应该是哪」不是「现在是哪」：路径是确定的，
//   但环境建好没有、权重齐没齐，由 install-state 的三态报，徽标里单独说。

const BADGE_TONE = { ok: 'ok', warn: 'warn', muted: 'neutral' }

/**
 * @param {object} manifest 当前名片
 * @param {Function} onChange 名片变化回调
 * @param {object|null} facts install-state 给的完成状态
 * @param {Function} onScan 扫描参数（页面层持有扫描状态）
 * @param {boolean} scanBusy 扫描中
 * @param {boolean} scanned 这台引擎扫过至少一次
 * @param {object|null} diag 校验结果（有硬错时点保存只列问题、不存）
 * @param {Function} onSaved 保存成功回调
 */
export default function EngineIdentity ({
  manifest, onChange, facts, onScan, scanBusy, scanned, diag, onSaved,
}) {
  const { t } = useT()
  const { loadOne } = useInstalled()
  const { dirs, reload: reloadDirs } = useEngineDirs()
  const [engineId, setEngineId] = React.useState(manifest.id || '')
  const [reading, setReading] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)   // 磁盘上的名片已读进表单
  const [localErr, setLocalErr] = React.useState(null)
  // 点过「保存」才列出挡着保存的错误。
  //   进第 4 步时名片还是空的，检查器必然报「少了必填项」；
  //   人还什么都没做就先看到一片红，只会加重心智负担。
  //   计数照常在「检查结果」面板里，想看随时能看；这里只在人要保存时说为什么存不了。
  const [triedSave, setTriedSave] = React.useState(false)

  React.useEffect(() => {
    if (!engineId && manifest.id) setEngineId(manifest.id)
  }, [manifest.id, engineId])

  const selectedDir = dirs.find((d) => d.id === engineId)
  const hasManifest = !!selectedDir && selectedDir.manifestPresent === true

  const { save, busy: saving, result } = useSaveManifest(manifest, hasManifest, (j) => {
    // 新建的名片存下去之后，这台引擎就「有名片」了：下拉与覆盖语义都要跟上。
    reloadDirs()
    setLoaded(true)
    if (onSaved) onSaved(j)
  })

  // 选引擎：只换「正在填哪一台」，不自动读盘。
  //   上一台的内容一律清掉（manifestForEngineSwitch），
  //   不能只改 id：那会把上一台的 runtime 与 call 整段带过去。
  //   有名片的引擎要用户点「读取参数」才读进来。
  const pickEngine = (id) => {
    setEngineId(id)
    setLoaded(false)
    setLocalErr(null)
    setTriedSave(false)
    if (id) onChange(manifestForEngineSwitch(manifest, id, id))
  }

  const readManifest = async () => {
    if (!engineId) return
    setReading(true); setLocalErr(null)
    try {
      const r = await loadOne(engineId)
      if (!r.ok) { setLocalErr(r.error || t('Failed to read the manifest', '读取名片失败')); return }
      let parsed
      try { parsed = JSON.parse(r.text) } catch {
        setLocalErr(t('The manifest on disk is not valid JSON', '磁盘上的名片不是合法 JSON'))
        return
      }
      onChange(parsed)
      setLoaded(true)
    } finally { setReading(false) }
  }

  // 只有一个动作按钮：有名片且没读进来 ⇒ 读取；其余 ⇒ 扫描。
  const needsRead = hasManifest && !loaded
  const ready = loaded || (!hasManifest && scanned)

  const hasErrors = !!(diag && diag.summary && diag.summary.errors > 0)

  const models = facts && facts.models
  const weights = models === true
    ? { tone: 'ok', text: t('Weights ready', '权重已就绪') }
    : models === false
      ? { tone: 'warn', text: t('Weights missing', '权重还没下好') }
      : { tone: 'muted', text: t('Weights not checked', '权重还没查过') }
  const envOk = !!(facts && facts.env === true)
  const engineState = envOk ? weights : { tone: 'muted', text: t('Engine environment not ready', '引擎环境还没建好') }

  return (
    <div className="section">
      <div className="section-body">
        <div className="wz-identity-bar">
          <select className="control wz-identity-engine" value={engineId}
            aria-label={t('Engine', '引擎')}
            disabled={reading || saving}
            onChange={(e) => pickEngine(e.target.value)}>
            <option value="">{t('— pick an engine —', '— 选一台引擎 —')}</option>
            {dirs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}{d.manifestPresent ? '' : `（${t('no manifest yet', '还没名片')}）`}
              </option>
            ))}
          </select>

          {needsRead
            ? (
              <button className="btn btn-sm btn-primary" type="button"
                disabled={!engineId || reading} onClick={readManifest}>
                {reading ? t('Reading…', '读取中…') : t('Read parameters', '读取参数')}
              </button>
              )
            : (
              <button className="btn btn-sm btn-primary" type="button"
                disabled={!engineId || scanBusy} onClick={onScan}>
                {scanBusy ? t('Scanning…', '扫描中…') : t('Scan parameters', '扫描参数')}
              </button>
              )}

          {ready && (
            <code className="wz-identity-path">{`engines/${engineId}/manifest.json`}</code>
          )}
          {engineId && (
            <span className={`badge badge-${BADGE_TONE[engineState.tone]}`}>{engineState.text}</span>
          )}

          <span className="wz-identity-spacer" />

          {/* 有错时按钮照样能点：点了不存，只把挡着的问题列出来。
              灰掉的按钮不告诉人缺什么，而提前列出来又是进门就一片红。 */}
          <button className="btn btn-sm btn-primary" type="button"
            disabled={!ready || saving}
            onClick={() => { if (hasErrors) { setTriedSave(true); return } save() }}>
            {saving ? t('Saving…', '保存中…') : t('Save', '保存')}
          </button>
        </div>

        {localErr && <div className="msg msg-danger">{localErr}</div>}

        {/* 点了保存但有硬错：列出前 5 条，说清为什么没存。修完一条少一条，修完就消失。 */}
        {triedSave && hasErrors && (
          <div className="msg msg-danger">
            <strong>{t(`${diag.summary.errors} problem(s) must be fixed before saving:`,
              `还有 ${diag.summary.errors} 处问题，修完才能保存：`)}</strong>
            {(diag.diagnostics || []).filter((d) => d.level === 'error').slice(0, 5).map((d, i) => {
              const where = d.section || d.field || (d.index !== undefined ? `parameters[${d.index}]` : '')
              return (
                <div key={i}>
                  {where ? <code>{where}</code> : null}{where ? ' — ' : ''}{d.message}
                </div>
              )
            })}
          </div>
        )}

        {result && (
          <div className={`msg ${result.ok ? 'msg-info' : 'msg-danger'}`}>
            {result.ok
              ? <>{t('Saved', '已保存')} · <code>{result.path}</code></>
              : <><b>{t('Not saved', '未保存')}</b> · {result.error}</>}
          </div>
        )}
      </div>
    </div>
  )
}
