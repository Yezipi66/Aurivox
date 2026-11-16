// 自检该验谁：依赖清单里声明的 torch 系也要验，不只看命令行里出现过什么。
//
// 起因：`-r requirements.txt` 这种装法，包名不在 argv 上。只按 argv 找 torch
//   就会判成「没有可验证的依赖」，界面显示未验证，读的人据此以为 torch 没装。
//   清单是声明，命令行只是执行方式，两者都是「上游说需要什么」。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const envMod = require('../core/envInstall.js')

function mkEngine (id, reqText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-declared-'))
  const dir = path.join(root, 'engines', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(root, 'server.js'), '// anchor\n')
  fs.writeFileSync(path.join(dir, 'requirements.txt'), reqText)
  return { root, dir }
}

const okStep = async () => ({ ok: true, code: 'OK', status: 0, stdout: '', stderr: '' })

test('requirements 里声明了 torch：必须验它，而不是判成「没有可验证的依赖」', async () => {
  const { root } = mkEngine('reqtorch', 'torch\ntorchaudio\nnumpy\n')
  const seen = []
  const r = await envMod.runEnv({
    id: 'reqtorch', root, execute: true, manifest: {},
    runStep: okStep,
    probeImport: (rt, id, mod) => {
      seen.push(mod)
      return { ok: true, mod, code: 'OK', detail: '' }
    },
  })
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.envCheck.checked, true,
    '清单里声明了 torch 却没验：界面只能显示未验证，读的人会以为没装')
  assert.deepStrictEqual(r.envCheck.mods, ['torch', 'torchaudio'])
  assert.strictEqual(r.envUnverified, false)
  assert.ok(seen.includes('torch'), '自检说验了，就必须真的在该引擎环境里 import 过')
})

test('清单里没有 torch 的装法：不硬验，结论仍是「没有可验证对象」', async () => {
  const { root } = mkEngine('nocheck', 'numpy\nrequests\n')
  const r = await envMod.runEnv({
    id: 'nocheck', root, execute: true, manifest: {},
    runStep: okStep,
    probeImport: () => { throw new Error('没声明 torch 就不该验 torch') },
  })
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.envCheck.checked, false)
  assert.strictEqual(r.envCheck.reason, 'no-core-dependency-declared', r.envCheck.reason)
})

test('声明了但被人跳过：不验，且理由不能写成「上游没声明」', async () => {
  const { root } = mkEngine('skipped', 'torch\nnumpy\n')
  const r = await envMod.runEnv({
    id: 'skipped', root, execute: true, manifest: {},
    exclude: ['torch'],
    runStep: okStep,
    probeImport: () => { throw new Error('被跳过的包不该验：那不是没装成，是这次不装') },
  })
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.envCheck.checked, false)
  assert.strictEqual(r.envCheck.reason, 'declared-torch-was-skipped', r.envCheck.reason)
  assert.strictEqual(r.envUnverified, true)
  assert.match(r.noteZh, /跳过了/)
  assert.match(r.noteZh, /第 5 步/)
})

test('自检只取 torch 系：其它包名与 import 名对不上，不许猜', async () => {
  const { root } = mkEngine('mixed', 'torch\nPillow\npiper-phonemize\nsetuptools<81\n')
  const seen = []
  const r = await envMod.runEnv({
    id: 'mixed', root, execute: true, manifest: {},
    runStep: okStep,
    probeImport: (rt, id, mod) => {
      seen.push(mod)
      return { ok: true, mod, code: 'OK', detail: '' }
    },
  })
  assert.deepStrictEqual(r.envCheck.mods, ['torch'])
  assert.deepStrictEqual(seen, ['torch'])
})

// 装完之后 torch 到底是哪一档：只验「能 import」不够，CPU 版也能 import。
//   选了 XPU 却装成 CPU 时，前面每一步都会显示成功。
test('选了 XPU 却装成 CPU：结论必须说出来，并按警告标记', async () => {
  const { root } = mkEngine('be1', 'torch\ntorchaudio\n')
  const r = await envMod.runEnv({
    id: 'be1', root, execute: true, manifest: {},
    backend: 'ipex',
    runStep: okStep,
    probeImport: (rt, id, mod) => ({ ok: true, mod, code: 'OK', detail: '' }),
    probeBackend: () => ({ version: '2.15.0+cpu', cuda: false, xpu: false, backend: 'cpu' }),
  })
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.backendCheck.expected, 'ipex')
  assert.strictEqual(r.backendCheck.actual, 'cpu')
  assert.strictEqual(r.backendMismatch, true, '选的后端没装上，不能按成功显示')
  assert.match(r.noteZh, /选的是 XPU/)
  assert.match(r.noteZh, /2\.15\.0\+cpu/)
})

test('装到所选后端：结论里写明是哪一档，且不算不一致', async () => {
  const { root } = mkEngine('be2', 'torch\ntorchaudio\n')
  const r = await envMod.runEnv({
    id: 'be2', root, execute: true, manifest: {},
    backend: 'ipex',
    runStep: okStep,
    probeImport: (rt, id, mod) => ({ ok: true, mod, code: 'OK', detail: '' }),
    probeBackend: () => ({ version: '2.15.0+xpu', cuda: false, xpu: true, backend: 'ipex' }),
  })
  assert.strictEqual(r.backendCheck.ok, true)
  assert.strictEqual(r.backendMismatch, false)
  assert.match(r.noteZh, /torch 是 XPU 版/)
})

test('没选后端：只报实测是哪一档，不判不一致', async () => {
  const { root } = mkEngine('be3', 'torch\n')
  const r = await envMod.runEnv({
    id: 'be3', root, execute: true, manifest: {},
    runStep: okStep,
    probeImport: (rt, id, mod) => ({ ok: true, mod, code: 'OK', detail: '' }),
    probeBackend: () => ({ version: '2.15.0+cpu', cuda: false, xpu: false, backend: 'cpu' }),
  })
  assert.strictEqual(r.backendCheck.expected, null)
  assert.strictEqual(r.backendMismatch, false)
  assert.match(r.noteZh, /torch 是 CPU 版/)
})
