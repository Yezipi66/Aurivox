'use strict'
// editor/StepPrepare.jsx 的结构守卫：请求失败时「正在读…」必须撤掉。
//
// 这条判据失守时的现象：第 1 步永远显示「正在读…」，且不显示任何原因。
//   使用者看不出是网络问题还是程序问题（这个现象已经出现过一次）。
// 所以这里直接读源码，断「setBusy('') 在 finally 里」这个结构。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'editor', 'StepPrepare.jsx')
const src = fs.readFileSync(SRC, 'utf8')

/** 取出某个函数的源码片段：从它的定义行到下一个同缩进层的函数定义。 */
function functionBody (name) {
  const lines = src.split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes(`const ${name} = async`))
  if (start < 0) return null
  const indent = (lines[start].match(/^\s*/) || [''])[0]
  let end = start + 1
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) continue
    const ind = (l.match(/^\s*/) || [''])[0]
    if (ind.length <= indent.length && l.trim() !== '}') { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

test('resolve：setBusy(\'\') 必须在 finally 里（请求失败也要撤掉「正在读…」）', () => {
  const body = functionBody('resolve')
  assert.ok(body, 'resolve 函数不见了')
  assert.ok(/finally\s*\{/.test(body), 'resolve 没有 finally 块')
  const finallyIdx = body.indexOf('finally')
  const busyIdx = body.indexOf("setBusy('')")
  assert.ok(busyIdx > finallyIdx,
    'setBusy(\'\') 必须写在 finally 里，写在普通语句上时请求一失败就撤不掉提示')
})

test('doProbe：setBusy(\'\') 必须在 finally 里', () => {
  const body = functionBody('doProbe')
  assert.ok(body, 'doProbe 函数不见了')
  assert.ok(/finally\s*\{/.test(body), 'doProbe 没有 finally 块')
  const finallyIdx = body.indexOf('finally')
  const busyIdx = body.indexOf("setBusy('')")
  assert.ok(busyIdx > finallyIdx,
    'setBusy(\'\') 必须写在 finally 里，写在普通语句上时请求一失败就撤不掉提示')
})

test('post 不直接调 fetch（失败收口统一走 postJson）', () => {
  // 直接调 fetch 的写法会漏掉失败收口：fetch 抛出去，调用方就卡住。
  const body = functionBody('resolve')
  assert.ok(body, 'resolve 函数不见了')
  assert.ok(!/await\s+fetch\s*\(/.test(body), 'resolve 不许直接调 fetch，要走 postJson')
})

test('导入 postJson（判据收口只有一处）', () => {
  assert.ok(/import\s*\{\s*postJson\s*\}\s*from\s*'\.\/postJson'/.test(src),
    'postJson 没被导入')
})

// 读取手动化：以前第 1 步的探测只跟着失焦自动跑，而探测对 404 同样返回 ok:true，
//   它的原话放在 notes（数组）里，界面却只渲染 note（单数）⇒ 仓库不存在时界面
//   停在一个「进行中」，既不报原因，也没法自己再探一次。

test('doProbe 必须接在按钮上（手动读取的入口）', () => {
  assert.ok(/onClick=\{doProbe\}/.test(src),
    'doProbe 没有接在任何按钮上：探测只能跟着失焦自动跑，失败时使用者无从再探一次')
})

test('探测的 notes（数组）必须渲染出来（404 只出现在那里）', () => {
  // 判据不是「存在 notes 这个字段」，是它真的进了渲染：
  //   读不到默认分支、HTTP_404 这些信号只在 notes 里，不摆出来等于没探。
  const m = src.match(/probe\.notes[\s\S]{0,240}?\.map\(/)
  assert.ok(m, 'notes（数组）没被渲染成列表：仓库不存在这类信号会静默消失')
})

// 截断一致化：后端 /wizard/resolve 已把 /tree/... /blob/... 剥掉，返回截断后的 j.url。
//   前端若把原始输入（带尾巴）写回 wz.url / 输入框，使用者看到的是一串带尾巴的链接，
//   而克隆/探测实际用的是截断后，显示与使用不一致，心智模型对不上。
//   所以 resolve 必须用截断后的 j.url 覆盖输入框与状态，且 res.input 也同步。

test('resolve 用截断后的 j.url 写回状态（不用原始输入）', () => {
  const body = functionBody('resolve')
  assert.ok(body, 'resolve 函数不见了')
  // 状态写回：onChange({ url: resolvedUrl, ... })，resolvedUrl = j.url || url
  assert.ok(/const resolvedUrl = j\.url \|\| url/.test(body),
    'resolve 没算截断后的 resolvedUrl：输入框会留着带尾巴的原始链接')
  assert.ok(/onChange\(\{\s*url: resolvedUrl,/.test(body),
    "onChange 写回的是原始 url 而非截断后的 resolvedUrl：wz.url 与 wz.repoUrl 会分叉")
  assert.ok(/input: resolvedUrl/.test(body),
    "res.input 没同步成截断后的 resolvedUrl：改一个字符就会误判为「改了链接」")
  // 输入框：截断后 ≠ 原始输入时，setUrl(resolvedUrl) 让显示跟着变
  assert.ok(/if \(resolvedUrl !== url\) setUrl\(resolvedUrl\)/.test(body),
    '输入框没有更新为截断后的 resolvedUrl：使用者看到的是带尾巴的原始链接')
})

// 读取手动化：探测只从「读取仓库信息」按钮走，不跟着解析自动跑。
//   解析是纯本地的（不联网、地址写错也说 ok），自动探一次会让按钮形同虚设，
//   而且使用者分不清「探的是哪一步」。resolve 必须清掉 probe（界面回到「尚未读取」），
//   把「仓库在不在」的回答留给按钮。
test('resolve 不再自动读取（探测只从按钮走）', () => {
  const body = functionBody('resolve')
  assert.ok(body, 'resolve 函数不见了')
  assert.ok(!/wizard\/probe/.test(body),
    'resolve 还在自动调 /wizard/probe：探测跟着解析跑，手动按钮形同虚设')
  assert.ok(/probe: null/.test(body),
    'resolve 没把 probe 清掉：读取状态会残留上一次的，界面不回到「尚未读取」')
  // /wizard/probe 全文件只出现一次，且只在一个函数里：就是 doProbe（按钮）。
  const probeCalls = src.match(/wizard\/probe/g) || []
  assert.strictEqual(probeCalls.length, 1,
    '/wizard/probe 不止一处：探测入口不唯一，使用者会看到两个动作做同一件事')
})
