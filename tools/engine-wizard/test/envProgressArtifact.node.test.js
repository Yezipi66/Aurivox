'use strict'

// 断点续传的产物检查：命令文本之外，还要核对**产物的版本与后端**。
//
// 被测代码：tools/engine-wizard/core/envProgress.js
//   （stepArtifactExists / installedPackageVersion / parseDeclaredSpecs
//     / parseIndexName / versionMatches）
//
// 这一层为什么必须有：产物在、但已经不是命令要装的那一版时
//   （例如手工把 torch 从 2.6.0+xpu 降回上游钉的 2.5.1），
//   命令文本一字未变 ⇒ 只看命令文本会判「已完成」而跳过
//   ⇒ 装出来的环境是错的，而界面报「完成」。
//
// 判「装对了」不能只看 import 成不成功：`2.5.1+cpu` 能 import 成功，
//   但它是 CPU 版，在 XPU 机器上用不上加速。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CORE_DIR = path.join(__dirname, '..', 'core')
const progress = require(path.join(CORE_DIR, 'envProgress.js'))

/**
 * 引擎 venv 里 site-packages 的相对路径。
 *
 * 被测代码（tools/engine-wizard/core/envProgress.js 的 sitePackagesDir）
 * 按运行平台找目录：Windows 是 `Lib/site-packages`，
 * posix 是 `lib/python3.<次版本>/site-packages`。
 * 夹具之前写死 Windows 那种形状，于是同一份夹具跑到 posix 上就找不到
 * site-packages，读版本读成 null，断言拿不到值就红。
 * 夹具得跟被测代码按同一口径找目录，两个平台上才都能验同一条判据。
 *
 * posix 那一段不写死次版本：被测代码是扫 `lib` 下所有 `python3.*` 目录，
 * 夹具也扫一遍 ⇒ 解释器是 3.11 还是 3.12 都对得上。
 *
 * @param {string} venvDir 引擎 venv 目录
 * @returns {string} site-packages 的绝对路径
 */
function sitePackagesAbs (venvDir) {
  if (process.platform === 'win32') return path.join(venvDir, 'Lib', 'site-packages')
  const libDir = path.join(venvDir, 'lib')
  let entries = []
  try { entries = fs.readdirSync(libDir, { withFileTypes: true }) } catch (e) { entries = [] }
  for (const e of entries) {
    if (e.isDirectory() && /^python3\./.test(e.name)) {
      return path.join(libDir, e.name, 'site-packages')
    }
  }
  // 目录还没建 ⇒ 按 3.11 摆（平台基座就是 3.11）
  return path.join(libDir, 'python3.11', 'site-packages')
}

/**
 * 造一个假的引擎 venv：site-packages 下放几个 `<包>-<版本>.dist-info` 目录。
 * @param {string[]} distInfoNames 要造的 dist-info 目录名
 * @returns {string} 引擎 venv 目录
 */
function makeVenv (distInfoNames) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-progress-'))
  const venvDir = path.join(root, 'engines', 'myeng', '.venv')
  const sp = sitePackagesAbs(venvDir)
  fs.mkdirSync(sp, { recursive: true })
  for (const n of distInfoNames) fs.mkdirSync(path.join(sp, n), { recursive: true })
  return root
}

/** 装 torch 2.6.0 那一步的命令（xpu index） */
const TORCH_260_XPU = [
  'uv', 'pip', 'install',
  '-p', 'C:/x/.venv/Scripts/python.exe',
  'torch==2.6.0', 'torchaudio==2.6.0',
  '--index-url', 'https://download.pytorch.org/whl/xpu',
]

// ------------------------------------------------------------------
// 小工具的单独判据
// ------------------------------------------------------------------

test('读已装版本：从 dist-info 目录名读出版本与后缀', () => {
  const root = makeVenv(['torch-2.6.0+xpu.dist-info', 'torchaudio-2.6.0+xpu.dist-info'])
  const venvDir = path.join(root, 'engines', 'myeng', '.venv')
  assert.strictEqual(progress.installedPackageVersion(venvDir, 'torch'), '2.6.0+xpu')
  assert.strictEqual(progress.installedPackageVersion(venvDir, 'torchaudio'), '2.6.0+xpu')
  assert.strictEqual(progress.installedPackageVersion(venvDir, 'numpy'), null,
    '没装的包 ⇒ null，不编')
  fs.rmSync(root, { recursive: true, force: true })
})

test('读已装版本：包名匹配不认前缀（torch 不该匹配 torchgen）', () => {
  const root = makeVenv(['torch-2.6.0+xpu.dist-info', 'torchgen-0.6.0.dist-info'])
  const venvDir = path.join(root, 'engines', 'myeng', '.venv')
  assert.strictEqual(progress.installedPackageVersion(venvDir, 'torch'), '2.6.0+xpu')
  fs.rmSync(root, { recursive: true, force: true })
})

test('解析命令里声明的包与版本', () => {
  assert.deepStrictEqual(progress.parseDeclaredSpecs(TORCH_260_XPU), [
    { name: 'torch', version: '2.6.0' },
    { name: 'torchaudio', version: '2.6.0' },
  ])
})

