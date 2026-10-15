'use strict'
// A3：下载完整性校验与半截文件处理。
//
// 判据是「不假装」：上游给了 sha 就真比对；没给就如实报「未校验」，
// 不许把没校验过的文件说成好的。删半截只删判为 partial 的，
// 判为 ok 的不碰（删了等于让使用者白下一遍）。
const assert = require('node:assert')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { checkFileStatus, enrichManifestFiles, removePartialFiles } = require('../core/download.js')

const REAL_ENGINES = path.join(__dirname, '..', '..', '..', 'engines')
function realNames () {
  try { return fs.readdirSync(REAL_ENGINES).sort().join(',') } catch (e) { return '' }
}

// root 必须是 mkdtempSync 出来的临时根，本文件不许写真仓库的 engines/
function tmpRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'a3-download-'))
}

function putFile (root, id, name, content) {
  const dir = path.join(root, 'engines', id, 'checkpoints')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

function shaOf (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// ---- 一、checkFileStatus 的 sha 比对 ----

test('大小对且 sha 相符 → ok，且标明校验过', async () => {
  const before = realNames()
  const root = tmpRoot()
  const content = Buffer.from('weights')
  putFile(root, 'eng1', 'm.safetensors', content)
  const st = await checkFileStatus('m.safetensors', content.length, root, 'eng1', shaOf(content))
  assert.strictEqual(st.status, 'ok')
  assert.strictEqual(st.shaVerified, true)
  assert.strictEqual(realNames(), before, '不许写真仓库 engines/')
  fs.rmSync(root, { recursive: true, force: true })
})

test('大小对但 sha 不符 → partial（内容坏了，只看大小会当成好的）', async () => {
  const root = tmpRoot()
  const content = Buffer.from('weights')
  putFile(root, 'eng1', 'm.safetensors', content)
  const st = await checkFileStatus('m.safetensors', content.length, root, 'eng1',
    shaOf(Buffer.from('different bytes')))
  assert.strictEqual(st.status, 'partial', '大小一致但内容损坏必须算半截')
  assert.strictEqual(st.shaVerified, false)
  assert.ok(st.noteZh.includes('SHA-256'), st.noteZh)
  fs.rmSync(root, { recursive: true, force: true })
})

test('上游没给 sha → 不报已校验（不许假装校验过）', async () => {
  const root = tmpRoot()
  const content = Buffer.from('weights')
  putFile(root, 'eng1', 'm.safetensors', content)
  const st = await checkFileStatus('m.safetensors', content.length, root, 'eng1', null)
  assert.strictEqual(st.status, 'ok')
  assert.notStrictEqual(st.shaVerified, true, '上游没给 sha 就不能声称校验过')
  fs.rmSync(root, { recursive: true, force: true })
})

test('上游没给大小 → partial，无法确认完整性', async () => {
  const root = tmpRoot()
  putFile(root, 'eng1', 'm.safetensors', Buffer.from('weights'))
  const st = await checkFileStatus('m.safetensors', null, root, 'eng1', null)
  assert.strictEqual(st.status, 'partial')
  fs.rmSync(root, { recursive: true, force: true })
})

// ---- 二、半截的几种形态 ----

test('只有 .tmp 没有正式文件 → partial', async () => {
  const root = tmpRoot()
  const dir = path.join(root, 'engines', 'eng1', 'checkpoints')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'm.safetensors.tmp'), 'half')
  const st = await checkFileStatus('m.safetensors', 100, root, 'eng1', 'abc')
  assert.strictEqual(st.status, 'partial')
  fs.rmSync(root, { recursive: true, force: true })
})

test('大小介于 0 与上游大小之间 → partial', async () => {
  const root = tmpRoot()
  putFile(root, 'eng1', 'm.safetensors', Buffer.from('half'))
  const st = await checkFileStatus('m.safetensors', 1000, root, 'eng1', null)
  assert.strictEqual(st.status, 'partial')
  assert.strictEqual(st.size, 4)
  fs.rmSync(root, { recursive: true, force: true })
})

