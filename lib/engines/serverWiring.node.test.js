'use strict'

// ===========================================================================
//  server.js 的接线守卫 —— 契约 §12 第 5 步「进程管理」
// ===========================================================================
//
// ⭐⭐⭐ 这个文件里全是**源码守卫**，不是行为测试。理由很硬：
//   这一步的接线错法有一个共同点 —— **一条测试都不会红**。
//     · 看管人没挂进上下文 ⇒ 合成时拿到 null ⇒ 整条路静默跳过，
//       引擎照样开机全点着、模型照样选了不生效，**而且不报错**。
//     · 自己挂 SIGINT 并当场退出 ⇒ 把已有的优雅退出架空，
//       用户 Ctrl-C 一下，跑了两分钟马上出音频的合成当场没了。
//       ⚠ 这一条是**真的差点交出去的**：没有任何测试在跑真的信号，
//         是 `node --check` 撞上重名变量才顺带把它逼出来的。
//   ⇒ 只能钉源码。⛔ 别把这些改成"跑一遍看看"—— 跑不出来才是它们的性质。
//
// ⚠ 守卫的老坑（这个仓库栽过两次）：**守卫能在非代码的地方为真吗？**
//   所以下面每一条都先把注释剥掉，再在剩下的代码里找。
//   写完新守卫，必须问自己一句：我把它要找的那行删掉，它会不会照样绿？

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SERVER = path.join(__dirname, '..', '..', 'server.js')

// 把 // 行注释、/* 块注释 全部剥掉，只留真正会执行的代码。
function codeOnly (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

const CODE = codeOnly(fs.readFileSync(SERVER, 'utf8'))

// ---------------------------------------------------------------------------

test('⭐⭐⭐ 看管人必须挂进那个传给所有路由的上下文里', () => {
  // ⛔ 不挂上去，`ctx.engineSupervisor` 永远是 null：
  //   合成那两步全部跳过、引擎列表也报不出进程实况 —— 而这一切**不报错**。
  //   这一步做的所有东西都还在，只是一个都不生效。
  assert.match(CODE, /engineSupervisor\s*:\s*_engineSupervisor/,
    'server.js 的 ctx 里没有 engineSupervisor —— 整条路会静默不生效')
})

test('⭐⭐ 引擎进程必须在后端退出时一起带走', () => {
  assert.match(CODE, /process\.on\(\s*["']exit["']/,
    '没挂 exit ⇒ 后端关了，吃着 6 GB 的引擎还活着；' +
    '下次启动会被自己的残骸占住端口，而且看不出原因')
  assert.match(CODE, /_engineSupervisor\.stopAll\(/,
    '挂了 exit 却没真的去停引擎')
})

test('⛔⛔ 这一步不许自己挂 SIGINT / SIGTERM —— 那会架空已有的优雅退出', () => {
  // ⭐⭐⭐ 这个后端本来就有一套 shutdown()：收到信号后**先不退**，
  //   停收新请求、让正在跑的合成做完（默认最多 120 秒），然后才退。
  //   在它旁边再挂一个"收到信号就 process.exit"，等于把那 120 秒删掉。
  // ⇒ 正确做法是只挂 `exit` —— 那是那套流程的**最后一站**，
  //   不管正常走完、超时强退还是第二次信号强杀都会经过。
  // ⚠ 这条守卫盯的是**数量**，不是有没有：原来那两个 shutdown 的信号挂钩
  //   必须留着，多出来的才是错的。
  const sigints = CODE.match(/process\.on\(\s*["']SIGINT["']/g) || []
  const sigterms = CODE.match(/process\.on\(\s*["']SIGTERM["']/g) || []
  assert.equal(sigints.length, 1,
    `SIGINT 被挂了 ${sigints.length} 次。多出来的那个会在优雅退出把话说完之前` +
    '就 process.exit —— 正在跑的合成当场没了，而且没有任何测试会红')
  assert.equal(sigterms.length, 1,
    `SIGTERM 被挂了 ${sigterms.length} 次，同上`)

  // 更直接的一条：进程管理这块里不许出现 process.exit。
  const block = CODE.split('引擎进程看管人')[1]
  if (block) {
    const head = block.slice(0, 2000)
    assert.ok(!/process\.exit/.test(head),
      '进程管理这块里出现了 process.exit —— 退出该由 shutdown() 决定，不是这里')
  }
})

test('⚠ 那个定时清扫必须 unref，否则 Ctrl-C 之后后端不退出', () => {
  // ⭐ 一个没 unref 的 setInterval 会单独把 node 进程留住。
  //   表现是：Ctrl-C 之后窗口卡着不动，看起来像后端挂了。
  assert.match(CODE, /_engineSweepTimer\.unref\(\)/,
    '清扫定时器没有 unref')
})

test('⛔ spawn 引擎时不许 detached —— 引擎是平台的下属，不是孤儿', () => {
  const spawnSrc = codeOnly(
    fs.readFileSync(path.join(__dirname, 'spawnEngine.js'), 'utf8'))
  assert.ok(!/detached\s*:\s*true/.test(spawnSrc),
    'spawnEngine.js 里 detached:true —— 后端崩掉会留下吃着 6 GB 的孤儿进程，' +
    '下次启动被自己的残骸占住端口，比崩掉本身还糟')
})
