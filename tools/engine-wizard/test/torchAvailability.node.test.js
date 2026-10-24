'use strict'

// torch 版本探测的结论分类：确认可用 / 确认不可用 / 没能确认。
//
// 被测代码：tools/engine-wizard/core/env.js 的 probeTorchAvailability，
//   与 tools/engine-wizard/core/torchVersionProbe.js 的 probeTorchVersion。
//
// 这一组测的是「什么时候该报什么」：
//   ① 确认可用 ⇒ 不打扰使用者（返回 null）。
//   ② 确认不可用且有可替换版本 ⇒ 给出 suggested。
//   ③ 确认不可用但一个轮子都没有（no-wheel-for-this-python）⇒ 如实报，不给 suggested。
//   ④ 没能确认（could-not-check）⇒ 如实报「没确认」，不编结论、不给 suggested。
//   ⑤ 上游没声明 torch / 后端没有官方 index ⇒ 与 torch 版本无关，返回 null。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CORE_DIR = path.join(__dirname, '..', 'core')
const probeMod = require(path.join(CORE_DIR, 'torchVersionProbe.js'))
const envMod = require(path.join(CORE_DIR, 'env.js'))

// ---- 一个假的引擎目录：上游声明的 torch 版本由测试自己写 ----
function makeEngineDir (requirements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-torchprobe-'))
  fs.writeFileSync(path.join(dir, 'requirements.txt'), requirements)
  return dir
}

const REQ_TORCH_251 = 'torch==2.5.1\ntorchaudio==2.5.1\n'

// ---- 把网络那层换掉：探测只认 html 内容，不联网 ----
// probeTorchVersion 内部自己抓 index，所以这里直接测它解析层的行为，
//   而 probeTorchAvailability 的联网路径用 stub 掉 require 的方式验证。

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

test('index 上有这个版本 ⇒ ok=true（不打扰使用者）', () => {
  const html = '<a href="torch-2.5.1%2Bcpu-cp311-cp311-win_amd64.whl">torch-2.5.1</a>'
  const parsed = probeMod.parseTorchIndex(html, 'cp311', 'win_amd64')
  assert.deepStrictEqual(parsed.versions, ['2.5.1'])
})

test('index 上没有这个版本 ⇒ 列出可用版本（前端据此给建议）', () => {
  const html = [
    '<a href="torch-2.6.0%2Bxpu-cp311-cp311-win_amd64.whl">torch-2.6.0</a>',
    '<a href="torch-2.7.0%2Bxpu-cp311-cp311-win_amd64.whl">torch-2.7.0</a>',
  ].join('\n')
  const parsed = probeMod.parseTorchIndex(html, 'cp311', 'win_amd64')
  assert.deepStrictEqual(parsed.versions, ['2.6.0', '2.7.0'])
})

test('index 上有这个 ABI 但版本不同 ⇒ 那个版本不会被列进可用列表', () => {
  const html = '<a href="torch-2.5.1%2Bxpu-cp310-cp310-win_amd64.whl">torch-2.5.1</a>'
  const parsed = probeMod.parseTorchIndex(html, 'cp311', 'win_amd64')
  assert.deepStrictEqual(parsed.versions, [],
    'cp310 的轮子不满足 cp311，不能算可用')
  assert.ok(parsed.tags.includes('cp310'), '但要如实报出 index 覆盖了哪些 ABI')
})

test('index 上的轮子 ABI 对得上但平台不对 ⇒ 也不算可用', () => {
  const html = '<a href="torch-2.6.0%2Bxpu-cp311-cp311-manylinux_2_28_x86_64.whl">torch-2.6.0</a>'
  const parsed = probeMod.parseTorchIndex(html, 'cp311', 'win_amd64')
  assert.deepStrictEqual(parsed.versions, [],
    'Linux 轮子在 Windows 上装不了')
})

test('index 页面上的后缀分隔符两种写法都要认', () => {
  // 链接文本里是字面 `+`，href 属性里是 URL 编码的 `%2B`。
  //   只认一种的话，哪天页面只留另一种，探测会静默地认为「没有可用版本」，
  //   于是误报成「这个后端上装不了」。
  const literal = '<a>torch-2.6.0+xpu-cp311-cp311-win_amd64.whl</a>'
  const encoded = '<a>torch-2.6.0%2Bxpu-cp311-cp311-win_amd64.whl</a>'
  for (const html of [literal, encoded]) {
    const parsed = probeMod.parseTorchIndex(html, 'cp311', 'win_amd64')
    assert.deepStrictEqual(parsed.versions, ['2.6.0'],
      `这两种写法都要解析出可用版本：${html}`)
  }
})

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

