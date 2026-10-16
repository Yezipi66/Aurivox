import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// ============================================================================
//  DragBind —— 参数池与槽位绑定
//
//  参数池：cli 扫出的 flag 与 python 反射出的参数名渲染成可操作项，
//  按子命令或加载期分组，每项带上游原话说明。
//
//  绑定目标：call.bind 三槽位与 call.args 列表。
//
//  三种操作方式：
//    鼠标拖动（HTML5 drag&drop，不引库）
//    点击选中再点目标（触屏与无鼠标环境下这是主路径）
//    键盘（combobox 保留，在 CoreBindings 里）
//
//  绑定不直接写盘：改为内存态，用户显式保存才落盘。
// ============================================================================

const BIND_SLOTS = [
  { key: 'text', labelEn: 'Text to synthesize', labelZh: '合成文本' },
  { key: 'ref_audio', labelEn: 'Reference audio', labelZh: '参考音频' },
  { key: 'output_path', labelEn: 'Output path', labelZh: '输出' },
]

export default function DragBind ({ call, params, onChange }) {
  const { t } = useT()
  const bind = (call && call.bind) || {}
  const args = (call && call.args) || {}
  const kind = (call && call.kind) || null

  const [selected, setSelected] = React.useState(null) // 点击选中态

  // 参数池按 group 分组
  const groups = []
  const groupMap = {}
  for (const p of params) {
    const g = p.group || '(root)'
    if (!groupMap[g]) { groupMap[g] = []; groups.push(g) }
    groupMap[g].push(p)
  }

  // 建立绑定：写入 bind 槽位
  const bindToSlot = (param, slotKey) => {
    const nextBind = { ...bind }
    nextBind[slotKey] = param.target
    onChange({ ...(call || {}), bind: nextBind })
  }

  // 建立绑定：写入 args 列表
  const bindToArgs = (param) => {
    if (param.source !== 'cli') return // python 参数不进 args
    const nextArgs = { ...args }
    if (nextArgs[param.name]) return // 已存在，不覆盖
    const entry = { flag: param.target }
    if (param.style) entry.style = param.style
    nextArgs[param.name] = entry
    onChange({ ...(call || {}), args: nextArgs })
  }

  // 移除绑定
  const unbindSlot = (slotKey) => {
    const nextBind = { ...bind }
    delete nextBind[slotKey]
    onChange({ ...(call || {}), bind: nextBind })
  }

  const unbindArg = (name) => {
    const nextArgs = { ...args }
    delete nextArgs[name]
    onChange({ ...(call || {}), args: nextArgs })
  }

  // 点击选中逻辑
  const clickParam = (param) => {
    if (selected && selected.name === param.name && selected.source === param.source) {
      setSelected(null) // 再点一次取消
    } else {
      setSelected(param)
    }
  }

  const clickSlot = (slotKey) => {
    if (!selected) return
    bindToSlot(selected, slotKey)
    setSelected(null)
  }

  const clickArgs = () => {
    if (!selected) return
    bindToArgs(selected)
    setSelected(null)
  }

  // 拖拽逻辑
  const onDragStart = (e, param) => {
    e.dataTransfer.setData('text/plain', JSON.stringify(param))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const onDropSlot = (e, slotKey) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData('text/plain')
    if (!raw) return
    try {
      const param = JSON.parse(raw)
      bindToSlot(param, slotKey)
    } catch {}
  }

  const onDropArgs = (e) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData('text/plain')
    if (!raw) return
    try {
      const param = JSON.parse(raw)
      bindToArgs(param)
    } catch {}
  }

  const onDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  // 判断参数是否已绑定
  const isBoundToSlot = (param) => {
    return BIND_SLOTS.some((s) => bind[s.key] === param.target)
  }

  const isBoundToArgs = (param) => {
    return param.source === 'cli' && !!args[param.name]
  }

  return (
    <div className="section">
      <div className="section-hdr"><h2>{t('Parameter pool and slot binding', '参数池与槽位绑定')}</h2></div>
      <div className="section-body">
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('Drag a parameter to a slot, or click to select then click a target. '
            + 'Keyboard input is available in the Core Mapping section below. '
            + 'Changes take effect after explicit save.',
            '把参数拖到槽位，或点击选中再点目标。键盘输入在下方核心映射区。改动在显式保存后生效。')}
        </p>

        {/* 参数池 */}
        {groups.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <strong className="field-label">{t('Parameter pool', '参数池')}</strong>
            {groups.map((g) => (
              <div key={g} style={{ marginTop: 8 }}>
                <div className="field-hint" style={{ marginBottom: 4 }}>
                  <code>{g}</code>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {groupMap[g].map((p) => {
                    const isSelected = selected && selected.name === p.name && selected.source === p.source
                    const bound = isBoundToSlot(p) || isBoundToArgs(p)
                    return (
                      <div
                        key={`${p.source}-${p.name}`}
                        draggable
                        onDragStart={(e) => onDragStart(e, p)}
                        onClick={() => clickParam(p)}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          cursor: 'grab',
                          background: isSelected ? 'var(--accent)' : bound ? 'var(--bg)' : 'transparent',
                          opacity: bound ? 0.6 : 1,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                        title={p.help || ''}
                      >
                        <code>{p.target}</code>
                        {p.source === 'python' && (
                          <span className="badge badge-neutral">{t('py', 'py')}</span>
                        )}
                        {bound && (
                          <span className="badge badge-ok">{t('bound', '已绑')}</span>
                        )}
                        {p.help && (
                          <span className="field-hint" style={{ fontSize: 10, marginLeft: 4 }}>
                            {p.help}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 绑定目标：call.bind 三槽位 */}
        <div style={{ marginBottom: 16 }}>
          <strong className="field-label">{t('Bind slots', '绑定槽位')}</strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {BIND_SLOTS.map((slot) => (
              <div
                key={slot.key}
                onDrop={(e) => onDropSlot(e, slot.key)}
                onDragOver={onDragOver}
                onClick={() => clickSlot(slot.key)}
                style={{
                  padding: '8px',
                  border: '1px dashed var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  background: selected ? 'var(--bg)' : 'transparent',
                  cursor: selected ? 'pointer' : 'default',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="field-label" style={{ margin: 0 }}>
                    {t(slot.labelEn, slot.labelZh)}
                  </span>
                  <span className="badge badge-accent">{slot.key}</span>
                  {bind[slot.key] && (
                    <code style={{ marginLeft: 'auto' }}>{bind[slot.key]}</code>
                  )}
                  {bind[slot.key] && (
                    <button
                      className="btn btn-sm btn-danger"
                      type="button"
                      onClick={(e) => { e.stopPropagation(); unbindSlot(slot.key) }}
                    >
                      {t('Unbind', '解绑')}
                    </button>
                  )}
                </div>
                {selected && (
                  <div className="field-hint" style={{ marginTop: 4 }}>
                    {t(`Click to bind selected parameter to this slot`,
                      `点击把选中的参数绑到此槽位`)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 绑定目标：call.args 列表 */}
        {kind === 'cli' && (
          <div
            onDrop={onDropArgs}
            onDragOver={onDragOver}
            onClick={clickArgs}
            style={{
              padding: '8px',
              border: '1px dashed var(--border)',
              borderRadius: 'var(--radius-sm)',
              background: selected ? 'var(--bg)' : 'transparent',
              cursor: selected ? 'pointer' : 'default',
            }}
          >
            <strong className="field-label">{t('call.args', 'call.args')}</strong>
            <div style={{ marginTop: 4 }}>
              {Object.keys(args).length === 0 && (
                <div className="field-hint">
                  {t('No arguments bound yet. Drag CLI parameters here.',
                    '尚未绑定参数。把 CLI 参数拖到这里。')}
                </div>
              )}
              {Object.entries(args).map(([name, entry]) => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <code>{name}</code>
                  <span className="field-hint">→</span>
                  <code>{entry.flag}</code>
                  {entry.style && <span className="badge badge-neutral">{entry.style}</span>}
                  <button
                    className="btn btn-sm btn-danger"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); unbindArg(name) }}
                    style={{ marginLeft: 'auto' }}
                  >
                    {t('Delete', '删除')}
                  </button>
                </div>
              ))}
            </div>
            {selected && selected.source === 'cli' && (
              <div className="field-hint" style={{ marginTop: 4 }}>
                {t('Click to add selected parameter to call.args',
                  '点击把选中的参数加进 call.args')}
              </div>
            )}
            {selected && selected.source === 'python' && (
              <div className="field-hint" style={{ marginTop: 4 }}>
                {t('Python parameters do not go into call.args',
                  'Python 参数不进 call.args')}
              </div>
            )}
          </div>
        )}

        {/* 当前绑定状态 JSON 预览 */}
        <details className="expert-block" style={{ marginTop: 16 }}>
          <summary className="expert-summary">
            {t('Current binding state (JSON)', '当前绑定状态（JSON）')}
          </summary>
          <div className="rc-cmd" style={{ marginTop: 8 }}>
            <pre className="rc-cmd-body">
              {JSON.stringify({ bind, args }, null, 2)}
            </pre>
          </div>
        </details>
      </div>
    </div>
  )
}
