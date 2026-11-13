// 锁死 styles.css 的样式语义收口：间距走 --sp-*、语义色走 token(color-mix)，不得写死。
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(__dirname, '..', '..')
const css = fs.readFileSync(path.join(repo, 'web/src/styles.css'), 'utf8')

// 语义色 rgb 元组 → token 名（与代码收口一一对应）
const SEMANTIC_RGB = {
  '187,134,252': '--accent',
  '100,181,246': '--info',
  '76,175,80': '--success',
  '255,183,77': '--warning',
  '207,102,121': '--danger（旧粉，已改 --danger 红）',
}
const SP_SET = new Set([2, 4, 6, 8, 10, 12, 16, 24])

test('styles.css：间距属性不得写死 token 值裸 px（应改用 --sp-*）', () => {
  const re = /(^|;|\{)\s*((?:margin|padding|gap)(?:-[a-z]+)?)\s*:\s*([^;{}]+)/g
  const bad = []
  let m
  while ((m = re.exec(css)) !== null) {
    const val = m[3]
    const px = val.match(/(\d+)px/g) || []
    for (const t of px) {
      const v = parseInt(t, 10)
      if (SP_SET.has(v)) bad.push(`${m[2]}: ${val.trim()}`)
    }
  }
  assert.deepEqual(bad, [], `styles.css 仍存在应走 --sp-* 的裸 px 间距：\n${bad.join('\n')}`)
})

test('styles.css：语义色不得写死 rgba 元组（应改用 color-mix(var(--token))）', () => {
  const re = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/g
  const bad = []
  let m
  while ((m = re.exec(css)) !== null) {
    const key = `${m[1]},${m[2]},${m[3]}`
    if (SEMANTIC_RGB[key]) bad.push(`${m[0]} → 应使用 ${SEMANTIC_RGB[key]}`)
  }
  assert.deepEqual(bad, [], `styles.css 仍存在写死的语义色 rgba：\n${bad.join('\n')}`)
})
