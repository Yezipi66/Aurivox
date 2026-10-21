'use strict'
// install-state 端点 ： 按真实产物判每步完成
//
// 直接打 HTTP（真起一个监听 127.0.0.1:0 的 http server，把 handler 挂上去），
// 而不是只 require 函数。理由：handler 的返回值就是中间件的判据（同步
// true/false），返回形状错了 vite 那边的 for 循环会静默失效 ： 那种 bug
// 只有真打一次才看得见。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const wb = require('../core/wizardbridge.js')

/** 起一个只挂本 wizard bridge 的服务器，打一次请求返回 {status, json} */
async function withServer (fn) {
  const server = http.createServer((req, res) => {
    // 复刻 vite 中间件的判据：同步 true 才算接管
    const r = wb.handleInstallState(req, res)
    if (r === true) return
    const r2 = wb.handleResetProgress(req, res)
    if (r2 === true) return
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const port = server.address().port
  try { return await fn(port) } finally { await new Promise((ok) => server.close(ok)) }
}

const get = (port, url) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}${url}`, (res) => {
    let b = ''
    res.on('data', (c) => { b += c })
    res.on('end', () => {
      let j = null
      try { j = JSON.parse(b) } catch (e) { j = null }
      resolve({ status: res.statusCode, json: j, body: b })
    })
  }).on('error', reject)
})

const post = (port, url, payload) => new Promise((resolve, reject) => {
  const body = JSON.stringify(payload)
  const req = http.request(`http://127.0.0.1:${port}${url}`,
    { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => {
        let j = null
        try { j = JSON.parse(b) } catch (e) { j = null }
        resolve({ status: res.statusCode, json: j })
      })
    })
  req.on('error', reject)
  req.end(body)
})

// 夹具造在临时目录里（守卫 enginesDirWriteGuard 要求路径带临时痕迹）
function mkdtempRoot () {
  const mkdtempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-istate-'))
  fs.mkdirSync(path.join(mkdtempRootDir, 'engines'), { recursive: true })
  fs.writeFileSync(path.join(mkdtempRootDir, 'server.js'), '// anchor\n')
  return mkdtempRootDir
}

// installState 认的 root 由端点从 projectRoot() 推。这里不能改 engines/，
//   所以用 root= 查询参数把夹具根传进去（端点本来就支持这个参数）。
const ISTATE = (id, root) =>
  `/wizard/install-state?id=${encodeURIComponent(id)}&root=${encodeURIComponent(root)}`

