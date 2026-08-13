'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const createSynthesisService = require('./synthesisService')

test('extracted synthesis service is independent from Express and keeps validation errors', async () => {
  const service = createSynthesisService({})
  assert.equal(typeof service.generateService, 'function')
  await assert.rejects(
    () => service.generateService({ body: {} }),
    error => error.status === 400 && /Missing 'voice' field/.test(error.message),
  )
})

test('extracted synthesis service keeps voice registration boundary', async () => {
  const service = createSynthesisService({
    loadVoices: () => ({}),
    isBaseVoice: () => false,
    clientError: error => String(error?.message || error),
  })
  await assert.rejects(
    () => service.generateService({ body: { voice: 'missing', text: '你好' } }),
    error => error.status === 404 && /Unknown voice/.test(error.message),
  )
})
