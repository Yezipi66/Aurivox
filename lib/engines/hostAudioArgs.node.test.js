'use strict'
// 多选音频的下发：前端那个选择器本来就允许选多个，路径是按数组下来的。
//   host 要按名片里的开关样式把它展开成命令行；写成 str(list) 会得到
//   "--aux ['a', 'b']" 这样一个词，上游只说文件不存在，看不出是这一层的事。

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const HOST_DIR = __dirname
const PYTHON = ['python3', 'python'].find((cmd) => {
  try { return spawnSync(cmd, ['--version'], { timeout: 10000 }).status === 0 } catch { return false }
}) || null
const skip = PYTHON ? false : '本机没有 Python'

function render (style, value) {
  const code = [
    `import sys, json`,
    `sys.path.insert(0, ${JSON.stringify(HOST_DIR)})`,
    'import host',
    'style, value = json.loads(sys.argv[1]), json.loads(sys.argv[2])',
    'print(json.dumps(host._render_cli_arg("aux", {"flag": "--aux", "style": style}, value), ensure_ascii=False))',
  ].join('\n')
  const r = spawnSync(PYTHON, ['-c', code,
    JSON.stringify(style), JSON.stringify(value)], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}

test('value：一个开关后面跟多个词（nargs="+"），不把列表塞成一个词', { skip }, () => {
  assert.deepStrictEqual(render('value', ['a.wav', 'b.wav']), ['--aux', 'a.wav', 'b.wav'])
  assert.deepStrictEqual(render('value', ['a.wav']), ['--aux', 'a.wav'])
})

test('repeat：每个值一个开关', { skip }, () => {
  assert.deepStrictEqual(render('repeat', ['a.wav', 'b.wav']),
    ['--aux', 'a.wav', '--aux', 'b.wav'])
})

test('join：合成一个词，分隔符默认逗号', { skip }, () => {
  assert.deepStrictEqual(render('join', ['a.wav', 'b.wav']), ['--aux', 'a.wav,b.wav'])
})

test('只收单个值的上游拿到多个，由它自己报错：平台不裁掉多余项', { skip }, () => {
  // 平台的责任只是把选中的路径一个不落地送到命令行上；接不接受是上游的事。
  assert.equal(render('value', ['a.wav', 'b.wav']).length, 3)
})
