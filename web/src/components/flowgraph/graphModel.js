// 画布对流程图做的全部改动，都是纯函数：输入是普通对象，输出是新对象。
// 对象形状与服务端保存的、引擎运行的是同一种，连线规则因此可以脱离浏览器单独测试，
// 组件那一侧只管画。
//
// 端口类型决定哪些口能接在一起，Any 通吃：接线规则是用来提前发现错误的，不是用来刁难人的。

// 接受任意类型的端口类型。
const WILDCARD = 'Any'

// 真正可用的类型对应关系。故意写短：没人能预料的规则比没有规则更糟。
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

// 节点 id 用人能读懂的写法，因为每条报错都会点名它：
// 「第 3 轮节点 tts 出错」只有屏幕上的方框也写着 tts 才有用。
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

// 音色当作预设用。音色属于 broker，不属于画布：它不是活的绑定，这里也不会回写它。
// 音色在这页的用处是省掉手工填一屏参数：选一个，它的值被复制进参数节点一次，
// 从此它们就是普通值，可以随意改。流程图因此是自包含的：事后改动音色记录，
// 不会悄悄改变一张已保存的流程图的行为。

// 白名单里只列平台自己的记账字段。引擎参数名一个都不列：
// 换一台引擎，它的键都不在名单上，于是选了音色却什么都没带进来，而界面不会说一个字。
// 换成减法：画布不认识引擎参数名，只认识平台自己的记账字段；
// 剩下的残余全是引擎的东西，原样带进参数节点，新引擎带来的新键自动就在里面。
// 白名单只许增加平台自己造的字段，不许增加引擎参数名。
export const VOICE_BOOKKEEPING_KEYS = Object.freeze([
  'id', 'voiceId', 'name', 'display_name', 'label', 'description', 'tags',
  'created_at', 'updated_at', 'engine_id', 'language',
  'ref_audio', 'reference_text', 'segments', 'meta',
])

// 把音色记录转成要写进引擎参数节点的键值。空值与缺失的字段跳过，
// 免得预设用 null 覆盖掉原有设置。
export function voicePreset(record) {
  const out = {}
  if (!record || typeof record !== 'object') return out
  for (const [key, value] of Object.entries(record)) {
    if (VOICE_BOOKKEEPING_KEYS.includes(key)) continue
    if (value === null || value === undefined || value === '') continue
    if (typeof value === 'object' && !Array.isArray(value)) continue
    out[key] = Array.isArray(value) ? value.join(',') : value
  }
  return out
}

// 把预设写进某个节点的 params。只写节点声明过的键：
// 节点没声明的设置会在运行时被引擎的参数白名单挡下，那样报错很难看懂。
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

// 删节点必须连带删掉指向它的每一根连线，否则流程图能存下，
// 运行时却对着一个已经不存在的节点报「接不上」。
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

// 文本、缩放与键盘辅助函数：纯函数，不依赖 DOM。

// 目录里的标签与文案都是 { en, zh }。旧夹具与尚未更新的服务端节点给的是纯字符串，
// 两种形状都得能用，否则一个过期字段就会让画布上一片空白。
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
 * 缩放时保持指针下的东西仍在指针下。pointer 是相对可见区域左上角量的，
 * scroll 是可见区域滚动到的位置。改成以屏幕中心缩放，会让画布显得在跟人较劲。
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

// 删除键与退格键要删节点，但光标在输入框里时必须删字符：
// 弄错的后果是有人一边改要合成的文字，一边把节点删掉了。
export function isTypingTarget(element) {
  if (!element) return false
  const tag = String(element.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (element.isContentEditable) return true
  return false
}

// 设置的当前值在节点上显示成什么样。目的是让流程图一眼能读：
// 方框上写着「seed -1（随机）」，比逐个点开节点查设置省事。
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

// 这根连线会不会连成一个圈。圈不是循环：循环由两个循环节点搭，
// 圈只是一个永远无法开始的流程图。
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

// 拒绝理由要显示给正在拖线的人，所以写成句子；界面有中英两种语言，
// 每条理由都是一对。reason 保持中文，已有读它的代码不受影响，
// 画布读的是 reason_i18n。
function refuse(zh, en) {
  return { ok: false, reason: zh, reason_i18n: { zh, en } }
}

/**
 * 尝试接线。成功返回 { ok: true, graph }，失败返回 { ok: false, reason }：
 * reason 是一句话，因为画布要把它显示给正在拖线的人。
 */
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
    // 单入口的输入口接新线、丢掉旧线：往已占的口上拖线就是这个意思。
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

// 流程图里的每一根连线，摊平成列表：画布要画它们，点击一根线也要能认出它。
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

// 哪些必填输入还空着。接线时就显示出来，跑不起来的流程图在画布上就看得出来，
// 而不是按下运行才知道。
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

// 每种端口类型一个颜色，由画布上的颜色就能看出哪里能接。圆点与连线用同一张表，
// 是有意为之。
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
