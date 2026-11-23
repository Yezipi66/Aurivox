'use strict'
// 下载命令的落点 = 权重目录解析值（第 3 步快照 / 第 4 步名片 / 默认），
//   且是引擎目录内的相对路径：命令在引擎目录里执行，写成 engines/<id>/... 会写到别处。
//
// 守的是「状态 → 命令里的落点」，不是实现：
//   ① 无声明无快照 → local_dir = checkpoints
//   ② 第 3 步改过 → local_dir = 快照值
//   ③ 名片声明 → local_dir = 名片值
//   ④ 非法快照 → 仍落在引擎目录内（回退默认）

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildEngineDownloadEntries } = require('../core/wizardbridge.js')

function mkdtempRoot () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-cmdir-'))
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  // 平台解释器：命令转写要找到 venv/Scripts/python.exe 才生成 argv（空文件即可，不执行）
  fs.mkdirSync(path.join(root, 'venv', 'Scripts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'venv', 'Scripts', 'python.exe'), '')
  fs.writeFileSync(path.join(dir, 'README.md'),
    '```python\nfrom modelscope import snapshot_download\n'
    + 'snapshot_download("org/model-1.0", local_dir="pretrained_models/model")\n```\n')
  return { root, dir }
}

function writeSnapshot (root, id, value) {
  const dir = path.join(root, 'engines', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'wizard.json'), JSON.stringify({ downloadDir: value }))
}

function localDirOf (entry) {
  const argv = entry && entry.argv
  if (!Array.isArray(argv)) return null
  const i = argv.findIndex((w) => w === '--local_dir' || w === '--local-dir')
  if (i >= 0) return argv[i + 1]
  // Windows 走 python -c "…local_dir=…"：值在代码串里，不是独立参数
  const code = argv.find((w) => typeof w === 'string' && w.includes('local_dir='))
  if (!code) return null
  const m = code.match(/local_dir\s*=\s*["']([^"']+)["']/)
  // 代码串里反斜杠是转义形式（weights\\s2），还原成真实路径再比
  return m ? m[1].replace(/\\\\/g, '\\') : null
}

test('没有声明与快照时，命令落在默认 checkpoints', () => {
  const { root } = mkdtempRoot()
  const e = buildEngineDownloadEntries(root, 'demo')[0]
  assert.equal(localDirOf(e), 'checkpoints')
})

test('第 3 步改过存放位置后，命令跟随快照（引擎内相对）', () => {
  const { root } = mkdtempRoot()
  writeSnapshot(root, 'demo', 'weights/s2')
  const e = buildEngineDownloadEntries(root, 'demo')[0]
  assert.equal(localDirOf(e), 'weights/s2')
})

test('名片声明后，命令以名片为准', () => {
  const { root, dir } = mkdtempRoot()
  writeSnapshot(root, 'demo', 'weights/s2')
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify({ id: 'demo', runtime: { checkpoints: 'cp/from-card' } }))
  const e = buildEngineDownloadEntries(root, 'demo')[0]
  // 名片的落点不在引擎目录下（models/tts/e1）⇒ 命令用绝对路径，避免相对引擎目录写错地方
  assert.equal(localDirOf(e), path.join(root, 'cp', 'from-card'))
})

test('非法快照不改变落点，仍落在引擎目录内', () => {
  const { root } = mkdtempRoot()
  writeSnapshot(root, 'demo', '../escape')
  const e = buildEngineDownloadEntries(root, 'demo')[0]
  const v = localDirOf(e)
  assert.ok(v && !v.split(/[\\/]/).includes('..'), `落点不应向外：${v}`)
})
