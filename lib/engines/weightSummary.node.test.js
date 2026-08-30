'use strict'

// 守卫：「这一次用的是哪几份模型」这句话，必须由名片说，⛔ 不是平台说。
//
// 病历见 lib/engines/weightSummary.js 顶上：Recent Generations 对一条
// IndexTTS2 的记录印出「GPT - / SoVITS -」—— 位名写死、位数写死成 2。
//
// ⭐ 这个文件里的用例**一台真引擎都不用**：位表是参数。一个函数只有在
//   "喂它没见过的形状"时才证明得了通用性；拿盘上那两台去测，测到的是
//   "对这两台为真"，正是造出这个 bug 的那种知识。

const test = require('node:test')
const assert = require('node:assert')

const { weightSummary, baseNameOf, storedGeneration } = require('./weightSummary')

// --------------------------------------------------------------------------

test('位的个数由名片说：0 个 / 1 个 / 3 个都要写得出来', () => {
  assert.deepEqual(weightSummary([], {}), [], '没有位就是空表，不是两个空位')

  const one = weightSummary(
    [{ name: 'model', label: 'Model', applies_at: 'launch' }],
    { launch_weights: { model: 'D:/p/checkpoints' } })
  assert.equal(one.length, 1)
  assert.deepEqual(one[0], { name: 'model', label: 'Model', value: 'checkpoints', path: 'D:/p/checkpoints' })

  const three = weightSummary(
    [{ name: 'a', label: 'A', param: 'a_model' },
     { name: 'b', label: 'B', param: 'b_model' },
     { name: 'c', label: 'C', applies_at: 'launch' }],
    { a_model: '/x/a.ckpt', b_model: '/x/b.pth', launch_weights: { c: '/x/c' } })
  assert.deepEqual(three.map((w) => w.value), ['a.ckpt', 'b.pth', 'c'])
})

test('⭐ 两个来源都要读：一次调用能换的位读参数名，开进程吃进去的位读 launch_weights', () => {
  const slots = [
    { name: 'call_slot', label: 'Call', param: 'some_param', applies_at: 'call' },
    { name: 'launch_slot', label: 'Launch', applies_at: 'launch' },
  ]
  // 只读参数名的话，第二个位永远是空 —— IndexTTS2 那种"位全在 launch 上"
  // 的引擎会得到一整张空表，症状从"写死的横杠"变成"一个横杠都没有"。
  const out = weightSummary(slots, { some_param: '/m/x.ckpt', launch_weights: { launch_slot: '/m/dir' } })
  assert.equal(out[0].path, '/m/x.ckpt')
  assert.equal(out[1].path, '/m/dir', 'launch 位必须从 launch_weights 里读')
})

test('⛔ 没选的位不许从表里消失 —— 空串，位还在', () => {
  const out = weightSummary(
    [{ name: 'gpt', label: 'GPT', param: 'gpt_model' },
     { name: 'sovits', label: 'SoVITS', param: 'sovits_model' }],
    {})
  assert.equal(out.length, 2)
  for (const w of out) {
    assert.equal(w.value, '')
    assert.equal(w.path, '')
    assert.ok(w.label, '空位也得有显示名')
  }
})

test('位没写 label 就用位名兜底（⛔ 平台不给位起名字）', () => {
  const out = weightSummary([{ name: 'weird_slot' }], { launch_weights: { weird_slot: '/m/f.bin' } })
  assert.equal(out[0].label, 'weird_slot')
})

test('⚠ 目录位：结尾的分隔符要先削掉，否则短名会是空串', () => {
  assert.equal(baseNameOf('D:\\p\\checkpoints\\'), 'checkpoints')
  assert.equal(baseNameOf('/p/checkpoints//'), 'checkpoints')
  assert.equal(baseNameOf('D:\\m\\GPT_x.ckpt'), 'GPT_x.ckpt', '反斜杠也要吃')
  assert.equal(baseNameOf(''), '')
  assert.equal(baseNameOf(null), '')
  assert.equal(baseNameOf(undefined), '')
})

test('坏形状不许把整条合成带崩：位表不是数组 / 位缺 name / launch_weights 是数组', () => {
  assert.deepEqual(weightSummary(null, {}), [])
  assert.deepEqual(weightSummary(undefined, undefined), [])
  assert.deepEqual(weightSummary([null, {}, { name: '' }], {}), [], '缺 name 的位直接跳过')
  const out = weightSummary([{ name: 'a', applies_at: 'launch' }], { launch_weights: ['x'] })
  assert.equal(out[0].path, '', '数组不是位名表，不许当对象读')
})

// ---- storedGeneration：**已经躺在盘上**的记录怎么描述 -----------------------
//
// Owner 2026-08-31：「那你这个元数据不就炸了？我都不知道是哪个模型生成的。
// 名片上不是有 engine_id 嘛？**有没有可能我是想不用硬编码**？」
// 老条目的信息一直都在 meta.recipe 里（原样的请求体），第一版是我把它扔了。

