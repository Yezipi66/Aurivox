'use strict'

// ===========================================================================
//  画布必须认识引擎名片（契约 v2 第 2 步 · §9 里 nodes.js:69 / docs.js:218-219 两行）
// ===========================================================================
// ⭐ 这个文件存在的理由，是一个下游作者真的会撞上的死路：
//
//    后端从 1b 起就已经是名片驱动的了 —— adapter.js 按 engine_id 找名片、
//    按 param_keys 过参数。但**画布看不见名片**：
//      · docs.js 的引擎下拉框写死 choices: [gpt-sovits] ⇒ 选不到别的引擎
//      · nodes.js 的「引擎参数」节点写死 16 个 GPT-SoVITS 私有键
//        ⇒ 作者自己引擎的参数在画布上根本没有格子可填
//    结果就是：名片写得再对，工作流插件也做不出来。
//
// 下面所有测试都用一台**不存在的** fishtts 当被试。它不装在这台机器上，
// 也永远不会有人为它写一行 lib/ 代码 —— 如果画布能长出它的格子，
// 那「零代码接引擎」才算真的成立。

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { describeDefinition } = require('./service')
const { getDefinition } = require('./registry')
const { RESERVED_PARAM_KEYS } = require('./adapter')
const docs = require('./docs')

// 一张假名片。字段只写画布会读的那几项，其余留空 —— 正好证明画布
// 不需要名片回答别的问题。
const FISHTTS = Object.freeze({
  id: 'fishtts',
  label: 'FishTTS',
  param_keys: ['format', 'split', 'max_chars', 'fish_prosody', 'fish_chunk', 'media_type'],
})

const GSV = Object.freeze({
  id: 'gpt-sovits',
  label: 'GPT-SoVITS',
  param_keys: ['format', 'split', 'top_k', 'gpt_model', 'media_type'],
})

function engineDef () { return getDefinition('io.engine') }
function paramsDef () { return getDefinition('io.engine_params') }

function describe (def, engines) { return describeDefinition(def, { engines }) }
function paramNames (described) { return described.params.map(p => p.name) }
function param (described, name) { return described.params.find(p => p.name === name) }

// -- 引擎下拉框 -------------------------------------------------------------

test('2: 引擎下拉框列的是本机装了什么，不是写死的一张表', () => {
  const d = describe(engineDef(), [GSV, FISHTTS])
  const choices = param(d, 'engine_id').choices
  assert.deepEqual(choices.map(c => c.value), ['gpt-sovits', 'fishtts'],
    '下游作者放了一张名片进来，画布上就该能选到他 —— 选不到 = 插件做不出来')
  // 下拉框上显示的是名片写的展示名，不是目录名。
  assert.equal(choices[1].label.zh, 'FishTTS')
  assert.equal(choices[1].label.en, 'FishTTS')
})

test('2: 一台引擎都没装时，下拉框是空的而不是炸掉或凭空变出 gpt-sovits', () => {
  const d = describe(engineDef(), [])
  assert.deepEqual(param(d, 'engine_id').choices, [])
})

test('2: 引擎这一项的来源标成 engines，跟音色那一项同一个机制', () => {
  const d = describe(engineDef(), [GSV])
  assert.equal(param(d, 'engine_id').source, 'engines',
    '标了来源前端才知道这是服务器现算的列表，而不是一份固定选项')
})

test('2: 引擎节点的默认值是空，⛔ 不是写死的 gpt-sovits', () => {
  assert.equal(engineDef().params.engine_id, null,
    'lib/ 里不许出现引擎名（契约 §6）；留空表示「用名片上写 legacy_default 的那台」')
})

test('2: 引擎节点没选引擎时输出 null，把「认领人是谁」留给名片去答', async () => {
  const out = await engineDef().handler({ params: { voice: 'v1' } })
  assert.equal(out.outputs.engine.engine_id, null)
  // 而选了就原样带出去。
  const picked = await engineDef().handler({ params: { engine_id: 'fishtts', voice: 'v1' } })
  assert.equal(picked.outputs.engine.engine_id, 'fishtts')
})

// -- 引擎参数格子 -----------------------------------------------------------

test('2: 「引擎参数」节点自己不带任何参数名 —— 那张表已经不在代码里了', () => {
  assert.deepEqual(Object.keys(paramsDef().params), [],
    '写死一份参数清单 = 接第二个引擎必须改这个文件，正是契约 §8 要清的重复副本')
  assert.equal(paramsDef().dynamic_params, 'engine_union',
    '留一个记号说明这张表从哪来，别让它看起来像「忘了写」')
})

test('2: 装了 fishtts，画布上就长出 fishtts 名片声明的格子', () => {
  const names = paramNames(describe(paramsDef(), [GSV, FISHTTS]))
  assert.ok(names.includes('fish_prosody'), 'fishtts 的参数在画布上没有格子 = 这台引擎在工作流里没法调')
  assert.ok(names.includes('fish_chunk'))
  // 老引擎的格子一个都不能少。
  assert.ok(names.includes('top_k'))
  assert.ok(names.includes('gpt_model'))
})

test('2: 拔掉 fishtts，它的格子就跟着消失（表是现算的，不是攒出来的）', () => {
  const names = paramNames(describe(paramsDef(), [GSV]))
  assert.ok(!names.includes('fish_prosody'))
  assert.ok(names.includes('top_k'))
})

