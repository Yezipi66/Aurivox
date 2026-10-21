import { pickText, findDefinition, edgesOf, colourFor, describeValue } from './graphModel'

//  Shared constants and utilities

export const NODE_WIDTH = 252
export const ROW_HEIGHT = 22
export const HEADER_HEIGHT = 32
export const PARAM_ROW = 18
export const PORT_TOP = 16

// How far the sheet extends. It used to be a fixed 4000 x 3000, which cut the
// drawing off for anyone who dragged a node past it; now it always reaches well
// past the furthest node.
export const MIN_SHEET_W = 2600
export const MIN_SHEET_H = 1600

// Dock sizing. The docks are draggable, so these are only starting points; the
// limits exist so a dock can never be dragged to a width nothing fits in, or
// wide enough to leave no canvas.
export const DEFAULT_LEFT = 220
export const DEFAULT_RIGHT = 300
export const DOCK_MIN = 170
export const DOCK_MAX = 560

export function clampDock(width, fallback) {
  const value = Number(width)
  if (!Number.isFinite(value)) return fallback
  return Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(value)))
}

export const BORDER = 'var(--border, #2a2f3a)'
export const PANEL = 'var(--panel, #14171d)'
export const MUTED = 'var(--muted, #8b93a3)'
export const ACCENT = 'var(--accent, #4c8dff)'

// One colour per category, used as a thin band on the node and as a dot in the
// node list, so the kind of a node is readable before its name is.
export const CATEGORY_COLOUR = {
  load: '#4c8dff',
  process: '#43b5a0',
  logic: '#a97bff',
  loop: '#e0b341',
  quality: '#ef8f5a',
  sink: '#7e879b',
  other: '#7e879b',
}

export function portY(index) {
  return HEADER_HEIGHT + PORT_TOP + index * ROW_HEIGHT
}

export function nodeHeight(definition) {
  const rows = Math.max(definition?.inputs?.length || 0, definition?.outputs?.length || 0)
  const params = definition?.params?.length || 0
  return HEADER_HEIGHT + PORT_TOP + rows * ROW_HEIGHT + (params ? params * PARAM_ROW + 12 : 0) + 12
}

export function sheetSize(nodes, catalogue) {
  let right = 0
  let bottom = 0
  for (const node of nodes) {
    right = Math.max(right, (node.position?.x || 0) + NODE_WIDTH)
    bottom = Math.max(bottom, (node.position?.y || 0) + nodeHeight(findDefinition(catalogue, node.type)))
  }
  return { width: Math.max(MIN_SHEET_W, right + 800), height: Math.max(MIN_SHEET_H, bottom + 500) }
}

export const buttonStyle = {
  padding: '5px 11px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
  border: `1px solid ${BORDER}`, background: PANEL, color: 'inherit',
}

export const iconButtonStyle = {
  width: 26, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 13, borderRadius: 6, cursor: 'pointer',
  border: `1px solid ${BORDER}`, background: PANEL, color: 'inherit',
}

export const fieldStyle = {
  width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12, boxSizing: 'border-box',
  border: `1px solid ${BORDER}`, background: 'rgba(17,20,26,0.9)', color: 'inherit',
}

export const RUN_COLOURS = {
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
export const RUN_LABELS = {
  pending: { en: 'queued', zh: '待执行' },
  running: { en: 'running', zh: '执行中' },
  accumulating: { en: 'collecting', zh: '结果汇总中' },
  suspended: { en: 'awaiting input', zh: '等待人工输入' },
  done: { en: 'completed', zh: '已完成' },
  skipped: { en: 'skipped', zh: '已跳过' },
  failed: { en: 'failed', zh: '执行失败' },
}

export const RUN_TEXT = {
  pending: '#9aa0a6',
  done: '#7bc47f',
  running: '#7aa7ff',
  accumulating: '#7aa7ff',
  suspended: '#e0b341',
  skipped: '#9aa0a6',
  failed: '#e08a95',
}

// What an input is currently connected to.
export function sourceOf(node, portName) {
  const wired = node.inputs?.[portName]
  if (!wired) return null
  const list = Array.isArray(wired) ? wired : [wired]
  if (!list.length) return null
  if (list.length === 1) return `${list[0].node}.${list[0].port}`
  return `${list[0].node}.${list[0].port} +${list.length - 1}`
}

// A setting with a fixed set of values shows the wording, not the code.
export function choiceLabel(param, value, lang) {
  const choice = (param.choices || []).find(c => c.value === value)
  if (choice) return pickText(choice.label, lang, String(value))
  return describeValue(value, lang)
}

// Where an output currently goes. Without this an output port looks like a dead
// end on screen even when it is connected.
export function usesOf(graph, catalogue, nodeId, portName, t) {
  const targets = []
  for (const edge of edgesOf(graph)) {
    if (edge.from.node === nodeId && edge.from.port === portName) {
      targets.push(`${edge.to.node}.${edge.to.port}`)
    }
  }
  if (!targets.length) return t('not used', '未使用')
  return t(`to ${targets.join(', ')}`, `去向：${targets.join('、')}`)
}

export function curve(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export function wireGeometry(edge, nodeById, catalogue) {
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

export function plainStatus(status, lang) {
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
export function describeFailure(error) {
  if (!error) {
    return { en: 'The run failed, but the server did not state a reason.', zh: '运行失败，服务器未返回具体原因。' }
  }
  const bits = [error.message]
  if (error.problems) bits.push(error.problems.map(p => p.message).join('；'))
  const joined = bits.filter(Boolean).join('\n')
  return { en: joined, zh: joined }
}

export function describeCandidate(candidate, index, t) {
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

export function formatCell(value) {
  if (typeof value === 'number') return Math.round(value * 1000) / 1000
  return value === null || value === undefined ? '' : String(value)
}

export function formatValue(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 1) } catch { return String(value) }
}

export const cellStyle = { border: `1px solid ${BORDER}`, padding: '3px 7px', textAlign: 'left' }
export const preStyle = { margin: 0, fontSize: 11, maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
