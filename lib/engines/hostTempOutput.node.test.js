'use strict'
// 宿主给 cli / python 形态准备输出路径时，不能把 mkstemp 建出来的空文件留给引擎。
//   空文件存在时，较新的 CLI 会以「output file already exists」在合成之前退出，
//   症状是第 5 步 A 级返回 500，看起来像权重或环境坏了。
// 这是一处内联改动，用源码扫描守住两处调用点，不另起一台宿主。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const HOST = path.join(__dirname, 'host.py')

test('两处 mkstemp 之后都要删掉空的输出文件', () => {
  const lines = fs.readFileSync(HOST, 'utf8').split(/\r?\n/)
  const at = []
  lines.forEach((line, i) => {
    if (/tempfile\.mkstemp\(/.test(line) && /out_path/.test(line)) at.push(i)
  })
  assert.ok(at.length >= 2, `应有 cli 与 python 两处，实际 ${at.length} 处`)
  for (const i of at) {
    const nearby = lines.slice(i, i + 8).join('\n')
    assert.ok(/os\.unlink\(out_path\)/.test(nearby),
      `host.py:${i + 1} 的 mkstemp 后没有删掉空文件`)
  }
})
