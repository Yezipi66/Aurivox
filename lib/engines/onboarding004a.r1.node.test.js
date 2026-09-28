'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.resolve(__dirname, '../..')

test('004A R1: Generate uses the project ConfirmDialog, never window.confirm', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web/src/components/generate/GenerateTab.jsx'), 'utf8')
  assert.match(src, /<ConfirmDialog/)
  assert.doesNotMatch(src, /window\.confirm/)
  assert.match(src, /memory_risk_confirmed:\s*true/)
})
