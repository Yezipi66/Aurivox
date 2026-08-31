'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const L = require('./memledger')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memledger-'))
}

// ---------------------------------------------------------------------------
//  只涨不落
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 账本存的是「最多吃过多少」，⛔ 不是「上次吃了多少」', () => {
  const root = tmpRoot()
  L.record(root, 'a', 3547)
  L.record(root, 'a', 800)    // 跑了一次短文本
  assert.equal(L.needMb(root, 'a'), 3547,
    '按上次的记，一次短文本就会抹掉上次长文本的教训 ⇒ 下次长文本 OOM')
  fs.rmSync(root, { recursive: true, force: true })
})

test('更高的实测会顶上去', () => {
  const root = tmpRoot()
  L.record(root, 'a', 3547)
  L.record(root, 'a', 4200)
  assert.equal(L.needMb(root, 'a'), 4200)
  fs.rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
//  「没量过」和「量到 0」
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 从来没记过 ⇒ needMb 返回 null，⛔ 不是 0', () => {
  // null 是「不知道」（问用户）；0 是「不吃内存」（随便起）。
  // 混起来 = 把最危险的情况当成最安全的。
  const root = tmpRoot()
  assert.equal(L.needMb(root, 'never-seen'), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('⛔ 绝不写 0 —— 量不到就整笔丢掉', () => {
  // 写 0 等于声称这台引擎不吃内存，那是账本里最危险的一条记录。
  const root = tmpRoot()
  assert.equal(L.record(root, 'a', 0), null)
  assert.equal(L.record(root, 'a', -5), null)
  assert.equal(L.record(root, 'a', NaN), null)
  assert.equal(L.needMb(root, 'a'), null)
  fs.rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
//  跨重启
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 落盘之后，换个进程读还在', () => {
  // 操作系统免费记的峰值跟着进程的命，进程一重启就归零。
  // 不落盘 ⇒ 后端每重启一次就把教训忘光，那个教训永远学不会。
  const root = tmpRoot()
  L.record(root, 'a', 3547)
  const fresh = L.load(root)
  assert.equal(fresh.engines.a.peakMb, 3547)
  assert.ok(fs.existsSync(L.ledgerPath(root)))
  fs.rmSync(root, { recursive: true, force: true })
})

test('⛔ 账本坏了当空账本，不抛 —— 账本坏了不该让引擎起不来', () => {
  const root = tmpRoot()
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  fs.writeFileSync(L.ledgerPath(root), '{ 这不是 JSON', 'utf8')
  assert.deepEqual(L.load(root).engines, {})
  assert.equal(L.needMb(root, 'a'), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('⛔ 写不进去也不抛 —— 记不住账是遗憾，起不了引擎是故障', () => {
  const bogus = path.join(os.tmpdir(), 'memledger-nonexistent', '\0bad')
  assert.doesNotThrow(() => L.record(bogus, 'a', 100))
})

// ---------------------------------------------------------------------------
//  崩掉那次
// ---------------------------------------------------------------------------

test('⭐⭐ 起之前落一条「正在试」，崩了下次认得出', () => {
  // 被 OOM 打死的进程来不及让我们读峰值，那次实测就白费了 ——
  // 下次还会用同样的无知去赌同一把。
  const root = tmpRoot()
  L.markAttempting(root, 'a')
  assert.ok(L.load(root).attempting.a)
  const dead = L.reapAttempts(root)
  assert.deepEqual(dead, ['a'])
  assert.equal(L.crashesOf(root, 'a'), 1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('活着回来的会把「正在试」清掉，⛔ 不算崩', () => {
  const root = tmpRoot()
  L.markAttempting(root, 'a')
  L.record(root, 'a', 3547)
  assert.deepEqual(L.reapAttempts(root), [])
  assert.equal(L.crashesOf(root, 'a'), 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('⚠ 崩过之后，实测照样记得下来（崩的账不挡记账）', () => {
  const root = tmpRoot()
  L.markAttempting(root, 'a')
  L.reapAttempts(root)
  L.record(root, 'a', 3547)
  assert.equal(L.needMb(root, 'a'), 3547)
  assert.equal(L.crashesOf(root, 'a'), 1, '崩的次数不该被记账抹掉')
  fs.rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
//  守卫
// ---------------------------------------------------------------------------

test('⛔ 守卫：memledger.js 不许认识任何一台具体的引擎', () => {
  // 种子数一旦按引擎 id 写死，装一台谁都没见过的引擎就得改这个文件。
  const src = fs.readFileSync(path.join(__dirname, 'memledger.js'), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  for (const banned of ['gpt', 'sovits', 'indextts', 'IndexTTS']) {
    assert.ok(!code.includes(banned), `memledger.js 的代码里出现了 ${banned}`)
  }
})