test('2: 两台引擎都声明的键只出一个格子，不重复', () => {
  const names = paramNames(describe(paramsDef(), [GSV, FISHTTS]))
  assert.equal(names.filter(n => n === 'media_type').length, 1)
})

test('2: 平台自己按次设定的键不给格子 —— 画布不许背着自己再切一次', () => {
  const names = paramNames(describe(paramsDef(), [GSV, FISHTTS]))
  for (const key of RESERVED_PARAM_KEYS) {
    assert.ok(!names.includes(key),
      `${key} 是平台每次自己设的；给了格子就意味着图能把 split 改回 true，` +
      '于是 broker 在背后再切一刀，画布上的循环次数不再对得上实际出了几段')
  }
  // 但它们确实写在名片的 param_keys 里 —— 这条测试防的正是「顺手全都放出来」。
  assert.ok(GSV.param_keys.includes('split'))
})

test('2: 每个格子都写清楚哪几台引擎接受它', () => {
  const d = describe(paramsDef(), [GSV, FISHTTS])
  const only = param(d, 'fish_prosody')
  assert.deepEqual(only.engines, ['fishtts'])
  assert.match(only.help.zh, /FishTTS/)
  assert.match(only.help.en, /FishTTS/)

  const shared = param(d, 'media_type')
  assert.deepEqual(shared.engines, ['gpt-sovits', 'fishtts'])
  assert.ok(!/FishTTS/.test(shared.help.zh),
    '所有引擎都接受时不该逐台点名，那只会把说明写成一串名字')
})

test('2: 没人手写过说明的键也有中英文两份文案，且老实承认平台不解释它', () => {
  const d = describe(paramsDef(), [GSV, FISHTTS])
  const p = param(d, 'fish_prosody')
  assert.ok(p.label.en && p.label.zh, '缺文案会让 docs.node.test.js 变红，也会让界面出现无名格子')
  assert.equal(p.label.en, 'fish_prosody', '没手写过就用键名本身，⛔ 不许平台替引擎瞎编含义')
  assert.match(p.help.zh, /名片/)
  assert.ok(p.help.en.includes(docs.GENERIC_ENGINE_PARAM_DOC.en.slice(0, 20)))
})

test('2: 手写过说明的键保留人话，只在后面补一句「哪几台认它」', () => {
  const d = describe(paramsDef(), [GSV, FISHTTS])
  const p = param(d, 'top_k')
  assert.match(p.help.zh, /采样候选数量/, '手写的人话被生成文案顶掉了')
  assert.match(p.help.zh, /GPT-SoVITS/)
})

test('2: 手写过说明的格子排在前面且保持原顺序，装一台新引擎不会把界面整个重排', () => {
  const before = paramNames(describe(paramsDef(), [GSV]))
  const after = paramNames(describe(paramsDef(), [GSV, FISHTTS]))
  const documented = Object.keys(docs.NODE_DOCS['io.engine_params'].params || {})
  const kept = documented.filter(k => before.includes(k))
  assert.deepEqual(before.slice(0, kept.length), kept)
  assert.deepEqual(after.slice(0, kept.length), kept, '装了新引擎后老格子换了位置 = 老用户找不到东西了')
})

test('2: 名片没声明的键不会凭空出现在画布上', () => {
  const names = paramNames(describe(paramsDef(), [FISHTTS]))
  assert.ok(!names.includes('top_k'),
    'fishtts 的图上出现 GPT-SoVITS 的 top_k 格子 = 填了就被 adapter 拦下，纯粹误导')
})

// -- 老图不能坏 -------------------------------------------------------------

test('2: 定义里不再列 top_k，已存盘的老图照样把 top_k 带着走', async () => {
  // engine.js 的合并方式是 Object.assign({}, def.params, node.params)：
  // 定义里那张表只提供默认值，节点自己存的值永远盖在上面。
  const merged = Object.assign({}, paramsDef().params, { top_k: 12, speed_factor: null })
  const out = await paramsDef().handler({ params: merged })
  assert.deepEqual(out.outputs.params, { top_k: 12 },
    '老图的参数丢了 = 清空表这一刀把别人已经画好的图改坏了')
})

// -- 守卫：这张表不许再长回代码里 -------------------------------------------

test('2: flowgraph 的节点定义里不许再出现任何引擎名或引擎私有参数名', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, 'nodes.js'), 'utf8')
  for (const banned of ['gpt-sovits', 'sovits_model', 'gpt_model', 'emo_alpha']) {
    assert.ok(!src.includes(`'${banned}'`),
      `nodes.js 里又写死了 ${banned} —— 这正是契约 §9 要清掉的那类硬编码`)
  }
})

test('2: 引擎下拉框的选项不许再写死在 docs.js 里', () => {
  const doc = docs.NODE_DOCS['io.engine'].params.engine_id
  assert.ok(!doc.choices,
    'choices 一旦写死，下游作者的引擎就永远进不了这个下拉框')
  assert.ok(!/gpt-sovits/i.test(docs.text(doc.help, '').zh + docs.text(doc.help, '').en),
    '说明里写着「目前仅实现 gpt-sovits」会劝退本来能成功的作者')
})
