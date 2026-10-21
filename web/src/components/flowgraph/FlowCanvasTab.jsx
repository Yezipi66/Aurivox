import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../../lib/api'
import { ConfirmDialog } from '../common/Dialogs'
import { useT } from '../../lib/i18n'
import { usePersistentState } from '../../usePersistentState'
import {
  emptyGraph, addNode, moveNode, setParam, removeNode, connect, disconnect,
  edgesOf, missingInputs, findDefinition, colourFor,
  pickText, clampZoom, zoomAround, isTypingTarget, describeValue,
  voicePreset, applyPreset,
  ZOOM_MIN, ZOOM_MAX,
} from './graphModel'
import {
  NODE_WIDTH, BORDER, MUTED, DEFAULT_LEFT, DEFAULT_RIGHT,
  clampDock, sheetSize, portY, curve, wireGeometry, describeFailure,
  iconButtonStyle,
} from './canvasShared'
import { Dock, Rail, Splitter, Palette, Toolbar } from './canvasChrome'
import { NodeBox, Inspector } from './canvasNodes'
import { RunPanel } from './canvasRun'

//  The canvas
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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const runAbortRef = useRef(null)
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

  const doDelete = useCallback(() => {
    if (!selected) return
    const gone = selected
    setGraph(g => removeNode(g, gone))
    setSelected(null)
    endGesture()
    setConfirmDelete(false)
    say(`Node ${gone} and all of its connections have been deleted.`, `已删除节点 ${gone} 及其全部连线。`)
  }, [endGesture, say, selected, setGraph])

  const deleteSelected = useCallback(() => {
    if (!selected) {
      say('Select a node first, then press Delete.', '请先选中节点，再按 Delete。', true)
      return
    }
    setConfirmDelete(true)
  }, [say, selected])

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
    const controller = new AbortController()
    runAbortRef.current = controller
    try {
      const r = await fetch('/api/flowgraph/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph }),
        signal: controller.signal,
      })
      const data = await r.json()
      setBusy(false)
      runAbortRef.current = null
      if (r.ok) { setRun(data); setNote(null) }
      else {
        setFailedNode(data?.error?.node_id || null)
        const text = describeFailure(data?.error)
        setNote({ bad: true, en: text.en, zh: text.zh })
      }
    } catch (e) {
      setBusy(false)
      runAbortRef.current = null
      if (e.name === 'AbortError') {
        say('The run was cancelled.', '运行已取消。')
        return
      }
      setNote({ bad: true, en: e.message || 'Network error.', zh: e.message || '网络错误。' })
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
        onSave={save} onCheck={check} onStart={start} onCancel={() => {
          runAbortRef.current?.abort()
        }} busy={busy}
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

      <ConfirmDialog
        open={confirmDelete}
        title={t('Delete node', '删除节点')}
        message={t(
          `Deleting node ${selected} will also remove all of its connections. This cannot be undone.`,
          `删除节点 ${selected} 将同时删除其全部连线，且无法撤销。`,
        )}
        confirmLabel={t('Delete', '删除')}
        cancelLabel={t('Cancel', '取消')}
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}

export default FlowCanvasTab