test('解析命令里的 index 目录名', () => {
  assert.strictEqual(progress.parseIndexName(TORCH_260_XPU), 'xpu')
  assert.strictEqual(
    progress.parseIndexName(['uv', 'pip', 'install', 'torch==2.6.0',
      '--index-url=https://download.pytorch.org/whl/cu121']),
    'cu121')
  assert.strictEqual(progress.parseIndexName(['uv', 'pip', 'install', '-r', 'requirements.txt']), null,
    '没带 index ⇒ null')
})

test('版本比对：版本号相同但后端不同 ⇒ 不匹配', () => {
  // 这条是核心：2.6.0+cpu 与 2.6.0+xpu 版本号一样，后端不一样。
  assert.strictEqual(progress.versionMatches('2.6.0+xpu', '2.6.0', 'xpu'), true)
  assert.strictEqual(progress.versionMatches('2.6.0+cpu', '2.6.0', 'xpu'), false,
    'CPU 版不是 XPU 版的产物')
  assert.strictEqual(progress.versionMatches('2.6.0+cpu', '2.6.0', 'cpu'), true)
})

test('版本比对：版本号不同 ⇒ 不匹配', () => {
  assert.strictEqual(progress.versionMatches('2.5.1+cpu', '2.6.0', 'xpu'), false)
  assert.strictEqual(progress.versionMatches('2.6.0+xpu', '2.6.0', 'xpu'), true)
})

test('版本比对：命令没带 index 时不比对后缀', () => {
  assert.strictEqual(progress.versionMatches('2.6.0+cpu', '2.6.0', null), true)
  assert.strictEqual(progress.versionMatches('2.6.0+xpu', '2.6.0', null), true)
})

test('版本比对：没装或没声明 ⇒ 不匹配（不编结论）', () => {
  assert.strictEqual(progress.versionMatches(null, '2.6.0', 'xpu'), false)
  assert.strictEqual(progress.versionMatches('2.6.0+xpu', null, 'xpu'), false)
})

// ------------------------------------------------------------------
// stepArtifactExists 的版本核对
// ------------------------------------------------------------------

test('装的那一版还在 ⇒ 判产物在（可以跳过）', () => {
  const root = makeVenv(['torch-2.6.0+xpu.dist-info', 'torchaudio-2.6.0+xpu.dist-info'])
  const step = { argv: TORCH_260_XPU }
  assert.strictEqual(progress.stepArtifactExists(step, root, 'myeng'), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('装的是别的那一版 ⇒ 判产物不在（要重跑）', () => {
  // 这一条是本轮修的真 bug：手工把 torch 降回上游钉的 2.5.1，
  //   命令文本一字未变 ⇒ 只看命令文本会跳过 ⇒ 装出来的是错的。
  const root = makeVenv(['torch-2.5.1+cpu.dist-info', 'torchaudio-2.5.1+cpu.dist-info'])
  const step = { argv: TORCH_260_XPU }
  assert.strictEqual(progress.stepArtifactExists(step, root, 'myeng'), false,
    '版本对不上就不能算已完成')
  fs.rmSync(root, { recursive: true, force: true })
})

test('版本号对但后端不对 ⇒ 判产物不在（要重跑）', () => {
  // 同版本号的 CPU 版装在 XPU 机器上 ⇒ 用不上加速 ⇒ 那个不是本步的产物。
  const root = makeVenv(['torch-2.6.0+cpu.dist-info', 'torchaudio-2.6.0+cpu.dist-info'])
  const step = { argv: TORCH_260_XPU }
  assert.strictEqual(progress.stepArtifactExists(step, root, 'myeng'), false,
    '后端不对就不是这一版')
  fs.rmSync(root, { recursive: true, force: true })
})

test('一个包对、一个包不对 ⇒ 判产物不在', () => {
  const root = makeVenv(['torch-2.6.0+xpu.dist-info', 'torchaudio-2.5.1+cpu.dist-info'])
  const step = { argv: TORCH_260_XPU }
  assert.strictEqual(progress.stepArtifactExists(step, root, 'myeng'), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('清单形式的装包步（-r requirements.txt）⇒ 不做版本核对，维持原行为', () => {
  // 清单里逐个版本解析不出来 ⇒ 只能判「site-packages 非空」，
  //   不许因为解析不出就判成「产物不在」⇒ 那会让每次都重装。
  const root = makeVenv(['numpy-1.26.0.dist-info'])
  const step = { argv: ['uv', 'pip', 'install', '-p', 'C:/x/.venv/Scripts/python.exe', '-r', 'requirements.txt'] }
  assert.strictEqual(progress.stepArtifactExists(step, root, 'myeng'), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('site-packages 空 ⇒ 判产物不在', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-progress-'))
  const venvDir = path.join(root, 'engines', 'myeng', '.venv')
  fs.mkdirSync(sitePackagesAbs(venvDir), { recursive: true })
  const step = { argv: TORCH_260_XPU }
  assert.strictEqual(progress.stepArtifactExists(step, root, 'myeng'), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('不是装包步（建环境步）⇒ 走原有的判据', () => {
  const root = makeVenv([])
  const step = { argv: ['python', '-m', 'uv', 'venv', 'C:/x/.venv'], skipIfExists: true }
  // 建环境步判的是「引擎 venv 的 python 能不能 spawn」，
  //   假 venv 里没有 python ⇒ 判产物不在。
  assert.strictEqual(progress.stepArtifactExists(step, root, 'myeng'), false)
  fs.rmSync(root, { recursive: true, force: true })
})