test('大小为 0 → partial', async () => {
  const root = tmpRoot()
  putFile(root, 'eng1', 'm.safetensors', Buffer.alloc(0))
  const st = await checkFileStatus('m.safetensors', 100, root, 'eng1', null)
  assert.strictEqual(st.status, 'partial')
  fs.rmSync(root, { recursive: true, force: true })
})

test('文件不存在 → missing', async () => {
  const root = tmpRoot()
  const st = await checkFileStatus('nope.bin', 100, root, 'eng1', null)
  assert.strictEqual(st.status, 'missing')
  fs.rmSync(root, { recursive: true, force: true })
})

// ---- 三、删半截 ----

test('删半截：只删 partial，ok 与 missing 不碰', async () => {
  const before = realNames()
  const root = tmpRoot()
  const good = Buffer.from('good bytes')
  putFile(root, 'eng1', 'good.safetensors', good)
  putFile(root, 'eng1', 'half.safetensors', Buffer.from('hal'))

  const r = await removePartialFiles([
    { name: 'good.safetensors', size: good.length, sha256: shaOf(good) },
    { name: 'half.safetensors', size: 999 },
    { name: 'missing.safetensors', size: 999 },
  ], root, 'eng1')

  assert.deepStrictEqual(r.deleted, ['half.safetensors'], '只有半截该被删')
  assert.strictEqual(r.skipped.length, 2, 'ok 与 missing 都不该被删')
  assert.ok(!fs.existsSync(path.join(root, 'engines', 'eng1', 'checkpoints', 'half.safetensors')))
  assert.ok(fs.existsSync(path.join(root, 'engines', 'eng1', 'checkpoints', 'good.safetensors')))
  assert.strictEqual(realNames(), before, '不许写真仓库 engines/')
  fs.rmSync(root, { recursive: true, force: true })
})

// ⛔ 缺信息不等于残缺：删 ok 会让使用者白下一遍，比漏删半截严重。
// 这四条是独立验收子 Agent 漏掉的——它把「ok 被删」归因为自己的探针
// 写错字节数，只验了参数正确那一种就下了「核心行为全部正确」的结论。
test('删半截：size 与 sha 都正确 ⇒ 不删', async () => {
  const root = tmpRoot()
  const good = Buffer.from('good bytes')
  putFile(root, 'eng1', 'g.bin', good)
  const r = await removePartialFiles(
    [{ name: 'g.bin', size: good.length, sha256: shaOf(good) }], root, 'eng1')
  assert.deepStrictEqual(r.deleted, [])
  assert.ok(fs.existsSync(path.join(root, 'engines', 'eng1', 'checkpoints', 'g.bin')))
  fs.rmSync(root, { recursive: true, force: true })
})

test('删半截：size 传错一个字节也不删（上游/前端给错不该毁掉文件）', async () => {
  const root = tmpRoot()
  const good = Buffer.from('good bytes')
  putFile(root, 'eng1', 'g.bin', good)
  const r = await removePartialFiles(
    [{ name: 'g.bin', size: good.length + 1, sha256: shaOf(good) }], root, 'eng1')
  assert.deepStrictEqual(r.deleted, [], 'size 不符也有可能是上游给错，不许删')
  assert.ok(fs.existsSync(path.join(root, 'engines', 'eng1', 'checkpoints', 'g.bin')))
  fs.rmSync(root, { recursive: true, force: true })
})

