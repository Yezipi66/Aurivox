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
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, exclude: [], execute: true })
  assert.strictEqual(p.ok, true)
  assert.strictEqual(p.choices.applied, false)
  assert.ok(!envArgv(p).join(' ').includes('--excludes'))
  assert.ok(!fs.existsSync(path.join(dir, EXCLUDES_FILE)))
})

// 选的后端与 PyPI 会给的那个一致时不必改写：Windows 上 PyPI 的 torch 就是 CPU 版。
test('Windows 上选 CPU ⇒ 装法不变（PyPI 给的本来就是 CPU）', () => {
  const { root } = mkdtempEngine({ 'requirements.txt': 'numpy\ntorch\n' })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'cpu',
    platform: 'win32', execute: true })
  assert.strictEqual(p.choices.applied, false)
  assert.ok(!envArgv(p).join(' ').includes('--excludes'))
})

// 这条是「选中推荐档反而不生效」的回归用例：
//   Intel 机器上推荐值就是 ipex，判据若写成「所选 == 推荐就不改写」，
//   选了 XPU 仍从 PyPI 装成 CPU 版。
test('所选后端等于本机推荐（Intel 选 XPU）⇒ 照样改写，第三段从 xpu 索引装', () => {
  const { root, dir } = mkdtempEngine({ 'requirements.txt': 'numpy\ntorch\ntorchaudio\n' })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'ipex',
    recommendedBackend: 'ipex', platform: 'win32', execute: true })
  assert.strictEqual(p.choices.applied, true)
  const argv = envArgv(p)
  assert.strictEqual(argv.length, 2, `应当是主装 + 追加两步：${argv.join(' | ')}`)
  assert.match(argv[1], /--index-url https:\/\/download\.pytorch\.org\/whl\/xpu$/)
  assert.strictEqual(fs.readFileSync(path.join(dir, EXCLUDES_FILE), 'utf8'),
    'torch\ntorchaudio\n')
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
  // 必须强制重装：PyPI 装过同名同版本的 CPU 版时，uv 只会回一句 Checked 就结束，
  //   索引里的 GPU 轮子一个都不落盘，而退出码仍是 0。
  assert.match(argv[1], /--reinstall-package torch/,
    `追加步没有强制重装，已装的 CPU 版会让它空转：${argv[1]}`)
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
  // sync 路线要把 Python 版本点名，否则它按 requires-python 自己挑。
  assert.ok(/^uv sync( --no-install-package \S+)*( --python [\d.]+)?$/.test(envArgv(p)[0]), envArgv(p)[0])
  assert.ok(envArgv(p)[0].includes('--no-install-package numpy'))
})

test('锁文件路线：所选后端与锁一致 ⇒ 照锁装，不另装 torch', () => {
  const { root } = mkdtempEngine({ 'uv.lock': LOCK })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'cuda',
    recommendedBackend: 'ipex' })
  assert.match(envArgv(p)[0], /^uv sync( --python [\d.]+)?$/, envArgv(p)[0])
})

test('锁文件路线：换到别的后端 ⇒ 跳过 torch 系，从所选 index 装同一版本', () => {
  const { root } = mkdtempEngine({ 'uv.lock': LOCK })
  const p = buildEnvPlan({ id: 'demo', root, manifest: {}, backend: 'ipex',
    recommendedBackend: 'cuda', exclude: ['torchaudio'] })
  const argv = envArgv(p)
  assert.match(argv[0], /^uv sync --no-install-package torch --no-install-package torchaudio( --python [\d.]+)?$/, argv[0])
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
