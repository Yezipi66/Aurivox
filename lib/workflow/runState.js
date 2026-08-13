'use strict'

const RUN_STATES = Object.freeze([
  'created',
  'validated',
  'queued',
  'running',
  'awaiting_human_review',
  'resuming',
  'succeeded',
  'rejected',
  'failed',
  'cancelled',
  'interrupted',
  'stale',
])

const RUN_TRANSITIONS = Object.freeze({
  created: ['validated', 'cancelled'],
  validated: ['queued', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['awaiting_human_review', 'succeeded', 'rejected', 'failed', 'cancelled', 'interrupted'],
  awaiting_human_review: ['resuming', 'rejected', 'failed', 'cancelled', 'stale'],
  resuming: ['running', 'failed', 'cancelled'],
  interrupted: ['running', 'failed', 'cancelled', 'stale'],
  succeeded: [],
  rejected: [],
  failed: [],
  cancelled: [],
  stale: [],
})

const GATE_STATES = Object.freeze([
  'awaiting_review',
  'resolving',
  'resolved',
  'superseded',
  'invalidated',
])

const GATE_TRANSITIONS = Object.freeze({
  awaiting_review: ['resolving', 'superseded', 'invalidated'],
  resolving: ['resolved', 'superseded', 'invalidated'],
  resolved: [],
  superseded: [],
  invalidated: [],
})

function transitionError(kind, from, to) {
  const error = new Error(`${kind} transition is not allowed: ${from} -> ${to}`)
  error.code = kind === 'RUN' ? 'RUN_TRANSITION_INVALID' : 'GATE_TRANSITION_INVALID'
  error.from = from
  error.to = to
  return error
}

function canTransitionRun(from, to) {
  return Array.isArray(RUN_TRANSITIONS[from]) && RUN_TRANSITIONS[from].includes(to)
}

function canTransitionGate(from, to) {
  return Array.isArray(GATE_TRANSITIONS[from]) && GATE_TRANSITIONS[from].includes(to)
}

function transitionRun(from, to) {
  if (!canTransitionRun(from, to)) throw transitionError('RUN', from, to)
  return to
}

function transitionGate(from, to) {
  if (!canTransitionGate(from, to)) throw transitionError('GATE', from, to)
  return to
}

module.exports = {
  GATE_STATES,
  GATE_TRANSITIONS,
  RUN_STATES,
  RUN_TRANSITIONS,
  canTransitionGate,
  canTransitionRun,
  transitionGate,
  transitionRun,
}
