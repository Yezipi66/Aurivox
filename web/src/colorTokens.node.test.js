// 离群色守卫。
// 统一色板：所有语义色必须走 :root 里的基础 token，禁止在 CSS/JSX 里再写下面这些
// 「离群色」字面量。它们原本散落在 dc2626/b91c1c/ff5252/e5484d（强警示红）、
// f0a05a/f6b877/ffa726/e0b03c（强警示橙）、4dd0e1（青）、2fbf71（成功绿）、
// e0b341（jsx 里的离群琥珀）、9aa0a6/7bc47f/7aa7ff/e08a95（画布状态色原硬编码值）里。
// 收敛方案：不再为它们开 danger-strong / warning-strong / info-teal / success-strong
// 这类「强语义变体 token」——直接归并回基础 token（红→--danger、橙→--warning、
// 绿→--success、青→--info），高注意力态用 color-mix 从基础 token 派生深浅。
// --danger 已重定义为正红 #e5484d。此守卫禁止离群色以字面量回流，并防止被删的
// 变体 token 悄悄复活。
// 例外：:root 里的 token 定义行本身（如 --token: #hex）放行；带兜底值的 var() 引用（如 var(自定义属性, #hex)）也放行
// （它引用了 token，兜底只是安全网，算不上新的样式决策）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8')

function walk (d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, acc); continue }
    if (/\.(css|jsx|js)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p)
  }
  return acc
}

// 只扫 web/src。向导（tools/engine-wizard）的色板归它自己那份守卫管。
const FILES = [...walk(path.join(repo, 'web/src'))]

// 已收编进基础 token 的离群色字面量（小写比对）。
const OFFPALETTE = [
  '#dc2626', '#b91c1c', '#ff5252', '#e5484d',
  '#f0a05a', '#f6b877', '#ffa726', '#e0b03c',
  '#4dd0e1', '#2fbf71', '#e0b341',
  '#9aa0a6', '#7bc47f', '#7aa7ff', '#e08a95',
]

test('离群色不得再以字面量出现（CSS/JSX）', () => {
  const bad = []
  for (const f of FILES) {
    const rel = path.relative(repo, f).replace(/\\/g, '/')
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // token 定义行（--name: #hex）放行：它就是 token 本身
      if (/^\s*--[\w-]+:\s*#/.test(line)) return
      // 带兜底值的 var() 引用（如 var(自定义属性, #hex)）放行：引用了 token，兜底只是安全网
      const stripped = line.replace(/var\(--[\w-]+,\s*#[0-9a-fA-F]{3,8}\s*\)/g, '')
      const lower = stripped.toLowerCase()
      for (const c of OFFPALETTE) {
        if (lower.includes(c)) bad.push(`${rel}:${i + 1}: ${c}`)
      }
    })
  }
  assert.deepEqual(bad, [], `出现了已收编的离群色字面量：\n${bad.join('\n')}`)
})

test('核心语义色 token 必须在 styles.css 定义', () => {
  const css = read('web/src/styles.css')
  const required = [
    '--bg', '--surface', '--panel', '--border', '--text', '--muted',
    '--accent', '--accent-soft', '--success', '--warning', '--danger', '--info',
  ]
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
  const missing = required.filter((t) => !defined.has(t))
  assert.deepEqual(missing, [], `核心语义色 token 没在 styles.css 定义：\n${missing.join('\n')}`)
})

test('已删除的强语义变体 token 不得复活', () => {
  const css = read('web/src/styles.css')
  const banned = [
    '--danger-strong', '--danger-strong-deep', '--warning-strong',
    '--warning-strong-hover', '--info-teal', '--success-strong', '--accent2',
  ]
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
  const resurrected = banned.filter((t) => defined.has(t))
  assert.deepEqual(resurrected, [], `被删的变体 token 又出现了，应归并回基础 token：\n${resurrected.join('\n')}`)
})

test('画布运行状态色必须走全局 token（不得硬编码）', () => {
  const f = path.join(repo, 'web/src/components/flowgraph/canvasShared.jsx')
  const src = fs.readFileSync(f, 'utf8')
  const extract = (name) => {
    const m = src.match(new RegExp('export const ' + name + ' = \\{([\\s\\S]*?)\\}'))
    return m ? m[1] : ''
  }
  const bad = []
  for (const name of ['RUN_COLOURS', 'RUN_TEXT']) {
    extract(name).split('\n').forEach((line, i) => {
      const m = line.match(/:\s*'([^']*)'/)
      if (!m) return
      if (!/^(var\(|color-mix\()/.test(m[1])) bad.push(`${name} line ${i + 1}: ${m[1]}`)
    })
  }
  assert.deepEqual(bad, [], `画布状态色仍是硬编码，应走全局 token / color-mix：\n${bad.join('\n')}`)
})

// 中性 / 结构性暗底 hex 在画布内联里是渲染细节（高光、阴影、暗底），并非语义色，
// 放行；其余彩色 hex 一律禁止，防止新的离群色漂移。
const INLINE_HEX_WHITELIST = new Set([
  '#fff', '#ffffff', '#000', '#000000',
  '#0f0f0f', '#11141a', '#14171d', '#1a1a1a', '#242424', '#333',
])
test('JSX 内联 style 不得含离群 hex 色（中性/暗底白名单豁免）', () => {
  const bad = []
  for (const f of FILES) {
    if (!f.endsWith('.jsx')) continue
    const rel = path.relative(repo, f).replace(/\\/g, '/')
    const src = fs.readFileSync(f, 'utf8')
    // 只检查 style={{ ... }} 内联块（canvasShared 的类别色常量不在内联块内，不误伤）
    const blocks = src.split(/style=\{\{/).slice(1)
    for (const b of blocks) {
      const inline = b.split('}}')[0]
      for (const h of inline.match(/#[0-9a-fA-F]{3,6}/g) || []) {
        if (!INLINE_HEX_WHITELIST.has(h.toLowerCase())) bad.push(`${rel}: ${h}`)
      }
    }
  }
  assert.deepEqual(bad, [], `JSX 内联 style 出现离群 hex 色：\n${bad.join('\n')}`)
})
