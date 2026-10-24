'use strict'

// torch 版本与本机后端的匹配判断。
//
// 被测代码：
//   tools/engine-wizard/core/backendTorchSupport.js  （离线事实表）
//   tools/engine-wizard/core/torchVersionProbe.js   （judgeTorchVersion）
//   tools/engine-wizard/core/env.js                 （suggestTorchUpgrade）
//
// 判据是**离线查表比大小**：后端对 torch 版本的支持有下界，方向单向
//   （XPU 从 2.6.0 起才有官方轮子，不会回头兼容 2.5）。
//   所以「这个版本在这个后端上有没有」是确定的事实，不该联网去问。
//
// 这一组测的是「什么时候该报什么」：
//   ① 上游钉的版本 >= 下界 ⇒ 不打扰使用者（返回 null）。
//   ② 上游钉的版本 < 下界 ⇒ 报不可用，并给出下界作为建议版本。
//   ③ 这个 (index, 平台, ABI) 组合一个轮子都没有 ⇒ 如实报，不给建议版本。
//   ④ 上游没声明 torch / 后端没有官方 index ⇒ 与 torch 版本无关，返回 null。
//   ⑤ **判断过程不联网**：把 https.get 换成会抛异常的假实现，
//      结论仍要成立。这条是这一版实现的核心承诺。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CORE_DIR = path.join(__dirname, '..', 'core')
const probeMod = require(path.join(CORE_DIR, 'torchVersionProbe.js'))
const envMod = require(path.join(CORE_DIR, 'env.js'))
const support = require(path.join(CORE_DIR, 'backendTorchSupport.js'))

const REQ_TORCH_251 = 'torch==2.5.1\ntorchaudio==2.5.1\n'

/**
 * 造一个根目录，底下放 engines/<id>/requirements.txt。
 * @returns {string} 根目录路径
 */
function makeRoot (id, requirements) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-torchroot-'))
  const dir = path.join(root, 'engines', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'requirements.txt'), requirements)
  return root
}

/**
 * 造一个只有引擎目录、没有 engines/<id> 层级的目录（直接放 requirements）。
 * @returns {string} 目录路径
 */
function makeEngineDir (requirements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-torchprobe-'))
  fs.writeFileSync(path.join(dir, 'requirements.txt'), requirements)
  return dir
}

// ------------------------------------------------------------------
// 读上游声明
// ------------------------------------------------------------------

