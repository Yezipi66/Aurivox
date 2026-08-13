'use strict'

const crypto = require('crypto')
const {
  HUMAN_GATE_DECISIONS,
  getNodeDefinition,
  isArtifactType,
  isHumanGateDecision,
  isKnownPortType,
} = require('./nodeRegistry')

const WORKFLOW_SCHEMA = 'aurivox.workflow'
const WORKFLOW_SCHEMA_VERSION = 1
const RUN_PLAN_SCHEMA = 'aurivox.run_plan'
const RUN_PLAN_SCHEMA_VERSION = 1
const ID_RE = /^[a-zA-Z0-9_-]+$/

class WorkflowValidationError extends Error {
  constructor(errors) {
    super(`Workflow validation failed with ${errors.length} error(s)`)
    this.name = 'WorkflowValidationError'
    this.code = 'WORKFLOW_INVALID'
    this.errors = errors
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function issue(code, message, extra = {}) {
  return { code, message, ...extra }
}

function compatibleType(sourceType, targetType) {
  if (sourceType === targetType) return true
  // A Human Gate deliberately carries a typed-at-runtime ArtifactRef. The
  // review schema is responsible for narrowing that ref before execution.
  if (sourceType === 'ArtifactRef' && (targetType === 'ArtifactRef' || isArtifactType(targetType))) return true
  if (targetType === 'ArtifactRef' && isArtifactType(sourceType)) return true
  return false
}

function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (!isObject(value)) return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortedKeys(value[key])
  return out
}

function stableStringify(value) {
  return JSON.stringify(sortedKeys(value))
}

function hashJson(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function validateWorkflowInputSpec(name, spec, errors) {
  if (!isObject(spec)) {
    errors.push(issue('WORKFLOW_INPUT_INVALID', `Workflow input '${name}' must be an object`, { path: `inputs.${name}` }))
    return
  }
  if (!isKnownPortType(spec.type)) {
    errors.push(issue('WORKFLOW_INPUT_TYPE_UNKNOWN', `Workflow input '${name}' has unknown type '${spec.type}'`, { path: `inputs.${name}.type` }))
  }
  if (spec.required !== undefined && typeof spec.required !== 'boolean') {
    errors.push(issue('WORKFLOW_INPUT_REQUIRED_INVALID', `Workflow input '${name}.required' must be boolean`, { path: `inputs.${name}.required` }))
  }
}

function validateResourcePolicy(node, errors) {
  if (node.resource_policy === undefined) return
  if (!isObject(node.resource_policy)) {
    errors.push(issue('RESOURCE_POLICY_INVALID', `Node '${node.id}' resource_policy must be an object`, { node_id: node.id, path: `nodes.${node.id}.resource_policy` }))
    return
  }
  for (const key of ['requires_gpu', 'exclusive_gpu', 'can_run_on_cpu']) {
    if (node.resource_policy[key] !== undefined && typeof node.resource_policy[key] !== 'boolean') {
      errors.push(issue('RESOURCE_POLICY_FIELD_INVALID', `Node '${node.id}' resource_policy.${key} must be boolean`, { node_id: node.id, path: `nodes.${node.id}.resource_policy.${key}` }))
    }
  }
  for (const key of ['estimated_vram_mb', 'estimated_disk_mb']) {
    if (node.resource_policy[key] !== undefined && (!Number.isFinite(node.resource_policy[key]) || node.resource_policy[key] < 0)) {
      errors.push(issue('RESOURCE_POLICY_NUMBER_INVALID', `Node '${node.id}' resource_policy.${key} must be a non-negative number`, { node_id: node.id, path: `nodes.${node.id}.resource_policy.${key}` }))
    }
  }
}

function validateSourceNode(node, definition, workflowInputs, errors) {
  const params = isObject(node.params) ? node.params : {}
  const workflowInput = params.workflow_input
  if (workflowInput !== undefined) {
    if (typeof workflowInput !== 'string' || !workflowInput) {
      errors.push(issue('SOURCE_BINDING_INVALID', `Node '${node.id}' workflow_input must be a non-empty string`, { node_id: node.id, path: `nodes.${node.id}.params.workflow_input` }))
      return
    }
    const spec = workflowInputs[workflowInput]
    if (!spec) {
      errors.push(issue('WORKFLOW_INPUT_NOT_FOUND', `Node '${node.id}' references unknown workflow input '${workflowInput}'`, { node_id: node.id, path: `nodes.${node.id}.params.workflow_input` }))
      return
    }
    const outputTypes = Object.values(definition.outputs).map(port => port.type)
    if (!outputTypes.some(type => compatibleType(spec.type, type))) {
      errors.push(issue('WORKFLOW_INPUT_TYPE_MISMATCH', `Node '${node.id}' workflow input '${workflowInput}' cannot produce its source output type`, { node_id: node.id, path: `nodes.${node.id}.params.workflow_input`, details: { input_type: spec.type, output_types: outputTypes } }))
    }
    return
  }

  const literalPresent = (
    (node.type === 'io.text_input' && typeof params.value === 'string')
    || (node.type === 'io.voice_input' && typeof params.voice_id === 'string' && params.voice_id.length > 0)
    || (node.type === 'io.audio_input' && typeof params.artifact_id === 'string' && params.artifact_id.length > 0)
  )
  if (!literalPresent) {
    errors.push(issue('SOURCE_BINDING_REQUIRED', `Source node '${node.id}' needs params.workflow_input or a valid literal binding`, { node_id: node.id, path: `nodes.${node.id}.params` }))
  }
}

function validateHumanGate(node, errors) {
  const params = isObject(node.params) ? node.params : {}
  if (typeof params.review_schema !== 'string' || !params.review_schema.trim()) {
    errors.push(issue('HUMAN_GATE_SCHEMA_REQUIRED', `Human Gate '${node.id}' requires params.review_schema`, { node_id: node.id, path: `nodes.${node.id}.params.review_schema` }))
  }
  if (!Array.isArray(params.decisions) || params.decisions.length === 0) {
    errors.push(issue('HUMAN_GATE_DECISIONS_REQUIRED', `Human Gate '${node.id}' requires a non-empty params.decisions array`, { node_id: node.id, path: `nodes.${node.id}.params.decisions` }))
    return
  }
  const seen = new Set()
  for (const decision of params.decisions) {
    if (!isHumanGateDecision(decision)) {
      errors.push(issue('HUMAN_GATE_DECISION_UNKNOWN', `Human Gate '${node.id}' has unsupported decision '${decision}'`, { node_id: node.id, path: `nodes.${node.id}.params.decisions`, allowed: HUMAN_GATE_DECISIONS }))
    }
    if (seen.has(decision)) {
      errors.push(issue('HUMAN_GATE_DECISION_DUPLICATE', `Human Gate '${node.id}' repeats decision '${decision}'`, { node_id: node.id, path: `nodes.${node.id}.params.decisions` }))
    }
    seen.add(decision)
  }
}

function validateBinding(node, portName, binding, portDefinition, workflowInputs, errors) {
  if (!isObject(binding)) {
    errors.push(issue('NODE_BINDING_INVALID', `Node '${node.id}' binding for '${portName}' must be an object`, { node_id: node.id, path: `nodes.${node.id}.bindings.${portName}` }))
    return true
  }
  if (typeof binding.workflow_input !== 'string' || !binding.workflow_input) {
    errors.push(issue('NODE_BINDING_SOURCE_REQUIRED', `Node '${node.id}' binding for '${portName}' must name workflow_input`, { node_id: node.id, path: `nodes.${node.id}.bindings.${portName}` }))
    return true
  }
  const inputSpec = workflowInputs[binding.workflow_input]
  if (!inputSpec) {
    errors.push(issue('WORKFLOW_INPUT_NOT_FOUND', `Node '${node.id}' binding references unknown workflow input '${binding.workflow_input}'`, { node_id: node.id, path: `nodes.${node.id}.bindings.${portName}` }))
    return true
  }
  if (!compatibleType(inputSpec.type, portDefinition.type)) {
    errors.push(issue('WORKFLOW_INPUT_TYPE_MISMATCH', `Workflow input '${binding.workflow_input}' cannot bind to '${node.id}.${portName}'`, { node_id: node.id, path: `nodes.${node.id}.bindings.${portName}`, details: { input_type: inputSpec.type, port_type: portDefinition.type } }))
  }
  return true
}

function topologicalOrder(nodeIds, edges) {
  const adjacency = new Map(nodeIds.map(id => [id, new Set()]))
  const indegree = new Map(nodeIds.map(id => [id, 0]))
  for (const edge of edges) {
    const targets = adjacency.get(edge.from.node)
    if (!targets || targets.has(edge.to.node)) continue
    targets.add(edge.to.node)
    indegree.set(edge.to.node, indegree.get(edge.to.node) + 1)
  }
  const queue = nodeIds.filter(id => indegree.get(id) === 0).sort()
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const next of [...adjacency.get(id)].sort()) {
      const value = indegree.get(next) - 1
      indegree.set(next, value)
      if (value === 0) {
        queue.push(next)
        queue.sort()
      }
    }
  }
  return { order, cyclic: nodeIds.filter(id => !order.includes(id)).sort() }
}

