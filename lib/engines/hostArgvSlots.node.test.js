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

// 上面几条验的是「拼出来的 argv 长什么样」，都在同一个进程里跑。
// 这一条真的起一个子进程，验它收到的就是那样：中间只隔一次 subprocess.run，
//   但一旦有人把 argv 拼成一个字符串交给 shell，带空格的文本会当场裂成两个位置参数，
//   而在纯函数层面看不出来。
test('⭐⭐⭐ 真起子进程：带空格的文本整串到达，不被拆成两个位置参数', { skip }, () => {
  const script = [
    'import json, os, sys, wave',
    'text, out = sys.argv[1], sys.argv[2]',
    'here = os.path.dirname(os.path.abspath(__file__))',
    'json.dump({"argv": sys.argv[1:]}, open(os.path.join(here, "argv.json"), "w", encoding="utf-8"), ensure_ascii=False)',
    'w = wave.open(out, "wb")',
    'w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)',
    'w.writeframesraw(b"\\x00\\x00" * 8)',
    'w.close()',
  ].join('\n')
  const out = py(`
import os, sys, tempfile, json, wave
d = os.path.dirname(os.path.dirname(os.path.abspath(tempfile.mkdtemp())))
d = tempfile.mkdtemp()
script = os.path.join(d, "speak.py")
open(script, "w", encoding="utf-8").write(${JSON.stringify(script)})
# 第一项用当前解释器的绝对路径：{engine_python} 要从 runtime.python（虚拟环境目录）
# 推出 Scripts/python.exe，而测试进程的解释器未必住在这种目录里。这条验的是位置参数。
prof = {"id": "p", "dir": d, "runtime": {},
        "call": {"kind": "cli", "argv": [sys.executable, script, "{text}", "{output_path}"],
                 "bind": {}, "returns": "file", "seed": "none", "weights": "self"}}
text = "hello world, this is one argument"
data, _meta = host.Engine(prof).synthesize(text, None, {})
got = json.load(open(os.path.join(d, "argv.json"), encoding="utf-8"))["argv"]
print(json.dumps({"count": len(got), "first": got[0], "head": data[:4].decode("ascii", "replace")}))
`)
  assert.equal(out.count, 2, '位置参数是两个词：文本与输出路径')
  assert.equal(out.first, 'hello world, this is one argument',
    '文本被空格拆开了：交给子进程的必须是列表，不是一条拼好的字符串')
  assert.equal(out.head, 'RIFF', '引擎确实写出了音频，不是空文件')
})
