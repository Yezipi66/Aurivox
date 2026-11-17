'use strict'
// 连接看守：只有「网络层连不上」才算断开，业务错误与主动取消都不算。
// 断开后后台探活，探通自动恢复。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const { esbuild } = require('../../../lib/testDeps.js')

const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR, 'connGuard.js'), 'utf8'),
  { loader: 'js', format: 'cjs', target: 'node18' }).code
const mod = { exports: {} }
// eslint-disable-next-line no-new-func
new Function('exports', 'require', 'module', code)(mod.exports, require, mod)
const { createConnGuard, isNetworkError } = mod.exports

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('连不上（Failed to fetch）⇒ 记下地址并通知订阅者', async () => {
  const guard = createConnGuard({
    fetch: async () => { throw new TypeError('Failed to fetch') },
    delay: 15,
  })
  const seen = []
  guard.subscribe((s) => seen.push(s && s.url))
  await assert.rejects(() => guard.fetch('/wizard/discover', { method: 'POST' }))
  assert.deepStrictEqual(seen, [null, '/wizard/discover'])
  assert.strictEqual(guard.state().url, '/wizard/discover')
})

test('探活通了就自动恢复，提示不需要刷新页面才消失', async () => {
  let calls = 0
  const guard = createConnGuard({
    fetch: async (url) => {
      calls += 1
      if (url === '/wizard/discover') throw new TypeError('Failed to fetch')
      return { ok: true, status: 200 }
    },
    delay: 15,
  })
  const seen = []
  guard.subscribe((s) => seen.push(!!s))
  await assert.rejects(() => guard.fetch('/wizard/discover'))
  assert.strictEqual(guard.state() !== null, true, '应当先记成断开')
  await sleep(120)
  assert.strictEqual(guard.state(), null, '探活通过后要清掉断开状态')
  assert.deepStrictEqual(seen, [false, true, false])
  assert.ok(calls > 1, '应当真的探过')
})

test('服务答了话（HTTP 500）不算断开：那是业务错误', async () => {
  const guard = createConnGuard({
    fetch: async () => ({ ok: false, status: 500 }),
    delay: 15,
  })
  const r = await guard.fetch('/api/voices')
  assert.strictEqual(r.status, 500)
  assert.strictEqual(guard.state(), null)
})

test('主动取消不算断开：页面自己断的', async () => {
  const ac = new AbortController()
  const guard = createConnGuard({
    fetch: async () => {
      ac.abort()
      const e = new Error('The operation was aborted.')
      e.name = 'AbortError'
      throw e
    },
    delay: 15,
  })
  await assert.rejects(() => guard.fetch('/wizard/download/attach', { signal: ac.signal }))
  assert.strictEqual(guard.state(), null)
})

test('别的 TypeError（代码写错）不算断开', async () => {
  const guard = createConnGuard({
    fetch: async () => { throw new TypeError('x.map is not a function') },
    delay: 15,
  })
  await assert.rejects(() => guard.fetch('/wizard/spec'))
  assert.strictEqual(guard.state(), null)
})

test('判据本身：网络层失败才认', () => {
  assert.strictEqual(isNetworkError(new TypeError('Failed to fetch')), true)
  assert.strictEqual(isNetworkError(new TypeError('fetch failed')), true)
  assert.strictEqual(isNetworkError(new TypeError('Load failed')), true)
  assert.strictEqual(isNetworkError(new TypeError('nope')), false)
  assert.strictEqual(isNetworkError(new Error('Failed to fetch')), false, '只认 TypeError')
  const ab = new Error('aborted'); ab.name = 'AbortError'
  assert.strictEqual(isNetworkError(ab), false)
})

test('提示条占文档流：插在页面顶部的槽位，不浮层、不盖中栏、不透字', () => {
  // 浮层两条路都走不通：
  //   ① 角落提示无论多窄，都可能盖到那一步的中栏内容上；
  //   ② 留在 #root 里，一旦某个祖先建了新的包含块（transform / contain）又带 overflow，
  //      浮层就被那个祖先的边界裁掉，文字跟着被切。
  // 占流（App.jsx 顶部的 #wz-conn-slot）内容整体下移，两个问题都不存在。
  const jsx = fs.readFileSync(path.join(EDITOR, 'index.jsx'), 'utf8')
  assert.ok(/msg-error wz-conn-banner/.test(jsx), 'index.jsx 要用这个类名')
  assert.ok(/createPortal\(/.test(jsx), '提示条经 portal 插进槽位')
  assert.ok(/getElementById\('wz-conn-slot'\)/.test(jsx), '落点是 App 顶部的槽位')

  const app = fs.readFileSync(path.join(EDITOR, 'App.jsx'), 'utf8')
  assert.ok(app.includes('id="wz-conn-slot"'), 'App.jsx 要留出提示条的槽位')

  const css = fs.readFileSync(path.join(EDITOR, 'editor.css'), 'utf8')
  const rule = /\.wz-conn-banner\s*\{([\s\S]*?)\}/.exec(css)
  assert.ok(rule, 'editor.css 里没有 .wz-conn-banner')
  assert.ok(!/position:\s*fixed/.test(rule[1]), '提示条占文档流，不做浮层')
  assert.ok(/background:[^;]*var\(--bg\)/.test(rule[1]),
    '提示条的底色要混入页面底色，不能是透明底')
  assert.ok(!/background:[^;]*transparent/.test(rule[1]), '提示条不能留透明底')
  assert.ok(/text-overflow:\s*ellipsis/.test(css), '失败地址超长要省略，不能撑破一行')
})
