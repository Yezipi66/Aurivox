// ---------------------------------------------------------------------------
//  What the canvas does to a graph, with no React in sight
// ---------------------------------------------------------------------------
// Everything here is a pure function on a plain graph object — the same shape
// the server saves and the engine runs. Keeping it separate means the rules
// about what may connect to what can be tested without a browser, and the
// component stays about pixels.

// A port type that accepts anything. Wiring rules exist to catch mistakes early,
// not to be clever, so anything involving Any is allowed through.
const WILDCARD = 'Any'

// Where a type is genuinely usable in another slot. Deliberately short: a rule
// nobody can predict is worse than no rule.
const ACCEPTS = {
  Number: ['Score'],
  Score: ['Number'],
  Boolean: ['Number'],
  Audio: ['ReferenceAudio'],
  ReferenceAudio: ['Audio'],
  Metrics: ['MetricsList'],
  Score_: [],
}

export function emptyGraph(name = '未命名流程') {
  return { schema_version: 1, graph_id: null, name, nodes: [], groups: [], blocks: [], meta: {} }
}

export function findDefinition(catalogue, type) {
  if (!catalogue) return null
  for (const category of catalogue.categories || []) {
    const found = (category.nodes || []).find(n => n.type === type)
    if (found) return found
  }
  return null
}

export function definitionList(catalogue) {
  return (catalogue?.categories || []).flatMap(c => c.nodes || [])
}

// A node id a person can read, because it is what every error message will
// name: "第 3 轮节点 tts 出错" is only useful if the box on screen says tts.
export function makeNodeId(graph, type) {
  const base = String(type).split('.').pop() || 'node'
  const used = new Set(graph.nodes.map(n => n.id))
  if (!used.has(base)) return base
  let i = 2
  while (used.has(`${base}${i}`)) i += 1
  return `${base}${i}`
}

export function addNode(graph, definition, position = { x: 60, y: 60 }) {
  const id = makeNodeId(graph, definition.type)
  const params = {}
  for (const p of definition.params || []) params[p.name] = p.default
  return {
    ...graph,
    nodes: [...graph.nodes, {
      id,
      type: definition.type,
      title: null,
      inputs: {},
      params,
      position: { x: Math.round(position.x), y: Math.round(position.y) },
      block_id: null,
    }],
  }
}

// ---------------------------------------------------------------------------
//  Voice as a preset
// ---------------------------------------------------------------------------
// A voice belongs to the broker, not to this canvas: it is not a live binding
// and nothing here writes back to it. What a voice is good for here is saving
// someone from typing a dozen settings — pick one, its values are copied into
// the parameter node once, and from that moment they are ordinary values that
// can be edited freely. The graph therefore stays self-contained: changing the
// voice record later cannot silently change what a saved graph does.

// The fields of a voice record that mean something to the engine. Everything
// else in the record (display name, tags, timestamps) is broker bookkeeping.
export const VOICE_PRESET_KEYS = Object.freeze([
  'gpt_model', 'sovits_model',
  'sample_steps', 'if_sr', 'aux_ref_audio_paths',
  'batch_size', 'batch_threshold', 'split_bucket', 'fragment_interval',
  'parallel_infer', 'speed_factor',
])

// voice record -> the values to write into an engine-parameters node. Empty and
// absent fields are skipped so a preset never overwrites something with null.
export function voicePreset(record) {
  const out = {}
  if (!record || typeof record !== 'object') return out
  for (const key of VOICE_PRESET_KEYS) {
    const value = record[key]
    if (value === null || value === undefined || value === '') continue
    out[key] = Array.isArray(value) ? value.join(',') : value
  }
  return out
}

// Writes a preset into one node's params. Only keys the node actually has are
// written: a setting the node does not declare would be rejected by the engine
// parameter whitelist at run time, which is a confusing way to learn about it.
export function applyPreset(graph, nodeId, preset) {
  const node = graph.nodes.find(n => n.id === nodeId)
  if (!node) return { graph, applied: [], skipped: Object.keys(preset || {}) }
  const applied = []
  const skipped = []
  const params = { ...node.params }
  for (const [key, value] of Object.entries(preset || {})) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      params[key] = value
      applied.push(key)
    } else {
      skipped.push(key)
    }
  }
  return {
    graph: { ...graph, nodes: graph.nodes.map(n => (n.id === nodeId ? { ...n, params } : n)) },
    applied,
    skipped,
  }
}

export function moveNode(graph, nodeId, position) {
  return {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === nodeId
      ? { ...n, position: { x: Math.round(position.x), y: Math.round(position.y) } }
      : n)),
  }
}

export function setParam(graph, nodeId, name, value) {
  return {
    ...graph,
    nodes: graph.nodes.map(n => (n.id === nodeId ? { ...n, params: { ...n.params, [name]: value } } : n)),
  }
}

