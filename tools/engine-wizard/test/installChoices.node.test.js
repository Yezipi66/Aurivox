'use strict'
// 第 2 步：用户可以跳过任意包、可以换 torch 后端；什么都不改时装法与原来一致。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildEnvPlan } = require('../core/env.js')
const { EXCLUDES_FILE } = require('../core/installChoices.js')

function mkdtempEngine (files) {
  const mkdtempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-choices-'))
  fs.writeFileSync(path.join(mkdtempRootDir, 'server.js'), '// anchor\n')
  const mkdtempEngineDir = path.join(mkdtempRootDir, 'engines', 'demo')
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(mkdtempEngineDir, name), text)
  }
  return { root: mkdtempRootDir, dir: mkdtempEngineDir }
}

const envArgv = (p) => p.steps.filter((s) => s.kind === 'env' && !s.skipIfExists)
  .map((s) => s.argv.join(' '))

const LOCK = [
  'version = 1', '',
  '[[package]]', 'name = "torch"', 'version = "2.8.0+cu128"',
  'source = { registry = "https://download.pytorch.org/whl/cu128" }', '',
  '[[package]]', 'name = "torchaudio"', 'version = "2.8.0+cu128"', '',
].join('\n')

test('什么都不改 ⇒ 装法与原来一致，也不写排除文件', () => {
  const { root, dir } = mkdtempEngine({ 'requirements.txt': 'numpy\ntorch==2.1.0\n' })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'cuda',
    recommendedBackend: 'cuda', exclude: [], execute: true })
  assert.strictEqual(p.ok, true)
  assert.strictEqual(p.choices.applied, false)
  assert.ok(!envArgv(p).join(' ').includes('--excludes'))
  assert.ok(!fs.existsSync(path.join(dir, EXCLUDES_FILE)))
})

test('跳过普通包 ⇒ --excludes 排除文件，名字按 PEP 503 归一', () => {
  const { root, dir } = mkdtempEngine({ 'requirements.txt': 'numpy\nLibRosa\n' })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, exclude: ['LibRosa'], execute: true })
  assert.strictEqual(p.choices.applied, true)
  assert.match(envArgv(p)[0], /-r requirements\.txt --excludes \.wizard-excludes\.txt$/)
  assert.strictEqual(fs.readFileSync(path.join(dir, EXCLUDES_FILE), 'utf8'), 'librosa\n')
})

test('只出计划（execute 不为 true）⇒ 不写文件', () => {
  const { root, dir } = mkdtempEngine({ 'requirements.txt': 'numpy\n' })
  buildEnvPlan({ id: 'demo', root, manifest: {}, exclude: ['numpy'] })
  assert.ok(!fs.existsSync(path.join(dir, EXCLUDES_FILE)))
})

test('requirements 换后端 ⇒ torch 从主安装排除，另从所选后端 index 装，去掉本地版本后缀', () => {
  const { root, dir } = mkdtempEngine({
    'requirements.txt': 'numpy\ntorch==2.1.0+cu118 ; sys_platform == "win32"\n' })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'ipex',
    recommendedBackend: 'cuda', execute: true })
  const argv = envArgv(p)
  assert.strictEqual(argv.length, 2)
  assert.match(argv[1], /install .*torch==2\.1\.0 --index-url https:\/\/download\.pytorch\.org\/whl\/xpu$/)
  assert.strictEqual(fs.readFileSync(path.join(dir, EXCLUDES_FILE), 'utf8'), 'torch\n')
})

test('所选后端没有官方 index ⇒ 如实报错，不装', () => {
  const { root } = mkdtempEngine({ 'requirements.txt': 'torch==2.1.0\n' })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'directml',
    recommendedBackend: 'cpu' })
  assert.strictEqual(p.ok, false)
  assert.strictEqual(p.code, 'BACKEND_NO_INDEX')
  assert.ok(p.errorZh && p.error)
})

test('锁文件路线跳包 ⇒ --no-install-package', () => {
  const { root } = mkdtempEngine({ 'uv.lock': LOCK })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'cuda',
    recommendedBackend: 'cuda', exclude: ['numpy'] })
  assert.ok(/^uv sync( --no-install-package \S+)*$/.test(envArgv(p)[0]), envArgv(p)[0])
  assert.ok(envArgv(p)[0].includes('--no-install-package numpy'))
})

test('锁文件路线：所选后端与锁一致 ⇒ 照锁装，不另装 torch', () => {
  const { root } = mkdtempEngine({ 'uv.lock': LOCK })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'cuda',
    recommendedBackend: 'ipex' })
  assert.deepStrictEqual(envArgv(p), ['uv sync'])
})

test('锁文件路线：换到别的后端 ⇒ 跳过 torch 系，从所选 index 装同一版本', () => {
  const { root } = mkdtempEngine({ 'uv.lock': LOCK })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'ipex',
    recommendedBackend: 'cuda', exclude: ['torchaudio'] })
  const argv = envArgv(p)
  assert.strictEqual(argv[0], 'uv sync --no-install-package torch --no-install-package torchaudio')
  assert.match(argv[1], /install .*torch==2\.8\.0 --index-url https:\/\/download\.pytorch\.org\/whl\/xpu$/)
  assert.ok(!argv[1].includes('torchaudio'))
})

test('pyproject 路线跳包 ⇒ -e 加 --excludes', () => {
  const { root } = mkdtempEngine({
    'pyproject.toml': '[project]\nname = "x"\ndependencies = [\n  "numpy",\n  "gradio",\n]\n' })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, exclude: ['gradio'] })
  assert.match(envArgv(p)[0], /install .*-e \. --excludes \.wizard-excludes\.txt$/)
})

test('名片自己写了装法 ⇒ 不能单独跳包，命令原样', () => {
  const { root } = mkdtempEngine({ 'requirements.txt': 'numpy\n' })
  const manifest = { install: { env_command: ['uv', 'pip', 'install', '-r', 'requirements.txt'] } }
  const p = buildEnvPlan({ id: 'demo', root, manifest, exclude: ['numpy'] })
  assert.strictEqual(p.choices.supported, false)
  assert.ok(!JSON.stringify(p.steps).includes('--excludes'))
})
