'use strict'

// 空值在各来源上必须一样处理：没给值就不出词。
//   bind 四个槽位、call_time 参数、join / repeat 的空数组、boolean_optional 的 null
//   都走同一条判据；false 与 0 是有意义的取值，照发。
// 反例是这条规矩存在的理由：同一个空串，从参考文本进来时不发，从参数格进来时
//   却发成 `--speed ""`，上游对空词的反应各不相同（当路径不存在、当合法空串继续跑）。
// 直接在 Python 里调 host.py 的纯函数，不起进程、不要模型。没有 Python 的机器上跳过。

const test = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')

const HOST_DIR = __dirname

const PYTHON = ['python3', 'python'].find((cmd) => {
  try { return spawnSync(cmd, ['--version'], { timeout: 10000 }).status === 0 } catch { return false }
}) || null

function py (body) {
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(HOST_DIR)})`,
    'import host',
    body,
  ].join('\n')
  const r = spawnSync(PYTHON, ['-c', code], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

const skip = PYTHON ? false : '本机没有 Python'

// 一张覆盖四种开关形状的名片：value / join / repeat / boolean_optional / boolean。
const CALL = {
  kind: 'cli',
  argv: ['python', '-m', 'x'],
  bind: { text: '--text', ref_audio: '--voice', ref_text: '--ref-text', output_path: '--out' },
  args: {
    speed: { flag: '--speed', style: 'value' },
    emo: { flag: '--emo', style: 'join', join: ',' },
    files: { flag: '--f', style: 'repeat' },
    opt: { flag: '--opt', style: 'boolean_optional' },
    on: { flag: '--on', style: 'boolean' },
  },
}
const FULL = { text: 'hi', ref_audio: 'a.wav', ref_text: 'r', output_path: 'o.wav' }

test('bind 四个槽位空着时都不出词，不只是参考文本', { skip }, () => {
  const out = py(`
call = json.loads(${JSON.stringify(JSON.stringify(CALL))})
full = json.loads(${JSON.stringify(JSON.stringify(FULL))})
res = {}
for slot in ('text', 'ref_audio', 'ref_text', 'output_path'):
    slots = dict(full); slots[slot] = ''
    res[slot] = host.build_cli_argv(call, {}, slots, {})
print(json.dumps(res))
`)
  assert.deepEqual(out.text, ['python', '-m', 'x', '--voice', 'a.wav', '--ref-text', 'r', '--out', 'o.wav'],
    'text 空着时不该出现 --text 与一个空词')
  assert.deepEqual(out.ref_audio, ['python', '-m', 'x', '--text', 'hi', '--ref-text', 'r', '--out', 'o.wav'])
  assert.deepEqual(out.ref_text, ['python', '-m', 'x', '--text', 'hi', '--voice', 'a.wav', '--out', 'o.wav'])
  assert.deepEqual(out.output_path, ['python', '-m', 'x', '--text', 'hi', '--voice', 'a.wav', '--ref-text', 'r'])
})

test('参数格里是空串 / 空数组时都不出词', { skip }, () => {
  const out = py(`
call = json.loads(${JSON.stringify(JSON.stringify(CALL))})
full = json.loads(${JSON.stringify(JSON.stringify(FULL))})
cases = {'empty': {'speed': ''}, 'join': {'emo': []}, 'repeat': {'files': []}}
print(json.dumps({k: host.build_cli_argv(call, {}, full, v) for k, v in cases.items()}))
`)
  const base = ['python', '-m', 'x', '--text', 'hi', '--voice', 'a.wav', '--ref-text', 'r', '--out', 'o.wav']
  assert.deepEqual(out.empty, base, '空串参数不该发成 --speed ""')
  assert.deepEqual(out.join, base, '空数组 join 不该发成 --emo ""')
  assert.deepEqual(out.repeat, base)
})

test('false 与 0 是有意义的取值，照发；只有空值才不出词', { skip }, () => {
  const out = py(`
call = json.loads(${JSON.stringify(JSON.stringify(CALL))})
full = json.loads(${JSON.stringify(JSON.stringify(FULL))})
print(json.dumps({
  'zero': host.build_cli_argv(call, {}, full, {'speed': 0}),
  'false_bool': host.build_cli_argv(call, {}, full, {'on': False}),
  'false_opt': host.build_cli_argv(call, {}, full, {'opt': False}),
  'null_opt': host.build_cli_argv(call, {}, full, {'opt': None}),
}))
`)
  assert.ok(out.zero.includes('--speed') && out.zero.includes('0'), '0 要发出去')
  assert.ok(!out.false_bool.includes('--on'), 'boolean 的 false 就是不出现')
  assert.ok(out.false_opt.includes('--no-opt'), 'boolean_optional 的 false 是明确的否')
  assert.ok(!out.null_opt.includes('--no-opt'), 'null 只表示没填，不能替使用者决定「否」')
})

test('python 形态用同一条判据：空串的 kwargs 不往下游传', { skip }, () => {
  const out = py(`
print(json.dumps({
  'empty': host._is_absent(''),
  'blank': host._is_absent('   '),
  'none': host._is_absent(None),
  'empty_list': host._is_absent([]),
  'zero': host._is_absent(0),
  'false': host._is_absent(False),
}))
`)
  assert.deepEqual(out, { empty: true, blank: true, none: true, empty_list: true, zero: false, false: false })
})
