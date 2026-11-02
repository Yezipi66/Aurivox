'use strict'

// 界面显示的那条 spec 必须与真正写进清单副本的那条一致。
//
// 这条守的是三个容易漏掉的地方：
//   ① 使用者没选后端时，判 torch 版本那一步也得有后端可比
//      （否则 torch 系静默不改 ⇒ 界面显示上游那版、实际装另一版）；
//   ② 判 torch 版本要 Python 的 ABI，调用方没传时函数自己算
//      （否则缺这一项就静默不改 torch）；
//   ③ 改写完的清单副本与返回的 specs 逐条一致。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const IC = require(path.join(__dirname, '..', 'core', 'installChoices.js'))

const MANIFEST = [
  'einops==0.8.1',
  'torch==2.5.1',
  'torchaudio==2.5.1',
  'transformers==4.45.0',
  '',
].join('\n')

function tmpDir (manifest) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-torchspec-'))
  fs.writeFileSync(path.join(d, 'requirements.txt'), manifest, 'utf8')
  return d
}

const GUESS = {
  from: 'requirements.txt',
  cwd: '.',
  argv: ['uv', 'pip', 'install', '-r', 'requirements.txt'],
  label: 'requirements',
}

function copySpecs (dir) {
  const p = path.join(dir, '.wizard-requirements.local.txt')
  if (!fs.existsSync(p)) return null
  return fs.readFileSync(p, 'utf8').split('\n')
    .map((l) => l.replace(/#.*$/, '').split(';')[0].trim())
    .filter((l) => l && !l.startsWith('-'))
}

test('写进清单副本的那条与返回的 specs 逐条一致', () => {
  const dir = tmpDir(MANIFEST)
  const r = IC.applyInstallChoices(dir, GUESS, {
    versionOverrides: { einops: '0.7.0' }, execute: true,
  })
  assert.ok(!r.ok, '这一步不该报错：' + JSON.stringify(r))
  assert.deepStrictEqual(copySpecs(dir), r.specs,
    '界面显示的 specs 与写进副本的那份必须一致')
})

test('使用者没选后端时，torch 系也要按本机后端改写', () => {
  const dir = tmpDir(MANIFEST)
  // backend 不给（前端在使用者没选时就是不给）。
  //   recommendedBackend 给 ipex：XPU 上 2.5.1 的下界是 2.6.0 ⇒ 一定不可用
  //   ⇒ torch 那两行必然被改成 2.6.0。这条与本机有没有 GPU 无关。
  const r = IC.applyInstallChoices(dir, GUESS, {
    versionOverrides: { einops: '0.7.0' },
    recommendedBackend: 'ipex',
    execute: true,
  })
  assert.ok(!r.ok, '这一步不该报错：' + JSON.stringify(r))
  assert.ok(r.specs.includes('torch==2.6.0'),
    'XPU 上 2.5.1 装不上，torch 要改成 2.6.0：' + JSON.stringify(r.specs))
  assert.ok(r.specs.includes('torchaudio==2.6.0'),
    'torchaudio 要一起改：' + JSON.stringify(r.specs))
  assert.deepStrictEqual(copySpecs(dir), r.specs,
    '改了版本之后副本与 specs 也要一致')
})

test('调用方没给 Python 版本时，函数自己算（缺这一项不该静默不改 torch）', () => {
  const dir = tmpDir(MANIFEST)
  // 不传 pythonVersion：函数要自己读引擎声明，读不到就用平台基座。
  const r = IC.applyInstallChoices(dir, GUESS, {
    versionOverrides: { einops: '0.7.0' },
    recommendedBackend: 'ipex',
    execute: false,
  })
  assert.ok(!r.ok, '这一步不该报错：' + JSON.stringify(r))
  assert.ok(r.specs.includes('torch==2.6.0'),
    '没给 Python 版本也要判出 torch 不可用：' + JSON.stringify(r.specs))
})

test('没选后端且本机判不出后端时，如实保持上游版本（不编）', () => {
  const dir = tmpDir(MANIFEST)
  const r = IC.applyInstallChoices(dir, GUESS, {
    versionOverrides: { einops: '0.7.0' },
    recommendedBackend: 'cuda',   // 判不出的后端
    execute: false,
  })
  assert.ok(!r.ok, '这一步不该报错：' + JSON.stringify(r))
  // 判不出来时 torch 保持上游那版。
  assert.ok(r.specs.includes('torch==2.5.1'),
    '判不出来就不该改 torch：' + JSON.stringify(r.specs))
})

test('使用者显式选了 torch 时，照他选的来，不自动换', () => {
  const dir = tmpDir(MANIFEST)
  const r = IC.applyInstallChoices(dir, GUESS, {
    versionOverrides: { torch: '2.7.0' }, execute: true,
  })
  assert.ok(!r.ok, '这一步不该报错：' + JSON.stringify(r))
  assert.ok(r.specs.includes('torch==2.7.0'), '显式选的版本要照用')
  assert.deepStrictEqual(copySpecs(dir), r.specs)
})