test('probeTorchAvailability 是导出的（端点要用它）', () => {
  assert.strictEqual(typeof envMod.probeTorchAvailability, 'function')
})

test('上游没声明 torch ⇒ 不打扰使用者（与 torch 版本无关）', async () => {
  const dir = makeEngineDir('numpy==1.26.0\n')
  const r = await envMod.probeTorchAvailability({ id: 'x', root: dir, backend: 'ipex' })
  assert.strictEqual(r, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('后端没有官方 index ⇒ 无从比对，返回 null（由别处的检查去报）', async () => {
  const dir = makeEngineDir(REQ_TORCH_251)
  const r = await envMod.probeTorchAvailability({ id: 'x', root: dir, backend: 'zluda' })
  assert.strictEqual(r, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('引擎目录不存在 ⇒ 返回 null', async () => {
  const r = await envMod.probeTorchAvailability({
    id: 'no-such-engine', root: os.tmpdir(), backend: 'ipex',
  })
  assert.strictEqual(r, null)
})

// ---- 三种探测结论：靠换掉 https.get 来控制 index 返回什么 ----

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
 * 在探测期间把 https.get 换成假的，返回指定的 index 正文。
 * body 为 null 表示「抓不到」（HTTP 500）。
 */
async function withIndexBody (body, fn) {
  const https = require('node:https')
  const orig = https.get
  https.get = (url, opts, cb) => {
    const res = {
      statusCode: body ? 200 : 500,
      resume () {},
      setEncoding () {},
      on (ev, f) {
        if (ev === 'data' && body) f(body)
        if (ev === 'end') f()
      },
    }
    if (cb) {
      setImmediate(() => cb(res))
      return { on () {}, destroy () {} }
    }
    return { on () {}, destroy () {} }
  }
  try {
    return await fn()
  } finally {
    https.get = orig
  }
}

test('index 抓不到 ⇒ 如实报「没能确认」，不编结论', async () => {
  const root = makeRoot('myeng', REQ_TORCH_251)
  const r = await withIndexBody(null, () => envMod.probeTorchAvailability({
    id: 'myeng', root, backend: 'ipex',
  }))
  assert.ok(r, '没能确认也要报出来，不能静默放行')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'could-not-check')
  assert.ok(!r.suggested, '没确认就不能编一个建议版本出来')
  assert.strictEqual(r.declared, '2.5.1', '要说清上游钉的是哪个版本')
  fs.rmSync(root, { recursive: true, force: true })
})

test('index 上一个轮子都没有 ⇒ 报「装不了」，且不给建议版本', async () => {
  const root = makeRoot('myeng', REQ_TORCH_251)
  const r = await withIndexBody('<html>no wheels here</html>', () => envMod.probeTorchAvailability({
    id: 'myeng', root, backend: 'ipex',
  }))
  assert.ok(r)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no-wheel-for-this-python')
  assert.ok(!r.suggested, '换 torch 版本解决不了，不该给建议版本')
  fs.rmSync(root, { recursive: true, force: true })
})

test('index 上有可替换的版本 ⇒ 报不可用并给建议版本', async () => {
  const root = makeRoot('myeng', REQ_TORCH_251)
  const body = '<a>torch-2.6.0+xpu-cp311-cp311-win_amd64.whl</a>'
  const r = await withIndexBody(body, () => envMod.probeTorchAvailability({
    id: 'myeng', root, backend: 'ipex',
  }))
  assert.ok(r)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'version-not-on-this-backend')
  assert.strictEqual(r.suggested, '2.6.0')
  fs.rmSync(root, { recursive: true, force: true })
})

test('上游钉的版本在这个后端上可用 ⇒ 返回 null（不打扰使用者）', async () => {
  const root = makeRoot('myeng', REQ_TORCH_251)
  const body = '<a>torch-2.5.1+xpu-cp311-cp311-win_amd64.whl</a>'
  const r = await withIndexBody(body, () => envMod.probeTorchAvailability({
    id: 'myeng', root, backend: 'ipex',
  }))
  assert.strictEqual(r, null, '可用就别弹窗')
  fs.rmSync(root, { recursive: true, force: true })
})