// Deleting a node must also delete every wire that pointed at it, or the graph
// saves fine and then refuses to run with "接不上" about a node that is gone.
export function removeNode(graph, nodeId) {
  return {
    ...graph,
    nodes: graph.nodes.filter(n => n.id !== nodeId).map(n => {
      const inputs = {}
      for (const [port, ref] of Object.entries(n.inputs || {})) {
        if (Array.isArray(ref)) {
          const kept = ref.filter(r => r.node !== nodeId)
          if (kept.length) inputs[port] = kept
        } else if (ref && ref.node !== nodeId) {
          inputs[port] = ref
        }
      }
      return { ...n, inputs }
    }),
    groups: (graph.groups || []).map(g => ({ ...g, node_ids: (g.node_ids || []).filter(id => id !== nodeId) })),
  }
}

// ---------------------------------------------------------------------------
//  Text, zoom and keyboard helpers — pure, so they can be tested without a DOM
// ---------------------------------------------------------------------------

// The catalogue carries every label and every sentence as { en, zh }. Older
// fixtures (and any node whose server has not been updated) carry a plain
// string, so both shapes have to work or one stale field blanks the canvas.
export function pickText(value, lang = 'en', fallback = '') {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') return value || fallback
  if (typeof value === 'object') {
    const wanted = value[lang]
    if (wanted) return wanted
    return value.en || value.zh || fallback
  }
  return String(value)
}

export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 2.5

export function clampZoom(zoom) {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 1000) / 1000))
}

/**
 * Zoom while keeping whatever is under the pointer under the pointer.
 * `pointer` is measured from the top-left of the visible box, `scroll` is where
 * the box is scrolled to. Zooming towards the middle of the screen instead is
 * the thing that makes a canvas feel like it is fighting you.
 */
export function zoomAround({ zoom, factor, pointer, scroll }) {
  const from = clampZoom(zoom)
  const to = clampZoom(from * factor)
  const graphX = (scroll.left + pointer.x) / from
  const graphY = (scroll.top + pointer.y) / from
  return {
    zoom: to,
    left: Math.max(0, Math.round(graphX * to - pointer.x)),
    top: Math.max(0, Math.round(graphY * to - pointer.y)),
  }
}

// Delete / Backspace must delete a node — unless the cursor is in a text box, in
// which case it must delete a character. Getting this wrong means someone loses
// a node while editing the text they are about to synthesise.
export function isTypingTarget(element) {
  if (!element) return false
  const tag = String(element.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (element.isContentEditable) return true
  return false
}

// What a setting's current value looks like on the node itself. The point is
// that a graph can be read at a glance: "seed -1 (random)" on the box beats
// having to click every node to find out what it is set to.
export function describeValue(value, lang = 'en') {
  if (value === null || value === undefined || value === '') {
    return lang === 'zh' ? '未设置' : '(empty)'
  }
  if (typeof value === 'boolean') {
    if (lang === 'zh') return value ? '启用' : '停用'
    return value ? 'on' : 'off'
  }
  if (Array.isArray(value)) return `[${value.join(', ')}]`
  if (typeof value === 'object') return JSON.stringify(value)
  const text = String(value)
  return text.length > 22 ? `${text.slice(0, 22)}…` : text
}

export function typesFit(fromType, toType) {
  if (!fromType || !toType) return true
  if (fromType === WILDCARD || toType === WILDCARD) return true
  if (fromType === toType) return true
  return (ACCEPTS[fromType] || []).includes(toType)
}

// Would this wire make a ring? A ring is not a loop: loops are made with the two
// loop nodes, and a ring is just a graph that can never start.
export function wouldCycle(graph, fromNodeId, toNodeId) {
  if (fromNodeId === toNodeId) return true
  const upstream = new Map()
  for (const node of graph.nodes) {
    const sources = []
    for (const ref of Object.values(node.inputs || {})) {
      for (const one of Array.isArray(ref) ? ref : [ref]) if (one) sources.push(one.node)
    }
    upstream.set(node.id, sources)
  }
  const seen = new Set()
  const stack = [fromNodeId]
  while (stack.length) {
    const current = stack.pop()
    if (current === toNodeId) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const source of upstream.get(current) || []) stack.push(source)
  }
  return false
}

/**
 * Try to make a wire. Returns { ok: true, graph } or { ok: false, reason } — a
 * sentence, because the canvas shows it to a person who is mid-drag.
 */
// Refusals are shown to a person who is mid-drag, so they are sentences — and
// since the interface ships in two languages, every one of them is a pair. The
// plain `reason` stays Chinese so nothing that already reads it breaks; the
// canvas reads `reason_i18n`.
function refuse(zh, en) {
  return { ok: false, reason: zh, reason_i18n: { zh, en } }
}

