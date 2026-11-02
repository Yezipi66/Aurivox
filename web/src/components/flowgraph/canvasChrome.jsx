import { useState, useEffect } from 'react'
import { emptyGraph, pickText } from './graphModel'
import {
  BORDER, PANEL, MUTED, ACCENT, CATEGORY_COLOUR,
  clampDock, buttonStyle, iconButtonStyle, fieldStyle,
} from './canvasShared'

//  Docks — laid out beside the sheet, not on top of it, and resizable.

export function Dock({ label, width, onClose, children }) {
  return (
    <div
      // A drag that starts inside a dock is a dock drag, never a canvas one.
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      style={{
        width, flex: `0 0 ${width}px`, minWidth: 0,
        display: 'flex', flexDirection: 'column', borderRadius: 8, overflow: 'hidden',
        border: `1px solid ${BORDER}`, background: 'rgba(20,23,29,0.98)',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
        borderBottom: `1px solid ${BORDER}`, fontSize: 'var(--fs-11)', fontWeight: 600,
        letterSpacing: 0.5, color: MUTED, textTransform: 'uppercase',
      }}>
        <span>{label}</span>
        <button onClick={onClose} title={label} style={{
          marginLeft: 'auto', ...iconButtonStyle, width: 20, height: 18, fontSize: 'var(--fs-11)',
        }}>✕</button>
      </div>
      {/* One scroll area for the whole dock. Panels inside must not scroll on
          their own — two nested scrollbars in a 300px column is unusable. */}
      <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
    </div>
  )
}

// A closed dock leaves a 26px rail, the way an editor does: still visible,
// still one click from coming back, costing almost nothing.
export function Rail({ side, label, onOpen }) {
  return (
    <button
      onClick={onOpen}
      title={label}
      style={{
        flex: '0 0 26px', width: 26, alignSelf: 'stretch', padding: '8px 0',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 6,
        writingMode: 'vertical-rl', letterSpacing: 2, fontSize: 'var(--fs-11)', cursor: 'pointer',
        borderRadius: 8, border: `1px solid ${BORDER}`, background: PANEL, color: MUTED,
        marginRight: side === 'left' ? 6 : 0, marginLeft: side === 'right' ? 6 : 0,
      }}
    >
      {side === 'left' ? '›' : '‹'} {label}
    </button>
  )
}

// The drag handle between a dock and the sheet. Listeners go on the window for
// the duration of the drag, so the handle keeps following the pointer even when
// it runs ahead onto the canvas.
export function Splitter({ side, width, onResize, onReset }) {
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return undefined
    const onMove = event => {
      const delta = event.clientX - dragging.x
      onResize(clampDock(side === 'left' ? dragging.width + delta : dragging.width - delta, width))
    }
    const stop = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
    // Stops the pointer from selecting text in the panel while dragging.
    const previous = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stop)
      document.body.style.userSelect = previous
    }
  }, [dragging, onResize, side, width])

  return (
    <div
      onMouseDown={e => { e.preventDefault(); setDragging({ x: e.clientX, width }) }}
      onDoubleClick={onReset}
      title="拖动调整宽度，双击恢复默认"
      style={{
        flex: '0 0 6px', width: 6, cursor: 'col-resize', alignSelf: 'stretch',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: 2, height: '100%', borderRadius: 2,
        background: dragging ? ACCENT : 'transparent',
      }} />
    </div>
  )
}

