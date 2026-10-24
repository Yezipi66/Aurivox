import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { useInstalled } from './useInstalled'
import ParamPool from './ParamPool'

// 左栏容器：统一入口 + 扫描 + 扫到的参数。
//
// 入口只有一个：选一台引擎，平台看它有没有名片决定后续动作。
//   有名片 ⇒ 先把磁盘上的名片灌进表单（改一台已有的）
//   没名片 ⇒ 直接进扫描（给第 1 步克隆来的引擎建一张）
// 判据来自 GET /wizard/installed?all=1 返回的 manifestPresent。
//
// 扫描不覆盖已有内容：扫到的参数进左栏的池子，参数池只是可拖的源，
// 往中栏落点拖才会改名片。已有名片的引擎扫完之后，
// 名片里原有的 call.args 保持原样。

/**
 * 统一的引擎下拉：列出 engines/ 下的全部目录，标出哪些已经有名片。
 * @returns {Array} {id, manifestPresent, idMatchesDir} 形状的列表
 */
export function useEngineDirs () {
  const [dirs, setDirs] = React.useState([])
  const reload = React.useCallback(() => {
    fetch('/wizard/installed?all=1').then((r) => r.json())
      .then((j) => setDirs(j.engines || []))
      .catch(() => { /* 拿不到就空着，不报错 */ })
  }, [])
  React.useEffect(() => { reload() }, [reload])
  return { dirs, reload }
}

/**
 * 左栏：引擎选择 + 扫描 + 参数池。
 *
 * @param {object} manifest 当前名片
 * @param {Function} onChange 名片变化回调
 * @param {Array} params 扫到的参数（当前分组的）
 * @param {object|null} selected 当前选中的参数
 * @param {Function} onSelect 选中参数回调
 * @param {Function} onDragStart 拖拽开始回调
 * @param {Array} groups 扫到的分组
 * @param {string} group 当前分组
 * @param {Function} onGroupChange 切分组回调
 * @param {boolean} busy 扫描中
 * @param {string|null} err 扫描错误
 * @param {Function} onScan 扫描回调
 * @param {React.ReactNode} children 额外内容（说明与提示）
 */
export default function EngineScanZone ({
  manifest, onChange, params, selected, onSelect, onDragStart,
  groups, group, onGroupChange, busy, err, onScan, children,
}) {
  const { t } = useT()
  const { loadOne } = useInstalled()
  const { dirs } = useEngineDirs()
  const [engineId, setEngineId] = React.useState(manifest.id || '')
  const [picking, setPicking] = React.useState(false)
  const [localErr, setLocalErr] = React.useState(null)

  React.useEffect(() => {
    if (!engineId && manifest.id) setEngineId(manifest.id)
  }, [manifest.id, engineId])

  const selectedDir = dirs.find((d) => d.id === engineId)
  const hasManifest = !!selectedDir && selectedDir.manifestPresent === true

  // 选中一台引擎：有名片的先把磁盘原文灌进表单，没名片的直接进扫描态。
  // 两件事都是「打开这台引擎的名片」，区别只在平台已知的那一个判据。
  const openEngine = async (id) => {
    if (!id) return
    setEngineId(id)
    setLocalErr(null)
    setPicking(true)
    try {
      const target = dirs.find((d) => d.id === id)
      if (!target || target.manifestPresent !== true) {
        // 没名片：把 id 定下来，其余交给扫描。
        onChange({ ...manifest, id, label: manifest.label || id })
        return
      }
      const r = await loadOne(id)
      if (!r.ok) { setLocalErr(r.error || t('Failed to read the manifest', '读取名片失败')); return }
      let parsed
      try { parsed = JSON.parse(r.text) } catch (e) {
        setLocalErr(t('The manifest on disk is not valid JSON', '磁盘上的名片不是合法 JSON'))
        return
      }
      onChange(parsed)
    } finally { setPicking(false) }
  }

  const message = err || localErr

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="field">
        <label className="field-label">{t('Engine', '引擎')}</label>
        <select className="control" value={engineId}
          disabled={picking}
          onChange={(e) => openEngine(e.target.value)}>
          <option value="">{t('— pick an engine —', '— 选一台引擎 —')}</option>
          {dirs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id}{d.manifestPresent ? '' : `（${t('no manifest yet', '还没名片')}）`}
            </option>
          ))}
        </select>
        {hasManifest && (
          <div className="field-hint">
            {t('This engine already has a manifest. The scan lists its parameters on the left; '
              + 'the manifest keeps what it already has.',
              '这台引擎已经有名片。扫描只把参数列在左栏，名片里已有的内容保持原样。')}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        {groups && groups.length > 1 && (
          <div className="field" style={{ flex: 1, minWidth: 0 }}>
            <label className="field-label">{t('Group', '分组')}</label>
            <select className="control" value={group}
              disabled={!params || !params.length}
              onChange={(e) => onGroupChange && onGroupChange(e.target.value)}>
              <option value="">{t('— pick a group —', '— 选一个分组 —')}</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        )}
        <div style={{ flexShrink: 0, paddingBottom: 2 }}>
          <button className="btn btn-sm btn-primary" type="button"
            disabled={busy || !engineId || picking}
            onClick={onScan}>
            {busy
              ? t('Scanning…', '扫描中…')
              : t('Scan parameters', '扫描参数')}
          </button>
        </div>
      </div>

      {message && <div className="msg msg-danger">{message}</div>}

      <ParamPool params={params} selected={selected}
        onSelect={onSelect} onDragStart={onDragStart} />

      {children}
    </div>
  )
}
