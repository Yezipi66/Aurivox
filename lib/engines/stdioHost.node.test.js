'use strict'

// 真宿主走 stdio：launchPlan → spawnFromPlan → host.py --stdio → 管道上探活与合成。
// 上游是一段假的命令行程序（Python，写一个最短的 wav，并把收到的 argv 记下来），不需要任何模型。
// 这一条把「零端口」落到真进程上：宿主没有拿到 --port，也就没有任何监听。
// 没有 Python 的机器上跳过（判据见 PYTHON）。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const HOST = path.join(__dirname, 'host.py')

const PYTHON = ['python3', 'python'].find((cmd) => {
  try { return spawnSync(cmd, ['--version'], { timeout: 10000 }).status === 0 } catch { return false }
}) || null

const FAKE_UPSTREAM = `
import json, sys, wave
argv = sys.argv[1:]
def val(flag):
    return argv[argv.index(flag) + 1] if flag in argv else None
with open(val("--record"), "w", encoding="utf-8") as fh:
    json.dump(argv, fh, ensure_ascii=False)
w = wave.open(val("--out"), "wb")
w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b"\\x00\\x00" * 1600)
w.close()
`

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-host-'))
  const enginesDir = path.join(tmp, 'engines')
  const id = 'stdio-fake'
  const dir = path.join(enginesDir, id)
  fs.mkdirSync(dir, { recursive: true })
  const upstream = path.join(dir, 'fake_tts.py')
  fs.writeFileSync(upstream, FAKE_UPSTREAM)
  const record = path.join(tmp, 'argv.json')
  const ref = path.join(tmp, 'ref.wav')
  fs.writeFileSync(ref, Buffer.alloc(64))
  const manifest = {
    contract_version: 2,
    id,
    label: 'Stdio Fake',
    // 没有 default_base_url：启动脚本是通用宿主 ⇒ 平台推出 stdio。
    runtime: { python: `engines/${id}/.venv`, entry: '../../lib/engines/host.py' },
    call: {
      kind: 'cli',
      argv: [PYTHON, upstream, '--record', record],
      bind: { text: '--text', ref_audio: '--ref', output_path: '--out' },
      seed: 'none',
    },
    params: { load_time: [], call_time: [] },
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { tmp, enginesDir, id, record, ref }
}

test('⭐⭐ 通用宿主走 stdio：不给端口，经管道探活、合成拿到 wav', { skip: !PYTHON && '没有 Python' }, async () => {
  const { resolveEngineProfile } = require('./profile')
  const { buildLaunchPlan } = require('./launchPlan')
  const { spawnFromPlan, probeStdio } = require('./spawnEngine')
  const { postToEngine } = require('./engineChannel')

  const w = setup()
  const profile = resolveEngineProfile(w.id, {}, { enginesDir: w.enginesDir, localRoot: w.tmp })
  assert.equal(profile.transport, 'stdio')
  const plan = buildLaunchPlan(profile, { rootDir: ROOT,
    profileJsonPath: path.join(w.tmp, 'cache', `${w.id}.profile.json`) })
  assert.equal(plan.port, null)
  assert.ok(plan.args.includes('--stdio'))
  assert.ok(!plan.args.includes('--port'))
  // 解释器与入口换成本机的：测试不装引擎的虚拟环境。
  plan.python = PYTHON
  plan.entry = HOST

  const child = spawnFromPlan(plan, { rootDir: w.tmp, logDir: path.join(w.tmp, 'logs'),
    enginesDir: w.enginesDir, localRoot: w.tmp })
  try {
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) {
      const r = await probeStdio(child.stdioTransport, plan.ready_endpoint, 2000)
      assert.ok(!(r instanceof Error), r && r.message)
      ready = r === true
      if (!ready) await new Promise((res) => setTimeout(res, 100))
    }
    assert.ok(ready, '宿主 10 秒内没有经管道答出 ready')

    const supervisor = { connectionOf: () => child.stdioTransport }
    const r = await postToEngine({ profile, supervisor, httpPost: () => assert.fail('不许走 HTTP'),
      path: '/tts', payload: { text: '你好', ref_audio_path: w.ref }, timeoutMs: 20000 })
    assert.equal(r.statusCode, 200, r.body.toString())
    assert.equal(r.body.slice(0, 4).toString(), 'RIFF')
    const argv = JSON.parse(fs.readFileSync(w.record, 'utf8'))
    assert.equal(argv[argv.indexOf('--text') + 1], '你好')
    assert.equal(argv[argv.indexOf('--ref') + 1], w.ref)

    // 同一条管道上接着再发：一台常驻的引擎要能连续合成，不是只答第一次。
    const again = await postToEngine({ profile, supervisor, httpPost: () => assert.fail('不许走 HTTP'),
      path: '/tts', payload: { text: '再来', ref_audio_path: w.ref }, timeoutMs: 20000 })
    assert.equal(again.statusCode, 200, again.body.toString())
    const argv2 = JSON.parse(fs.readFileSync(w.record, 'utf8'))
    assert.equal(argv2[argv2.indexOf('--text') + 1], '再来')
  } finally {
    child.kill()
    fs.rmSync(w.tmp, { recursive: true, force: true })
  }
})