export function Palette({ catalogue, search, setSearch, onPick, lang, t }) {
  const needle = search.trim().toLowerCase()
  const matches = definition => {
    if (!needle) return true
    const haystack = [
      definition.type,
      pickText(definition.label, 'en'),
      pickText(definition.label, 'zh'),
      pickText(definition.help, lang),
    ].join(' ').toLowerCase()
    return haystack.includes(needle)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder={t(`Search nodes (${catalogue.count} available)`, `搜索节点（共 ${catalogue.count} 个）`)}
        style={{ ...fieldStyle, marginBottom: 4 }}
      />
      {catalogue.categories.map(category => {
        const nodes = category.nodes.filter(matches)
        if (!nodes.length) return null
        const colour = CATEGORY_COLOUR[category.id] || CATEGORY_COLOUR.other
        return (
          <div key={category.id}>
            <div
              title={pickText(category.help, lang)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-11)', color: MUTED, margin: '10px 0 5px' }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: colour }} />
              {pickText(category.label, lang, category.id)}
            </div>
            {nodes.map(definition => (
              <button
                key={definition.type}
                onClick={() => onPick(definition)}
                // The tooltip carries what the node does and its technical name,
                // in that order: the sentence is what is needed, the type name is
                // what gets quoted when something goes wrong.
                title={`${pickText(definition.help, lang)}\n(${definition.type})`}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', marginBottom: 3,
                  padding: '6px 9px', fontSize: 'var(--fs-12)', borderRadius: 6, cursor: 'pointer',
                  borderLeft: `2px solid ${colour}`, border: `1px solid ${BORDER}`,
                  borderLeftWidth: 3, borderLeftColor: colour,
                  background: 'rgba(27,31,39,0.9)', color: 'inherit',
                }}
              >
                {pickText(definition.label, lang, definition.type)}
                {definition.suspends && (
                  <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', color: 'var(--warn, #e0b341)' }}>
                    {t('needs input', '需人工介入')}
                  </span>
                )}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

export function Toolbar({
  graph, setGraph, saved, onOpen, onSave, onCheck, onStart, onCancel, busy, problems, status, t,
  docks, setDocks,
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        value={graph.name}
        onChange={e => setGraph(g => ({ ...g, name: e.target.value }))}
        style={{ ...fieldStyle, width: 180 }}
      />
      <button onClick={onSave} disabled={busy} style={buttonStyle}>{t('Save', '保存')}</button>
      <select
        value=""
        onChange={e => e.target.value && onOpen(e.target.value)}
        style={{ ...buttonStyle, cursor: 'pointer' }}
      >
        <option value="">{t('Open…', '打开…')}</option>
        {saved.map(s => (
          <option key={s.graph_id} value={s.graph_id}>
            {t(`${s.name} (${s.node_count} nodes)`, `${s.name}（${s.node_count} 个节点）`)}
          </option>
        ))}
      </select>
      <button onClick={() => setGraph(emptyGraph())} style={buttonStyle}>{t('New', '新建')}</button>
      <span style={{ width: 1, height: 18, background: BORDER, margin: '0 2px' }} />
      <button
        onClick={() => setDocks(d => ({ ...d, leftOpen: !d.leftOpen }))}
        style={{ ...buttonStyle, opacity: docks.leftOpen ? 1 : 0.65 }}
      >{t('Node list', '节点列表')}</button>
      <button
        onClick={() => setDocks(d => ({ ...d, rightOpen: !d.rightOpen }))}
        style={{ ...buttonStyle, opacity: docks.rightOpen ? 1 : 0.65 }}
      >{t('Properties', '属性面板')}</button>
      <div style={{ flex: 1 }} />
      {problems.length > 0 && (
        <span style={{ fontSize: 'var(--fs-11)', color: 'var(--warn, #e0b341)' }}>
          {t(`${problems.length} required inputs not connected`, `${problems.length} 处必填输入未连接`)}
        </span>
      )}
      {status && !status.can_synthesize && (
        // Worth stating plainly: a graph that runs but produces no audio is the
        // most confusing possible outcome.
        <div className="msg msg-warn" style={{ marginTop: 8 }}>
          {t('Synthesis is not configured on this machine; synthesis nodes will fail.', '本机未配置合成服务，合成节点将执行失败')}
        </div>
      )}
      <button onClick={onCheck} style={buttonStyle}>{t('Validate', '校验')}</button>
      {busy
        ? (
          <button onClick={onCancel}
            style={{ ...buttonStyle, background: 'var(--danger, #cf6679)', color: '#fff', borderColor: 'transparent', fontWeight: 600 }}>
            {t('Cancel', '取消')}
          </button>
        )
        : (
          <button onClick={onStart} disabled={false}
            style={{ ...buttonStyle, background: ACCENT, color: '#fff', borderColor: 'transparent', fontWeight: 600 }}>
            {t('Run', '运行')}
          </button>
        )}
    </div>
  )
}

// A section inside a dock: a heading and a rule, no box. Boxes inside a boxed
// dock waste horizontal space and read as a second, unrelated container.
export function Panel({ title, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 'var(--fs-12)', fontWeight: 600, marginBottom: 7, paddingBottom: 5,
        borderBottom: `1px solid ${BORDER}`, wordBreak: 'break-all',
      }}>{title}</div>
      {children}
    </div>
  )
}
