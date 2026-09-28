'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('runtime: GPT-SoVITS is not preloaded on Aurivox startup', () => {
  const file = path.resolve(__dirname, '../../engines/gpt-sovits/manifest.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(manifest.runtime.preload, false)
})
