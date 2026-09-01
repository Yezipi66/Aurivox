// lib/engines/hostProfileCli.node.test.js
//
// kind="cli"：**名片能不能这么写**（校验那一半）。
//
// ⛔ 这里钉不到「命令真的跑起来了」—— 那半在 host.py 里，用 node 测它只能
//   测到「文件里有这几个字」。真跑一次的读数在 tools/dev/probe_cli_host.py
//   （起真进程、拿真 wav 字节）。两半分开，是因为它们会以不同方式失败。
//
// ⭐ 这一刀的形状是**删限制 + 让名片描述**，所以每一条负向测试都在问同一句话：
//   名片写错的时候，是当场喊，还是悄悄不生效？

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const ID = 'cli-fake'

// 一张最小的、能过 resolveEngineProfile 的名片，call 段是 cli 形态。
function manifest(call) {
  return {
    // ⭐ 2026-08-31（刀 B1）：这里原本写的是 `manifest_version` —— 契约里
    //   没有这个键，正确的名字是 `contract_version`。它被静默忽略了不知多久，
    //   顶层白名单一上来当场就把它抓出来了。**第一个被这道闸拦下的是我们自己。**
    contract_version: 2,
    id: ID,
    label: 'CLI Fake',
    default_base_url: 'http://127.0.0.1:59998',
    timeout_ms: 1000,
    max_chars: 20,
    // ⭐ 刀 B1 抓到：这里原本还写了 hard_max_chars: 40。
    //   那不是名片键 —— 它是 profile.js 算出来的（max_chars × 2）。
    //   写了整整多久都在被扔掉，而 40 恰好 == 20×2 ⇒ **连一条测试都不会红**。
    //   这就是「你设了它，但什么都没发生」的原样。
    capabilities: {
      requires_reference_audio: false,
      reference_clip_seconds: null,
      streaming: false,
      output_sample_rate: 16000,
      supports_finetune: false,
    },
    maps: {},
    payload_keys: ['speed'],
    params: { load_time: [], call_time: ['speed'], schema: {} },
    call,
  }
}

const GOOD_CALL = {
  kind: 'cli',
  argv: ['{engine_python}', '-m', 'fake.cli', 'synth'],
  bind: { text: '--text', output_path: '--output' },
  args: { speed: { flag: '--speed' } },
  returns: 'file',
  seed: 'none',
}

// buildHostProfile 走 registry ⇒ 要一个真的 ENGINES_DIR ⇒ 子进程。
function build(call) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-fake-'))
  try {
    fs.mkdirSync(path.join(dir, ID))
    fs.writeFileSync(path.join(dir, ID, 'manifest.json'),
      JSON.stringify(manifest(call), null, 2))
    const script = `
      const { buildHostProfile } = require(${JSON.stringify(path.join(ROOT, 'lib/engines/hostProfile'))});
      try { process.stdout.write(JSON.stringify({ ok: buildHostProfile(${JSON.stringify(ID)}) })) }
      catch (e) { process.stdout.write(JSON.stringify({ err: e.message })) }
    `
    const stdout = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, ENGINES_DIR: dir },
      encoding: 'utf-8',
    })
    return JSON.parse(stdout)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function rejects(call, needle, message) {
  const got = build(call)
  assert.equal(got.ok, undefined, `本该被拒，却过了：${JSON.stringify(call)}`)
  assert.match(got.err, needle, message)
}

// ---------------------------------------------------------------------------

test('⭐ kind="cli" 的名片能被平台读进去（在这一刀之前它是当场被拒的）', () => {
  const got = build(GOOD_CALL)
  assert.equal(got.err, undefined, got.err)
  assert.equal(got.ok.call.kind, 'cli')
  // 原样带过去：宿主读的是这份 JSON，⛔ 不是 manifest.json。
  assert.deepEqual(got.ok.call.argv, GOOD_CALL.argv)
  assert.deepEqual(got.ok.call.bind, GOOD_CALL.bind)
  assert.deepEqual(got.ok.call.args, GOOD_CALL.args)
})

test('认不出的 kind 仍然当场拒（放开的是值域，不是闸门）', () => {
  rejects({ ...GOOD_CALL, kind: 'carrier-pigeon' }, /carrier-pigeon/)
})

test('⭐ 键表按 kind 分：cli 名片里写 module ⇒ 拒，⛔ 不许写了不生效', () => {
  rejects({ ...GOOD_CALL, module: 'indextts.infer_v2' }, /call\.module/)
})

test('⭐ 反过来也一样：python 名片里写 argv ⇒ 拒', () => {
  rejects({
    kind: 'python',
    module: 'm', class: 'C', method: 'infer',
    bind: { text: 't', output_path: 'o' },
    argv: ['x'], seed: 'none',
  }, /call\.argv/)
})

test('cli 少了 argv ⇒ 拒（平台不知道该执行什么）', () => {
  const { argv, ...noArgv } = GOOD_CALL
  rejects(noArgv, /call\.argv/)
})

test('argv 是空数组 ⇒ 拒', () => {
  rejects({ ...GOOD_CALL, argv: [] }, /call\.argv/)
})

test('⭐ bind 槽位里写成了方法参数名（不以 - 开头）⇒ 拒，⛔ 不许变成位置参数', () => {
  rejects({ ...GOOD_CALL, bind: { text: 'text', output_path: '--output' } },
    /命令行开关/)
})

test('returns="file" 却没有 bind.output_path ⇒ 拒（老规矩，cli 也照用）', () => {
  rejects({ ...GOOD_CALL, bind: { text: '--text' } }, /output_path/)
})

test('returns="bytes" 时不需要 output_path（从 stdout 拿）', () => {
  const got = build({ ...GOOD_CALL, returns: 'bytes', bind: { text: '--text' } })
  assert.equal(got.err, undefined, got.err)
  assert.equal(got.ok.call.returns, 'bytes')
})

test('call.args 的四种开关形状都认', () => {
  const got = build({
    ...GOOD_CALL,
    args: {
      speed: { flag: '--speed' },
      verbose: { flag: '--verbose', style: 'boolean' },
      fp16: { flag: '--fp16', style: 'boolean_optional' },
      emo: { flag: '--emotion-vector', style: 'join', join: ',' },
    },
  })
  assert.equal(got.err, undefined, got.err)
})

test('style 打错字 ⇒ 拒（⛔ 不许当成默认的 value 悄悄过去）', () => {
  rejects({ ...GOOD_CALL, args: { speed: { flag: '--speed', style: 'boolen' } } },
    /style/)
})

test('flag 不以 - 开头 ⇒ 拒', () => {
  rejects({ ...GOOD_CALL, args: { speed: { flag: 'speed' } } }, /flag/)
})

test('⭐ join 写在别的 style 下 ⇒ 拒（写了不生效是最难发现的那种错）', () => {
  rejects({ ...GOOD_CALL, args: { speed: { flag: '--speed', join: ',' } } }, /join/)
})

test('boolean_optional 配短开关 ⇒ 拒（造不出 --no-x）', () => {
  rejects({ ...GOOD_CALL, args: { f: { flag: '-f', style: 'boolean_optional' } } },
    /boolean_optional/)
})

test('call.args 里多写一个认不出的键 ⇒ 拒', () => {
  rejects({ ...GOOD_CALL, args: { speed: { flag: '--speed', when: 'always' } } },
    /when/)
})

test('cli 也必须显式声明可复现性（call.seed 缺了 ⇒ 拒）', () => {
  const { seed, ...noSeed } = GOOD_CALL
  rejects(noSeed, /seed/)
})
