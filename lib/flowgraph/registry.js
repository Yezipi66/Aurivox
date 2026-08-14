'use strict'

// ---------------------------------------------------------------------------
//  Node registry
// ---------------------------------------------------------------------------
// One entry per node type. A definition owns its ports and its handler, so a
// node cannot exist on the canvas without something that actually runs it.
//
// Two structural rules come straight from the design rulings:
//
//  1. EVERY node may carry an optional `enable` (Boolean) input. A 0 there means
//     "this node does not run, and neither does anything downstream of it".
//     That is the engine capability "条件为 0 的那条边，下游不执行" and it lives
//     here rather than in each handler so no node can forget it.
//
//  2. Nothing is freed automatically. A value stays in memory until a
//     `sys.release` node consumes it. See engine.js `releaseValue`.

const { isPortType } = require('./types')

const registry = new Map()

function port(type, options = {}) {
  if (!isPortType(type)) throw new Error(`Unknown port type '${type}'`)
  return Object.freeze({
    type,
    required: options.required !== false,
    multiple: options.multiple === true,
    description: options.description || '',
  })
}

function define(definition) {
  const {
    type,
    category,
    label,
    inputs = {},
    outputs = {},
    params = {},
    handler,
    suspends = false,
    control = null,
  } = definition

  if (!type || typeof type !== 'string') throw new Error('Node definition requires a type')
  if (registry.has(type)) throw new Error(`Node type '${type}' is already defined`)
  if (typeof handler !== 'function') throw new Error(`Node type '${type}' requires a handler`)

  const withEnable = Object.assign({}, inputs)
  if (!withEnable.enable) {
    withEnable.enable = port('Boolean', {
      required: false,
      description: '0 means this node and everything downstream of it does not run',
    })
  }

  const entry = Object.freeze({
    type,
    category,
    label: label || type,
    inputs: Object.freeze(withEnable),
    outputs: Object.freeze(Object.assign({}, outputs)),
    params: Object.freeze(Object.assign({}, params)),
    handler,
    suspends,
    control,
  })
  registry.set(type, entry)
  return entry
}

function getDefinition(type) {
  return registry.get(type) || null
}

function listDefinitions() {
  return [...registry.values()]
}

function listTypes() {
  return [...registry.keys()].sort()
}

function reset() {
  registry.clear()
}

module.exports = { define, getDefinition, listDefinitions, listTypes, port, reset }
