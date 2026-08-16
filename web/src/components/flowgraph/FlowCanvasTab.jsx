import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { usePersistentState } from '../../usePersistentState'
import {
  emptyGraph, addNode, moveNode, setParam, removeNode, connect, disconnect,
  edgesOf, missingInputs, findDefinition, colourFor,
  pickText, clampZoom, zoomAround, isTypingTarget, describeValue,
  voicePreset, applyPreset,
  ZOOM_MIN, ZOOM_MAX,
} from './graphModel'

// ---------------------------------------------------------------------------
//  The canvas
// ---------------------------------------------------------------------------
// Laid out like an editor: a dock on each side for the node list and the
// settings/run report, the sheet in the middle taking every pixel that is left.
// The docks sit beside the sheet rather than over it, can be dragged to any
// width, and collapse to a rail — the sheet is the subject of this page and
// nothing is allowed to cover it.
//
// The rule this page is built to keep: a node that exists on the server can be
// dragged out and used here without any per-node code. Everything drawn below
// comes from what the server says the node has (ports, types, settings, and the
// sentence that explains each of them), so a new node on the back end shows up
// here — explained, in both interface languages — on the next reload.

const NODE_WIDTH = 252
const ROW_HEIGHT = 22
const HEADER_HEIGHT = 32
const PARAM_ROW = 18
const PORT_TOP = 16

// How far the sheet extends. It used to be a fixed 4000 x 3000, which cut the
// drawing off for anyone who dragged a node past it; now it always reaches well
// past the furthest node.
const MIN_SHEET_W = 2600
const MIN_SHEET_H = 1600

// Dock sizing. The docks are draggable, so these are only starting points; the
// limits exist so a dock can never be dragged to a width nothing fits in, or
// wide enough to leave no canvas.
const DEFAULT_LEFT = 220
const DEFAULT_RIGHT = 300
const DOCK_MIN = 170
const DOCK_MAX = 560

function clampDock(width, fallback) {
  const value = Number(width)
  if (!Number.isFinite(value)) return fallback
  return Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(value)))
}

const BORDER = 'var(--border, #2a2f3a)'
const PANEL = 'var(--panel, #14171d)'
const MUTED = 'var(--muted, #8b93a3)'
const ACCENT = 'var(--accent, #4c8dff)'

// One colour per category, used as a thin band on the node and as a dot in the
// node list, so the kind of a node is readable before its name is.
const CATEGORY_COLOUR = {
  load: '#4c8dff',
  process: '#43b5a0',
  logic: '#a97bff',
  loop: '#e0b341',
  quality: '#ef8f5a',
  sink: '#7e879b',
  other: '#7e879b',
}

function portY(index) {
  return HEADER_HEIGHT + PORT_TOP + index * ROW_HEIGHT
}

function nodeHeight(definition) {
  const rows = Math.max(definition?.inputs?.length || 0, definition?.outputs?.length || 0)
  const params = definition?.params?.length || 0
  return HEADER_HEIGHT + PORT_TOP + rows * ROW_HEIGHT + (params ? params * PARAM_ROW + 12 : 0) + 12
}

function sheetSize(nodes, catalogue) {
  let right = 0
  let bottom = 0
  for (const node of nodes) {
    right = Math.max(right, (node.position?.x || 0) + NODE_WIDTH)
    bottom = Math.max(bottom, (node.position?.y || 0) + nodeHeight(findDefinition(catalogue, node.type)))
  }
  return { width: Math.max(MIN_SHEET_W, right + 800), height: Math.max(MIN_SHEET_H, bottom + 500) }
}

