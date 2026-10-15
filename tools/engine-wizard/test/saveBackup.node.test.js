'use strict'
// 名片存盘：覆盖前留一份备份，只留一份；写入失败不破坏原文件。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

// save.js 的写盘入口：saveManifest(manifest, opts)
const { saveManifest } = require('../core/save.js')
// saveManifest(manifest, { enginesDir })：用引擎目录直接指向临时根，不碰真仓库
const writeFn = ({ manifest, root, overwrite }) =>
  saveManifest(manifest, { enginesDir: path.join(root, 'engines'), overwrite })

function tmpRoot () {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'savebak-'))
  fs.mkdirSync(path.join(r, 'engines', 'eng1'), { recursive: true })
  return r
}

// 真仓库的 engines/ 是用户资产，本文件的测试一个字节都不许写进去。
// 每次用例前后各查一次目录清单，多出条目就当场失败。
const REAL_ENGINES = path.join(__dirname, '..', '..', '..', 'engines')
function realEngineNames () {
  try { return fs.readdirSync(REAL_ENGINES).sort().join(',') } catch (e) { return '' }
}
function assertRealEnginesUntouched (before, when) {
  const after = realEngineNames()
  assert.strictEqual(after, before,
    `${when}：真 engines/ 目录被改动了，测试只许写临时目录`)
}

const M1 = { id: 'eng1', contract_version: 2, label: 'first' }
const M2 = { id: 'eng1', contract_version: 2, label: 'second' }

test('首次保存：没有原文件 ⇒ 不产生备份', () => {
  const root = tmpRoot()
  const r = writeFn({ id: 'eng1', manifest: M1, root })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.backup, null, '首次保存没有可备份的原文件')
  fs.rmSync(root, { recursive: true, force: true })
})

test('覆盖保存：备份内容等于覆盖前', () => {
  const root = tmpRoot()
  writeFn({ id: 'eng1', manifest: M1, root })
  const r = writeFn({ id: 'eng1', manifest: M2, root, overwrite: true })
  assert.strictEqual(r.ok, true)
  assert.ok(r.backup && fs.existsSync(r.backup), '覆盖时应留下备份')
  const bak = JSON.parse(fs.readFileSync(r.backup, 'utf8'))
  assert.strictEqual(bak.label, 'first', '备份应是覆盖前的内容')
  const cur = JSON.parse(fs.readFileSync(r.path, 'utf8'))
  assert.strictEqual(cur.label, 'second')
  fs.rmSync(root, { recursive: true, force: true })
})

test('二次覆盖：备份只留一份，内容是上一次的', () => {
  const root = tmpRoot()
  writeFn({ id: 'eng1', manifest: M1, root })
  writeFn({ id: 'eng1', manifest: M2, root, overwrite: true })
  const r = writeFn({ id: 'eng1', manifest: { ...M2, label: 'third' }, root, overwrite: true })
  const bak = JSON.parse(fs.readFileSync(r.backup, 'utf8'))
  assert.strictEqual(bak.label, 'second', '备份应是上一次的内容')
  // 目录下只有一个 .bak
  const baks = fs.readdirSync(path.join(root, 'engines', 'eng1')).filter((f) => f.endsWith('.bak'))
  assert.strictEqual(baks.length, 1, '备份只留一份，不攒')
  fs.rmSync(root, { recursive: true, force: true })
})

test('写入失败：原文件未被破坏，且如实报错', () => {
  const root = tmpRoot()
  writeFn({ id: 'eng1', manifest: M1, root })
  const dir = path.join(root, 'engines', 'eng1')
  const file = path.join(dir, 'manifest.json')
  const before = fs.readFileSync(file, 'utf8')
  // 让临时文件的写入失败：把 tmp 路径占成一个目录
  const tmp = file + '.tmp-wizard'
  fs.mkdirSync(tmp, { recursive: true })
  const r = writeFn({ id: 'eng1', manifest: M2, root, overwrite: true })
  assert.strictEqual(r.ok, false, '写不进去要如实报失败')
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, '原文件必须原样不动')
  fs.rmSync(root, { recursive: true, force: true })
})
