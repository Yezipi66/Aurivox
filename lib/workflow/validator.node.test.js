'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  WorkflowValidationError,
  createRunPlan,
  getNodeDefinition,
  validateWorkflowDocument,
} = require('./index')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function ttsWorkflow() {
  return {
    schema: 'aurivox.workflow',
    schema_version: 1,
    id: 'tts_demo',
    name: 'TTS demo',
    inputs: {
      text: { type: 'TextArtifact', required: true },
      voice: { type: 'VoiceRef', required: true },
    },
    nodes: [
      { id: 'text', type: 'io.text_input', type_version: 1, params: { workflow_input: 'text' } },
      { id: 'voice', type: 'io.voice_input', type_version: 1, params: { workflow_input: 'voice' } },
      { id: 'route', type: 'text.auto_language', type_version: 1 },
      {
        id: 'review',
        type: 'review.human_gate',
        type_version: 1,
        params: {
          review_schema: 'pronunciation.v1',
          decisions: ['approve', 'submit_revision', 'reject', 'cancel'],
        },
      },
      { id: 'tts', type: 'tts.generate', type_version: 1 },
      { id: 'output', type: 'io.audio_output', type_version: 1 },
    ],
    edges: [
      { id: 'e_text_route', from: { node: 'text', port: 'text' }, to: { node: 'route', port: 'text' } },
      { id: 'e_route_review', from: { node: 'route', port: 'text' }, to: { node: 'review', port: 'review_target' } },
      { id: 'e_route_tts', from: { node: 'route', port: 'text' }, to: { node: 'tts', port: 'text' } },
      { id: 'e_voice_tts', from: { node: 'voice', port: 'voice' }, to: { node: 'tts', port: 'voice' } },
      { id: 'e_review_tts', from: { node: 'review', port: 'approved' }, to: { node: 'tts', port: 'recipe' } },
      { id: 'e_tts_output', from: { node: 'tts', port: 'audio' }, to: { node: 'output', port: 'audio' } },
    ],
  }
}

test('valid TTS workflow produces a deterministic topological order', () => {
  const result = validateWorkflowDocument(ttsWorkflow())
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.node_order, ['text', 'route', 'review', 'voice', 'tts', 'output'])
})

test('human gate exposes only the R1 decision vocabulary', () => {
  const definition = getNodeDefinition('review.human_gate', 1)
  assert.deepEqual(Object.keys(definition.outputs).sort(), ['approved', 'decision', 'rejected', 'review_record', 'revised'])
  const workflow = ttsWorkflow()
  workflow.nodes.find(node => node.id === 'review').params.decisions = ['approve', 'revision_requested']
  const result = validateWorkflowDocument(workflow)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.code === 'HUMAN_GATE_DECISION_UNKNOWN'))
})

test('missing required input is rejected before execution', () => {
  const workflow = ttsWorkflow()
  workflow.edges = workflow.edges.filter(edge => edge.id !== 'e_voice_tts')
  const result = validateWorkflowDocument(workflow)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.code === 'MISSING_REQUIRED_INPUT' && error.node_id === 'tts' && error.port === 'voice'))
})

test('port type mismatch is rejected', () => {
  const workflow = ttsWorkflow()
  workflow.edges = workflow.edges.filter(edge => edge.id !== 'e_route_tts')
  workflow.edges.push({
    id: 'e_voice_wrong',
    from: { node: 'voice', port: 'voice' },
    to: { node: 'tts', port: 'text' },
  })
  const result = validateWorkflowDocument(workflow)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.code === 'PORT_TYPE_MISMATCH'))
})

test('a single-input port cannot receive two edges', () => {
  const workflow = ttsWorkflow()
  workflow.edges.push({
    id: 'e_route_tts_duplicate',
    from: { node: 'route', port: 'text' },
    to: { node: 'tts', port: 'text' },
  })
  const result = validateWorkflowDocument(workflow)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.code === 'DUPLICATE_INPUT_CONNECTION'))
})

test('cycles are rejected even when all ports are otherwise valid', () => {
  const workflow = ttsWorkflow()
  workflow.edges.push({
    id: 'e_cycle',
    from: { node: 'route', port: 'text' },
    to: { node: 'route', port: 'text' },
  })
  const result = validateWorkflowDocument(workflow)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.code === 'DAG_CYCLE'))
})

test('workflow input bindings can feed a source node without an edge', () => {
  const workflow = {
    schema: 'aurivox.workflow',
    schema_version: 1,
    id: 'audio_output_binding',
    name: 'Audio output binding',
    inputs: { audio: { type: 'AudioArtifact', required: true } },
    nodes: [
      {
        id: 'output',
        type: 'io.audio_output',
        type_version: 1,
        bindings: { audio: { workflow_input: 'audio' } },
      },
    ],
    edges: [],
  }
  const result = validateWorkflowDocument(workflow)
  assert.equal(result.ok, true)
})

test('run plan fingerprint ignores UI-only labels and positions', () => {
  const first = ttsWorkflow()
  first.nodes[0].position = { x: 20, y: 30 }
  first.nodes[0].label = 'Input A'
  first.description = 'first layout'
  first.updated_at = '2026-08-09T00:00:00Z'

  const second = clone(first)
  second.nodes.reverse()
  second.edges.reverse()
  second.nodes[0].position = { x: 900, y: 700 }
  second.nodes[0].label = 'Input B'
  second.description = 'second layout'
  second.updated_at = '2026-08-10T00:00:00Z'

  const planA = createRunPlan(first)
  const planB = createRunPlan(second)
  assert.equal(planA.workflow_fingerprint, planB.workflow_fingerprint)
  assert.equal(planA.run_plan_fingerprint, planB.run_plan_fingerprint)
  assert.deepEqual(planA.node_order, planB.node_order)
})

test('run plan pins the explicit workflow revision and is deeply immutable', () => {
  const workflow = ttsWorkflow()
  workflow.workflow_revision_id = 'workflow_revision_003'
  const plan = createRunPlan(workflow)
  assert.equal(plan.workflow_revision_id, 'workflow_revision_003')
  assert.equal(plan.nodes.find(node => node.id === 'tts').resource_policy.requires_gpu, true)
  assert.equal(Object.isFrozen(plan), true)
  assert.equal(Object.isFrozen(plan.nodes), true)
  assert.throws(() => { plan.node_order.push('unexpected') }, TypeError)
})

test('invalid workflow throws a structured validation error when making a run plan', () => {
  const workflow = ttsWorkflow()
  workflow.nodes[0].type = 'community.unknown'
  assert.throws(
    () => createRunPlan(workflow),
    error => error instanceof WorkflowValidationError && error.code === 'WORKFLOW_INVALID' && error.errors.some(item => item.code === 'UNKNOWN_NODE_TYPE'),
  )
})

test('workflow revision id must be explicit and non-empty when supplied', () => {
  const workflow = ttsWorkflow()
  workflow.workflow_revision_id = ''
  const result = validateWorkflowDocument(workflow)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.code === 'WORKFLOW_REVISION_ID_INVALID'))
})
