const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// Register: the Chinese a user reads must be written Chinese.
//
// Why this file exists at all. Every sentence in the canvas — node names, port
// names, refusals, run status, validation results — was first written in a
// chatty register: "开跑", "没接东西", "过没过". It reads as a toy. The wording
// was cleaned up once by hand; a hand clean-up decays on the next patch, so the
// standard is written down here instead, where breaking it turns a test red.
//
// The list is deliberately small and literal. It bans the specific spoken forms
// that were actually found in this codebase, not a general "tone" — a test that
// tries to judge tone would produce arguments instead of failures.
const BANNED = [
  { bad: '开跑', use: '运行 / 开始运行' },
  { bad: '没开跑', use: '未开始运行' },
  { bad: '没接东西', use: '未连接' },
  { bad: '接不上', use: '类型不匹配 / 无法连接' },
  { bad: '过没过', use: '结果（通过 / 未通过）' },
  { bad: '存好了', use: '已保存 / 已写入' },
  { bad: '存不下来', use: '保存失败' },
  { bad: '停下来等人', use: '需人工介入' },
  { bad: '拔掉', use: '断开连接' },
  { bad: '出口', use: '输出端口' },
  { bad: '入口', use: '输入端口' },
  { bad: '开工', use: '开始执行' },
  { bad: '干活', use: '执行' },
  { bad: '搞定', use: '完成' },
  { bad: '弄好', use: '完成 / 配置完成' },
  { bad: '咋', use: '如何' },
  { bad: '没啥', use: '没有' },
  { bad: '嗓子', use: '音色' },
  { bad: '跑之前', use: '运行前' },
  { bad: '跑不了', use: '无法执行' },
  { bad: '认不出来', use: '无法识别' },
  { bad: '没成功', use: '执行失败' },
  { bad: '找不到了', use: '不存在 / 无法访问' },
  // Added after a counter-proof: a deliberately spoken sentence ("这台机器没地方
  // 存音色，弄不了") slipped past the list above. A guard that a five-second
  // attempt can walk around is not a guard.
  { bad: '弄不了', use: '无法执行 / 不支持' },
  { bad: '没地方', use: '未提供 / 未配置' },
  { bad: '这台机器', use: '本机' },
]

// The files whose Chinese ends up in front of a person: the single source of
// node wording, the two places that phrase a refusal, and the canvas itself.
const FILES = [
  'lib/flowgraph/docs.js',
  'lib/flowgraph/engine.js',
  'lib/flowgraph/adapter.js',
  // nodes.js phrases the refusals a node raises while running. It was left out
  // of the first version of this list and, predictably, kept six spoken
  // sentences that no other check would have caught.
  'lib/flowgraph/nodes.js',
  'web/src/components/flowgraph/graphModel.js',
  'web/src/components/flowgraph/FlowCanvasTab.jsx',
]

const ROOT = path.join(__dirname, '..', '..')

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

test('user-facing Chinese stays in written register', () => {
  const found = []
  for (const relative of FILES) {
    const source = read(relative)
    const lines = source.split(/\r?\n/)
    lines.forEach((line, i) => {
      // Comments in this codebase are English prose about the code; only text
      // that can reach a screen is judged here.
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      for (const entry of BANNED) {
        if (line.includes(entry.bad)) {
          found.push(`${relative}:${i + 1} 出现口语「${entry.bad}」，应改用：${entry.use}`)
        }
      }
    })
  }
  assert.deepEqual(found, [], `\n${found.join('\n')}`)
})

test('every node, port and setting is explained in both languages', () => {
  // A half-translated interface is worse than an untranslated one: it looks
  // finished. docs.js is the only place these sentences exist, so it is the
  // only place this has to be checked.
  const { NODE_DOCS } = require('./docs')
  const holes = []
  for (const [type, doc] of Object.entries(NODE_DOCS)) {
    const check = (what, value) => {
      if (!value) return
      if (typeof value !== 'object') return
      if (!value.en || !value.zh) holes.push(`${type} → ${what}`)
    }
    check('label', doc.label)
    check('help', doc.help)
    for (const [name, port] of Object.entries(doc.inputs || {})) {
      check(`input ${name}.label`, port.label)
      check(`input ${name}.help`, port.help)
    }
    for (const [name, port] of Object.entries(doc.outputs || {})) {
      check(`output ${name}.label`, port.label)
      check(`output ${name}.help`, port.help)
    }
    for (const [name, param] of Object.entries(doc.params || {})) {
      check(`param ${name}.label`, param.label)
      check(`param ${name}.help`, param.help)
    }
  }
  assert.deepEqual(holes, [], `\n${holes.join('\n')}`)
})
