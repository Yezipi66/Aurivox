'use strict'
// 第 3 步第一档：引擎自带入口的发现与占位符展开。
//   平台只负责找出来、执行、显示进度；命令内容由名片或上游脚本自己决定。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildEngineDownloadEntries, expandEngineArgv,
} = require('../core/wizardbridge')

function plant (opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-entries-'))
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  const manifest = { id: 'demo', runtime: { checkpoints: 'engines/demo/checkpoints' }, models: { required: [] } }
  if (opts.post) manifest.models.post_download = { command: opts.post }
  if (opts.scripts) for (const f of opts.scripts) fs.writeFileSync(path.join(dir, f), '')
  if (opts.venv) fs.mkdirSync(path.join(dir, '.venv'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return { root, dir, manifest }
}

test('名片声明优先于脚本；安装脚本要标出可能已在第 2 步部署', () => {
  const post = ['{engine_python}', '-c', "ensure('{checkpoints}')"]
  const { root } = plant({ post, scripts: ['install.sh', 'download.sh'], venv: true })
  const entries = buildEngineDownloadEntries(root, 'demo')
  assert.strictEqual(entries[0].key, 'manifest', '名片声明排第一')
  const inst = entries.find((e) => e.key === 'script:install.sh')
  assert.ok(inst)
  assert.strictEqual(inst.installs_env, true)
  assert.strictEqual(inst.already_deployed, true)
  const dl = entries.find((e) => e.key === 'script:download.sh')
  assert.strictEqual(dl.installs_env, false)
})

test('展开占位符后不留下未展开的 token，权重目录用正斜杠', () => {
  const post = ['{engine_python}', '-c', "ensure('{checkpoints}')", '{engine_dir}']
  const { root, dir, manifest } = plant({ post })
  const argv = expandEngineArgv(post, root, 'demo', dir, manifest)
  assert.ok(!argv.some((w) => /\{[a-z_]+\}/.test(w)))
  assert.ok(argv[2].includes('/engines/demo/checkpoints'))
  assert.ok(!argv[2].includes('\\'))
  assert.ok(argv[3].endsWith('/engines/demo'))
})

test('引擎目录不存在时返回空清单，不抛', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-entries-empty-'))
  assert.deepStrictEqual(buildEngineDownloadEntries(root, 'missing'), [])
})
