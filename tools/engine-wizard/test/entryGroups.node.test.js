'use strict'
// 推理入口的子命令表要真的交出去。
//   回归：`pickEntry` 的候选映射漏了 `groups`，`entry.groups` 变成 undefined，
//   界面上那台挂六个子命令的引擎一个下拉都不出现，而扫描结果里明明有。

const { test } = require('node:test')
const assert = require('node:assert')

const { pickEntry } = require('../core/entryPick')

function params (groups) {
  const out = []
  for (const g of groups) {
    out.push({
      source: 'cli', source_file: 'pkg/cli.py',
      name: 'text', target: '--text', group: g, required: true, style: 'value',
    })
    out.push({
      source: 'cli', source_file: 'pkg/cli.py',
      name: 'output_path', target: '--output-path', group: g, style: 'value',
    })
  }
  return out
}

test('多个子命令：groups 原样交出去，subcommand 留空', () => {
  const entry = pickEntry(params(['synth', 'infer', 'batch']))
  assert.deepStrictEqual(entry.groups, ['synth', 'infer', 'batch'])
  assert.strictEqual(entry.subcommand, null, '多于一个子命令时不替使用者挑')
})

test('只有一个子命令：既给 groups 也给默认值', () => {
  const entry = pickEntry(params(['synth']))
  assert.deepStrictEqual(entry.groups, ['synth'])
  assert.strictEqual(entry.subcommand, 'synth')
})
