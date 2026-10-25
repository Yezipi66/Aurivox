// 字号标度守卫。
// 11px 是全站下限：更小的中文在暗色底上要靠猜。这里管两件事：
//   1) 不许再出现低于 11px 的字号（CSS 的 font-size 与 JSX 的 fontSize 都算）
//   2) 代码里引用的 --fs-* / --sp-* token 必须真的在 styles.css 里定义过，
//      拼错档名时 build 照样绿、样式照样丢，跟类名没人查是同一种坏法。
// 离群值（11.5 / 12.5 / 15 / 17 / 20）尚未归档，是已登记的欠账，不在本守卫范围。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webSrc = path.resolve(here)
const repo = path.resolve(webSrc, '../..')
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8')

function walk (d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, acc); continue }
    if (/\.(css|jsx|js)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p)
  }
  return acc
}

const FILES = [
  ...walk(path.join(webSrc)),
  ...walk(path.join(repo, 'tools/engine-wizard/editor')),
]

test('字号下限 11px：CSS 与内联都不许再低于它', () => {
  const bad = []
  for (const f of FILES) {
    const rel = path.relative(repo, f).replace(/\\/g, '/')
    const src = fs.readFileSync(f, 'utf8')
    if (f.endsWith('.css')) {
      for (const m of src.matchAll(/font-size:\s*([0-9.]+)px/g)) {
        if (parseFloat(m[1]) < 11) bad.push(`${rel}: font-size: ${m[1]}px`)
      }
    } else {
      for (const m of src.matchAll(/\bfontSize:\s*([0-9.]+)(?![\d.])/g)) {
        if (parseFloat(m[1]) < 11) bad.push(`${rel}: fontSize: ${m[1]}`)
      }
    }
  }
  assert.deepEqual(bad, [], `出现了低于 11px 的字号：\n${bad.join('\n')}`)
})

test('引用的 --fs-* / --sp-* token 必须在 styles.css 里定义过', () => {
  const css = read('web/src/styles.css')
  const defined = new Set([...css.matchAll(/(--(?:fs|sp)-[0-9]+)\s*:/g)].map((m) => m[1]))
  assert.ok(defined.size >= 12, 'token 定义没扫到，这条守卫等于没跑')
  const bad = new Set()
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/var\((--(?:fs|sp)-[0-9]+)\)/g)) {
      if (!defined.has(m[1])) bad.add(`${path.relative(repo, f).replace(/\\/g, '/')}: ${m[1]}`)
    }
  }
  assert.deepEqual([...bad], [], `引用了未定义的 token：\n${[...bad].join('\n')}`)
})