export function connect(graph, catalogue, from, to) {
  const fromNode = graph.nodes.find(n => n.id === from.node)
  const toNode = graph.nodes.find(n => n.id === to.node)
  if (!fromNode || !toNode) {
    return refuse('连线的一端指向的节点已不存在。', 'One end of this connection points at a node that no longer exists.')
  }

  const fromDef = findDefinition(catalogue, fromNode.type)
  const toDef = findDefinition(catalogue, toNode.type)
  const fromPort = fromDef?.outputs.find(p => p.name === from.port)
  const toPort = toDef?.inputs.find(p => p.name === to.port)
  if (!fromPort) return refuse(`节点 ${fromNode.id} 不存在名为 ${from.port} 的输出端口。`, `Node ${fromNode.id} has no output port called ${from.port}.`)
  if (!toPort) return refuse(`节点 ${toNode.id} 不存在名为 ${to.port} 的输入端口。`, `Node ${toNode.id} has no input port called ${to.port}.`)

  if (!typesFit(fromPort.type, toPort.type)) {
    return refuse(
      `类型不匹配：${fromNode.id} 输出「${fromPort.type}」，而 ${toNode.id} 的 ${to.port} 需要「${toPort.type}」。`,
      `Type mismatch: ${fromNode.id} outputs ${fromPort.type}, but ${to.port} on ${toNode.id} requires ${toPort.type}.`,
    )
  }
  if (wouldCycle(graph, from.node, to.node)) {
    return refuse(
      '该连接会形成环路，流程将无法开始执行。如需重复执行，请使用「循环开始 / 循环结束」节点。',
      'This connection would create a cycle, which can never start. Use the Loop Start / Loop End pair to repeat work.',
    )
  }

  const existing = toNode.inputs?.[to.port]
  let next
  if (toPort.multiple) {
    const list = existing ? (Array.isArray(existing) ? existing : [existing]) : []
    if (list.some(r => r.node === from.node && r.port === from.port)) {
      return refuse('该连线已存在。', 'That connection already exists.')
    }
    next = [...list, { node: from.node, port: from.port }]
  } else {
    // A single-slot input takes the new wire and drops the old one, which is
    // what dragging onto an occupied port obviously means.
    next = { node: from.node, port: from.port }
  }

  return {
    ok: true,
    graph: {
      ...graph,
      nodes: graph.nodes.map(n => (n.id === to.node ? { ...n, inputs: { ...n.inputs, [to.port]: next } } : n)),
    },
  }
}

export function disconnect(graph, to, source = null) {
  return {
    ...graph,
    nodes: graph.nodes.map(n => {
      if (n.id !== to.node) return n
      const inputs = { ...n.inputs }
      const existing = inputs[to.port]
      if (Array.isArray(existing) && source) {
        const kept = existing.filter(r => !(r.node === source.node && r.port === source.port))
        if (kept.length) inputs[to.port] = kept
        else delete inputs[to.port]
      } else {
        delete inputs[to.port]
      }
      return { ...n, inputs }
    }),
  }
}

// Every wire in the graph, flattened — what the canvas draws and what a click on
// a line has to be able to identify.
export function edgesOf(graph) {
  const edges = []
  for (const node of graph.nodes) {
    for (const [port, ref] of Object.entries(node.inputs || {})) {
      for (const one of Array.isArray(ref) ? ref : [ref]) {
        if (one) edges.push({ from: { node: one.node, port: one.port }, to: { node: node.id, port } })
      }
    }
  }
  return edges
}

// Which required inputs are still empty. Shown while wiring, so a graph that
// cannot run says so on the canvas instead of at the moment you press go.
export function missingInputs(graph, catalogue) {
  const missing = []
  for (const node of graph.nodes) {
    const def = findDefinition(catalogue, node.type)
    if (!def) {
      const zh = `服务器未注册该节点类型：${node.type}`
      missing.push({
        node: node.id,
        port: null,
        message: zh,
        message_i18n: { zh, en: `This server has no node type registered as ${node.type}` },
      })
      continue
    }
    for (const port of def.inputs) {
      if (!port.required) continue
      if (!node.inputs?.[port.name]) {
        const label = pickText(port.label, 'zh', port.name)
        const labelEn = pickText(port.label, 'en', port.name)
        const zh = `节点 ${node.id} 的输入「${label}」未连接`
        missing.push({
          node: node.id,
          port: port.name,
          message: zh,
          message_i18n: { zh, en: `Input ${labelEn} on ${node.id} is not connected` },
        })
      }
    }
  }
  return missing
}

// A colour per port type, so a glance at the canvas shows what fits where. The
// same map is used for the dot and for the wire, on purpose.
const TYPE_COLOURS = {
  Text: '#7fb3ff', Audio: '#ffb86b', ReferenceAudio: '#ffcf8b', AudioList: '#ff9f43',
  Number: '#9ee37d', Score: '#6cd97e', Boolean: '#ff7b7b', Engine: '#c99bff',
  Metrics: '#5fd3d0', MetricsList: '#4fbfbc', ScoreList: '#6cd97e', Table: '#8fd3ff',
  QualityStandard: '#d5a6ff', Recipe: '#f5c2e7', IndexList: '#f0d67a', Any: '#9aa5b1',
}

export function colourFor(type) {
  return TYPE_COLOURS[type] || TYPE_COLOURS.Any
}

export const PORT_TYPE_COLOURS = TYPE_COLOURS
