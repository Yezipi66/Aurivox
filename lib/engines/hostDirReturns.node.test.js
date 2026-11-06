'use strict'

// call.returns = "dir"：引擎自己起文件名，平台给一个空目录，事后再从里面取那一个音频。
// 这一态以前只在名片校验里被接受，宿主没实现：它掉进 bytes 分支，最后报一句
// 「stdout 是空的」，与事实无关。下面从头到尾真跑一遍。
//
// 判据有三条，都按「宁可报错，不猜」：
//   恰好一个音频 ⇒ 用它
//   一个都没有 ⇒ 报错并列出目录内容
//   多于一个   ⇒ 报错，不挑
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const HOST_DIR = __dirname

const PYTHON = ['python3', 'python'].find((cmd) => {
  try { return spawnSync(cmd, ['--version'], { timeout: 10000 }).status === 0 } catch { return false }
}) || null

function py (body) {
  const code = [
    'import json, os, sys, tempfile',
    `sys.path.insert(0, ${JSON.stringify(HOST_DIR)})`,
    'import host',
    'host._wav_meta = lambda data: {}',
    body,
  ].join('\n')
  const r = spawnSync(PYTHON, ['-c', code], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

const skip = PYTHON ? false : '本机没有 Python'

const PY_KIND = `
class Up(object):
    def __init__(self, writer):
        self.writer = writer
    def infer(self, **kw):
        self.writer(kw["out_dir"])
        return None

def run(writer):
    prof = {"id": "x", "dir": tempfile.mkdtemp(), "call": {
        "kind": "python", "module": "m", "class": "Up", "method": "infer",
        "bind": {"text": "tts_text", "output_path": "out_dir"},
        "returns": "dir", "seed": "none"}}
    eng = host.Engine(prof)
    eng.obj = Up(writer)
    data, _meta = eng.synthesize("hi", None, {})
    return data
`

test('python 形态：引擎往目录里写一个 wav ⇒ 平台把它读回来', { skip }, () => {
  const out = py(PY_KIND + `
def one(d):
    with open(os.path.join(d, "out.wav"), "wb") as fh:
        fh.write(b"RIFF-one")
    open(os.path.join(d, "notes.txt"), "w").write("ignore me")
print(json.dumps({"hex": run(one).hex()}))
`)
  assert.equal(Buffer.from(out.hex, 'hex').toString(), 'RIFF-one',
    '目录里的非音频文件不参与挑选')
})

test('python 形态：目录里有两条音频 ⇒ 报错，不替人挑一条', { skip }, () => {
  const out = py(PY_KIND + `
def two(d):
    for n in ("a.wav", "b.wav"):
        with open(os.path.join(d, n), "wb") as fh:
            fh.write(b"RIFF")
try:
    run(two)
    print(json.dumps({"error": None}))
except Exception as exc:
    print(json.dumps({"error": str(exc)}, ensure_ascii=False))
`)
  assert.ok(out.error, '两条音频时必须报错')
  assert.match(out.error, /恰好一个/)
  assert.match(out.error, /a\.wav/)
})

test('python 形态：一个音频都没有 ⇒ 报错并列出目录内容', { skip }, () => {
  const out = py(PY_KIND + `
def none(d):
    open(os.path.join(d, "config.yaml"), "w").write("x")
try:
    run(none)
    print(json.dumps({"error": None}))
except Exception as exc:
    print(json.dumps({"error": str(exc)}, ensure_ascii=False))
`)
  assert.ok(out.error)
  assert.match(out.error, /没有音频文件/)
  assert.match(out.error, /config\.yaml/, '报错要带上目录里的实际内容')
})

test('cli 形态：给子进程一个空目录，它自己起文件名，平台事后取回', { skip }, () => {
  const out = py(`
import tempfile, sys, json, os
root = tempfile.mkdtemp()
script = os.path.join(root, "fake_cli.py")
with open(script, "w", encoding="utf-8") as fh:
    fh.write("import os, sys\\n"
             "out = sys.argv[sys.argv.index('--out') + 1]\\n"
             "assert os.path.isdir(out), 'platform must pass a directory'\\n"
             "open(os.path.join(out, 'take-001.wav'), 'wb').write(b'RIFF-cli')\\n")

prof = {"id": "x", "dir": root, "call": {
    "kind": "cli", "argv": [sys.executable, script],
    "bind": {"text": "--text", "output_path": "--out"},
    "returns": "dir", "seed": "none"}}
eng = host.Engine(prof)
data, _meta = eng.synthesize("hi", None, {})
print(json.dumps({"hex": data.hex()}))
`)
  assert.equal(Buffer.from(out.hex, 'hex').toString(), 'RIFF-cli',
    'cli 形态要真的把目录递给子进程，并把它写下的那个音频取回来')
})
