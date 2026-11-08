'use strict'
// 第 3 步的落盘子目录：上游把模型并排放进 checkpoints 下的子目录时，
//   显示的命令、清单核对、实际写盘三处要落在同一层。
//   写错的表现是「下好了但引擎找不到」：文件在 checkpoints 根，引擎去 checkpoints/<模型> 找。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')

function loadSource () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) throw new Error('拿不到 esbuild')
  const code = esbuild.transformSync(
    fs.readFileSync(path.join(EDITOR_DIR, 'downloadSource.js'), 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, () => {
    throw new Error('downloadSource 不该有依赖')
  }, mod)
  return mod.exports
}

const { subdirOf, buildCommand } = loadSource()

test('子目录：checkpoints 之后的那一段才是落点', () => {
  assert.strictEqual(subdirOf({ dir: 'checkpoints/s2-pro' }), 's2-pro')
  assert.strictEqual(subdirOf({ dir: './checkpoints/s2-pro' }), 's2-pro')
  assert.strictEqual(subdirOf({ dir: 'checkpoints' }), '')
  assert.strictEqual(subdirOf({ dir: './checkpoints/' }), '')
})

test('子目录：上游没写在 checkpoints 下时不下探', () => {
  assert.strictEqual(subdirOf({ dir: 'weights' }), '', '换了个目录名就不猜')
  assert.strictEqual(subdirOf({ dir: '' }), '')
  assert.strictEqual(subdirOf(null), '')
})

test('子目录：越界写法一律当没有', () => {
  assert.strictEqual(subdirOf({ dir: 'checkpoints/../../etc' }), '')
  assert.strictEqual(subdirOf({ dir: 'checkpoints/D:/x' }), '')
})

test('显示命令带上子目录：三种来源形态一致', () => {
  const c = { tool: 'hf', repo: 'org/model', dir: 'checkpoints/s2-pro' }
  assert.match(buildCommand(c, {}).display, /--local-dir=checkpoints\/s2-pro/)

  const ms = { tool: 'modelscope', repo: 'org/model', dir: 'checkpoints/s2-pro' }
  assert.match(buildCommand(ms, {}).display, /--local_dir checkpoints\/s2-pro/)

  const snap = { tool: 'snapshot', repo: 'org/model', dir: 'checkpoints/s2-pro', source: 'hf' }
  assert.match(buildCommand(snap, {}).display, /local_dir='checkpoints\/s2-pro'/)
})

test('显示命令：没有子目录时仍是 checkpoints', () => {
  const c = { tool: 'hf', repo: 'org/model', dir: 'checkpoints' }
  assert.match(buildCommand(c, {}).display, /--local-dir=checkpoints\s*$/)
})

// 后端：核对文件状态时也要认这一层，否则清单会显示「未下载」，
//   而文件其实就在子目录里。
test('后端核对：同一份文件在子目录里能被认出来', async () => {
  const { checkFileStatus } = require('../core/download.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-subdir-'))
  const id = 'demo'
  const dir = path.join(root, 'engines', id, 'checkpoints', 's2-pro')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), '{"a":1}')

  const hit = await checkFileStatus('config.json', 7, root, id, null, 's2-pro')
  assert.notStrictEqual(hit.status, 'missing', '子目录里的文件要算已下载')

  const miss = await checkFileStatus('config.json', 7, root, id, null, '')
  assert.strictEqual(miss.status, 'missing', '根目录下没有这个文件')

  fs.rmSync(root, { recursive: true, force: true })
})
