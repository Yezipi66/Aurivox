'use strict'

// 「这台引擎上一次成功调用填了什么」只从生成记录里捞：捞不到就返回 null，交回「不做任何补全」那一条。
// 这里钉住的是捞的规矩：按时间新→旧、只认这台引擎、只认 status 为 ok 的那次、读不动的一律跳过而不抛。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readLastSuccessRecipe, LOOKBACK } = require('./lastSuccessRecipe')

function makeRoots () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-last-recipe-'))
  const outputRoots = {
    generate: path.join(root, 'generate'),
    comparerefs: path.join(root, 'comparerefs'),
    broker: path.join(root, 'broker'),
  }
  for (const dir of Object.values(outputRoots)) fs.mkdirSync(dir, { recursive: true })
  return { root, outputRoots }
}

/** 落一份生成记录；id 用 ISO 时间戳打头，因为目录名字典序就是时间序。recipe 传 null = 那份配方都没有。 */
function record (outputRoots, { source = 'generate', id, engine_id = 'gpt-sovits', status = 'ok', recipe = { x: 1 } }) {
  const dir = path.join(outputRoots[source], id)
  fs.mkdirSync(dir, { recursive: true })
  const meta = { engine_id, status }
  if (recipe !== null) meta.recipe = recipe
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
  return dir
}

const read = (outputRoots, engineId = 'gpt-sovits', over = {}) =>
  readLastSuccessRecipe({ engineId, outputRoots, fs, path, ...over })

test('⭐ 取最近一次成功的那份：两条都成功时，新的赢', () => {
  const { outputRoots } = makeRoots()
  record(outputRoots, { id: '2026-10-01T00-00-00-000', recipe: { x: '旧' } })
  record(outputRoots, { id: '2026-11-01T00-00-00-000', recipe: { x: '新' } })

  assert.deepEqual(read(outputRoots), { x: '新' })
})

test('⭐ 失败的那次不算上一次：跳过它，用再往前一次成功的', () => {
  const { outputRoots } = makeRoots()
  record(outputRoots, { id: '2026-10-01T00-00-00-000', recipe: { x: '成了' } })
  record(outputRoots, { id: '2026-11-01T00-00-00-000', status: 'error', recipe: { x: '失败' } })

  assert.deepEqual(read(outputRoots), { x: '成了' }, '把失败那次填的值接过来，等于把一次错配再犯一遍')
})

test('⭐ 别的引擎的记录不算：参数表是这台引擎的，不跨引擎接', () => {
  const { outputRoots } = makeRoots()
  record(outputRoots, { id: '2026-11-01T00-00-00-000', engine_id: 'other-engine', recipe: { x: 9 } })

  assert.equal(read(outputRoots), null)
})

test('没有配方的记录跳过：那条记录里没存下这一份，就继续往前找', () => {
  const { outputRoots } = makeRoots()
  record(outputRoots, { id: '2026-10-01T00-00-00-000', recipe: { x: 1 } })
  record(outputRoots, { id: '2026-11-01T00-00-00-000', recipe: null })

  assert.deepEqual(read(outputRoots), { x: 1 })
})

test('配方形状不对的记录跳过：存进来一个字符串配方，就当这条没有', () => {
  const { outputRoots } = makeRoots()
  record(outputRoots, { id: '2026-10-01T00-00-00-000', recipe: { x: 1 } })
  record(outputRoots, { id: '2026-11-01T00-00-00-000', recipe: '一个字符串' })

  assert.deepEqual(read(outputRoots), { x: 1 })
})

test('三个输出根都翻：Compare 与 Broker 那两处也是这台引擎成功过的地方', () => {
  const { outputRoots } = makeRoots()
  record(outputRoots, { source: 'broker', id: '2026-11-01T00-00-00-000', recipe: { x: 'broker' } })

  assert.deepEqual(read(outputRoots), { x: 'broker' })
})

test('读不动的一律跳过，不抛：坏 JSON、空目录、非生成记录的杂物都不能让这次合成失败', () => {
  const { outputRoots } = makeRoots()
  record(outputRoots, { id: '2026-10-01T00-00-00-000', recipe: { x: '好的' } })
  const bad = path.join(outputRoots.generate, '2026-11-01T00-00-00-000')
  fs.mkdirSync(bad, { recursive: true })
  fs.writeFileSync(path.join(bad, 'meta.json'), '{ 不是 JSON')
  fs.writeFileSync(path.join(outputRoots.generate, 'README.txt'), '不是生成目录')

  assert.deepEqual(read(outputRoots), { x: '好的' })
})

test('目录还没建起来 ⇒ null，不抛：第一次用这台引擎就是这个形状', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-last-recipe-'))
  const outputRoots = { generate: path.join(root, 'outputs/generate') }

  assert.equal(read(outputRoots), null)
})

test('没人说是哪台引擎 ⇒ 不扫盘，也不回落到某一台', () => {
  const { outputRoots } = makeRoots()
  record(outputRoots, { id: '2026-11-01T00-00-00-000', recipe: { x: 1 } })

  assert.equal(read(outputRoots, ''), null, '引擎不明时绝不能把别的引擎的参数接过来')
})

test(`⭐ 只翻最近 ${LOOKBACK} 条：往前翻是有限的一次，不是每次合成都全量扫盘`, () => {
  const { outputRoots } = makeRoots()
  record(outputRoots, { id: '2026-01-01T00-00-00-000', recipe: { x: '太远了' } })
  // LOOKBACK 条别的引擎的记录，时间都排在上面那条之后：窗口被它们占满。
  for (let i = 0; i < LOOKBACK; i++) {
    const day = String(i + 1).padStart(2, '0')
    record(outputRoots, {
      id: `2026-09-${day}T00-00-00-000`,
      engine_id: 'other-engine',
      recipe: { x: '别人的' },
    })
  }

  assert.equal(read(outputRoots), null, '窗口外那一次成功不算上一次：宁可什么都不补')
  assert.equal(read(outputRoots, 'gpt-sovits', { lookback: LOOKBACK + 1 }).x, '太远了', '窗口是可调的一次读盘上限，不是规矩本身')
})
