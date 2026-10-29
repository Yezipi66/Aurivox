'use strict'

// 通用宿主收参考音频与参考文本：请求体用平台的词（reference_audio / reference_text），
// 参考文本经 call.bind.ref_text 交给上游。cli 形态拼成「开关 值」，python 形态拼成一个参数；
// 没绑、或值是空串时不传。
// 直接在 Python 里调 host.py 的纯函数与 Engine 的合成入口（上游是一个假对象），不起进程、不要模型。
// 没有 Python 的机器上跳过。

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const HOST_DIR = __dirname

const PYTHON = ['python3', 'python'].find((cmd) => {
  try { return spawnSync(cmd, ['--version'], { timeout: 10000 }).status === 0 } catch { return false }
}) || null

// 跑一段 Python，最后一行 print 一个 JSON，取回来。
function py (body) {
  const code = [
    'import json, os, sys, tempfile',
    `sys.path.insert(0, ${JSON.stringify(HOST_DIR)})`,
    'import host',
    body,
  ].join('\n')
  const r = spawnSync(PYTHON, ['-c', code], { encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

const skip = PYTHON ? false : '本机没有 Python'

test('cli：绑了 ref_text ⇒ 参考文本跟在那个开关后面；没绑或值为空 ⇒ 命令行上没有它', { skip }, () => {
  const out = py(`
call = {"kind": "cli", "argv": ["up"], "bind": {"text": "--text", "ref_audio": "--ref", "ref_text": "--ref-words", "output_path": "--out"}}
unbound = {"kind": "cli", "argv": ["up"], "bind": {"text": "--text", "ref_audio": "--ref", "output_path": "--out"}}
prof = {"id": "x"}
slots = {"text": "hi", "ref_audio": "/r.wav", "ref_text": "原话", "output_path": "/o.wav"}
print(json.dumps({
  "bound": host.build_cli_argv(call, prof, slots, {}),
  "unbound": host.build_cli_argv(unbound, prof, slots, {}),
  "empty": host.build_cli_argv(call, prof, dict(slots, ref_text=""), {}),
  "none": host.build_cli_argv(call, prof, dict(slots, ref_text=None), {}),
}, ensure_ascii=False))
`)
  assert.deepStrictEqual(out.bound,
    ['up', '--text', 'hi', '--ref', '/r.wav', '--ref-words', '原话', '--out', '/o.wav'])
  assert.ok(!out.unbound.includes('原话'), '没绑 ref_text 不该把参考文本放上命令行')
  assert.ok(!out.empty.includes('--ref-words'), '参考文本是空串时不该出现一个空开关')
  assert.ok(!out.none.includes('--ref-words'))
})

test('python：绑了 ref_text ⇒ 参考文本作为那个参数传给上游；没绑不传；方法不要参考音频时也不传', { skip }, () => {
  const out = py(`
class Up(object):
    def __init__(self):
        self.calls = []
    def infer(self, **kw):
        self.calls.append(kw)
        return b"RIFF"

def run(bind, ref_text, method_cfg=None):
    prof = {"id": "x", "call": {"kind": "python", "module": "m", "class": "Up", "method": "infer", "bind": bind, "returns": "bytes", "seed": "none"}}
    eng = host.Engine(prof)
    eng.obj = Up()
    host._wav_meta = lambda data: {}
    eng.synthesize("hi", "/r.wav", {}, method_cfg=method_cfg, ref_text=ref_text)
    return eng.obj.calls[0]

bound = {"text": "tts_text", "ref_audio": "prompt_wav", "ref_text": "prompt_words"}
print(json.dumps({
  "bound": run(bound, "原话"),
  "unbound": run({"text": "tts_text", "ref_audio": "prompt_wav"}, "原话"),
  "empty": run(bound, ""),
  "no_ref_method": run(bound, "原话", {"method": "infer", "bind": bound, "requires_ref_audio": False}),
}, ensure_ascii=False))
`)
  assert.deepStrictEqual(out.bound, { tts_text: 'hi', prompt_wav: '/r.wav', prompt_words: '原话' })
  assert.deepStrictEqual(out.unbound, { tts_text: 'hi', prompt_wav: '/r.wav' })
  assert.deepStrictEqual(out.empty, { tts_text: 'hi', prompt_wav: '/r.wav' })
  assert.deepStrictEqual(out.no_ref_method, { tts_text: 'hi' })
})

test('请求校验：平台的词 reference_audio / reference_text 收得下；旧名片发的 ref_audio_path 照收', { skip }, () => {
  const out = py(`
d = tempfile.mkdtemp()
ref = os.path.join(d, "r.wav")
open(ref, "wb").close()
prof = {"id": "x", "requires_reference_audio": True, "params": {"load_time": [], "call_time": []}, "call": {"method": "infer"}}
plan = host.SeedPlan("none")
def v(body):
    r = host.validate_request(body, prof, plan)
    return None if r is None else [r[0], r[1]]
print(json.dumps({
  "platform": v({"text": "hi", "reference_audio": ref, "reference_text": "原话"}),
  "legacy": v({"text": "hi", "ref_audio_path": ref}),
  "missing": v({"text": "hi", "reference_text": "原话"}),
  "empty_text_ok": v({"text": "hi", "reference_audio": ref, "reference_text": ""}),
  "pick": [host.request_ref_audio({"reference_audio": "a", "ref_audio_path": "b"}),
           host.request_ref_audio({"reference_audio": "", "ref_audio_path": "b"}),
           host.request_ref_audio({})],
}, ensure_ascii=False))
`)
  assert.equal(out.platform, null, JSON.stringify(out.platform))
  assert.equal(out.legacy, null, JSON.stringify(out.legacy))
  assert.equal(out.missing[0], 400)
  assert.match(out.missing[1], /reference_audio/)
  assert.equal(out.empty_text_ok, null)
  assert.deepStrictEqual(out.pick, ['a', 'b', null])
})

test('宿主与平台两份槽位表一致：host.py 的 BIND_SLOTS 与 hostProfile.js 的 BIND_SLOTS', { skip }, () => {
  const { BIND_SLOTS } = require(path.join(HOST_DIR, 'hostProfile'))
  const out = py('print(json.dumps(list(host.BIND_SLOTS)))')
  assert.deepStrictEqual(out, BIND_SLOTS)
})