test('删半截：上游没给 sha 也不删，报 NEEDS_VERIFY', async () => {
  const root = tmpRoot()
  const good = Buffer.from('good bytes')
  putFile(root, 'eng1', 'g.bin', good)
  const r = await removePartialFiles([{ name: 'g.bin', size: good.length }], root, 'eng1')
  assert.deepStrictEqual(r.deleted, [], '没有 sha 能证明内容是坏的，不删')
  assert.strictEqual(r.skipped[0].code, 'NEEDS_VERIFY')
  assert.ok(fs.existsSync(path.join(root, 'engines', 'eng1', 'checkpoints', 'g.bin')))
  fs.rmSync(root, { recursive: true, force: true })
})

test('删半截：size 与 sha 都没传也不删', async () => {
  const root = tmpRoot()
  const good = Buffer.from('good bytes')
  putFile(root, 'eng1', 'g.bin', good)
  const r = await removePartialFiles([{ name: 'g.bin' }], root, 'eng1')
  assert.deepStrictEqual(r.deleted, [], '前端传 null 过来也不许删掉好文件')
  assert.ok(fs.existsSync(path.join(root, 'engines', 'eng1', 'checkpoints', 'g.bin')))
  fs.rmSync(root, { recursive: true, force: true })
})

test('删半截：sha 不符 ⇒ 删（内容真坏了）', async () => {
  const root = tmpRoot()
  const good = Buffer.from('good bytes')
  putFile(root, 'eng1', 'g.bin', good)
  const r = await removePartialFiles(
    [{ name: 'g.bin', size: good.length, sha256: shaOf(Buffer.from('bad')) }], root, 'eng1')
  assert.deepStrictEqual(r.deleted, ['g.bin'], 'sha 证明内容坏了才删')
  fs.rmSync(root, { recursive: true, force: true })
})

test('删半截：只有 .tmp 没有正式文件 ⇒ 删掉 .tmp', async () => {
  const root = tmpRoot()
  const dir = path.join(root, 'engines', 'eng1', 'checkpoints')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'm.safetensors.tmp'), 'half')
  await removePartialFiles([{ name: 'm.safetensors', size: null }], root, 'eng1')
  assert.ok(!fs.existsSync(path.join(dir, 'm.safetensors.tmp')), '半截 .tmp 要删')
  fs.rmSync(root, { recursive: true, force: true })
})

test('删半截：正式文件加 .tmp 且 sha 不符 ⇒ 两个都删', async () => {
  const root = tmpRoot()
  const dir = path.join(root, 'engines', 'eng1', 'checkpoints')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'm.safetensors'), 'x')
  fs.writeFileSync(path.join(dir, 'm.safetensors.tmp'), 'half')
  await removePartialFiles([{ name: 'm.safetensors', size: 100, sha256: 'nope' }], root, 'eng1')
  assert.ok(!fs.existsSync(path.join(dir, 'm.safetensors')), 'sha 不符的正式文件要删')
  assert.ok(!fs.existsSync(path.join(dir, 'm.safetensors.tmp')), '半截 .tmp 也要删')
  fs.rmSync(root, { recursive: true, force: true })
})

// ---- 四、enrichManifestFiles 的输出 ----

test('enrichManifestFiles 带出 shaVerified 与两端 sha 比对结果', async () => {
  const root = tmpRoot()
  const content = Buffer.from('weights')
  putFile(root, 'eng1', 'a.bin', content)
  putFile(root, 'eng1', 'b.bin', Buffer.from('other'))

  const out = await enrichManifestFiles([
    { name: 'a.bin', size: content.length, sha256: shaOf(content) },
    { name: 'b.bin', size: 5, sha256: shaOf(content) },
    { name: 'c.bin', size: 5 },
  ], 'repo', 'tool', root, 'eng1')

  assert.strictEqual(out[0].status, 'ok')
  assert.strictEqual(out[0].shaVerified, true)
  assert.strictEqual(out[1].status, 'partial', 'sha 不符的那条要报半截')
  assert.strictEqual(out[2].status, 'missing')
  assert.strictEqual(out[2].shaVerified, false, '没碰过的文件不能报已校验')
  fs.rmSync(root, { recursive: true, force: true })
})
