'use strict'

// ---------------------------------------------------------------------------
//  The documentation is part of the node, not an extra
// ---------------------------------------------------------------------------
// A node whose ports are called `a`, `value` and `seed` and which explains none
// of them is not usable by anyone who did not write it. These tests are what
// stops that from coming back: a new node with no prose fails the suite, and so
// does a doc entry for a port that no longer exists.

const test = require('node:test')
const assert = require('node:assert/strict')

const { FlowgraphService } = require('./service')
const { NODE_DOCS, PORT_TYPE_DOCS } = require('./docs')
const { PORT_TYPES } = require('./types')

const catalogue = new FlowgraphService({ rootDir: require('node:os').tmpdir() }).nodeCatalogue()
const allNodes = catalogue.categories.flatMap(c => c.nodes)

const HAN = /[\u4e00-\u9fff]/

function bothLanguages(pair, what) {
  assert.ok(pair && typeof pair === 'object', `${what} 没有中英文两份文案`)
  assert.ok(pair.en && pair.en.trim(), `${what} 缺英文`)
  assert.ok(pair.zh && pair.zh.trim(), `${what} 缺中文`)
}

test('every node on the canvas says what it is, in both languages', () => {
  assert.ok(allNodes.length >= 38, `只描述了 ${allNodes.length} 个节点，比注册的少`)
  for (const node of allNodes) {
    bothLanguages(node.label, `${node.type} 的名称`)
    bothLanguages(node.help, `${node.type} 的说明`)
    assert.notEqual(node.label.en, node.type, `${node.type} 的英文名还是类型名`)
    assert.ok(!HAN.test(node.label.en), `${node.type} 的英文名里混了中文：${node.label.en}`)
    assert.ok(HAN.test(node.label.zh), `${node.type} 的中文名里没有中文：${node.label.zh}`)
    assert.ok(node.help.zh.length >= 8, `${node.type} 的中文说明太短，等于没说`)
    assert.ok(node.help.en.length >= 8, `${node.type} 的英文说明太短，等于没说`)
  }
})

test('every port on every node says what it wants or what it gives back', () => {
  for (const node of allNodes) {
    for (const [side, ports] of [['输入', node.inputs], ['输出', node.outputs]]) {
      for (const port of ports) {
        bothLanguages(port.label, `${node.type} 的${side}口 ${port.name} 的名称`)
        bothLanguages(port.help, `${node.type} 的${side}口 ${port.name} 的说明`)
        bothLanguages(port.type_help, `${node.type} 的${side}口 ${port.name} 的类型说明（${port.type}）`)
        assert.ok(port.help.zh.length >= 4, `${node.type}.${port.name} 的中文说明是空话`)
      }
    }
  }
})

test('every setting says what it does, and fixed-choice settings list their choices', () => {
  for (const node of allNodes) {
    for (const param of node.params) {
      bothLanguages(param.label, `${node.type} 的设置 ${param.name} 的名称`)
      bothLanguages(param.help, `${node.type} 的设置 ${param.name} 的说明`)
      assert.ok(Array.isArray(param.choices), `${node.type}.${param.name} 的候选项应当是数组`)
      for (const choice of param.choices) bothLanguages(choice.label, `${node.type}.${param.name} 的候选 ${choice.value}`)
    }
  }
  const compare = allNodes.find(n => n.type === 'logic.compare')
  const op = compare.params.find(p => p.name === 'op')
  assert.deepEqual(op.choices.map(c => c.value), ['>', '>=', '<', '<=', '==', '!='],
    '比较方式是固定几种，界面就该给列表而不是让人硬记')
})

test('the seed node explains what a seed is and what -1 means', () => {
  // This one is called out by name: "我 seed 明明改过，但我不知道 seed 是什么".
  const seed = allNodes.find(n => n.type === 'io.seed')
  assert.match(seed.help.zh, /-1/)
  assert.match(seed.help.en, /-1/)
  assert.match(seed.help.zh, /复现|随机/)
  const param = seed.params.find(p => p.name === 'seed')
  assert.match(param.help.zh, /-1/)
})

test('the documentation and the registry cannot drift apart', () => {
  const byType = new Map(allNodes.map(n => [n.type, n]))
  for (const type of Object.keys(NODE_DOCS)) {
    assert.ok(byType.has(type), `docs.js 里写了 ${type}，但这个节点没有注册`)
    const node = byType.get(type)
    const portNames = new Set([
      ...node.inputs.map(p => p.name),
      ...node.outputs.map(p => `${p.name}_out`),
      ...node.outputs.map(p => p.name),
    ])
    for (const name of Object.keys(NODE_DOCS[type].ports || {})) {
      assert.ok(portNames.has(name), `docs.js 里写了 ${type} 的 ${name} 口，但这个口不存在`)
    }
    const paramNames = new Set(node.params.map(p => p.name))
    for (const name of Object.keys(NODE_DOCS[type].params || {})) {
      assert.ok(paramNames.has(name), `docs.js 里写了 ${type} 的设置 ${name}，但这个设置不存在`)
    }
  }
  for (const type of byType.keys()) {
    assert.ok(NODE_DOCS[type], `${type} 没有写说明`)
  }
})

test('every port type a wire can carry has a plain description', () => {
  for (const type of PORT_TYPES) {
    assert.ok(PORT_TYPE_DOCS[type], `端口类型 ${type} 没有说明，鼠标停上去什么都看不到`)
    bothLanguages(PORT_TYPE_DOCS[type], `端口类型 ${type}`)
  }
})

test('the categories in the left panel are named in both languages too', () => {
  for (const category of catalogue.categories) {
    bothLanguages(category.label, `分类 ${category.id} 的名称`)
    assert.ok(!HAN.test(category.label.en), `分类 ${category.id} 的英文名里混了中文`)
  }
})
