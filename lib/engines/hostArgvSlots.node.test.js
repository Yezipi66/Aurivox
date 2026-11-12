'use strict'

// 位置参数：命令行上没有开关名的槽位，只能按位置给值。
//   argv 里写 {text} / {ref_audio} / {ref_text} / {output_path}，宿主按请求里的槽位值替换。
// 与 call.bind 的同一个槽位互斥：两处都声明会把值发两遍，上游要么报错，要么把后一个词当成别的位置。
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

test('位置参数：argv 里的 {text} 换成槽位值，位置不变', { skip }, () => {
  const out = py(`
call = {"kind": "cli", "argv": ["up", "--style", "x", "{text}", "{output_path}"], "bind": {}}
prof = {"id": "x"}
print(json.dumps(host.build_cli_argv(call, prof,
  {"text": "hello world", "output_path": "/o.wav"}, {}), ensure_ascii=False))
`)
  assert.deepStrictEqual(out, ['up', '--style', 'x', 'hello world', '/o.wav'])
})

test('位置参数与开关混用：argv 给文本，bind 给参考音频', { skip }, () => {
  const out = py(`
call = {"kind": "cli", "argv": ["up", "{text}"], "bind": {"ref_audio": "--ref", "output_path": "--out"}}
prof = {"id": "x"}
print(json.dumps(host.build_cli_argv(call, prof,
  {"text": "hi", "ref_audio": "/r.wav", "output_path": "/o.wav"}, {}), ensure_ascii=False))
`)
  assert.deepStrictEqual(out, ['up', 'hi', '--ref', '/r.wav', '--out', '/o.wav'])
})

test('同一个槽位声明两次：argv 占位符与 bind 开关同时写，当场拒', { skip }, () => {
  const out = py(`
call = {"kind": "cli", "argv": ["up", "{text}"], "bind": {"text": "--text"}}
prof = {"id": "x"}
try:
    host.build_cli_argv(call, prof, {"text": "hi"}, {})
    print(json.dumps({"raised": False}))
except ValueError as e:
    print(json.dumps({"raised": True, "msg": str(e)}, ensure_ascii=False))
`)
  assert.equal(out.raised, true, '两处都声明时必须拒，否则文本会发两遍')
  assert.match(out.msg, /\{text\}/)
})

test('位置参数缺值：请求里没给这一项，当场拒而不是让后面的词错位', { skip }, () => {
  const out = py(`
call = {"kind": "cli", "argv": ["up", "{text}", "{output_path}"], "bind": {}}
prof = {"id": "x"}
res = {}
for name, slots in (("no_text", {"output_path": "/o.wav"}),
                    ("no_out", {"text": "hi"}),
                    ("empty_text", {"text": "", "output_path": "/o.wav"})):
    try:
        host.build_cli_argv(call, prof, slots, {})
        res[name] = None
    except ValueError as e:
        res[name] = str(e)
print(json.dumps(res, ensure_ascii=False))
`)
  assert.match(out.no_text, /text/)
  assert.match(out.no_out, /output_path/)
  assert.equal(out.empty_text, null, '空串是合法的正文，只有 None 才算没给')
})

test('路径占位符与槽位占位符可以出现在同一个词里', { skip }, () => {
  const out = py(`
call = {"kind": "cli", "argv": ["up", "{checkpoints}/voices/{text}.wav"], "bind": {}}
prof = {"id": "x", "dir": "engines/x", "runtime": {"checkpoints": "engines/x/ckpt"}}
print(json.dumps(host.build_cli_argv(call, prof, {"text": "v1"}, {}), ensure_ascii=False))
`)
  assert.ok(out[1].endsWith('/voices/v1.wav'), out[1])
  assert.ok(out[1].includes('ckpt'), '路径占位符要按 profile 的 checkpoints 换掉：' + out[1])
})

test('文本入口的三种写法各自认得出，互斥的两个同时写会被拒', { skip }, () => {
  const out = py(`
call_argv = {"kind": "cli", "argv": ["up", "{text}"], "bind": {}}
print(json.dumps({
  "pos": host.declares_text(call_argv),
  "bind": host.declares_text({"bind": {"text": "--text"}}),
  "stdin": host.declares_text({"bind": {}, "text_via": "stdin"}),
  "none": host.declares_text({"bind": {}}),
}))
`)
  assert.deepStrictEqual(out, { pos: true, bind: true, stdin: true, none: false })

  const conflict = py(`
call = {"kind": "cli", "argv": ["up", "{text}"], "bind": {}, "text_via": "stdin"}
try:
    host.stdin_payload(call, "hi")
    print(json.dumps({"raised": False}))
except ValueError as e:
    print(json.dumps({"raised": True, "msg": str(e)}, ensure_ascii=False))
`)
  assert.equal(conflict.raised, true, '正文走 stdin 与 {text} 占位符不能同时声明')
})

test('四个槽位名都能当占位符用：名字只有一个来源（BIND_SLOTS）', { skip }, () => {
  const out = py(`
res = {}
for slot in host.BIND_SLOTS:
    call = {"kind": "cli", "argv": ["up", "{%s}" % slot], "bind": {}}
    res[slot] = host.build_cli_argv(call, {"id": "x"}, {slot: "v-" + slot}, {})[1]
print(json.dumps(res, ensure_ascii=False))
`)
  assert.deepStrictEqual(out, {
    text: 'v-text', ref_audio: 'v-ref_audio', ref_text: 'v-ref_text', output_path: 'v-output_path',
  })
})
