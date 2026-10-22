// 流程图编辑器页：按侧栏布局画布（左边节点列表，右边属性与运行报告），中间画布占满剩余宽度。
// 画出来的一切都取自 /api/flowgraph/nodes 对该节点的描述（端口、类型、设置与解释文案），
// 所以后端新增节点后前端无需改代码；本页只负责布局、手势与本地草稿的存取。

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

export function FlowCanvasTab() {
  const { lang, t } = useT()
  const [catalogue, setCatalogue] = useState(null)
  const [status, setStatus] = useState(null)
  // 正在编辑的这张图在离开页面与刷新浏览器之后仍然保留。它用的是本应用其他页面共用的那份存储，
  // 所以版本号一升，它与其他内容一起被清掉。
  const [graph, setGraph] = usePersistentState('flowgraph.draft', () => emptyGraph(), {
    rehydrate: value => (value && Array.isArray(value.nodes) ? value : emptyGraph()),
  })
  const [saved, setSaved] = useState([])
  const [selected, setSelected] = useState(null)
  const [run, setRun] = useState(null)
  // 上一次失败落在哪个节点上。失败的运行返回的是错误而不是报告，没有这一项，
  // 画布在最需要看结果的那种情况下什么状态都不显示。
  const [failedNode, setFailedNode] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const runAbortRef = useRef(null)
  const [search, setSearch] = useState('')
  // 本机保存的音色。读一次就好，这样音色这项是一个可以挑选的列表，而不是要记准确才能填的 id。
  const [voices, setVoices] = useState([])
  const [dragWire, setDragWire] = useState(null)
  const [pointer, setPointer] = useState({ x: 0, y: 0 })
  // 两侧侧栏：开合与宽度。宽度可以拖动并被记住，因为固定宽度只对一种屏幕是对的。
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

  // 提示成对保存，在画出来的那一刻才翻译，所以切换语言不会留下上一种语言的旧句子。
  const say = useCallback((en, zh, bad = false) => setNote({ bad, en, zh }), [])

  const reloadSaved = useCallback(() => {
    api('/api/flowgraph/graphs').then(r => { if (r.ok) setSaved(r.data.graphs || []) }).catch(() => {})
  }, [])

  useEffect(() => {
    api('/api/flowgraph/nodes').then(r => { if (r.ok) setCatalogue(r.data) })
      .catch(() => say('Cannot reach the canvas service.', '无法连接画布服务。', true))
    api('/api/flowgraph/status').then(r => { if (r.ok) setStatus(r.data) }).catch(() => {})
    // 音色清单取自 broker，只读。取不到时音色这项退回普通输入框，不阻塞整个页面。
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

  // 音色作为预设

  // 把一个音色的设置一次性复制进引擎参数节点，之后不再有链接：这些值成为本图自己的，可以逐项修改，
  // 改它们不会影响那个音色。图形还没有参数节点时，就在引擎节点旁边放一个，而不是先问用户要不要。
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

  // 拖动节点与连线

  // 屏幕坐标换算成画布坐标。除以缩放倍数是关键：画布不在 100% 时，节点才会停在指针下面。
  const canvasPoint = useCallback(event => {
    const box = canvasRef.current?.getBoundingClientRect()
    const z = zoomRef.current || 1
    return {
      x: (event.clientX - (box?.left || 0) + (canvasRef.current?.scrollLeft || 0)) / z,
      y: (event.clientY - (box?.top || 0) + (canvasRef.current?.scrollTop || 0)) / z,
    }
  }, [])

  // 每一次手势都在这里结束，而且结束得彻底。手势只能被取消一半的话，
  // 会出现这种情况：点输入端口时事件被吃掉，同一次按下开始的拖动没有被清掉，
  // 节点就粘在指针上，而按钮已经松开了。
  const endGesture = useCallback(() => {
    dragNode.current = null
    panRef.current = null
    // 在空白处松手取消这次连线，而不是留下一根等着谁来点的线。
    setDragWire(null)
  }, [])

  // Esc 撤销当前进行中的操作，包括把拖了一半的节点放回原处。
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
    // 平移直接读滚动容器的位置，这样它与滚动条配合而不是与滚动条较劲。
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

  // 中键（1）或右键（2）抓住画布拖动视野。
  const onCanvasDown = useCallback(event => {
    if (event.button !== 1 && event.button !== 2) return
    event.preventDefault()
    const box = canvasRef.current
    panRef.current = {
      x: event.clientX, y: event.clientY,
      left: box?.scrollLeft || 0, top: box?.scrollTop || 0,
    }
  }, [])

  // 滚轮缩放必须手动以 { passive: false } 挂监听：React 把 wheel 监听默认当成 passive，
  // onWheel 属性拦不住页面跟着滚动，画布会在缩放时滑走。监听只挂在滚动容器上，
  // 所以在侧栏上滚滚轮时滚的是那个侧栏。
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

  // 用按钮缩放时，可见区域的中点保持不动。
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

  // Esc、Delete 与 Backspace。在冒泡阶段与捕获阶段都监听，
  // 所以按键在手势还在进行时就被处理，而不是等别的东西先把它吃掉。
  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') {
        cancelGesture()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        // 文本框里的 Backspace 必须照常删字符：编辑要合成的文本时顺手删掉节点，
        // 是不可接受的工作丢失方式。
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
    if (event.button !== 0) return   // 中键与右键归画布平移
    event.stopPropagation()
    const point = canvasPoint(event)
    dragNode.current = {
      id: node.id,
      offsetX: point.x - node.position.x,
      offsetY: point.y - node.position.y,
      // 记住位置，Esc 才能还原。
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
    // 先无条件清掉。不管下面发生什么，都不会有手势活过这个函数。
    endGesture()
    if (!pending) {
      // 点一个已连接的输入端口（手上没东西）就断开它。一次点击，连上它的那一次点击，不需要双击。
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

      {/* 编辑器布局：两侧各一个侧栏，中间是画布，侧栏之间有一条可拖动的分隔条。
          侧栏摆在画布旁边而不是浮在它上面：盖住正在编辑的节点的面板，比没有面板更糟。 */}
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
            // 不拦住的话，平移途中右键会弹出浏览器菜单。
          onContextMenu={e => e.preventDefault()}
          onClick={() => setSelected(null)}
          style={{
            position: 'absolute', inset: 0, overflow: 'auto', borderRadius: 10,
            border: `1px solid ${BORDER}`, background: 'var(--panel, #11141a)',
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          }}
        >
          {/* 外层盒子是缩放后的画布大小，滚动条据此知道能滚多远；内层盒子是画布自身的大小，再做缩放。
              要两个盒子，因为 CSS 的 transform 不改变元素占的空间。 */}
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
