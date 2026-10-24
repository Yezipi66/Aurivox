'use strict'
// 名片页的布局不许被外层容器挤扁。
//
// 这条守卫来自一次真实的事故：三栏容器 .wz-three-zone 被放进了
// 项目的 .workspace-grid 里，而那个 grid 自己就是两列
// （minmax(0,1fr) 380px）⇒ 三栏容器被塞进它的第一列，
// 中栏从 690px 缩成 302px，右边空出一大片 380px。
//
// 为什么别的守卫抓不到：
//   - 逐文件编译：语法没问题，照样绿。
//   - Vite 构建：能构建出来，照样绿。
//   - jsdom 渲染：jsdom 不做布局计算，所有元素宽度都是 0，照样绿。
//   只有真浏览器里量出来的宽度才会说话。
//
// 所以这里用 CSS 规则本身做判据：读 editor.css 与 styles.css，
// 断言 .wz-three-zone 的父容器不是 .workspace-grid 这类两列 grid。
// 判据落在「声明」上而不是「渲染结果」上 ⇒ 不需要浏览器也能跑。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const EDITOR_CSS = path.join(EDITOR, 'editor.css')
const PAGE = path.join(EDITOR, 'ManifestPage.jsx')

const css = fs.readFileSync(EDITOR_CSS, 'utf8')
const page = fs.readFileSync(PAGE, 'utf8')

/** 从 CSS 里取出某个选择器的声明块。 */
function ruleBody (selector) {
  const re = new RegExp(
    `(^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')
  const m = css.match(re)
  return m ? m[2] : null
}

test('名片页的外层容器不是项目的两列 grid', () => {
  // .workspace-grid 本身就是两列：minmax(0, 1fr) 380px。
  // 三栏容器放进去会被塞进第一列。
  assert.ok(!/className="workspace-grid"/.test(page),
    '名片页又用回了 .workspace-grid：三栏容器会被塞进它的第一列，'
    + '中栏会缩成第一列宽度里的一小块')

  assert.ok(/className="wz-manifest-layout"/.test(page),
    '名片页的外层容器应当是 .wz-manifest-layout')
})

test('.wz-manifest-layout 是单列 flex，不是 grid', () => {
  const body = ruleBody('.wz-manifest-layout')
  assert.ok(body, 'editor.css 里没有 .wz-manifest-layout')
  assert.ok(/display:\s*flex/.test(body), '.wz-manifest-layout 必须是 flex')
  assert.ok(!/display:\s*grid/.test(body),
    '.wz-manifest-layout 要是 grid，就会重新引入外层列 ⇒ 三栏又被挤')
  assert.ok(/flex-direction:\s*column/.test(body),
    '.wz-manifest-layout 必须是竖排：三栏一行，SaveBar 另起一行')
})

test('三栏容器的列宽是「左窄 中宽 右 380」', () => {
  const body = ruleBody('.wz-three-zone')
  assert.ok(body, 'editor.css 里没有 .wz-three-zone')
  assert.ok(/display:\s*grid/.test(body), '.wz-three-zone 必须是 grid')
  const cols = body.match(/grid-template-columns:\s*([^;]+);/)
  assert.ok(cols, '.wz-three-zone 没写 grid-template-columns')
  const value = cols[1].trim()
  assert.ok(/260px/.test(value), '左栏应当是固定窄栏（参数名不长），实际 ' + value)
  assert.ok(/minmax\(0,\s*1fr\)/.test(value),
    '中栏应当占满剩余宽度（表单最挤），实际 ' + value)
  assert.ok(/380px/.test(value), '右栏应当与项目的 .workspace-right 同宽，实际 ' + value)
})

test('三栏容器的三列加起来不超过容器宽度（1fr 之外没有多余固定列）', () => {
  const body = ruleBody('.wz-three-zone')
  const cols = body.match(/grid-template-columns:\s*([^;]+);/)
  const value = cols[1].trim()
  const fixed = [...value.matchAll(/(\d+)px/g)].map((m) => Number(m[1]))
  const hasFlex = /minmax\(0,\s*1fr\)|1fr/.test(value)
  assert.ok(hasFlex, '三栏里没有弹性列 ⇒ 中栏不会随窗口变宽')
  assert.equal(fixed.length, 2,
    '只该有左右两栏是固定宽度，实际固定列有 ' + fixed.length + ' 个：' + value)
  assert.deepStrictEqual(fixed, [260, 380], '固定列宽度变了：' + value)
})

test('SaveBar 那一行是 sticky 且独立成行（不塞进任何一栏）', () => {
  const body = ruleBody('.wz-savebar-row')
  assert.ok(body, 'editor.css 里没有 .wz-savebar-row')
  assert.ok(/position:\s*sticky/.test(body), 'SaveBar 那一行必须 sticky')
  assert.ok(/bottom:\s*0/.test(body), 'SaveBar 那一行必须吸在底部')
  assert.ok(/className="wz-savebar-row"/.test(page),
    'SaveBar 应当有自己的行，而不是塞进某一栏里')
})

test('窄屏降级成单列（960px，与项目口径一致）', () => {
  const media = css.match(/@media\s*\(max-width:\s*960px\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(media, 'editor.css 里没有 960px 的降级规则')
  assert.ok(/grid-template-columns:\s*1fr/.test(media[1]),
    '960px 以下没有降级成单列')
})
