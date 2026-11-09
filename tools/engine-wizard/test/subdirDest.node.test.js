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

// 模型页链接形状固定，识别出来就该直接进下载清单，不必再让人点一次「加入」。
//   单文件直链与其它站点仍走原来的文件下载口子。
const { repoLinkFromUrl } = loadSource()

test('模型页链接：HF 与魔搭都认，长尾路径剥掉', () => {
  assert.deepStrictEqual(repoLinkFromUrl('https://huggingface.co/Org/Model-A'),
    { tool: 'hf', repo: 'Org/Model-A', url: 'https://huggingface.co/Org/Model-A' })
  assert.deepStrictEqual(repoLinkFromUrl('https://huggingface.co/Org/Model-A/tree/main'),
    { tool: 'hf', repo: 'Org/Model-A', url: 'https://huggingface.co/Org/Model-A' })
  assert.strictEqual(repoLinkFromUrl('https://huggingface.co/Org/Model-B/resolve/main/config.json'), null,
    '输入框里的单文件直链要交回文件下载，不能当仓库引入')
  assert.deepStrictEqual(repoLinkFromUrl('https://www.modelscope.cn/models/iic/CosyVoice2-0.5B'),
    { tool: 'modelscope', repo: 'iic/CosyVoice2-0.5B',
      url: 'https://modelscope.cn/models/iic/CosyVoice2-0.5B' })
})

test('非模型仓库：不当成仓库，交回单文件下载', () => {
  for (const u of [
    'https://huggingface.co/spaces/Org/Demo',
    'https://huggingface.co/datasets/Org/Data',
    'https://huggingface.co/docs/transformers/index',
    'https://github.com/org/repo/releases/download/v1/model.zip',
    'https://huggingface.co/Org/Model-B/resolve/main/config.json',
    'https://www.modelscope.cn/models/iic/CosyVoice2-0.5B/resolve/master/config.json',
    'https://example.com/model.safetensors',
    'ftp://example.com/model.bin',
    'not a url',
    '',
  ]) assert.strictEqual(repoLinkFromUrl(u), null, u)
})

test('链接直接进下载清单：不再有一次「加入」动作', () => {
  const src = fs.readFileSync(path.join(EDITOR_DIR, 'StepsExtra.jsx'), 'utf8')
  assert.match(src, /\.\.\.\[\.\.\.repoLinks, \.\.\.pastedRepos\]\.filter\(keepLink\)\.map\(linkCmd\)/,
    '探测到的链接与手贴的仓库都直接成为命令')
  assert.ok(!src.includes('Add to download list'), '不再要求人逐个加入')
  assert.match(src, /const link = repoLinkFromUrl\(repoUrl\.trim\(\)\)/,
    '手贴模型仓库页时按仓库处理，不当单文件下载')
  assert.match(src, /const sub = \(c && c\.subdir\) \|\| subdirOf\(c\)/,
    '手填的落地位置要带进列文件请求')
})
