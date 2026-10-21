'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.resolve(__dirname, '../..')
const { readDirSources } = require('../__testsupport__/readDirSources.cjs')
// 读 generate/ 目录下全部源码：组件按功能拆成多个文件后，只读
// GenerateTab.jsx 会看不见拆出去的部分，守卫静默失效。
const GEN_SRC = readDirSources(path.join(ROOT, 'web/src/components/generate'))

test('004A R1: Generate uses the project ConfirmDialog, never window.confirm', () => {
  const src = GEN_SRC
  assert.match(src, /<ConfirmDialog/)
  assert.doesNotMatch(src, /window\.confirm/)
  assert.match(src, /memory_risk_confirmed:\s*true/)
})
