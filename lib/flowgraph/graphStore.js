'use strict'

// ---------------------------------------------------------------------------
//  Graph store — save a graph, read it back, unchanged
// ---------------------------------------------------------------------------
// Three words, three different things, on purpose:
//   node  — one box that does one thing
//   group — a lasso round some boxes. Purely visual. Deleting a group deletes
//           nothing but the lasso.
//   block — boxes wrapped up so they behave like one box. A block has its own
//           inside. v1 stores the structure and hands it back; it does not yet
//           run a block as a single node.

const fs = require('node:fs')
const path = require('node:path')

const SCHEMA_VERSION = 1

function storeError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function emptyGraph(name = '未命名流程') {
  return {
    schema_version: SCHEMA_VERSION,
    graph_id: null,
    name,
    nodes: [],
    groups: [],
    blocks: [],
    meta: {},
  }
}

function normaliseNode(raw, where) {
  if (!raw || typeof raw !== 'object') throw storeError('FG_STORE_BAD_NODE', `${where} 里有一个不是节点的东西`)
  if (typeof raw.id !== 'string' || !raw.id) throw storeError('FG_STORE_NODE_NO_ID', `${where} 里有个节点没有编号`)
  if (typeof raw.type !== 'string' || !raw.type) throw storeError('FG_STORE_NODE_NO_TYPE', `节点 ${raw.id} 没写它是哪种节点`)
  const inputs = {}
  for (const [portName, ref] of Object.entries(raw.inputs || {})) {
    if (Array.isArray(ref)) {
      inputs[portName] = ref.map(one => ({ node: String(one.node), port: String(one.port) }))
    } else if (ref && typeof ref === 'object') {
      inputs[portName] = { node: String(ref.node), port: String(ref.port) }
    }
  }
  return {
    id: raw.id,
    type: raw.type,
    title: raw.title || null,
    inputs,
    params: raw.params && typeof raw.params === 'object' ? Object.assign({}, raw.params) : {},
    position: raw.position && typeof raw.position === 'object'
      ? { x: Number(raw.position.x) || 0, y: Number(raw.position.y) || 0 }
      : { x: 0, y: 0 },
    block_id: raw.block_id || null,
  }
}

function normaliseGroup(raw) {
  return {
    id: String(raw.id),
    title: raw.title || '',
    colour: raw.colour || null,
    node_ids: Array.isArray(raw.node_ids) ? raw.node_ids.map(String) : [],
    bounds: raw.bounds || null,
  }
}

function normaliseBlock(raw) {
  // A block is a graph in its own right. Its `interface` says which of the
  // inner ports show up on the outside once v2 starts running blocks as one
  // node; v1 keeps the shape so today's saved graphs stay readable then.
  return {
    id: String(raw.id),
    title: raw.title || '',
    interface: {
      inputs: Array.isArray(raw.interface && raw.interface.inputs) ? raw.interface.inputs.map(p => ({
        name: String(p.name), node: String(p.node), port: String(p.port),
      })) : [],
      outputs: Array.isArray(raw.interface && raw.interface.outputs) ? raw.interface.outputs.map(p => ({
        name: String(p.name), node: String(p.node), port: String(p.port),
      })) : [],
    },
    nodes: (raw.nodes || []).map(n => normaliseNode(n, `块 ${raw.id}`)),
    groups: (raw.groups || []).map(normaliseGroup),
    blocks: (raw.blocks || []).map(normaliseBlock),
  }
}

function normaliseGraph(raw) {
  if (!raw || typeof raw !== 'object') throw storeError('FG_STORE_BAD_GRAPH', '这不是一张流程图')
  const version = Number(raw.schema_version || SCHEMA_VERSION)
  if (version > SCHEMA_VERSION) {
    throw storeError('FG_STORE_VERSION_TOO_NEW',
      `这张图是用更新的版本存的（它是第 ${version} 版，这里只认到第 ${SCHEMA_VERSION} 版）`,
      { found: version, supported: SCHEMA_VERSION })
  }
  const nodes = (raw.nodes || []).map(n => normaliseNode(n, '流程图'))
  const seen = new Set()
  for (const node of nodes) {
    if (seen.has(node.id)) throw storeError('FG_STORE_DUPLICATE_ID', `有两个节点用了同一个编号 '${node.id}'`)
    seen.add(node.id)
  }
  return {
    schema_version: SCHEMA_VERSION,
    graph_id: raw.graph_id || null,
    name: raw.name || '未命名流程',
    nodes,
    groups: (raw.groups || []).map(normaliseGroup),
    blocks: (raw.blocks || []).map(normaliseBlock),
    meta: raw.meta && typeof raw.meta === 'object' ? Object.assign({}, raw.meta) : {},
  }
}

class GraphStore {
  constructor(options = {}) {
    this.dir = options.dir
    if (!this.dir) throw storeError('FG_STORE_NO_DIR', '图库没有告诉我存在哪个文件夹')
    this.fs = options.fs || fs
    this.clock = options.clock || (() => new Date().toISOString())
    this.idFactory = options.idFactory || (() => `graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  }

  _path(graphId) {
    if (!/^[A-Za-z0-9_-]+$/.test(graphId)) {
      throw storeError('FG_STORE_BAD_ID', `流程编号 '${graphId}' 里有不该有的字符`, { graph_id: graphId })
    }
    return path.join(this.dir, `${graphId}.json`)
  }

  save(graph) {
    const clean = normaliseGraph(graph)
    clean.graph_id = clean.graph_id || this.idFactory()
    clean.meta = Object.assign({}, clean.meta, { saved_at: this.clock() })
    this.fs.mkdirSync(this.dir, { recursive: true })
    const file = this._path(clean.graph_id)
    const tmp = `${file}.tmp`
    // Write aside then move: a save interrupted halfway must not leave the user
    // with a half-written graph where a working one used to be.
    this.fs.writeFileSync(tmp, JSON.stringify(clean, null, 2))
    this.fs.renameSync(tmp, file)
    return clean
  }

  load(graphId) {
    const file = this._path(graphId)
    if (!this.fs.existsSync(file)) {
      throw storeError('FG_STORE_NOT_FOUND', `找不到编号 ${graphId} 的流程`, { graph_id: graphId })
    }
    let parsed
    try {
      parsed = JSON.parse(this.fs.readFileSync(file, 'utf8'))
    } catch (error) {
      throw storeError('FG_STORE_UNREADABLE', `流程 ${graphId} 的文件读不动了，可能被别的程序改坏了`, { graph_id: graphId, cause: error.message })
    }
    return normaliseGraph(parsed)
  }

  list() {
    if (!this.fs.existsSync(this.dir)) return []
    return this.fs.readdirSync(this.dir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        try {
          const parsed = JSON.parse(this.fs.readFileSync(path.join(this.dir, name), 'utf8'))
          return {
            graph_id: parsed.graph_id || name.replace(/\.json$/, ''),
            name: parsed.name || '未命名流程',
            node_count: (parsed.nodes || []).length,
            saved_at: (parsed.meta && parsed.meta.saved_at) || null,
          }
        } catch {
          return { graph_id: name.replace(/\.json$/, ''), name: '（读不动）', node_count: 0, saved_at: null, broken: true }
        }
      })
      .sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || '')))
  }

  remove(graphId) {
    const file = this._path(graphId)
    if (!this.fs.existsSync(file)) return false
    this.fs.unlinkSync(file)
    return true
  }
}

module.exports = { GraphStore, normaliseGraph, emptyGraph, SCHEMA_VERSION }