test('产物判据：伪造目录树 ⇒ 对勾跟着变（端到端 HTTP）', async () => {
  const root = mkdtempRoot()
  try {
    await withServer(async (port) => {
      // 什么都没有 ⇒ 一个勾都没有
      let j = (await get(port, ISTATE('e1', root))).json
      assert.ok(j.ok, '端点应返回 ok:true')
      assert.deepStrictEqual(j.steps_done,
        { prepare: false, env: false, models: false, manifest: false, verify: false })

      // 克隆 + 名片 + 权重
      const d = path.join(root, 'engines', 'e1')
      fs.mkdirSync(path.join(d, 'checkpoints'), { recursive: true })
      fs.writeFileSync(path.join(d, 'README.md'), 'hello')
      fs.writeFileSync(path.join(d, 'manifest.json'), '{"id":"e1"}')
      fs.writeFileSync(path.join(d, 'checkpoints', 'm.bin'), 'xx')
      j = (await get(port, ISTATE('e1', root))).json
      assert.strictEqual(j.steps_done.prepare, true, '⛔ 克隆了却没打勾')
      assert.strictEqual(j.steps_done.manifest, true, '⛔ 名片在却没打勾')
      assert.strictEqual(j.steps_done.models, true, '⛔ 权重在却没打勾')
      // env 不许凭目录猜：.venv 的 python 起不起来才算（这里 fixture 里没有）
      assert.strictEqual(j.steps_done.env, false, '⛔ 没有可用的 venv 却打了勾')
      // verify 恒 false（未实现）
      assert.strictEqual(j.steps_done.verify, false)

      // 把名片删掉，那个勾必须消失（判据是产物，不是点过什么）
      fs.rmSync(path.join(d, 'manifest.json'))
      j = (await get(port, ISTATE('e1', root))).json
      assert.strictEqual(j.steps_done.manifest, false, '⛔ 文件没了勾还在')

      // 把权重清空，models 变成「查过了但缺了」仍是 done（steps.js 判据），
      //   但把整个 checkpoints 删掉 ⇒ 说不出来 ⇒ 不算做完
      fs.rmSync(path.join(d, 'checkpoints'), { recursive: true, force: true })
      j = (await get(port, ISTATE('e1', root))).json
      assert.strictEqual(j.steps_done.models, false, '⛔ 没有目录却算下好了')
      assert.strictEqual(j.steps.models.ready, null, '⛔ 没有目录要如实报「说不出来」')
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('端点不写死任何引擎名（换任意 id 都判得出来）', async () => {
  const root = mkdtempRoot()
  try {
    for (const id of ['aaa', 'some-other-engine-42']) {
      fs.mkdirSync(path.join(root, 'engines', id), { recursive: true })
      fs.writeFileSync(path.join(root, 'engines', id, 'README.md'), 'x')
    }
    await withServer(async (port) => {
      for (const id of ['aaa', 'some-other-engine-42']) {
        const j = (await get(port, ISTATE(id, root))).json
        assert.strictEqual(j.steps_done.prepare, true, `${id} 没判出来`)
      }
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('缺 id ⇒ 400 + 人话（不是 500 或穿透到 HTML）', async () => {
  await withServer(async (port) => {
    const r = await get(port, '/wizard/install-state')
    assert.strictEqual(r.status, 400)
    assert.strictEqual(r.json.ok, false)
    assert.match(r.json.error, /id/)
  })
})

test('请求方法不对 ⇒ handler 不接管（返回 false，与中间件判据一致）', () => {
  // 中间件只认严格 true：GET 之外的请求必须让路，不许吞掉
  assert.strictEqual(wb.handleInstallState(
    { method: 'POST', url: '/wizard/install-state?id=x' }, {}), false)
  assert.strictEqual(wb.handleResetProgress(
    { method: 'GET', url: '/wizard/reset-progress' }, {}), false)
  // 前缀不匹配也让路
  assert.strictEqual(wb.handleInstallState(
    { method: 'GET', url: '/wizard/installed' }, {}), false)
  // 前缀相同但尾巴不是 ? 的（/wizard/install-stateXYZ）也让路
  assert.strictEqual(wb.handleInstallState(
    { method: 'GET', url: '/wizard/install-stateXYZ' }, {}), false)
})

test('与已存在的 GET /wizard/installed 不冲突（各回各的）', async () => {
  const { handleInstalled } = require('../core/savebridge.js')
  await withServer(async (port) => {
    // installed 那个端点不该被 install-state 拦走
    let claimed = false
    const res = { writeHead () {}, end () { claimed = true } }
    assert.strictEqual(handleInstalled(
      { method: 'GET', url: '/wizard/installed' }, res), true)
    assert.ok(claimed, '⛔ /wizard/installed 没被它自己的 handler 接管')
  })
})

test('reset-progress 端点：只清自己那一段（HTTP 端到端）', async () => {
  const root = mkdtempRoot()
  try {
    const d = path.join(root, 'engines', 'e1')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'README.md'), 'x')
    const IS = require('../core/installState.js')
    IS.writeProgress(root, 'e1', 'env', new Set(['uv venv']))
    IS.writeProgress(root, 'e1', 'models', new Set(['hf download x']))

    await withServer(async (port) => {
      const r = await post(port, '/wizard/reset-progress', { id: 'e1', root, section: 'env' })
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.ok, true)
      assert.strictEqual(IS.readProgress(root, 'e1', 'env').size, 0, '⛔ env 段没清')
      assert.strictEqual(IS.readProgress(root, 'e1', 'models').size, 1,
        '⛔ 清 env 把 models 也清了')
      // 源码一个字节都没少（只清记录）
      assert.ok(fs.existsSync(path.join(d, 'README.md')))
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('reset-progress 缺 id ⇒ 400', async () => {
  await withServer(async (port) => {
    const r = await post(port, '/wizard/reset-progress', {})
    assert.strictEqual(r.status, 400)
    assert.strictEqual(r.json.ok, false)
  })
})

test('reset-progress 不许在 engines/ 下凭空造目录（不存在的引擎 ⇒ 只回一句）', async () => {
  const root = mkdtempRoot()
  try {
    await withServer(async (port) => {
      const r = await post(port, '/wizard/reset-progress',
        { id: 'no-such-engine', root, section: 'env' })
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.ok, true)
      // 引擎目录根本没被造出来（engines/ 只写真克隆出来的东西）
      assert.ok(!fs.existsSync(path.join(root, 'engines', 'no-such-engine')),
        '⛔ 为了清进度在 engines/ 下凭空造了一个引擎目录')
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'engines')), [])
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('reset-progress 拒绝非法 id（路径穿越 / 保留字）', async () => {
  const root = mkdtempRoot()
  try {
    await withServer(async (port) => {
      for (const bad of ['../escape', 'a/b', '.hidden']) {
        const r = await post(port, '/wizard/reset-progress', { id: bad, root, section: 'env' })
        assert.strictEqual(r.status, 400, `${bad} 应被拒`)
        assert.strictEqual(r.json.code, 'BAD_ID')
      }
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
