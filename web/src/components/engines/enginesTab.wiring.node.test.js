import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as engines from '../../lib/engines.js'

// ---------------------------------------------------------------------------
//  刀 F2 的接线守卫
// ---------------------------------------------------------------------------
//
// ⚠⚠ 老实说：**这个文件里的是文本守卫**（读源码找字符串），跟契约 §12.10 里
//   E1 那一刀点名批评的那 26 条是同一类。它抓不到 `engineId` 写成 `engineld`。
//   之所以还留着它，是因为它抓的是另一种坏法 —— **整个页面根本没接上**：
//   组件写好了但没人 import、按钮画好了但没人调那两个 POST。
//   那种坏法一次都不会报错，`npm run build` 照样绿。
//
// ⛔ 不许拿这个文件当"前端测过了"。真正的判据在 E1：
//   随便挑一个渲染点把东西删掉，必须有测试变红。
//   这个文件只保证"线接上了"，⛔ 不保证"画对了"。
//
// ⭐ 而"按钮什么情况下该灰"那部分**不在这里** —— 它在
//   lib/engineActions.node.test.js，那些是真的把函数调起来跑的。
//
// ⭐⭐ 下面两条（带 `真测试` 标记）是**真跑的接线测试**，不是文本守卫：
//   它们把 `startEngine` / `stopEngine` 当普通函数调，用 `globalThis.fetch`
//   的替身接住发出的请求，断言 URL 含 `/start` `/stop`、method 是 POST。
//   ⇒ 接线断掉（URL 写成别的路径、或改用 GET）时这两条**会红**，
//     补上了上面文本守卫"抓不到 engineld 笔误"的缺口。

const here = path.dirname(fileURLToPath(import.meta.url))
const webSrc = path.resolve(here, '../..')
const read = (p) => fs.readFileSync(path.join(webSrc, p), 'utf8')

test('⭐⭐⭐ 刀 F2：web/src 里必须真的有人请求那两个写路口', () => {
  // 这一刀之前，`web/src` 里请求 /api/engines 的**写**操作是 0 次。
  const lib = read('lib/engines.js')
  assert.match(lib, /\/api\/engines\/\$\{[^}]*\}\/start/,
    '没有任何地方在请求启动引擎 —— 那就还是"只有点合成才能起引擎"')
  assert.match(lib, /\/api\/engines\/\$\{[^}]*\}\/stop/, '没有任何地方在请求关闭引擎')
  assert.match(lib, /method:\s*'POST'/, '写路必须是 POST')
})

test('⭐⭐ 启动请求里不许无脑带 confirmed —— "没说" ≠ "说了不同意"', () => {
  const lib = read('lib/engines.js')
  assert.match(lib, /confirmed !== undefined/,
    '后端靠"有没有这个键"区分「没说」和「说了不同意」（supervisor.js:337）；' +
    '无脑带一个 false 会让每次手动启动都被拒')
})

test('⭐⭐⭐ 引擎管理页必须真的被挂进导航 —— 组件存在 ≠ 用户点得到', () => {
  const app = read('App.jsx')
  assert.match(app, /from '\.\/components\/engines\/EnginesTab'/, 'App.jsx 没有 import 这个页面')
  assert.match(app, /setPage\('engines'\)/, '导航条上没有进得去的按钮')
  assert.match(app, /page === 'engines'/, '没有任何一处会渲染它')
  assert.match(app, /<EnginesTab\b/, 'import 了却没渲染 —— 这正是 Flow 那套东西今天的样子')
})

test('⭐ 起 / 停成功之后必须立刻重拉一次，⛔ 不许干等那个 8 秒轮询', () => {
  const app = read('App.jsx')
  assert.match(app, /onChanged=\{refreshEngines\}/,
    '不重拉的表现是"按钮点了没反应"，然后用户再点一次 —— 而第二次点的是一台正在启动的引擎')
})

