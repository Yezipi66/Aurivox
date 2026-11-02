'use strict'
// core/installChoices.js 的「选依赖版本」路线：安装命令要真的按所选版本走。
//
// 判据的理由：这条路线改的是清单副本，不是排除。排除的语义是
//   「这个包连同依赖它的其它包一起不装」，所以改版本若走排除，
//   依赖它的包也会掉。命令形态必须能看出来改的是哪一条。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { applyInstallChoices, versionOverrideRoute } =
  require(path.join(__dirname, '..', 'core', 'installChoices.js'))
const VO = require(path.join(__dirname, '..', 'core', 'versionOverrides.js'))

function tmpDir (files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-'))
  for (const [name, text] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, name), text, 'utf8')
  }
  return dir
}

const REQ_GUESS = {
  argv: ['uv', 'pip', 'install', '-r', 'requirements.txt'],
  from: 'requirements.txt',
  cwd: '.',
}

test('普通包改版本：主命令指向清单副本，不是排除', () => {
  const dir = tmpDir({ 'requirements.txt': 'einops==0.8.1\ntorch==2.5.1\n' })
  const r = applyInstallChoices(dir, REQ_GUESS, {
    versionOverrides: { einops: '0.7.0' },
    // 后端给 cpu：CPU 上 torch 2.5.1 装得上（Python 3.11 的下界是 2.0.0）
    //   ⇒ torch 那行保持原样，这条测试要守的就是「没改的包要原样保留」。
    //   不给后端的话，torch 会不会被改写要看本机 GPU（各台机器结果不同）。
    recommendedBackend: 'cpu',
    execute: true,
  })
  assert.ok(r.guess, '要有结果')
  const argv = r.guess.argv
  assert.ok(argv.includes(VO.LOCAL_MANIFEST), `命令要指向清单副本：${argv.join(' ')}`)
  assert.ok(!argv.includes('--no-install-package'), '普通包改版本不能走排除')
  const local = fs.readFileSync(path.join(dir, VO.LOCAL_MANIFEST), 'utf8')
  assert.ok(local.includes('einops==0.7.0'), '副本里要是所选版本')
  assert.ok(local.includes('torch==2.5.1'), '没改的包要原样保留')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('普通包改版本：上游文件保持原样', () => {
  const dir = tmpDir({ 'requirements.txt': 'einops==0.8.1\n' })
  applyInstallChoices(dir, REQ_GUESS, {
    versionOverrides: { einops: '0.7.0' }, execute: true,
  })
  const upstream = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8')
  assert.ok(upstream.includes('einops==0.8.1'), '上游文件不能被改')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('torch 改版本：主命令跳过 torch，追加一步按所选版本装', () => {
  const dir = tmpDir({ 'requirements.txt': 'einops==0.8.1\ntorch==2.5.1\n' })
  const r = applyInstallChoices(dir, REQ_GUESS, {
    versionOverrides: { torch: '2.6.0' }, backend: 'ipex', execute: true,
  })
  assert.ok(r.guess, '要有结果')
  const alt = r.guess.alternative
  assert.ok(alt, 'torch 改版本要追加一步')
  assert.ok(alt.then.includes('torch==2.6.0'), `追加那一步要装所选版本：${alt.then.join(' ')}`)
  assert.ok(alt.then.some((a) => String(a).includes('/whl/xpu')),
    `追加那一步要用该后端的 index：${alt.then.join(' ')}`)
  const skip = fs.readFileSync(path.join(dir, '.wizard-excludes.txt'), 'utf8')
  assert.ok(skip.includes('torch'), '主命令要跳过 torch')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('torch 与普通包一起改版本：两条都要生效', () => {
  const dir = tmpDir({ 'requirements.txt': 'einops==0.8.1\ntorch==2.5.1\n' })
  const r = applyInstallChoices(dir, REQ_GUESS, {
    versionOverrides: { torch: '2.6.0', einops: '0.7.0' },
    backend: 'ipex', execute: true,
  })
  assert.ok(r.guess, '要有结果')
  const local = fs.readFileSync(path.join(dir, VO.LOCAL_MANIFEST), 'utf8')
  assert.ok(local.includes('einops==0.7.0'), '普通包要在副本里改')
  assert.ok(r.guess.alternative.then.includes('torch==2.6.0'), 'torch 要在追加那一步改')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('锁文件路线：如实报「版本已锁死」，不闷头改', () => {
  const dir = tmpDir({ 'uv.lock': 'name = "torch"\nversion = "2.5.1"\n' })
  const guess = { argv: ['uv', 'sync'], from: 'uv.lock', cwd: '.' }
  const r = applyInstallChoices(dir, guess, {
    versionOverrides: { torch: '2.6.0' }, execute: true,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'VERSION_OVERRIDE_ON_LOCK')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('所选版本对不上清单里的包：如实报', () => {
  const dir = tmpDir({ 'requirements.txt': 'einops==0.8.1\n' })
  const r = applyInstallChoices(dir, REQ_GUESS, {
    versionOverrides: { torch: '2.6.0' }, execute: true,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_VERSION_OVERRIDE_APPLIED')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('计划阶段（execute 不带）：不写盘，命令照样指向副本', () => {
  const dir = tmpDir({ 'requirements.txt': 'einops==0.8.1\n' })
  const r = applyInstallChoices(dir, REQ_GUESS, {
    versionOverrides: { einops: '0.7.0' },
  })
  assert.ok(r.guess.argv.includes(VO.LOCAL_MANIFEST), '计划里的命令就是真命令')
  assert.strictEqual(fs.existsSync(path.join(dir, VO.LOCAL_MANIFEST)), false,
    '计划阶段不写盘')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('什么都没选：命令原样返回', () => {
  const dir = tmpDir({ 'requirements.txt': 'einops==0.8.1\n' })
  // 钉住推荐后端：本测试只管「没选就不动」，与本机有没有显卡无关
  //   （Linux + CPU 时 torch 要改走 CPU index，见下面 pypiTorch 那两条）。
  const r = applyInstallChoices(dir, REQ_GUESS, { recommendedBackend: 'cuda' })
  assert.strictEqual(r.choices.applied, false)
  assert.deepStrictEqual(r.guess.argv, REQ_GUESS.argv)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('pyproject 路线：拆成「按副本装依赖」与「装项目本体」两步', () => {
  const dir = tmpDir({
    'pyproject.toml': '[project]\nname = "x"\ndependencies = [\n  "einops==0.8.1",\n  "torch==2.5.1",\n]\n',
  })
  const guess = { argv: ['uv', 'pip', 'install', '-e', '.'], from: 'pyproject.toml', cwd: '.' }
  const r = applyInstallChoices(dir, guess, {
    versionOverrides: { einops: '0.7.0' }, execute: true,
  })
  assert.ok(r.guess, '要有结果')
  assert.ok(r.guess.argv.includes(VO.LOCAL_MANIFEST), '第一步要按副本装')
  assert.ok(r.guess.alternative, '要有第二步')
  assert.ok(r.guess.alternative.then.includes('--no-deps'), '第二步装项目本体时不带依赖')
  const local = fs.readFileSync(path.join(dir, VO.LOCAL_MANIFEST), 'utf8')
  assert.ok(local.includes('einops==0.7.0'), '副本里要是所选版本')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Linux 上目标是 CPU：哪怕没选后端，torch 也改走 CPU 官方 index（PyPI 的是 CUDA 版）', () => {
  const dir = tmpDir({
    'pyproject.toml': '[project]\nname = "x"\ndependencies = [\n  "einops==0.8.1",\n  "torch>=2.8.0",\n  "torchaudio>=2.8.0",\n]\n',
  })
  const guess = { argv: ['uv', 'pip', 'install', '-e', '.'], from: 'pyproject.toml', cwd: '.' }
  const r = applyInstallChoices(dir, guess, { recommendedBackend: 'cpu', platform: 'linux' })
  assert.strictEqual(r.choices.applied, true)
  assert.ok(r.guess.argv.includes('--excludes'), r.guess.argv.join(' '))
  const then = r.guess.alternative.then
  assert.deepStrictEqual(then.slice(0, 5), ['uv', 'pip', 'install', 'torch>=2.8.0', 'torchaudio>=2.8.0'])
  assert.strictEqual(then[then.indexOf('--index-url') + 1], 'https://download.pytorch.org/whl/cpu')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Windows / macOS 上目标是 CPU：PyPI 的 torch 本来就是 CPU 版，命令原样', () => {
  const dir = tmpDir({ 'requirements.txt': 'torch>=2.8.0\n' })
  for (const platform of ['win32', 'darwin']) {
    const r = applyInstallChoices(dir, REQ_GUESS, { recommendedBackend: 'cpu', platform })
    assert.strictEqual(r.choices.applied, false, platform)
    assert.deepStrictEqual(r.guess.argv, REQ_GUESS.argv)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})