const CARD_TWO_CALL_SLOTS = {          // 两个位、都能一次调用换（有 param）
  id: 'engine-a', label: '引擎甲',
  weight_slots: [
    { name: 'first', label: '第一位', param: 'first_model', applies_at: 'call' },
    { name: 'second', label: '第二位', param: 'second_model', applies_at: 'call' },
  ],
}
const CARD_ONE_LAUNCH_SLOT = {         // 一个位、开进程时吃进去（没 param）
  id: 'engine-b', label: '引擎乙',
  weight_slots: [{ name: 'whole', label: '整包', applies_at: 'launch' }],
}
const resolve = (id) => {
  if (id === 'engine-a') return CARD_TWO_CALL_SLOTS
  if (id === 'engine-b') return CARD_ONE_LAUNCH_SLOT
  throw new Error(`Unknown engine: ${id}`)   // 真的 resolveEngineProfile 就是抛
}

test('新条目：写盘时已按名片算好 ⇒ 原样用，⛔ 不重新查名片', () => {
  const got = storedGeneration({
    engine_id: 'engine-a', engine_label: '引擎甲',
    weights: [{ name: 'first', label: '第一位', value: 'x.pth', path: '/m/x.pth' }],
    recipe: { engine_id: 'engine-a', first_model: '/m/CHANGED.pth' },
  }, resolve)
  assert.equal(got.weights[0].value, 'x.pth',
    '这条记录说的是**当时**用了什么；名片和请求今天变了也不许改写历史')
})

test('⭐⭐ 老条目（没有 weights）：拿 recipe.engine_id 查名片，把值从 recipe 里捡出来', () => {
  const got = storedGeneration({
    recipe: { engine_id: 'engine-b', launch_weights: { whole: 'D:/models/thing/checkpoints' } },
  }, resolve)
  assert.equal(got.engine_id, 'engine-b')
  assert.equal(got.engine_label, '引擎乙', '引擎的显示名由名片说')
  assert.deepEqual(got.weights.map((w) => [w.label, w.value]), [['整包', 'checkpoints']])
})

test('⭐⭐ 老条目的另一种：位在 recipe 的参数里（applies_at: call）', () => {
  const got = storedGeneration({
    recipe: { engine_id: 'engine-a', first_model: 'a/one.ckpt', second_model: 'b/two.pth' },
  }, resolve)
  assert.deepEqual(got.weights.map((w) => `${w.label} ${w.value}`), ['第一位 one.ckpt', '第二位 two.pth'])
})

test('老条目、位没选满 ⇒ 位还在，值是空的（⛔ 位不许从行里消失）', () => {
  const got = storedGeneration({ recipe: { engine_id: 'engine-a', first_model: 'a/one.ckpt' } }, resolve)
  assert.deepEqual(got.weights.map((w) => w.value), ['one.ckpt', ''])
})

test('⭐ 名片今天不在了（引擎被删/改名）⇒ 仍然说出 engine_id，位表为空', () => {
  const got = storedGeneration({ recipe: { engine_id: 'engine-gone' } }, resolve)
  assert.deepEqual(got, { engine_id: 'engine-gone', engine_label: 'engine-gone', weights: [] })
})

test('⛔ 真的什么都没有（连 recipe.engine_id 都没有）才是空的', () => {
  assert.deepEqual(storedGeneration({ recipe: { text: 'hi' } }, resolve),
    { engine_id: '', engine_label: '', weights: [] })
  assert.deepEqual(storedGeneration(null, resolve), { engine_id: '', engine_label: '', weights: [] })
  assert.deepEqual(storedGeneration({ recipe: ['not', 'an', 'object'] }, resolve),
    { engine_id: '', engine_label: '', weights: [] })
})

test('没给 resolve 函数也不许炸（历史列表一条坏记录不能带崩整页）', () => {
  const got = storedGeneration({ recipe: { engine_id: 'engine-a' } }, undefined)
  assert.deepEqual(got, { engine_id: 'engine-a', engine_label: 'engine-a', weights: [] })
})

test('⛔⛔ 本文件不提任何引擎、任何位名 —— 提了就说明这份知识又被写死进了平台', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'weightSummary.js'), 'utf8')
  // 只看代码，注释里讲病历必须能提（否则没人知道这个文件为什么存在）。
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  for (const word of ['gpt', 'sovits', 'indextts', 'GPT', 'SoVITS', 'IndexTTS']) {
    assert.ok(!code.toLowerCase().includes(word.toLowerCase()),
      `weightSummary.js 的代码里出现了 "${word}" —— 位名/引擎名只能来自名片`)
  }
})