test('⭐⭐⭐ 这个页面用到的每一个 CSS 类名，styles.css 里都得真有', () => {
  // ⚠ 这条是被真的抓到过才写的：第一版照着别处"看着像"抄了 panel / hint 两个类名，
  //   而 styles.css 里 .panel 只是个颜色变量、.hint 只在 .restore-modal 底下存在。
  //   ⭐ 症状：`npm run build` 绿，页面渲染出来，只是**没有边框没有底色**，
  //     看上去像"样式没加载"。⛔ 没有任何一条守卫会因为类名不存在而变红。
  const jsx = read('components/engines/EnginesTab.jsx')
  const css = read('styles.css')
  const used = new Set()
  for (const m of jsx.matchAll(/className="([^"${}]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c)
  }
  // 模板串里那半截（`badge ${TONE_CLASS[...]}`）的取值表也一并查
  for (const m of jsx.matchAll(/'(badge-[a-z0-9-]+)'/g)) used.add(m[1])
  assert.ok(used.size >= 5, '一个类名都没扫到，这条守卫等于没跑')
  const missing = [...used].filter((c) => !new RegExp(`\\.${c}\\b`).test(css))
  assert.deepEqual(missing, [], `styles.css 里没有这些类：${missing.join('、')}`)
})

test('⛔ 这个页面里不许出现任何一台引擎的名字', () => {
  // 规矩同 lib/engines/registry.js 和 lib/routes/engines.js。
  // 判据：装一台谁都没见过的引擎，这个页面一个字都不用改。
  const src = read('components/engines/EnginesTab.jsx') + read('lib/engineActions.pure.js')
  const enginesDir = path.resolve(webSrc, '../../engines')
  const ids = fs.readdirSync(enginesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
  assert.ok(ids.length > 0, '一台引擎都没扫到，这条守卫等于没跑')
  for (const id of ids) {
    assert.ok(!src.includes(id), `引擎管理页里写死了引擎名 "${id}"`)
  }
})

// ---------------------------------------------------------------------------
//  真测试：把 startEngine / stopEngine 当普通函数调，用 fetch 替身接住请求。
//  接线断掉（URL 写错路径、或改用 GET）⇒ 下面这两条红。
//  补上文本守卫"抓不到 engineld 笔误"的缺口。
// ---------------------------------------------------------------------------

function withFetchStub(fn) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body || null })
    return Promise.resolve({
      ok: true,
      headers: { get: () => null },
      json: () => ({}),
      arrayBuffer: () => new ArrayBuffer(0),
      text: () => '',
    })
  }
  return fn(calls).finally(() => { globalThis.fetch = real })
}

test('⭐⭐⭐ 真测试 F2：start/stop 必须真走 POST 写路口，接线断掉这里红', async () => {
  await withFetchStub(async (calls) => {
    await engines.startEngine('gpt-sovits', { confirmed: true })
    await engines.stopEngine('gpt-sovits')

    assert.equal(calls.length, 2, 'start + stop 应各触发一次 fetch')
    assert.match(calls[0].url, /\/start$/, '启动必须走 /<id>/start（URL 写错=红）')
    assert.equal(calls[0].method, 'POST', '启动必须是 POST（改 GET=红）')
    assert.match(calls[1].url, /\/stop$/, '关闭必须走 /<id>/stop')
    assert.equal(calls[1].method, 'POST', '关闭必须是 POST')
    const startBody = JSON.parse(calls[0].body)
    assert.equal(startBody.confirmed, true, '调用方传了 confirmed 应原样带')
  })
})

test('⭐⭐⭐ 真测试 F2：不传 confirmed 时请求体必须没有 confirmed 键', async () => {
  await withFetchStub(async (calls) => {
    await engines.startEngine('x') // 不传 confirmed

    const body = JSON.parse(calls[calls.length - 1].body)
    assert.equal('confirmed' in body, false,
      '不传 confirmed 时不许带该键——后端靠"有没有"区分"没说"和"不同意"（supervisor.js:337）')
  })
})
