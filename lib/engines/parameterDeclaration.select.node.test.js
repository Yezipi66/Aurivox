'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { deriveParameterViews } = require('./parameterDeclaration')
const { parseParamSchema } = require('./profile')

test('固定 choices 的 select 可省略 suggested_value，且不会自动选择第一项', () => {
  const manifest = deriveParameterViews({
    id: 'demo',
    parameters: [
      {
        name: 'mode',
        type: 'select',
        choices: ['zero_shot', 'instruct'],
      },
    ],
  })

  const schema = parseParamSchema(manifest, manifest.defaults)

  assert.equal(schema.length, 1)
  assert.deepEqual(
    schema[0].choices.map(choice => choice.value),
    ['zero_shot', 'instruct'],
  )
  assert.equal(Object.hasOwn(schema[0], 'default'), false)
})

test('固定 choices 提供 suggested_value 时，仍校验它必须属于 choices', () => {
  const manifest = deriveParameterViews({
    id: 'demo',
    parameters: [
      {
        name: 'mode',
        type: 'select',
        choices: ['a', 'b'],
        suggested_value: 'c',
      },
    ],
  })

  assert.throws(
    () => parseParamSchema(manifest, manifest.defaults),
    /不在 choices 里/,
  )
})