test('读上游声明的 torch 版本：requirements.txt 里的 torch==', () => {
  const dir = makeEngineDir(REQ_TORCH_251)
  const r = probeMod.readDeclaredTorchVersion(dir)
  assert.ok(r, '该读出声明')
  assert.strictEqual(r.version, '2.5.1')
  assert.strictEqual(r.source, 'requirements.txt')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('读上游声明：没有 torch 那行 ⇒ null（不猜）', () => {
  const dir = makeEngineDir('numpy==1.26.0\n')
  assert.strictEqual(probeMod.readDeclaredTorchVersion(dir), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------
// 事实表
// ------------------------------------------------------------------

test('事实表：XPU 的下界是 2.6.0（这就是「2.5.1 在 XPU 上装不上」的依据）', () => {
  assert.strictEqual(support.minTorchFor('ipex', 'cp311', 'win'), '2.6.0')
  assert.strictEqual(support.minTorchFor('ipex', 'cp311', 'linux'), '2.6.0')
})

test('事实表：同一个后端，不同 ABI 的下界可能不同', () => {
  // cu121+cp312 从 2.2.0 起，不是 2.1.0。
  assert.strictEqual(support.minTorchFor('cuda', 'cp311', 'win'), '2.1.0')
  assert.strictEqual(support.minTorchFor('cuda', 'cp312', 'win'), '2.2.0')
  // cpu+cp313 从 2.6.0 起，不是 2.5.0。
  assert.strictEqual(support.minTorchFor('cpu', 'cp312', 'win'), '2.2.0')
  assert.strictEqual(support.minTorchFor('cpu', 'cp313', 'win'), '2.6.0')
})

test('事实表：同一个后端，不同平台的下界也可能不同', () => {
  // cpu+cp311：Windows 从 2.0.0 起，Linux 从 1.13.0 起。
  assert.strictEqual(support.minTorchFor('cpu', 'cp311', 'win'), '2.0.0')
  assert.strictEqual(support.minTorchFor('cpu', 'cp311', 'linux'), '1.13.0')
})

test('事实表：这个组合一个轮子都没有 ⇒ null（不是给个假下界）', () => {
  // ROCm 6.4 在 Windows 上没有官方轮子。
  assert.strictEqual(support.minTorchFor('rocm', 'cp311', 'win'), null)
  // XPU 没有 macOS 轮子。
  assert.strictEqual(support.minTorchFor('ipex', 'cp311', 'mac'), null)
  // 没有官方 index 的后端无从比对。
  assert.strictEqual(support.minTorchFor('zluda', 'cp311', 'win'), null)
})

test('事实表里的值都是合法的版本号', () => {
  const re = /^\d+\.\d+\.\d+$/
  for (const [index, perFamily] of Object.entries(support.INDEX_MIN_TORCH)) {
    for (const [family, perAbi] of Object.entries(perFamily)) {
      for (const [abi, min] of Object.entries(perAbi)) {
        assert.match(min, re, `${index}/${family}/${abi} 的下界格式不对`)
      }
    }
  }
})

// ------------------------------------------------------------------
// 版本比较
// ------------------------------------------------------------------

test('版本比较：按主次修订号逐段比', () => {
  assert.ok(support.cmpVersion('2.5.1', '2.6.0') < 0)
  assert.ok(support.cmpVersion('2.6.0', '2.5.1') > 0)
  assert.strictEqual(support.cmpVersion('2.6.0', '2.6.0'), 0)
  assert.ok(support.cmpVersion('2.6', '2.6.0') === 0, '缺省段按 0 处理')
  assert.ok(support.cmpVersion('2.10.0', '2.9.0') > 0, '10 比 9 大')
})

// ------------------------------------------------------------------
// 判断：三种结论
// ------------------------------------------------------------------

test('上游钉的版本低于这个后端的下界 ⇒ 报不可用，并给出下界作为建议版本', () => {
  const dir = makeEngineDir(REQ_TORCH_251)
  const r = probeMod.judgeTorchVersion({
    dir, backend: 'ipex', pythonVersion: '3.11', platform: 'win32',
  })
  assert.ok(r, '低于下界必须报出来')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'version-not-on-this-backend')
  assert.strictEqual(r.declared, '2.5.1', '要说清上游钉的是哪个版本')
  assert.strictEqual(r.suggested, '2.6.0', '建议版本就是该后端的下界')
  assert.strictEqual(r.minVersion, '2.6.0')
  assert.strictEqual(r.pythonVersion, '3.11')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('上游钉的版本高于这个后端的下界 ⇒ 不打扰使用者（返回 null）', () => {
  const dir = makeEngineDir('torch==2.8.0\n')
  const r = probeMod.judgeTorchVersion({
    dir, backend: 'ipex', pythonVersion: '3.11', platform: 'win32',
  })
  assert.strictEqual(r, null, '装得上就别弹窗')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('正好等于下界 ⇒ 也算装得上', () => {
  const dir = makeEngineDir('torch==2.6.0\n')
  const r = probeMod.judgeTorchVersion({
    dir, backend: 'ipex', pythonVersion: '3.11', platform: 'win32',
  })
  assert.strictEqual(r, null, '下界本身有轮子，装得上')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('这个组合一个轮子都没有 ⇒ 如实报「装不了」，且不给建议版本', () => {
  const dir = makeEngineDir(REQ_TORCH_251)
  const r = probeMod.judgeTorchVersion({
    dir, backend: 'rocm', pythonVersion: '3.11', platform: 'win32',
  })
  assert.ok(r)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-wheel-for-this-python')
  assert.ok(!r.suggested, '换 torch 版本解决不了，不该给建议版本')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('上游没声明 torch ⇒ 不打扰使用者（与 torch 版本无关）', () => {
  const dir = makeEngineDir('numpy==1.26.0\n')
  const r = probeMod.judgeTorchVersion({
    dir, backend: 'ipex', pythonVersion: '3.11', platform: 'win32',
  })
  assert.strictEqual(r, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('后端没有官方 index ⇒ 无从比对，返回 null（由别处的检查去报）', () => {
  const dir = makeEngineDir(REQ_TORCH_251)
  const r = probeMod.judgeTorchVersion({
    dir, backend: 'zluda', pythonVersion: '3.11', platform: 'win32',
  })
  assert.strictEqual(r, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Python ABI 决定下界：同一个版本在不同 ABI 上结论不同', () => {
  // xpu+cp314 的下界是 2.9.0，xpu+cp312 的下界是 2.6.0。
  const dir = makeEngineDir('torch==2.5.1\n')
  const r12 = probeMod.judgeTorchVersion({
    dir, backend: 'ipex', pythonVersion: '3.12', platform: 'win32',
  })
  assert.ok(r12, 'cp312 上 xpu 的下界是 2.6.0，2.5.1 低于下界')
  assert.strictEqual(r12.suggested, '2.6.0')
  const r14 = probeMod.judgeTorchVersion({
    dir, backend: 'ipex', pythonVersion: '3.14', platform: 'win32',
  })
  assert.ok(r14, 'cp314 上 xpu 的下界是 2.9.0，2.5.1 装不上')
  assert.strictEqual(r14.suggested, '2.9.0')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------
// 核心承诺：判断过程不联网
// ------------------------------------------------------------------

test('判断过程不联网：把 https.get 换成会抛异常的假实现，结论仍要成立', () => {
  const https = require('node:https')
  const orig = https.get
  https.get = () => { throw new Error('判断阶段不允许联网') }
  try {
    const dir = makeEngineDir(REQ_TORCH_251)
    const r = probeMod.judgeTorchVersion({
      dir, backend: 'ipex', pythonVersion: '3.11', platform: 'win32',
    })
    assert.ok(r, '断网也要给出结论')
    assert.strictEqual(r.reason, 'version-not-on-this-backend')
    assert.strictEqual(r.suggested, '2.6.0')
    fs.rmSync(dir, { recursive: true, force: true })
  } finally {
    https.get = orig
  }
})

test('suggestTorchUpgrade 也不联网（端点拿它出计划）', () => {
  const https = require('node:https')
  const orig = https.get
  https.get = () => { throw new Error('判断阶段不允许联网') }
  try {
    const root = makeRoot('myeng', REQ_TORCH_251)
    const r = envMod.suggestTorchUpgrade({
      id: 'myeng', root, backend: 'ipex',
    })
    assert.ok(r, '断网也要给出结论')
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'version-not-on-this-backend')
    assert.strictEqual(r.suggested, '2.6.0')
    assert.strictEqual(r.declared, '2.5.1')
    fs.rmSync(root, { recursive: true, force: true })
  } finally {
    https.get = orig
  }
})

test('suggestTorchUpgrade 是同步函数（计划响应不该等网络）', () => {
  assert.strictEqual(typeof envMod.suggestTorchUpgrade, 'function')
  const root = makeRoot('myeng', REQ_TORCH_251)
  const r = envMod.suggestTorchUpgrade({ id: 'myeng', root, backend: 'ipex' })
  assert.ok(r && typeof r === 'object', '拿到的应该是结论对象，不是 Promise')
  assert.ok(!(r instanceof Promise), '不该返回 Promise')
  fs.rmSync(root, { recursive: true, force: true })
})

test('suggestTorchUpgrade：上游没声明 torch ⇒ null', () => {
  const root = makeRoot('myeng', 'numpy==1.26.0\n')
  const r = envMod.suggestTorchUpgrade({ id: 'myeng', root, backend: 'ipex' })
  assert.strictEqual(r, null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('suggestTorchUpgrade：引擎目录不存在 ⇒ null', () => {
  const r = envMod.suggestTorchUpgrade({
    id: 'no-such-engine', root: os.tmpdir(), backend: 'ipex',
  })
  assert.strictEqual(r, null)
})

// ------------------------------------------------------------------
// 解析层（index 页面正文 → 可用版本）
//   这一层只用于补充信息，不参与判断，但解析要认全两种写法。
// ------------------------------------------------------------------

test('index 上有这个版本 ⇒ 解析出可用版本', () => {
  const html = '<a href="torch-2.5.1%2Bcpu-cp311-cp311-win_amd64.whl">torch-2.5.1</a>'
  const parsed = probeMod.parseTorchIndex(html, 'cp311', 'win_amd64')
  assert.deepStrictEqual(parsed.versions, ['2.5.1'])
})

test('index 上的后缀分隔符两种写法都要认', () => {
  // 链接文本里是字面 `+`，href 属性里是 URL 编码的 `%2B`。
  //   只认一种的话，哪天页面只留另一种，会静默地认为「没有可用版本」。
  const literal = '<a>torch-2.6.0+xpu-cp311-cp311-win_amd64.whl</a>'
  const encoded = '<a>torch-2.6.0%2Bxpu-cp311-cp311-win_amd64.whl</a>'
  for (const html of [literal, encoded]) {
    const parsed = probeMod.parseTorchIndex(html, 'cp311', 'win_amd64')
    assert.deepStrictEqual(parsed.versions, ['2.6.0'],
      `这两种写法都要解析出可用版本：${html}`)
  }
})

test('index 上有别的 ABI 的轮子 ⇒ 不算本机可用', () => {
  const html = '<a href="torch-2.5.1%2Bxpu-cp310-cp310-win_amd64.whl">torch-2.5.1</a>'
  const parsed = probeMod.parseTorchIndex(html, 'cp311', 'win_amd64')
  assert.deepStrictEqual(parsed.versions, [],
    'cp310 的轮子不满足 cp311，不能算可用')
  assert.ok(parsed.tags.includes('cp310'), '但要如实报出 index 覆盖了哪些 ABI')
})

test('index 上的轮子平台不对 ⇒ 不算本机可用', () => {
  const html = '<a href="torch-2.6.0%2Bxpu-cp311-cp311-manylinux_2_28_x86_64.whl">torch-2.6.0</a>'
  const parsed = probeMod.parseTorchIndex(html, 'cp311', 'win_amd64')
  assert.deepStrictEqual(parsed.versions, [],
    'Linux 轮子在 Windows 上装不了')
})

// ------------------------------------------------------------------
// 小工具
// ------------------------------------------------------------------

test('Python 版本 ⇒ wheel 的 ABI tag', () => {
  assert.strictEqual(probeMod.abiTag('3.11'), 'cp311')
  assert.strictEqual(probeMod.abiTag('3.9'), 'cp39')
  assert.strictEqual(probeMod.abiTag('3.14'), 'cp314')
  assert.strictEqual(probeMod.abiTag(''), null)
  assert.strictEqual(probeMod.abiTag(null), null)
})

test('只有这些后端有官方 index', () => {
  assert.deepStrictEqual(probeMod.BACKENDS_WITH_INDEX, {
    cuda: 'cu121',
    ipex: 'xpu',
    rocm: 'rocm6.4',
    cpu: 'cpu',
  })
})