function validateWorkflowDocument(workflow, options = {}) {
  const errors = []
  const warnings = []
  const registry = options.registry || { getNodeDefinition }

  if (!isObject(workflow)) {
    return { ok: false, errors: [issue('WORKFLOW_NOT_OBJECT', 'Workflow must be a JSON object')], warnings, node_order: [] }
  }
  if (workflow.schema !== WORKFLOW_SCHEMA) {
    errors.push(issue('WORKFLOW_SCHEMA_INVALID', `Workflow schema must be '${WORKFLOW_SCHEMA}'`, { path: 'schema' }))
  }
  if (workflow.schema_version !== WORKFLOW_SCHEMA_VERSION) {
    errors.push(issue('WORKFLOW_SCHEMA_VERSION_UNSUPPORTED', `Workflow schema_version must be ${WORKFLOW_SCHEMA_VERSION}`, { path: 'schema_version' }))
  }
  if (typeof workflow.id !== 'string' || !ID_RE.test(workflow.id)) {
    errors.push(issue('WORKFLOW_ID_INVALID', 'Workflow id must match [a-zA-Z0-9_-]+', { path: 'id' }))
  }
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) {
    errors.push(issue('WORKFLOW_NAME_REQUIRED', 'Workflow name must be a non-empty string', { path: 'name' }))
  }
  for (const key of ['workflow_revision_id', 'revision_id']) {
    if (workflow[key] !== undefined && (typeof workflow[key] !== 'string' || !workflow[key].trim())) {
      errors.push(issue('WORKFLOW_REVISION_ID_INVALID', `${key} must be a non-empty string when provided`, { path: key }))
    }
  }

  const workflowInputs = isObject(workflow.inputs) ? workflow.inputs : {}
  if (workflow.inputs !== undefined && !isObject(workflow.inputs)) {
    errors.push(issue('WORKFLOW_INPUTS_INVALID', 'Workflow inputs must be an object', { path: 'inputs' }))
  }
  for (const [name, spec] of Object.entries(workflowInputs)) validateWorkflowInputSpec(name, spec, errors)

  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
  const edges = Array.isArray(workflow.edges) ? workflow.edges : []
  if (!Array.isArray(workflow.nodes)) errors.push(issue('WORKFLOW_NODES_REQUIRED', 'Workflow nodes must be an array', { path: 'nodes' }))
  if (!Array.isArray(workflow.edges)) errors.push(issue('WORKFLOW_EDGES_REQUIRED', 'Workflow edges must be an array', { path: 'edges' }))

  const nodeMap = new Map()
  const definitions = new Map()
  for (const node of nodes) {
    if (!isObject(node)) {
      errors.push(issue('NODE_INVALID', 'Every workflow node must be an object', { path: 'nodes' }))
      continue
    }
    if (typeof node.id !== 'string' || !ID_RE.test(node.id)) {
      errors.push(issue('NODE_ID_INVALID', `Node id '${node.id}' must match [a-zA-Z0-9_-]+`, { path: 'nodes.id', node_id: node.id }))
      continue
    }
    if (nodeMap.has(node.id)) {
      errors.push(issue('DUPLICATE_NODE_ID', `Duplicate node id '${node.id}'`, { path: `nodes.${node.id}`, node_id: node.id }))
      continue
    }
    nodeMap.set(node.id, node)
    if (typeof node.type !== 'string' || !node.type) {
      errors.push(issue('NODE_TYPE_REQUIRED', `Node '${node.id}' requires type`, { node_id: node.id, path: `nodes.${node.id}.type` }))
      continue
    }
    const version = node.type_version === undefined ? 1 : node.type_version
    if (!Number.isInteger(version) || version < 1) {
      errors.push(issue('NODE_VERSION_INVALID', `Node '${node.id}' type_version must be a positive integer`, { node_id: node.id, path: `nodes.${node.id}.type_version` }))
      continue
    }
    const definition = registry.getNodeDefinition(node.type, version)
    if (!definition) {
      errors.push(issue('UNKNOWN_NODE_TYPE', `Unknown node type/version '${node.type}@${version}'`, { node_id: node.id, path: `nodes.${node.id}.type`, type: node.type, type_version: version }))
      continue
    }
    definitions.set(node.id, definition)
    if (node.params !== undefined && !isObject(node.params)) errors.push(issue('NODE_PARAMS_INVALID', `Node '${node.id}' params must be an object`, { node_id: node.id, path: `nodes.${node.id}.params` }))
    if (node.bindings !== undefined && !isObject(node.bindings)) errors.push(issue('NODE_BINDINGS_INVALID', `Node '${node.id}' bindings must be an object`, { node_id: node.id, path: `nodes.${node.id}.bindings` }))
    if (node.disabled !== undefined && typeof node.disabled !== 'boolean') errors.push(issue('NODE_DISABLED_INVALID', `Node '${node.id}' disabled must be boolean`, { node_id: node.id, path: `nodes.${node.id}.disabled` }))
    validateResourcePolicy(node, errors)
    if (definition.source) validateSourceNode(node, definition, workflowInputs, errors)
    if (node.type === 'review.human_gate') validateHumanGate(node, errors)
  }

  const edgeMap = new Map()
  const incoming = new Map()
  for (const edge of edges) {
    if (!isObject(edge)) {
      errors.push(issue('EDGE_INVALID', 'Every workflow edge must be an object', { path: 'edges' }))
      continue
    }
    if (typeof edge.id !== 'string' || !ID_RE.test(edge.id)) {
      errors.push(issue('EDGE_ID_INVALID', `Edge id '${edge.id}' must match [a-zA-Z0-9_-]+`, { path: 'edges.id', edge_id: edge.id }))
      continue
    }
    if (edgeMap.has(edge.id)) {
      errors.push(issue('DUPLICATE_EDGE_ID', `Duplicate edge id '${edge.id}'`, { edge_id: edge.id }))
      continue
    }
    edgeMap.set(edge.id, edge)
    if (!isObject(edge.from) || !isObject(edge.to)) {
      errors.push(issue('EDGE_ENDPOINT_INVALID', `Edge '${edge.id}' requires from and to endpoints`, { edge_id: edge.id }))
      continue
    }
    const fromNode = nodeMap.get(edge.from.node)
    const toNode = nodeMap.get(edge.to.node)
    const fromDefinition = definitions.get(edge.from.node)
    const toDefinition = definitions.get(edge.to.node)
    if (!fromNode || !fromDefinition) errors.push(issue('EDGE_SOURCE_NODE_NOT_FOUND', `Edge '${edge.id}' references unknown source node '${edge.from.node}'`, { edge_id: edge.id }))
    if (!toNode || !toDefinition) errors.push(issue('EDGE_TARGET_NODE_NOT_FOUND', `Edge '${edge.id}' references unknown target node '${edge.to.node}'`, { edge_id: edge.id }))
    if (!fromDefinition || !toDefinition) continue
    const sourcePort = fromDefinition.outputs[edge.from.port]
    const targetPort = toDefinition.inputs[edge.to.port]
    if (!sourcePort) errors.push(issue('EDGE_SOURCE_PORT_NOT_FOUND', `Edge '${edge.id}' references unknown source port '${edge.from.port}'`, { edge_id: edge.id, node_id: edge.from.node }))
    if (!targetPort) errors.push(issue('EDGE_TARGET_PORT_NOT_FOUND', `Edge '${edge.id}' references unknown target port '${edge.to.port}'`, { edge_id: edge.id, node_id: edge.to.node }))
    if (!sourcePort || !targetPort) continue
    const targetKey = `${edge.to.node}:${edge.to.port}`
    const prior = incoming.get(targetKey) || []
    prior.push(edge.id)
    incoming.set(targetKey, prior)
    if (!targetPort.multiple && prior.length > 1) errors.push(issue('DUPLICATE_INPUT_CONNECTION', `Input '${targetKey}' accepts only one incoming edge`, { edge_id: edge.id, node_id: edge.to.node, port: edge.to.port }))
    if (!compatibleType(sourcePort.type, targetPort.type)) {
      errors.push(issue('PORT_TYPE_MISMATCH', `Cannot connect ${edge.from.node}.${edge.from.port} (${sourcePort.type}) to ${edge.to.node}.${edge.to.port} (${targetPort.type})`, { edge_id: edge.id, details: { source_type: sourcePort.type, target_type: targetPort.type } }))
    }
    if (edge.condition !== undefined && edge.condition !== null && !isObject(edge.condition)) errors.push(issue('EDGE_CONDITION_INVALID', `Edge '${edge.id}' condition must be null or an object`, { edge_id: edge.id }))
  }

  for (const [nodeId, definition] of definitions) {
    const node = nodeMap.get(nodeId)
    const bindings = isObject(node.bindings) ? node.bindings : {}
    for (const bindingPort of Object.keys(bindings)) {
      if (!definition.inputs[bindingPort]) errors.push(issue('NODE_BINDING_PORT_NOT_FOUND', `Node '${nodeId}' binds unknown input port '${bindingPort}'`, { node_id: nodeId, port: bindingPort }))
    }
    for (const [portName, portDefinition] of Object.entries(definition.inputs)) {
      const connections = incoming.get(`${nodeId}:${portName}`) || []
      if (connections.length > 0) continue
      if (bindings[portName]) {
        validateBinding(node, portName, bindings[portName], portDefinition, workflowInputs, errors)
        continue
      }
      if (portDefinition.required) errors.push(issue('MISSING_REQUIRED_INPUT', `Node '${nodeId}' is missing required input '${portName}'`, { node_id: nodeId, port: portName }))
    }
  }

  const nodeIds = [...nodeMap.keys()].sort()
  const { order, cyclic } = topologicalOrder(nodeIds, edges.filter(edge => edge && edge.from && edge.to && nodeMap.has(edge.from.node) && nodeMap.has(edge.to.node)))
  if (cyclic.length) errors.push(issue('DAG_CYCLE', `Workflow contains a cycle involving: ${cyclic.join(', ')}`, { node_ids: cyclic }))

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    node_order: order,
    node_ids: nodeIds,
  }
}

