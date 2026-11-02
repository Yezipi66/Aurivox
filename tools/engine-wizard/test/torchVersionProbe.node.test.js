'use strict'

// Torch 版本与本机后端的匹配：探测层。
//
// 判据的核心：上游钉的 torch 版本，在本机推荐后端的官方 index 上，
//   有没有匹配引擎环境那个 Python ABI 的轮子。没有 ⇒ 装依赖必然失败，
//   而 uv 的报错（No solution found when resolving dependencies）看不出真因。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const probe = require('../core/torchVersionProbe.js')

/** 造一个「项目根 + engines/<id>/」的夹具 */
function mkdtempEngine (id, files) {
  const mkdtempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-torch-'))
  const mkdtempEngineDir = path.join(mkdtempRoot, 'engines', id)
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  fs.writeFileSync(path.join(mkdtempRoot, 'server.js'), '// anchor\n')
  for (const [name, content] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(mkdtempEngineDir, name), content)
  }
  return { root: mkdtempRoot, engineDir: mkdtempEngineDir }
}

// 一段假的 index 页面：照真实的 <a href> 形态造
function fakeIndexHtml (entries) {
  const lines = ['<html><body>']
  for (const e of entries) {
    lines.push(`<a href="https://download-r2.pytorch.org/whl/xpu/${e}">${e}</a>`)
  }
  lines.push('</body></html>')
  return lines.join('\n')
}

test('读上游声明的 torch 版本：requirements.txt', () => {
  const { engineDir } = mkdtempEngine('r1', {
    'requirements.txt': 'einops==0.8.1\ntorch==2.5.1\ntorchaudio==2.5.1\n',
  })
  const got = probe.readDeclaredTorchVersion(engineDir)
  assert.deepStrictEqual(got, { version: '2.5.1', source: 'requirements.txt' })
})

test('读上游声明的 torch 版本：uv.lock 优先于 requirements', () => {
  const { engineDir } = mkdtempEngine('r2', {
    'uv.lock': 'version = 1\n\n[[package]]\nname = "torch"\nversion = "2.8.0+cu128"\n',
    'requirements.txt': 'torch==2.5.1\n',
  })
  const got = probe.readDeclaredTorchVersion(engineDir)
  assert.deepStrictEqual(got, { version: '2.8.0+cu128', source: 'uv.lock' })
})

test('读上游声明的 torch 版本：pyproject.toml', () => {
  const { engineDir } = mkdtempEngine('r3', {
    'pyproject.toml': '[project]\ndependencies = ["torch==2.7.0"]\n',
  })
  const got = probe.readDeclaredTorchVersion(engineDir)
  assert.deepStrictEqual(got, { version: '2.7.0', source: 'pyproject.toml' })
})

test('上游没声明 torch 版本 ⇒ 返回 null（不猜）', () => {
  const { engineDir } = mkdtempEngine('r4', { 'requirements.txt': 'einops==0.8.1\n' })
  assert.strictEqual(probe.readDeclaredTorchVersion(engineDir), null)
})

test('index 清单解析：只认匹配该 ABI 与平台的轮子', () => {
  const html = fakeIndexHtml([
    'torch-2.6.0+xpu-cp311-cp311-win_amd64.whl',
    'torch-2.6.0+xpu-cp312-cp312-win_amd64.whl',
    'torch-2.7.0+xpu-cp311-cp311-win_amd64.whl',
    'torch-2.6.0+xpu-cp311-cp311-manylinux_2_28_x86_64.whl',
  ])
  const got = probe.parseTorchIndex(html, 'cp311', 'win_amd64')
  assert.deepStrictEqual(got.versions, ['2.6.0', '2.7.0'],
    '只有 cp311 + win_amd64 的算可用')
  assert.ok(got.tags.includes('cp312'), 'ABI 覆盖清单要含所有出现过的 tag')
})

test('index 清单解析：版本按数值升序，不按字符串', () => {
  const html = fakeIndexHtml([
    'torch-2.10.0+xpu-cp311-cp311-win_amd64.whl',
    'torch-2.9.0+xpu-cp311-cp311-win_amd64.whl',
    'torch-2.11.0+xpu-cp311-cp311-win_amd64.whl',
  ])
  const got = probe.parseTorchIndex(html, 'cp311', 'win_amd64')
  assert.deepStrictEqual(got.versions, ['2.9.0', '2.10.0', '2.11.0'])
})

test('ABI tag 从 Python 版本算出来', () => {
  assert.strictEqual(probe.abiTag('3.11'), 'cp311')
  assert.strictEqual(probe.abiTag('3.12'), 'cp312')
  assert.strictEqual(probe.abiTag('3.9'), 'cp39')
  assert.strictEqual(probe.abiTag('nonsense'), null)
})

test('后端没有官方 index ⇒ 不探测（返回 null，不编）', () => {
  assert.strictEqual(probe.BACKENDS_WITH_INDEX.directml, undefined)
  assert.strictEqual(probe.BACKENDS_WITH_INDEX.zluda, undefined)
  assert.ok(probe.BACKENDS_WITH_INDEX.ipex, 'XPU 有官方 index')
  assert.ok(probe.BACKENDS_WITH_INDEX.rocm, 'ROCm 有官方 index')
})

test('版本比较：按主次补丁逐段比', () => {
  assert.ok(probe.cmpVersion('2.10.0', '2.9.0') > 0, '2.10 > 2.9')
  assert.ok(probe.cmpVersion('2.5.1', '2.5.1') === 0)
  assert.ok(probe.cmpVersion('2.6.0', '2.5.1') > 0)
})

test('探测：上游钉的版本 >= 这个后端的下界 ⇒ 可用（不打扰使用者）', async () => {
  const { engineDir } = mkdtempEngine('p1', {
    'requirements.txt': 'torch==2.6.0\ntorchaudio==2.6.0\n',
  })
  // 判据是离线查表，不联网。
  const r = await probe.probeTorchVersion({
    dir: engineDir, backend: 'ipex', pythonVersion: '3.11',
    platform: 'win32', arch: 'x64', timeoutMs: 20000,
  })
  assert.strictEqual(r, null, '2.6.0 正好是 XPU 的下界 ⇒ 装得上，不弹窗')
})

test('探测：上游钉的版本低于这个后端的下界 ⇒ 报不可用并给建议版本', async () => {
  const { engineDir } = mkdtempEngine('p2', {
    'requirements.txt': 'torch==2.5.1\ntorchaudio==2.5.1\n',
  })
  const r = await probe.probeTorchVersion({
    dir: engineDir, backend: 'ipex', pythonVersion: '3.11',
    platform: 'win32', arch: 'x64', timeoutMs: 20000,
  })
  assert.ok(r, '应当探测出结果')
  assert.strictEqual(r.ok, false, '2.5.1 在 XPU 上没有 ⇒ 不可用')
  assert.strictEqual(r.reason, 'version-not-on-this-backend')
  assert.strictEqual(r.declared, '2.5.1')
  assert.ok(r.suggested, '必须给出建议版本')
  assert.ok(probe.cmpVersion(r.suggested, '2.5.1') > 0,
    `建议版本必须高于上游钉的版本：${r.suggested}`)
})

test('探测：上游没声明 torch ⇒ 不给结论（返回 null，不编）', async () => {
  const { engineDir } = mkdtempEngine('p3', { 'requirements.txt': 'einops==0.8.1\n' })
  const r = await probe.probeTorchVersion({
    dir: engineDir, backend: 'ipex', pythonVersion: '3.11',
    platform: 'win32', arch: 'x64', timeoutMs: 20000,
  })
  assert.strictEqual(r, null)
})