// python 形态：上游代码与它起的子进程都往 stdout 打字，其中有 Windows 文本模式下 print 空行
// 写出的 \r\n\r\n。宿主要在加载上游之前把 stdout 收归协议，这些字节进日志，不进管道。
const NOISY_UPSTREAM = `
import os, sys, wave
sys.stdout.write("import time\\r\\n\\r\\n"); sys.stdout.flush()
class Noisy:
    def __init__(self):
        print("constructing")
        os.system(sys.executable + " -c \\"print('child\\\\r\\\\n\\\\r\\\\n')\\"")
    def tts(self, text, ref, out):
        sys.stdout.write("synth\\r\\n\\r\\n"); sys.stdout.flush()
        w = wave.open(out, "wb")
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b"\\x00\\x00" * 1600)
        w.close()
`

test('⭐⭐ 通用宿主走 stdio：上游往 stdout 打字不会搅乱管道', { skip: !PYTHON && '没有 Python' }, async () => {
  const { resolveEngineProfile } = require('./profile')
  const { buildLaunchPlan } = require('./launchPlan')
  const { spawnFromPlan, probeStdio } = require('./spawnEngine')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-noisy-'))
  const enginesDir = path.join(tmp, 'engines')
  const id = 'stdio-noisy'
  const dir = path.join(enginesDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'noisy_tts.py'), NOISY_UPSTREAM)
  const ref = path.join(tmp, 'ref.wav')
  fs.writeFileSync(ref, Buffer.alloc(64))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    contract_version: 2,
    id,
    label: 'Stdio Noisy',
    runtime: { python: `engines/${id}/.venv`, entry: '../../lib/engines/host.py',
      verify: { sys_path: [`engines/${id}`], imports: [{ module: 'noisy_tts', class: 'Noisy' }] } },
    call: { kind: 'python', module: 'noisy_tts', class: 'Noisy', method: 'tts', returns: 'file',
      bind: { text: 'text', ref_audio: 'ref', output_path: 'out' }, seed: 'none' },
    params: { load_time: [], call_time: [] },
  }, null, 2))

  const profile = resolveEngineProfile(id, {}, { enginesDir, localRoot: tmp })
  assert.equal(profile.transport, 'stdio')
  const plan = buildLaunchPlan(profile, { rootDir: ROOT,
    profileJsonPath: path.join(tmp, 'cache', `${id}.profile.json`) })
  plan.python = PYTHON
  plan.entry = HOST
  // sys_path 相对启动目录解析。
  plan.cwd = tmp

  const child = spawnFromPlan(plan, { rootDir: tmp, logDir: path.join(tmp, 'logs'), enginesDir, localRoot: tmp })
  try {
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) {
      const r = await probeStdio(child.stdioTransport, plan.ready_endpoint, 2000)
      assert.ok(!(r instanceof Error), r && r.message)
      ready = r === true
      if (!ready) await new Promise((res) => setTimeout(res, 100))
    }
    assert.ok(ready, '宿主 10 秒内没有经管道答出 ready')
    for (const text of ['一', '二']) {
      const r = await child.stdioTransport.request({ method: 'POST', path: '/tts',
        payload: { text, ref_audio_path: ref }, timeoutMs: 20000 })
      assert.equal(r.statusCode, 200, r.body.toString())
      assert.equal(r.body.slice(0, 4).toString(), 'RIFF')
    }
    assert.equal(child.stdioTransport.closed, false)
  } finally {
    child.kill()
    await new Promise((res) => setTimeout(res, 200))
    const errLog = fs.readFileSync(path.join(tmp, 'logs', `${id}.err.log`), 'utf8')
    fs.rmSync(tmp, { recursive: true, force: true })
    assert.match(errLog, /constructing/, '上游打的字应当进日志')
    assert.match(errLog, /child/, '子进程打的字也应当进日志')
  }
})
