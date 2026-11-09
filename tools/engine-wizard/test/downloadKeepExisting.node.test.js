'use strict'
// 两个仓库下到同一个权重目录时，同名文件不允许被后下的那份覆盖：
//   主权重与补充文件常混在不同仓库里，文件大小不同，覆盖后是哪一套无从判断。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { downloadFile, checkFileStatus, enrichManifestFiles } = require('../core/download')

function plant (files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-keep-'))
  const dir = path.join(root, 'engines', 'demo', 'checkpoints')
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const abs = path.join(dir, ...name.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return { root, dir }
}

test('已有正式文件且没有 .tmp ⇒ 保留不覆盖，返回 KEPT_EXISTING', async () => {
  const { root, dir } = plant({ 'gpt.pth': '来自第一个仓库' })
  const lines = []
  const r = await downloadFile({ name: 'gpt.pth', size: 999, tool: 'hf' },
    'org/another-repo', root, 'demo', (text) => lines.push(text), () => {})
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.code, 'KEPT_EXISTING')
  assert.strictEqual(r.skipped, true)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'gpt.pth'), 'utf8'), '来自第一个仓库')
  assert.ok(lines.some((l) => /另一个仓库/.test(l)), '要给出冲突说明')
})

test('有 .tmp 时不拦截：那是没下完的续传，照旧交给下载层', async () => {
  const { root } = plant({ 'gpt.pth.tmp': 'half' })
  // 只验短路判据没触发：触发时会立刻 resolve 且 code=KEPT_EXISTING。
  // 已取消的 signal 让下载层立刻收尾，不打网络。
  const r = await downloadFile({ name: 'gpt.pth', size: 999, tool: 'hf' },
    'org/another-repo', root, 'demo', () => {}, () => {},
    null, AbortSignal.abort())
  assert.notStrictEqual(r.code, 'KEPT_EXISTING')
})

test('清单里同名但大小不符的文件：状态仍是 partial，但说清可能来自另一个仓库', async () => {
  const { root } = plant({ 'config.yaml': 'first' })
  const st = await checkFileStatus('config.yaml', 999, root, 'demo', null)
  assert.strictEqual(st.status, 'partial')
  assert.ok(/另一个仓库/.test(st.noteZh))
  const files = await enrichManifestFiles([{ name: 'config.yaml', size: 999 }],
    'org/another-repo', 'hf', root, 'demo')
  assert.strictEqual(files[0].status, 'partial')
  assert.ok(/另一个仓库/.test(files[0].noteZh))
})
