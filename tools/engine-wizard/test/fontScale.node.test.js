// 向导侧的字号标度守卫（平台的同名守卫在 web/src/fontScale.node.test.js，扫的是 web/src）。
// 本文件只扫 tools/engine-wizard/editor：11px 是下限，更小的中文在暗色底上要靠猜；
// 向导的样式引用平台的 --fs-* / --sp-*，那边没定义就整条失效，所以也要核对定义存在。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const editorDir = path.resolve(here, '../editor')
const stylesCss = fs.readFileSync(path.resolve(here, '../../../web/src/styles.css'), 'utf8')

function walk (d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { walk(p, acc); continue }
    if (/\.(css|jsx|js)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p)
  }
  return acc
}

const FILES = walk(editorDir)

test('向导内字号下限 11px：CSS 与内联都不许低于它', () => {
  const bad = []
  for (const f of FILES) {
    const rel = path.relative(process.cwd(), f).replace(/\\/g, '/')
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

test('向导引用的 --fs-* / --sp-* 必须在平台 styles.css 里定义过', () => {
  const defined = new Set([...stylesCss.matchAll(/(--(?:fs|sp)-[0-9]+)\s*:/g)].map((m) => m[1]))
  assert.ok(defined.size >= 12, 'token 定义没扫到，这条守卫等于没跑')
  const bad = new Set()
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/var\((--(?:fs|sp)-[0-9]+)\)/g)) {
      if (!defined.has(m[1])) bad.add(`${path.relative(process.cwd(), f).replace(/\\/g, '/')}: ${m[1]}`)
    }
  }
  assert.deepEqual([...bad], [], `引用了未定义的 token：\n${[...bad].join('\n')}`)
})