function canonicalExecutionDocument(workflow) {
  const nodes = (workflow.nodes || []).map(node => {
    const typeVersion = node.type_version === undefined ? 1 : node.type_version
    const definition = getNodeDefinition(node.type, typeVersion)
    return {
      id: node.id,
      type: node.type,
      type_version: typeVersion,
      params: node.params || {},
      bindings: node.bindings || {},
      disabled: node.disabled === true,
      resource_policy: {
        ...(definition?.resourcePolicy || {}),
        ...(node.resource_policy || {}),
      },
    }
  }).sort((a, b) => a.id.localeCompare(b.id))
  const edges = (workflow.edges || []).map(edge => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    condition: edge.condition === undefined ? null : edge.condition,
  })).sort((a, b) => a.id.localeCompare(b.id))
  return {
    schema: WORKFLOW_SCHEMA,
    schema_version: WORKFLOW_SCHEMA_VERSION,
    id: workflow.id,
    revision_id: workflow.workflow_revision_id || workflow.revision_id || null,
    inputs: workflow.inputs || {},
    nodes,
    edges,
    settings: workflow.settings || {},
  }
}

function createRunPlan(workflow, options = {}) {
  const result = validateWorkflowDocument(workflow, options)
  if (!result.ok) throw new WorkflowValidationError(result.errors)
  const executionDocument = canonicalExecutionDocument(workflow)
  const workflowFingerprint = hashJson(executionDocument)
  const workflowRevisionId = workflow.workflow_revision_id || workflow.revision_id || `wfrev_${workflowFingerprint.slice(7, 23)}`
  const nodeById = new Map(executionDocument.nodes.map(node => [node.id, node]))
  const planBody = {
    schema: RUN_PLAN_SCHEMA,
    schema_version: RUN_PLAN_SCHEMA_VERSION,
    workflow_id: workflow.id,
    workflow_revision_id: workflowRevisionId,
    workflow_fingerprint: workflowFingerprint,
    node_order: result.node_order,
    nodes: result.node_order.map(id => nodeById.get(id)),
    edges: executionDocument.edges,
    inputs: executionDocument.inputs,
    settings: executionDocument.settings,
  }
  const runPlan = {
    ...planBody,
    run_plan_fingerprint: hashJson(planBody),
  }
  return deepFreeze(runPlan)
}

function assertValidWorkflow(workflow, options = {}) {
  const result = validateWorkflowDocument(workflow, options)
  if (!result.ok) throw new WorkflowValidationError(result.errors)
  return result
}

module.exports = {
  ID_RE,
  RUN_PLAN_SCHEMA,
  RUN_PLAN_SCHEMA_VERSION,
  WORKFLOW_SCHEMA,
  WORKFLOW_SCHEMA_VERSION,
  WorkflowValidationError,
  assertValidWorkflow,
  canonicalExecutionDocument,
  compatibleType,
  createRunPlan,
  deepFreeze,
  hashJson,
  stableStringify,
  validateWorkflowDocument,
}
