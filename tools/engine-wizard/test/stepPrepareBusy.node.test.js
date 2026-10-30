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

// 嗅探手动化：以前第 1 步的探测只跟着失焦自动跑，而探测对 404 同样返回 ok:true，
//   它的原话放在 notes（数组）里，界面却只渲染 note（单数）⇒ 仓库不存在时界面
//   停在一个「进行中」，既不报原因，也没法自己再探一次。

test('doProbe 必须接在按钮上（手动嗅探的入口）', () => {
  assert.ok(/onClick=\{doProbe\}/.test(src),
    'doProbe 没有接在任何按钮上：探测只能跟着失焦自动跑，失败时使用者无从再探一次')
})

test('探测的 notes（数组）必须渲染出来（404 只出现在那里）', () => {
  // 判据不是「存在 notes 这个字段」，是它真的进了渲染：
  //   读不到默认分支、HTTP_404 这些信号只在 notes 里，不摆出来等于没探。
  const m = src.match(/probe\.notes[\s\S]{0,240}?\.map\(/)
  assert.ok(m, 'notes（数组）没被渲染成列表：仓库不存在这类信号会静默消失')
})