export function FlowCanvasTab() {
  const { lang, t } = useT()
  const [catalogue, setCatalogue] = useState(null)
  const [status, setStatus] = useState(null)
  // The graph you are working on survives leaving the page and reloading the
  // browser. It uses the same store every other tab in this app uses, so it
  // is cleared by the same version bump as everything else.
  const [graph, setGraph] = usePersistentState('flowgraph.draft', () => emptyGraph(), {
    rehydrate: value => (value && Array.isArray(value.nodes) ? value : emptyGraph()),
  })
  const [saved, setSaved] = useState([])
  const [selected, setSelected] = useState(null)
  const [run, setRun] = useState(null)
  // Which node the last failure landed on. A failed run comes back as an error
  // rather than a report, so without this the canvas shows no state at all for
  // the one case where you most need to see it.
  const [failedNode, setFailedNode] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [search, setSearch] = useState('')
  // The voices saved on this machine. Loaded once so the voice setting can be a
  // list to pick from instead of an id to remember and type correctly.
  const [voices, setVoices] = useState([])
  const [dragWire, setDragWire] = useState(null)
  const [pointer, setPointer] = useState({ x: 0, y: 0 })
  // The two docks: open/closed and how wide. Widths are yours to drag and they
  // are remembered, because a fixed width is only ever right for one screen.
  const [docks, setDocks] = usePersistentState('flowgraph.docks', () => ({
    leftOpen: true, rightOpen: true, leftWidth: DEFAULT_LEFT, rightWidth: DEFAULT_RIGHT,
  }), {
    rehydrate: value => ({
      leftOpen: value?.leftOpen !== false,
      rightOpen: value?.rightOpen !== false,
      leftWidth: clampDock(value?.leftWidth, DEFAULT_LEFT),
      rightWidth: clampDock(value?.rightWidth, DEFAULT_RIGHT),
    }),
  })
  const [zoom, setZoom] = usePersistentState('flowgraph.zoom', () => 1, {
    rehydrate: value => clampZoom(Number(value)),
  })
  const canvasRef = useRef(null)
  const dragNode = useRef(null)
  const panRef = useRef(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // Notices are held as a pair and translated at the moment they are drawn, so
  // switching language does not leave a stale sentence in the old one.
  const say = useCallback((en, zh, bad = false) => setNote({ bad, en, zh }), [])

  // -- loading ---------------------------------------------------------------

  const reloadSaved = useCallback(() => {
    api('/api/flowgraph/graphs').then(r => { if (r.ok) setSaved(r.data.graphs || []) }).catch(() => {})
  }, [])

  useEffect(() => {
    api('/api/flowgraph/nodes').then(r => { if (r.ok) setCatalogue(r.data) })
      .catch(() => say('Cannot reach the canvas service.', '无法连接画布服务。', true))
    api('/api/flowgraph/status').then(r => { if (r.ok) setStatus(r.data) }).catch(() => {})
    // The voice list is the broker's, read only. If it cannot be reached the
    // voice setting falls back to a plain text box rather than blocking the page.
    api('/api/voices').then(r => { if (r.ok) setVoices(r.data.voices || r.data || []) }).catch(() => {})
    reloadSaved()
  }, [reloadSaved, say])

  const problems = useMemo(
    () => (catalogue ? missingInputs(graph, catalogue) : []),
    [graph, catalogue],
  )
  const edges = useMemo(() => edgesOf(graph), [graph])
  const nodeById = useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph])
  const sheet = useMemo(() => sheetSize(graph.nodes, catalogue), [graph.nodes, catalogue])

  const statusByNode = useMemo(() => {
    const map = new Map()
    for (const n of run?.nodes || []) map.set(n.node_id, n.status)
    if (failedNode) map.set(failedNode, 'failed')
    return map
  }, [run, failedNode])

  // -- voice as a preset ------------------------------------------------------

  // Copies a voice's settings into an engine-parameters node, once. There is no
  // link afterwards: the values become this graph's own and can be edited, and
  // editing them never touches the voice. If the graph has no parameters node
  // yet, one is placed next to the engine node rather than asking for it first.
  const importVoicePreset = useCallback(async (engineNodeId, voiceId) => {
    if (!voiceId) return
    let record = null
    try {
      const r = await api('/api/voices/full')
      if (!r.ok) throw new Error('unavailable')
      const all = r.data?.voices || r.data || {}
      record = Array.isArray(all) ? all.find(v => v.id === voiceId) : all[voiceId]
    } catch {
      say('Cannot read the voice list, so nothing was filled in.',
        '无法读取音色清单，未填充任何参数。', true)
      return
    }
    const preset = voicePreset(record)
    if (Object.keys(preset).length === 0) {
      say(`Voice ${voiceId} carries no engine settings, so nothing was filled in.`,
        `音色 ${voiceId} 未记录引擎参数，未填充任何参数。`, true)
      return
    }
    setGraph(g => {
      let next = g
      let target = g.nodes.find(n => n.type === 'io.engine_params')
      if (!target) {
        const definition = findDefinition(catalogue, 'io.engine_params')
        if (!definition) return g
        const anchor = g.nodes.find(n => n.id === engineNodeId)
        next = addNode(next, definition, {
          x: (anchor?.position?.x || 60),
          y: (anchor?.position?.y || 60) + 150,
        })
        target = next.nodes[next.nodes.length - 1]
      }
      const result = applyPreset(next, target.id, preset)
      const applied = result.applied.length
      const skipped = result.skipped
      say(
        `Filled ${applied} settings on ${target.id} from voice ${voiceId}${skipped.length ? `; ${skipped.length} not applicable here` : ''}. Every value can now be edited.`,
        `已按音色 ${voiceId} 填充节点 ${target.id} 的 ${applied} 项参数${skipped.length ? `，另有 ${skipped.length} 项不适用于该节点` : ''}。填充后的每一项均可手动修改。`,
      )
      return result.graph
    })
  }, [catalogue, say])

  // -- dragging nodes and wires ----------------------------------------------

  // Screen point -> point on the sheet. Dividing by the zoom is what keeps a
  // node under the pointer when the sheet is not at 100%.
  const canvasPoint = useCallback(event => {
    const box = canvasRef.current?.getBoundingClientRect()
    const z = zoomRef.current || 1
    return {
      x: (event.clientX - (box?.left || 0) + (canvasRef.current?.scrollLeft || 0)) / z,
      y: (event.clientY - (box?.top || 0) + (canvasRef.current?.scrollTop || 0)) / z,
    }
  }, [])

  // Every gesture ends here, and it ends *completely*. The bug this replaces:
  // clicking an input port stopped the event, so the node-drag started by the
  // same mousedown was never cleared and the node stayed glued to the pointer
  // with no button held down. Nothing may cancel a gesture only halfway.
  const endGesture = useCallback(() => {
    dragNode.current = null
    panRef.current = null
    // Releasing over empty space cancels the connection rather than leaving a
    // line hanging around waiting for a click nobody expects.
    setDragWire(null)
  }, [])

  // Esc undoes whatever is in progress — including putting a half-dragged node
  // back where it started. Before this, Esc during a drag did nothing visible,
  // which read as "Esc does not work".
  const cancelGesture = useCallback(() => {
    const dragged = dragNode.current
    const hadWire = !!dragWire
    endGesture()
    if (dragged) {
      setGraph(g => moveNode(g, dragged.id, dragged.origin))
      say('Cancelled: the node has been restored to its previous position.', '已取消：节点已还原至拖动前的位置。')
      return true
    }
    if (hadWire) {
      say('Cancelled: the connection was not created.', '已取消：连线未建立。')
      return true
    }
    if (selected) {
      setSelected(null)
      say('No operation in progress; selection cleared.', '当前无进行中的操作，已取消选中。')
      return true
    }
    say('Nothing to cancel.', '当前无可取消的操作。')
    return false
  }, [dragWire, endGesture, say, selected, setGraph])

  const deleteSelected = useCallback(() => {
    if (!selected) {
      say('Select a node first, then press Delete.', '请先选中节点，再按 Delete。', true)
      return
    }
    const gone = selected
    setGraph(g => removeNode(g, gone))
    setSelected(null)
    endGesture()
    say(`Node ${gone} and all of its connections have been deleted.`, `已删除节点 ${gone} 及其全部连线。`)
  }, [endGesture, say, selected, setGraph])

  const onCanvasMove = useCallback(event => {
    // Panning is read straight off the scroll box, so it composes with the
    // scrollbars instead of fighting them.
    if (panRef.current) {
      const box = canvasRef.current
      if (box) {
        box.scrollLeft = panRef.current.left - (event.clientX - panRef.current.x)
        box.scrollTop = panRef.current.top - (event.clientY - panRef.current.y)
      }
      return
    }
    const point = canvasPoint(event)
    if (dragWire) setPointer(point)
    if (dragNode.current) {
      const { id, offsetX, offsetY } = dragNode.current
      setGraph(g => moveNode(g, id, { x: point.x - offsetX, y: point.y - offsetY }))
    }
  }, [canvasPoint, dragWire, setGraph])

  const onCanvasUp = useCallback(() => { endGesture() }, [endGesture])

  // Middle button (1) or right button (2) grabs the sheet and drags the view.
  const onCanvasDown = useCallback(event => {
    if (event.button !== 1 && event.button !== 2) return
    event.preventDefault()
    const box = canvasRef.current
    panRef.current = {
      x: event.clientX, y: event.clientY,
      left: box?.scrollLeft || 0, top: box?.scrollTop || 0,
    }
  }, [])

  // The wheel zooms. It has to be attached by hand with { passive: false }:
  // React attaches wheel listeners as passive, so an onWheel prop cannot stop
  // the page from scrolling underneath and the sheet would slide away while
  // zooming. The listener is on the scroll box only, so a wheel over one of the
  // docks scrolls that dock instead.
  useEffect(() => {
    const box = canvasRef.current
    if (!box) return undefined
    const onWheel = event => {
      event.preventDefault()
      const rect = box.getBoundingClientRect()
      const next = zoomAround({
        zoom: zoomRef.current,
        factor: event.deltaY < 0 ? 1.1 : 1 / 1.1,
        pointer: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        scroll: { left: box.scrollLeft, top: box.scrollTop },
      })
      setZoom(next.zoom)
      box.scrollLeft = next.left
      box.scrollTop = next.top
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [setZoom, catalogue])

  // Zoom from the buttons keeps the middle of the visible area still.
  const zoomBy = useCallback(factor => {
    const box = canvasRef.current
    const rect = box?.getBoundingClientRect()
    const next = zoomAround({
      zoom: zoomRef.current,
      factor,
      pointer: { x: (rect?.width || 0) / 2, y: (rect?.height || 0) / 2 },
      scroll: { left: box?.scrollLeft || 0, top: box?.scrollTop || 0 },
    })
    setZoom(next.zoom)
    if (box) { box.scrollLeft = next.left; box.scrollTop = next.top }
  }, [setZoom])

  // Esc, Delete and Backspace. Listened for on the way down and in the capture
  // phase, so a key press is acted on while the gesture is still running rather
  // than after something else has swallowed it.
  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') {
        cancelGesture()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        // Backspace inside a text box must still delete a character — losing a
        // node while editing the text about to be synthesised would be an
        // unacceptable way to lose work.
        if (isTypingTarget(event.target)) return
        if (!selected) return
        event.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cancelGesture, deleteSelected, selected])

  const startNodeDrag = (event, node) => {
    if (event.button !== 0) return   // middle/right belong to the canvas pan
    event.stopPropagation()
    const point = canvasPoint(event)
    dragNode.current = {
      id: node.id,
      offsetX: point.x - node.position.x,
      offsetY: point.y - node.position.y,
      // Remembered so Esc can restore it.
      origin: { x: node.position.x, y: node.position.y },
    }
    setSelected(node.id)
  }

  const startWire = (event, nodeId, port, type) => {
    if (event.button !== 0) return
    event.stopPropagation()
    setPointer(canvasPoint(event))
    setDragWire({ node: nodeId, port, type })
  }

  const finishWire = (event, nodeId, port, wired) => {
    event.stopPropagation()
    const pending = dragWire
    // Clear first, unconditionally. Whatever happens below, no gesture survives
    // this function.
    endGesture()
    if (!pending) {
      // Clicking a connected input port with nothing in hand disconnects it.
      // One click, the same click that connected it — no hidden double-click.
      if (wired) { setGraph(g => disconnect(g, { node: nodeId, port }, null)); setNote(null) }
      return
    }
    const result = connect(graph, catalogue, { node: pending.node, port: pending.port }, { node: nodeId, port })
    if (!result.ok) {
      setNote({ bad: true, en: result.reason_i18n?.en || result.reason, zh: result.reason_i18n?.zh || result.reason })
    } else { setGraph(result.graph); setNote(null) }
  }

  // -- the buttons -----------------------------------------------------------

  const drop = definition => {
    setGraph(g => addNode(g, definition, { x: 120 + (g.nodes.length % 5) * 70, y: 90 + (g.nodes.length % 7) * 50 }))
  }

  const save = async () => {
    setBusy(true)
    const r = await api('/api/flowgraph/graphs', { method: 'POST', body: { graph } })
    setBusy(false)
    if (r.ok) {
      setGraph(r.data.graph); reloadSaved()
      say(`Saved: ${r.data.graph.name}`, `已保存：${r.data.graph.name}`)
    } else {
      const detail = r.data?.error?.message || ''
      say(detail || 'Save failed.', detail || '保存失败。', true)
    }
  }

  const open = async graphId => {
    const r = await api(`/api/flowgraph/graphs/${graphId}`)
    if (r.ok) { setGraph(r.data.graph); setRun(null); setFailedNode(null); setSelected(null); setNote(null) }
  }

  const check = async () => {
    const r = await api('/api/flowgraph/check', { method: 'POST', body: { graph } })
    if (!r.ok) {
      const detail = r.data?.error?.message || ''
      return say(detail || 'Validation could not be carried out.', detail || '校验无法执行。', true)
    }
    if (r.data.ok) return say('Validation passed. The graph is ready to run.', '校验通过，可以运行。')
    const joined = r.data.problems.map(p => p.message).join('；')
    return say(
      `Validation failed, ${r.data.problems.length} issues: ${joined}`,
      `校验未通过，共 ${r.data.problems.length} 处：${joined}`,
      true,
    )
  }

  const start = async () => {
    setBusy(true)
    setRun(null)
    setFailedNode(null)
    const r = await api('/api/flowgraph/runs', { method: 'POST', body: { graph } })
    setBusy(false)
    if (r.ok) { setRun(r.data); setNote(null) }
    else {
      setFailedNode(r.data?.error?.node_id || null)
      const text = describeFailure(r.data?.error)
      setNote({ bad: true, en: text.en, zh: text.zh })
    }
  }

  const answer = async value => {
    setBusy(true)
    const r = await api(`/api/flowgraph/runs/${run.run_id}/resume`, { method: 'POST', body: { value } })
    setBusy(false)
    if (r.ok) { setRun(r.data); setFailedNode(null); setNote(null) }
    else {
      setFailedNode(r.data?.error?.node_id || null)
      const text = describeFailure(r.data?.error)
      setNote({ bad: true, en: text.en, zh: text.zh })
    }
  }

  const selectedNode = selected ? nodeById.get(selected) : null
  const selectedDef = selectedNode ? findDefinition(catalogue, selectedNode.type) : null

  if (!catalogue) {
    return (
      <div style={{ padding: 24, color: MUTED }}>
        {t(
          'Loading the node catalogue… if it does not arrive, check that the canvas was enabled at startup.',
          '正在加载节点清单…（若长时间无响应，请确认启动时已启用画布）',
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: 'calc(100vh - 92px)' }}>
      <Toolbar
        graph={graph} setGraph={setGraph} saved={saved} onOpen={open}
        onSave={save} onCheck={check} onStart={start} busy={busy}
        problems={problems} status={status} t={t}
        docks={docks} setDocks={setDocks}
      />

      {/* Editor layout: a dock on each side, the sheet in the middle, a drag
          handle between them. The docks are laid out beside the sheet rather
          than floating over it — a panel that covers the node you are editing
          is worse than no panel. */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 0 }}>
        {docks.leftOpen
          ? (
            <>
              <Dock label={t('Nodes', '节点')} width={docks.leftWidth}
                onClose={() => setDocks(d => ({ ...d, leftOpen: false }))}>
                <Palette catalogue={catalogue} search={search} setSearch={setSearch} onPick={drop} lang={lang} t={t} />
              </Dock>
              <Splitter side="left" width={docks.leftWidth}
                onResize={w => setDocks(d => ({ ...d, leftWidth: w }))}
                onReset={() => setDocks(d => ({ ...d, leftWidth: DEFAULT_LEFT }))} />
            </>
          )
          : <Rail side="left" label={t('Nodes', '节点')} onOpen={() => setDocks(d => ({ ...d, leftOpen: true }))} />}

      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <div
          ref={canvasRef}
          onMouseDown={onCanvasDown}
          onMouseMove={onCanvasMove}
          onMouseUp={onCanvasUp}
          onMouseLeave={onCanvasUp}
          // Without this the right button opens the browser menu mid-pan.
          onContextMenu={e => e.preventDefault()}
          onClick={() => setSelected(null)}
          style={{
            position: 'absolute', inset: 0, overflow: 'auto', borderRadius: 10,
            border: `1px solid ${BORDER}`, background: 'var(--panel, #11141a)',
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          }}
        >
          {/* The outer box is the sheet at its zoomed size, so the scrollbars
              know how far there is to go; the inner one is the sheet at its own
              size, scaled. Two boxes, because a CSS transform does not change
              how much room an element takes up. */}
          <div style={{ position: 'relative', width: sheet.width * zoom, height: sheet.height * zoom }}>
            <div style={{
              position: 'absolute', top: 0, left: 0, width: sheet.width, height: sheet.height,
              transform: `scale(${zoom})`, transformOrigin: '0 0',
            }}>
              <svg style={{ position: 'absolute', inset: 0, width: sheet.width, height: sheet.height, pointerEvents: 'none' }}>
                {edges.map((edge, i) => {
                  const geometry = wireGeometry(edge, nodeById, catalogue)
                  if (!geometry) return null
                  return (
                    <path key={i} d={geometry.d} fill="none" strokeWidth={2}
                      stroke={geometry.colour} opacity={0.8} />
                  )
                })}
                {dragWire && (() => {
                  const source = nodeById.get(dragWire.node)
                  const def = findDefinition(catalogue, source?.type)
                  const index = def?.outputs.findIndex(p => p.name === dragWire.port) ?? 0
                  const x = (source?.position.x || 0) + NODE_WIDTH
                  const y = (source?.position.y || 0) + portY(index)
                  return <path d={curve(x, y, pointer.x, pointer.y)} fill="none" strokeWidth={2}
                    stroke={colourFor(dragWire.type)} strokeDasharray="5 4" />
                })()}
              </svg>

              {graph.nodes.map(node => (
                <NodeBox
                  key={node.id}
                  node={node}
                  definition={findDefinition(catalogue, node.type)}
                  selected={selected === node.id}
                  runStatus={statusByNode.get(node.id)}
                  lang={lang}
                  t={t}
                  onDragStart={startNodeDrag}
                  onStartWire={startWire}
                  onFinishWire={finishWire}
                  onDisconnect={(port, source) => setGraph(g => disconnect(g, { node: node.id, port }, source))}
                />
              ))}
            </div>
          </div>
        </div>

        {graph.nodes.length === 0 && (
          <div style={{
            position: 'absolute', left: 28, top: 24, maxWidth: 520,
            color: MUTED, fontSize: 13, lineHeight: 2, pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 14, color: 'var(--text, #d8dbe2)', marginBottom: 6 }}>
              {t('Getting started', '使用方法')}
            </div>
            {t('1. Choose a node from the list on the left to place it on the sheet.', '1. 在左侧列表中选择节点，即可放入画布。')}<br />
            {t('2. Drag from an output port on the right of a node to an input port on the left of another.', '2. 从节点右侧的输出端口拖动至另一节点左侧的输入端口，即可建立连线。')}<br />
            {t('3. Only compatible types connect; a refused connection states the reason.', '3. 仅类型兼容的端口可以连接；连接被拒绝时会说明原因。')}<br />
            {t('4. Click a connected input port to disconnect it.', '4. 单击已连接的输入端口即可断开该连线。')}<br />
            {t('5. Hold the middle or right button to pan; the wheel zooms.', '5. 按住中键或右键拖动可平移画布，滚轮缩放。')}<br />
            {t('6. Esc cancels the current operation; Delete removes the selected node.', '6. Esc 取消当前操作，Delete 删除选中的节点。')}
          </div>
        )}

        {note && (
          <div style={{
            position: 'absolute', left: '50%', top: 12, transform: 'translateX(-50%)',
            maxWidth: '58%', padding: '7px 12px', borderRadius: 8, fontSize: 12, zIndex: 5,
            background: note.bad ? 'rgba(50,24,29,0.96)' : 'rgba(22,40,26,0.96)',
            color: note.bad ? 'var(--danger, #e08a95)' : 'var(--success, #7bc47f)',
            border: `1px solid ${note.bad ? 'rgba(207,102,121,0.45)' : 'rgba(76,175,80,0.45)'}`,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)', whiteSpace: 'pre-wrap', cursor: 'pointer',
          }} onClick={() => setNote(null)}>{t(note.en, note.zh)}</div>
        )}

        <div style={{
          position: 'absolute', right: 12, bottom: 12, display: 'flex', alignItems: 'center',
          gap: 2, padding: 3, borderRadius: 8, background: 'rgba(20,23,29,0.92)',
          border: `1px solid ${BORDER}`, boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        }}>
          <button onClick={() => zoomBy(1 / 1.25)} disabled={zoom <= ZOOM_MIN} style={iconButtonStyle} title={t('Zoom out', '缩小')}>−</button>
          <button onClick={() => setZoom(1)} style={{ ...iconButtonStyle, width: 52, fontVariantNumeric: 'tabular-nums' }} title={t('Reset to 100%', '恢复 100%')}>
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={() => zoomBy(1.25)} disabled={zoom >= ZOOM_MAX} style={iconButtonStyle} title={t('Zoom in', '放大')}>+</button>
        </div>

        <div style={{
          position: 'absolute', left: 12, bottom: 12, fontSize: 11, color: MUTED,
          pointerEvents: 'none',
        }}>
          {t(
            'Wheel: zoom · Middle / right drag: pan · Esc: cancel · Delete: remove selected node',
            '滚轮缩放 · 中键或右键拖动平移 · Esc 取消当前操作 · Delete 删除选中节点',
          )}
        </div>
      </div>

        {docks.rightOpen
          ? (
            <>
              <Splitter side="right" width={docks.rightWidth}
                onResize={w => setDocks(d => ({ ...d, rightWidth: w }))}
                onReset={() => setDocks(d => ({ ...d, rightWidth: DEFAULT_RIGHT }))} />
              <Dock label={t('Properties', '属性')} width={docks.rightWidth}
                onClose={() => setDocks(d => ({ ...d, rightOpen: false }))}>
                <Inspector
                  node={selectedNode} definition={selectedDef} graph={graph} catalogue={catalogue}
                  lang={lang} t={t} voices={voices}
                  onImportVoice={voiceId => importVoicePreset(selectedNode.id, voiceId)}
                  onChange={(name, value) => setGraph(g => setParam(g, selectedNode.id, name, value))}
                  onDelete={deleteSelected}
                />
                <RunPanel run={run} busy={busy} onAnswer={answer} problems={problems} lang={lang} t={t} />
              </Dock>
            </>
          )
          : <Rail side="right" label={t('Properties', '属性')} onOpen={() => setDocks(d => ({ ...d, rightOpen: true }))} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Docks — laid out beside the sheet, not on top of it, and resizable.
// ---------------------------------------------------------------------------

function Dock({ label, width, onClose, children }) {
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
        borderBottom: `1px solid ${BORDER}`, fontSize: 11, fontWeight: 600,
        letterSpacing: 0.5, color: MUTED, textTransform: 'uppercase',
      }}>
        <span>{label}</span>
        <button onClick={onClose} title={label} style={{
          marginLeft: 'auto', ...iconButtonStyle, width: 20, height: 18, fontSize: 11,
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
function Rail({ side, label, onOpen }) {
  return (
    <button
      onClick={onOpen}
      title={label}
      style={{
        flex: '0 0 26px', width: 26, alignSelf: 'stretch', padding: '8px 0',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 6,
        writingMode: 'vertical-rl', letterSpacing: 2, fontSize: 11, cursor: 'pointer',
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
function Splitter({ side, width, onResize, onReset }) {
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

// ---------------------------------------------------------------------------

function Palette({ catalogue, search, setSearch, onPick, lang, t }) {
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
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: MUTED, margin: '10px 0 5px' }}
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
                  padding: '6px 9px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                  borderLeft: `2px solid ${colour}`, border: `1px solid ${BORDER}`,
                  borderLeftWidth: 3, borderLeftColor: colour,
                  background: 'rgba(27,31,39,0.9)', color: 'inherit',
                }}
              >
                {pickText(definition.label, lang, definition.type)}
                {definition.suspends && (
                  <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--warn, #e0b341)' }}>
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

function Toolbar({
  graph, setGraph, saved, onOpen, onSave, onCheck, onStart, busy, problems, status, t,
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
        <span style={{ fontSize: 11, color: 'var(--warn, #e0b341)' }}>
          {t(`${problems.length} required inputs not connected`, `${problems.length} 处必填输入未连接`)}
        </span>
      )}
      {status && !status.can_synthesize && (
        // Worth stating plainly: a graph that runs but produces no audio is the
        // most confusing possible outcome.
        <span style={{ fontSize: 11, color: MUTED }}>
          {t('Synthesis is not configured on this machine; synthesis nodes will fail.', '本机未配置合成服务，合成节点将执行失败')}
        </span>
      )}
      <button onClick={onCheck} style={buttonStyle}>{t('Validate', '校验')}</button>
      <button onClick={onStart} disabled={busy}
        style={{ ...buttonStyle, background: ACCENT, color: '#fff', borderColor: 'transparent', fontWeight: 600 }}>
        {busy ? t('Running…', '运行中…') : t('Run', '运行')}
      </button>
    </div>
  )
}

const buttonStyle = {
  padding: '5px 11px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
  border: `1px solid ${BORDER}`, background: PANEL, color: 'inherit',
}

const iconButtonStyle = {
  width: 26, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 13, borderRadius: 6, cursor: 'pointer',
  border: `1px solid ${BORDER}`, background: PANEL, color: 'inherit',
}

const fieldStyle = {
  width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12, boxSizing: 'border-box',
  border: `1px solid ${BORDER}`, background: 'rgba(17,20,26,0.9)', color: 'inherit',
}

const RUN_COLOURS = {
  pending: 'rgba(150,150,150,0.55)',
  done: 'rgba(76,175,80,0.5)',
  running: 'rgba(76,141,255,0.6)',
  accumulating: 'rgba(76,141,255,0.6)',
  suspended: 'rgba(224,179,65,0.7)',
  skipped: 'rgba(120,120,120,0.5)',
  failed: 'rgba(207,102,121,0.8)',
}

// A 1px border is not a status. Every state the engine can put a node in gets a
// word on the node itself, in the same words the run panel uses. The list is
// the engine's full set — pending / running / accumulating / suspended / done /
// skipped / failed — so a node can never be in a state the canvas cannot name.
const RUN_LABELS = {
  pending: { en: 'queued', zh: '待执行' },
  running: { en: 'running', zh: '执行中' },
  accumulating: { en: 'collecting', zh: '结果汇总中' },
  suspended: { en: 'awaiting input', zh: '等待人工输入' },
  done: { en: 'completed', zh: '已完成' },
  skipped: { en: 'skipped', zh: '已跳过' },
  failed: { en: 'failed', zh: '执行失败' },
}

const RUN_TEXT = {
  pending: '#9aa0a6',
  done: '#7bc47f',
  running: '#7aa7ff',
  accumulating: '#7aa7ff',
  suspended: '#e0b341',
  skipped: '#9aa0a6',
  failed: '#e08a95',
}

// What an input is currently connected to.
function sourceOf(node, portName) {
  const wired = node.inputs?.[portName]
  if (!wired) return null
  const list = Array.isArray(wired) ? wired : [wired]
  if (!list.length) return null
  if (list.length === 1) return `${list[0].node}.${list[0].port}`
  return `${list[0].node}.${list[0].port} +${list.length - 1}`
}

function NodeBox({ node, definition, selected, runStatus, lang, t, onDragStart, onStartWire, onFinishWire, onDisconnect }) {
  if (!definition) {
    return (
      <div style={{ position: 'absolute', left: node.position.x, top: node.position.y, width: NODE_WIDTH, padding: 8, borderRadius: 8, border: '1px dashed var(--danger, #cf6679)', color: 'var(--danger, #cf6679)', fontSize: 12 }}>
        {t(`Unrecognised node type: ${node.type}`, `未识别的节点类型：${node.type}`)}
      </div>
    )
  }
  const height = nodeHeight(definition)
  const rows = Math.max(definition.inputs.length, definition.outputs.length)
  const paramsTop = HEADER_HEIGHT + PORT_TOP + rows * ROW_HEIGHT
  const accent = CATEGORY_COLOUR[definition.category] || CATEGORY_COLOUR.other
  return (
    <div
      onMouseDown={e => onDragStart(e, node)}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', left: node.position.x, top: node.position.y,
        width: NODE_WIDTH, height, borderRadius: 10, cursor: 'move', userSelect: 'none',
        background: 'linear-gradient(180deg, rgba(31,36,45,0.98) 0%, rgba(24,28,36,0.98) 100%)',
        border: `1px solid ${selected ? ACCENT : (RUN_COLOURS[runStatus] || BORDER)}`,
        boxShadow: selected
          ? `0 0 0 2px rgba(76,141,255,0.25), 0 10px 26px rgba(0,0,0,0.45)`
          : '0 6px 18px rgba(0,0,0,0.35)',
        outline: runStatus === 'suspended' ? '2px solid rgba(224,179,65,0.35)' : 'none',
      }}
    >
      <div style={{
        height: HEADER_HEIGHT, padding: '0 9px', display: 'flex', alignItems: 'center', gap: 7,
        borderBottom: `1px solid ${BORDER}`, fontSize: 12, fontWeight: 600,
        borderTop: `2px solid ${accent}`, borderTopLeftRadius: 9, borderTopRightRadius: 9,
      }}>
        <span
          title={pickText(definition.help, lang)}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >{pickText(definition.label, lang, definition.type)}</span>
        {runStatus
          ? (
            <span style={{
              marginLeft: 'auto', fontSize: 10, fontWeight: 500, padding: '1px 6px', borderRadius: 9,
              whiteSpace: 'nowrap', color: RUN_TEXT[runStatus] || MUTED,
              border: `1px solid ${RUN_COLOURS[runStatus] || BORDER}`,
            }}>{pickText(RUN_LABELS[runStatus], lang, runStatus)}</span>
          )
          : (
            <span style={{
              marginLeft: 'auto', fontSize: 10, color: MUTED, padding: '1px 6px', borderRadius: 9,
              background: 'rgba(255,255,255,0.04)', whiteSpace: 'nowrap',
            }}>{node.id}</span>
          )}
      </div>

      {/* Inputs: the port, what it is called in the active language, what it
          accepts, and — the part that was missing — what is currently connected
          to it. Reading a graph should not require clicking every node. */}
      {definition.inputs.map((portDef, i) => {
        const wired = sourceOf(node, portDef.name)
        const label = pickText(portDef.label, lang, portDef.name)
        const help = pickText(portDef.help, lang)
        const typeHelp = pickText(portDef.type_help, lang, portDef.type)
        return (
          <div key={portDef.name} style={{ position: 'absolute', left: 0, top: portY(i) - 9, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, maxWidth: NODE_WIDTH / 2 + 26 }}>
            <span
              // Pressing a port must never start dragging the node behind it.
              // That was the whole cause of the stuck-node bug.
              onMouseDown={e => e.stopPropagation()}
              onMouseUp={e => onFinishWire(e, node.id, portDef.name, !!wired)}
              onDoubleClick={e => { e.stopPropagation(); onDisconnect(portDef.name, null) }}
              title={[
                `${label}（${portDef.name}）`,
                help,
                t(`Type: ${typeHelp}`, `类型：${typeHelp}`),
                portDef.required ? t('Required', '必填') : t('Optional', '选填'),
                portDef.multiple ? t('Accepts several connections', '支持多路输入') : '',
                wired ? t(`Connected from ${wired}. Click to disconnect.`, `来源：${wired}；单击可断开连接。`) : '',
              ].filter(Boolean).join('\n')}
              style={{
                width: 11, height: 11, marginLeft: -6, borderRadius: '50%', cursor: 'crosshair', flexShrink: 0,
                background: wired ? colourFor(portDef.type) : '#11141a',
                border: `2px solid ${colourFor(portDef.type)}`,
              }}
            />
            <span style={{ minWidth: 0 }}>
              <span style={{
                color: portDef.required && !wired ? 'var(--warn, #e0b341)' : 'var(--text, #d8dbe2)',
                whiteSpace: 'nowrap',
              }}>
                {label}{portDef.multiple ? ' ⋯' : ''}{portDef.required && !wired ? ' *' : ''}
              </span>
              <span style={{ display: 'block', color: MUTED, fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {wired ? `← ${wired}` : typeHelp}
              </span>
            </span>
          </div>
        )
      })}

      {definition.outputs.map((portDef, i) => {
        const label = pickText(portDef.label, lang, portDef.name)
        const typeHelp = pickText(portDef.type_help, lang, portDef.type)
        return (
          <div key={portDef.name} style={{ position: 'absolute', right: 0, top: portY(i) - 9, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, maxWidth: NODE_WIDTH / 2 + 12 }}>
            <span style={{ minWidth: 0, textAlign: 'right' }}>
              <span style={{ color: 'var(--text, #d8dbe2)', whiteSpace: 'nowrap' }}>{label}</span>
              <span style={{ display: 'block', color: MUTED, fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {typeHelp}
              </span>
            </span>
            <span
              onMouseDown={e => onStartWire(e, node.id, portDef.name, portDef.type)}
              // Deliberately no onMouseUp here: letting it bubble to the canvas is
              // what guarantees the gesture always gets cleared. Stopping it here
              // would recreate the very bug this change removes.
              title={[
                `${label}（${portDef.name}）`,
                pickText(portDef.help, lang),
                t(`Type: ${typeHelp}`, `类型：${typeHelp}`),
              ].filter(Boolean).join('\n')}
              style={{
                width: 11, height: 11, marginRight: -6, borderRadius: '50%', cursor: 'crosshair', flexShrink: 0,
                background: colourFor(portDef.type), border: `2px solid ${colourFor(portDef.type)}`,
              }}
            />
          </div>
        )
      })}

      {/* Settings and their current values, on the node itself. This answers
          "the seed has been changed, but the node does not show what it is". */}
      {definition.params.length > 0 && (
        <div style={{
          position: 'absolute', left: 9, right: 9, top: paramsTop,
          borderTop: `1px dashed ${BORDER}`, paddingTop: 6,
        }}>
          {definition.params.map(param => {
            const value = node.params?.[param.name]
            const shown = value === undefined ? param.default : value
            return (
              <div key={param.name} style={{ display: 'flex', gap: 6, fontSize: 10, height: PARAM_ROW, alignItems: 'center' }}>
                <span style={{ color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '52%' }}>
                  {pickText(param.label, lang, param.name)}
                </span>
                <span style={{
                  marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  color: 'var(--text, #d8dbe2)', fontVariantNumeric: 'tabular-nums',
                }}>
                  {choiceLabel(param, shown, lang)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// A setting with a fixed set of values shows the wording, not the code.
function choiceLabel(param, value, lang) {
  const choice = (param.choices || []).find(c => c.value === value)
  if (choice) return pickText(choice.label, lang, String(value))
  return describeValue(value, lang)
}

function Inspector({ node, definition, graph, catalogue, lang, t, voices, onImportVoice, onChange, onDelete }) {
  if (!node || !definition) {
    return (
      <Panel title={t('Node settings', '节点设置')}>
        <div style={{ fontSize: 12, color: MUTED }}>
          {t('Select a node to edit its settings here.', '选中节点后，在此编辑其设置。')}
        </div>
      </Panel>
    )
  }
  return (
    <Panel title={`${pickText(definition.label, lang, definition.type)}　${node.id}`}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, lineHeight: 1.7 }}>
        {pickText(definition.help, lang)}
        <div style={{ fontSize: 10, marginTop: 4, opacity: 0.8 }}>{definition.type}</div>
      </div>

      <PortList
        title={t('Inputs', '输入')}
        ports={definition.inputs}
        lang={lang}
        t={t}
        describe={port => {
          const from = sourceOf(node, port.name)
          if (from) return { text: t(`from ${from}`, `来源：${from}`), warn: false }
          if (port.required) return { text: t('not connected', '未连接'), warn: true }
          return { text: t('not connected (optional)', '未连接（选填）'), warn: false }
        }}
      />
      <PortList
        title={t('Outputs', '输出')}
        ports={definition.outputs}
        lang={lang}
        t={t}
        describe={port => ({ text: usesOf(graph, catalogue, node.id, port.name, t), warn: false })}
      />

      <div style={{ fontSize: 11, color: MUTED, margin: '12px 0 6px' }}>{t('Settings', '设置')}</div>
      {definition.params.length === 0 && (
        <div style={{ color: MUTED, fontSize: 12 }}>
          {t('This node has no configurable settings.', '该节点没有可配置项。')}
        </div>
      )}
      {definition.params.map(param => {
        const value = node.params?.[param.name]
        const isBool = typeof param.default === 'boolean'
        const isNumber = typeof param.default === 'number'
        const isLong = param.name === 'text'
        // A server-owned list (voices) beats a fixed one, and both beat asking
        // someone to type an id they have no way of knowing.
        const fromServer = param.source === 'voices'
          ? (voices || []).map(v => ({
            value: v.id,
            label: { en: `${v.display_name || v.id}${v.language ? ` · ${v.language}` : ''}`, zh: `${v.display_name || v.id}${v.language ? ` · ${v.language}` : ''}` },
          }))
          : []
        const choices = param.choices?.length ? param.choices : fromServer
        // The voice list may be empty because nothing is saved yet or because
        // the broker is unreachable; either way a text box is still usable.
        const asDropdown = choices.length > 0
        return (
          <label key={param.name} style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
            <div style={{ marginBottom: 3 }}>{pickText(param.label, lang, param.name)}</div>
            {pickText(param.help, lang) && (
              <div style={{ color: MUTED, fontSize: 11, marginBottom: 5, lineHeight: 1.6 }}>
                {pickText(param.help, lang)}
              </div>
            )}
            {asDropdown ? (
              <select
                value={value === null || value === undefined ? (param.source ? '' : param.default) : value}
                onChange={e => onChange(param.name, e.target.value === '' ? null : e.target.value)}
                style={fieldStyle}
              >
                {param.source && <option value="">{t('(server default)', '（服务器默认）')}</option>}
                {choices.map(choice => (
                  <option key={String(choice.value)} value={choice.value}>
                    {pickText(choice.label, lang, String(choice.value))}
                  </option>
                ))}
              </select>
            ) : isBool ? (
              <input type="checkbox" checked={!!value} onChange={e => onChange(param.name, e.target.checked)} />
            ) : isLong ? (
              <textarea value={value ?? ''} rows={4} onChange={e => onChange(param.name, e.target.value)} style={fieldStyle} />
            ) : (
              <input
                value={value === null || value === undefined ? '' : value}
                onChange={e => {
                  const raw = e.target.value
                  if (raw === '') return onChange(param.name, null)
                  onChange(param.name, isNumber && raw !== '-' && !Number.isNaN(Number(raw)) ? Number(raw) : raw)
                }}
                style={fieldStyle}
              />
            )}
            <div style={{ color: MUTED, fontSize: 10, marginTop: 4 }}>
              {t(`default: ${describeValue(param.default, 'en')}`, `默认值：${describeValue(param.default, 'zh')}`)}
            </div>
            {param.source === 'voices' && (
              <>
                <button
                  type="button"
                  disabled={!value}
                  onClick={() => onImportVoice(value)}
                  style={{ ...buttonStyle, marginTop: 6, width: '100%', opacity: value ? 1 : 0.5 }}
                >
                  {t('Fill engine parameters from this voice', '按该音色填充引擎参数')}
                </button>
                <div style={{ color: MUTED, fontSize: 10, marginTop: 4, lineHeight: 1.6 }}>
                  {t(
                    'A voice is a preset: its values are copied into the engine-parameters node once and stay editable. Nothing is written back to the voice.',
                    '音色是一份预设：其参数值会一次性复制到引擎参数节点，之后仍可手动修改；修改不会写回音色。',
                  )}
                </div>
              </>
            )}
          </label>
        )
      })}
      <button onClick={onDelete} style={{ ...buttonStyle, borderColor: 'var(--danger, #cf6679)', color: 'var(--danger, #cf6679)' }}>
        {t('Delete this node (Del)', '删除该节点（Del）')}
      </button>
    </Panel>
  )
}

function PortList({ title, ports, lang, t, describe }) {
  if (!ports.length) return null
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>{title}</div>
      {ports.map(port => {
        const state = describe(port)
        return (
          <div key={port.name} style={{ fontSize: 11, marginBottom: 6, lineHeight: 1.6 }}>
            <span style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6,
              background: colourFor(port.type),
            }} />
            <span>{pickText(port.label, lang, port.name)}</span>
            <span style={{ color: MUTED }}>
              　{pickText(port.type_help, lang, port.type)}
              {port.required ? t('　required', '　必填') : ''}
              {port.multiple ? t('　several allowed', '　支持多路') : ''}
            </span>
            <div style={{ color: state.warn ? 'var(--warn, #e0b341)' : MUTED, marginLeft: 14 }}>
              {state.text}
            </div>
            {pickText(port.help, lang) && (
              <div style={{ color: MUTED, marginLeft: 14, opacity: 0.85 }}>{pickText(port.help, lang)}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Where an output currently goes. Without this an output port looks like a dead
// end on screen even when it is connected.
function usesOf(graph, catalogue, nodeId, portName, t) {
  const targets = []
  for (const edge of edgesOf(graph)) {
    if (edge.from.node === nodeId && edge.from.port === portName) {
      targets.push(`${edge.to.node}.${edge.to.port}`)
    }
  }
  if (!targets.length) return t('not used', '未使用')
  return t(`to ${targets.join(', ')}`, `去向：${targets.join('、')}`)
}

function RunPanel({ run, busy, onAnswer, problems, lang, t }) {
  const [picked, setPicked] = useState([])
  useEffect(() => { setPicked([]) }, [run?.pending?.node_id])

  if (!run) {
    return (
      <Panel title={t('Run', '运行')}>
        {problems.length > 0
          ? <div style={{ fontSize: 12, color: 'var(--warn, #e0b341)' }}>
            {problems.slice(0, 6).map((p, i) => (
              <div key={i}>{p.message_i18n ? pickText(p.message_i18n, lang, p.message) : p.message}</div>
            ))}
            {problems.length > 6 && <div>{t(`…and ${problems.length - 6} more`, `…另有 ${problems.length - 6} 处`)}</div>}
          </div>
          : <div style={{ fontSize: 12, color: MUTED }}>{t('Not run yet. Press Run to start.', '尚未运行。点击「运行」开始。')}</div>}
      </Panel>
    )
  }

  const request = run.pending?.request
  return (
    <Panel title={t(`Run · ${plainStatus(run.status, 'en')}`, `运行 · ${plainStatus(run.status, 'zh')}`)}>
      {request && (
        <div style={{ marginBottom: 10, padding: 9, borderRadius: 8, border: '1px solid var(--warn, #e0b341)' }}>
          <div style={{ fontSize: 12, marginBottom: 7 }}>{request.prompt}</div>
          {request.kind === 'pause' && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button disabled={busy} onClick={() => onAnswer(true)} style={buttonStyle}>{t('Continue', '继续执行')}</button>
              <button disabled={busy} onClick={() => onAnswer(false)} style={buttonStyle}>{t('Stop here', '终止')}</button>
            </div>
          )}
          {request.kind === 'select' && (
            <div>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 5 }}>
                {t(`${request.count} items — tick the ones to carry on with:`, `共 ${request.count} 项，请勾选需要继续处理的条目：`)}
              </div>
              {(request.candidates || []).map((candidate, i) => (
                <label key={i} style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
                  <input
                    type="checkbox" checked={picked.includes(i)}
                    onChange={e => setPicked(p => (e.target.checked ? [...p, i] : p.filter(x => x !== i)))}
                  />
                  <span style={{ marginLeft: 6 }}>{describeCandidate(candidate, i, t)}</span>
                  {candidate?.url && <audio src={candidate.url} controls style={{ height: 26, marginLeft: 8, verticalAlign: 'middle' }} />}
                </label>
              ))}
              <button disabled={busy} onClick={() => onAnswer(picked.slice().sort((a, b) => a - b))} style={buttonStyle}>
                {t(`Confirm (${picked.length} selected)`, `确认选择（${picked.length} 项）`)}
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 11, color: MUTED, marginBottom: 7 }}>
        {t(
          `${run.live_values} intermediate results are held in memory (they remain until a release node frees them)`,
          `内存中驻留 ${run.live_values} 个中间结果（未接入释放节点将持续占用）`,
        )}
      </div>

      {(run.events || []).filter(e => ['preview', 'table', 'saved', 'released', 'recipe'].includes(e.type)).map((event, i) => (
        <EventView key={i} event={event} t={t} />
      ))}
    </Panel>
  )
}

function EventView({ event, t }) {
  if (event.type === 'table') {
    return (
      <div style={{ marginBottom: 10, overflowX: 'auto' }}>
        <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>
          {t(`Score table (pass mark ${event.table.pass_score})`, `评分表（及格线 ${event.table.pass_score}）`)}
        </div>
        <table style={{ fontSize: 11, borderCollapse: 'collapse' }}>
          <thead><tr>{event.table.columns.map(c => (
            <th key={c} style={cellStyle}>{c}</th>
          ))}</tr></thead>
          <tbody>{event.table.rows.map((row, i) => (
            <tr key={i}>{event.table.columns.map(c => (
              <td key={c} style={{ ...cellStyle, color: c === '结果' && String(row[c]).startsWith('未通过') ? 'var(--danger, #cf6679)' : 'inherit' }}>
                {formatCell(row[c])}
              </td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
    )
  }
  if (event.type === 'saved') {
    const names = event.files.map(f => f.split(/[\\/]/).pop())
    return (
      <div style={{ fontSize: 11, marginBottom: 6 }}>
        {t(`Wrote ${event.files.length} files: ${names.join(', ')}`, `已写入 ${event.files.length} 个文件：${names.join('、')}`)}
      </div>
    )
  }
  if (event.type === 'released') {
    return (
      <div style={{ fontSize: 11, marginBottom: 6, color: MUTED }}>
        {t(`Released ${event.freed} intermediate results`, `已释放 ${event.freed} 个中间结果`)}
      </div>
    )
  }
  if (event.type === 'recipe') {
    return (
      <div style={{ fontSize: 11, marginBottom: 6 }}>
        <div style={{ color: MUTED }}>{t('Generation record (recipe)', '生成记录（配方）')}</div>
        <pre style={preStyle}>{JSON.stringify(event.recipe, null, 1)}</pre>
        <div style={{ color: MUTED, fontSize: 10, marginTop: 3, lineHeight: 1.6 }}>
          {t(
            'To keep these settings, connect the recipe output to a Save as Voice node.',
            '如需保留这组参数，请将配方输出连接到「保存为音色」节点。',
          )}
        </div>
      </div>
    )
  }
  if (event.type === 'voice_saved') {
    return (
      <div style={{ fontSize: 11, marginBottom: 6 }}>
        {t(`Saved as voice ${event.voice_id}`, `已保存为音色 ${event.voice_id}`)}
      </div>
    )
  }
  if (event.type === 'note') {
    return <div style={{ fontSize: 11, marginBottom: 6, color: MUTED }}>{event.message}</div>
  }
  return (
    <div style={{ fontSize: 11, marginBottom: 6 }}>
      <div style={{ color: MUTED }}>{event.label || event.node_id}</div>
      {event.value?.url
        ? <audio src={event.value.url} controls style={{ width: '100%', height: 30 }} />
        : <pre style={preStyle}>{formatValue(event.value)}</pre>}
    </div>
  )
}

const cellStyle = { border: `1px solid ${BORDER}`, padding: '3px 7px', textAlign: 'left' }
const preStyle = { margin: 0, fontSize: 11, maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }

// A section inside a dock: a heading and a rule, no box. Boxes inside a boxed
// dock waste horizontal space and read as a second, unrelated container.
function Panel({ title, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 12, fontWeight: 600, marginBottom: 7, paddingBottom: 5,
        borderBottom: `1px solid ${BORDER}`, wordBreak: 'break-all',
      }}>{title}</div>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
//  small helpers
// ---------------------------------------------------------------------------

function curve(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

function wireGeometry(edge, nodeById, catalogue) {
  const from = nodeById.get(edge.from.node)
  const to = nodeById.get(edge.to.node)
  if (!from || !to) return null
  const fromDef = findDefinition(catalogue, from.type)
  const toDef = findDefinition(catalogue, to.type)
  const outIndex = fromDef?.outputs.findIndex(p => p.name === edge.from.port) ?? 0
  const inIndex = toDef?.inputs.findIndex(p => p.name === edge.to.port) ?? 0
  const type = fromDef?.outputs[outIndex]?.type
  return {
    d: curve(from.position.x + NODE_WIDTH, from.position.y + portY(outIndex), to.position.x, to.position.y + portY(inIndex)),
    colour: colourFor(type),
  }
}

function plainStatus(status, lang) {
  const words = {
    running: { en: 'running', zh: '执行中' },
    awaiting_input: { en: 'awaiting input', zh: '等待人工输入' },
    succeeded: { en: 'completed', zh: '已完成' },
    failed: { en: 'failed', zh: '已失败' },
  }
  return pickText(words[status], lang, status)
}

// The server's error object already carries which node and which round; this
// only makes sure none of it is thrown away on the way to the screen.
function describeFailure(error) {
  if (!error) {
    return { en: 'The run failed, but the server did not state a reason.', zh: '运行失败，服务器未返回具体原因。' }
  }
  const bits = [error.message]
  if (error.problems) bits.push(error.problems.map(p => p.message).join('；'))
  const joined = bits.filter(Boolean).join('\n')
  return { en: joined, zh: joined }
}

function describeCandidate(candidate, index, t) {
  if (candidate === null || candidate === undefined) {
    return t(`#${index + 1} (empty)`, `第 ${index + 1} 项（空）`)
  }
  if (typeof candidate === 'object') {
    const name = candidate.path ? String(candidate.path).split(/[\\/]/).pop() : null
    const text = candidate.recipe?.text
    return t(
      `#${index + 1}${name ? `: ${name}` : ''}${text ? ` (${text.slice(0, 16)})` : ''}`,
      `第 ${index + 1} 项${name ? `：${name}` : ''}${text ? `（${text.slice(0, 16)}）` : ''}`,
    )
  }
  return t(`#${index + 1}: ${String(candidate).slice(0, 40)}`, `第 ${index + 1} 项：${String(candidate).slice(0, 40)}`)
}

function formatCell(value) {
  if (typeof value === 'number') return Math.round(value * 1000) / 1000
  return value === null || value === undefined ? '' : String(value)
}

function formatValue(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 1) } catch { return String(value) }
}

export default FlowCanvasTab
