'use strict'

// ---------------------------------------------------------------------------
//  五种预设样式 —— 声明侧 + 收取侧，每一种都要有judgement
// ---------------------------------------------------------------------------
//
// ⛔⛔ 这个文件存在的理由是一次真事故：
//
//   2026-08-29 加 'path' 那一刀，声明侧写了 6 条判据（名片说得出「我有个参数
//   值是文件」、个数不限、默认值必须有、必须先在 param_keys 里声明过…），
//   **收取侧一条都没有**。而 coerceIncoming 当时只有 integer / number /
//   boolean / enum 四个分支，path 落到函数末尾的 `return undefined`。
//
//   ⇒ 名片声明得了、前端画得出格子、用户填得进值，然后那个值**在平台里被
//     无声丢掉**。症状是「我明明选了权重，它却没换」，而且不报错。
//
//   声明侧全绿、收取侧全空 —— 这就是「测了一半」长什么样。
//
// ⇒ 从今天起，五种样式**每一种**都要有一条会红的收取侧判据。
//   判据的判据（变异）：把 coerceScalar 里任何一个分支删掉，本文件必须变红。
//   ⛔ 不许用「五种一起过一遍」的循环写法 —— 那样删掉一个分支只红一条，
//     而红的那条会被当成「改坏了一个边角」，不是「一整种类型没接上」。

const test = require('node:test')
const assert = require('node:assert')

const { coerceIncoming } = require('./paramTable')
const { canonicalType, repeatOf, PARAM_TYPES, TYPE_ALIASES } = require('./paramTypes')

// ───────────────────────────────────────────────────────────────────────
//  类型表本身
// ───────────────────────────────────────────────────────────────────────

test('五种预设样式，一个不多一个不少', () => {
  // Owner 2026-08-29 定的。⛔ 想加第六种之前先回去看 paramTypes.js 的文件头：
  //   「向量」不是类型（是 repeat）、「情绪参考音频」不是类型（是名片给格子起的名字）。
  assert.deepEqual(PARAM_TYPES, ['text', 'number', 'select', 'boolean', 'file'])
})

test('老名字全部折进五种之一，⛔ 一个都不许漏到出口', () => {
  assert.equal(canonicalType('integer'), 'number')
  assert.equal(canonicalType('enum'), 'select')
  assert.equal(canonicalType('path'), 'file')
  assert.equal(canonicalType('string'), 'text')
  // 折完必须落在五种里 —— 否则下游又要认两套词
  for (const legacy of Object.keys(TYPE_ALIASES)) {
    assert.ok(PARAM_TYPES.includes(canonicalType(legacy)), `${legacy} 折出了五种之外的东西`)
  }
  // 不认识的就是不认识，⛔ 不猜
  assert.equal(canonicalType('filepath'), null)
  assert.equal(canonicalType('vector'), null)
  assert.equal(canonicalType(undefined), null)
})

// ───────────────────────────────────────────────────────────────────────
//  收取侧：五种，一种一条
// ───────────────────────────────────────────────────────────────────────

test('收取侧 ①文本：用户打的字原样收下', () => {
  const f = { name: 'a', type: 'text' }
  assert.equal(coerceIncoming(f, 'hello'), 'hello')
  // ⛔ 不 trim、不截断、不做换行归一 —— 平台是搬运工，不是翻译。
  assert.equal(coerceIncoming(f, '  两边有空格  '), '  两边有空格  ')
  assert.equal(coerceIncoming(f, 'a\nb'), 'a\nb')
  // 没填还是没填
  assert.equal(coerceIncoming(f, ''), undefined)
  assert.equal(coerceIncoming(f, undefined), undefined)
  // ⚠ 老词 string 走同一条路
  assert.equal(coerceIncoming({ name: 'a', type: 'string' }, 'hi'), 'hi')
})

test('收取侧 ②数字：转得成就是数，转不成当没填', () => {
  const f = { name: 'a', type: 'number' }
  assert.equal(coerceIncoming(f, '0.85'), 0.85)
  assert.equal(coerceIncoming(f, 3), 3)
  assert.equal(coerceIncoming(f, 'abc'), undefined)
  assert.equal(coerceIncoming(f, ''), undefined)
  // 0 是有效值，⛔ 不许被当成没填
  assert.equal(coerceIncoming(f, '0'), 0)
})

test('收取侧 ②b 数字的整数那一味：7.5 不许悄悄发给只吃整数的引擎', () => {
  // 「是不是整数」不是第六种样式，是数字的一味。⛔ 丢了它不报错，
  //   只是引擎那边收到一个它不该收到的小数。
  const asInt = { name: 'a', type: 'number', int: true }
  assert.equal(coerceIncoming(asInt, '7'), 7)
  assert.equal(coerceIncoming(asInt, '7.5'), 7)
  // 名片还写着老词 integer 的（缓存下来的旧 param_schema）也要认
  assert.equal(coerceIncoming({ name: 'a', type: 'integer' }, '7.5'), 7)
  // 对照组：不是整数那一味的，7.5 就是 7.5
  assert.equal(coerceIncoming({ name: 'a', type: 'number' }, '7.5'), 7.5)
})

test('收取侧 ③下拉：名片写死的选项只收在册的', () => {
  const f = { name: 'a', type: 'select', choices: [{ value: 'x' }, { value: 'y' }] }
  assert.equal(coerceIncoming(f, 'x'), 'x')
  assert.equal(coerceIncoming(f, 'zzz'), undefined)
  // ⚠ 老词 enum 走同一条路
  assert.equal(coerceIncoming({ name: 'a', type: 'enum', choices: [{ value: 'x' }] }, 'x'), 'x')
})

test('收取侧 ③b 下拉的选项来自平台托管库时一律放行', () => {
  // ⭐ 有哪些要运行时扫盘才知道，而扫盘结果随时在变（用户刚训出来的音色）。
  //   在这儿拿一份旧名单去卡，症状会是「我明明选了它却没生效」，还不报错。
  const f = { name: 'a', type: 'select', source: 'voices' }
  assert.equal(coerceIncoming(f, 'assets/新音色/ref.wav'), 'assets/新音色/ref.wav')
  // 托管路径那种 { base, path } 形状也收（pathResolver 按形状工作）
  const managed = { base: 'asset', path: 'v/models/x.ckpt' }
  assert.deepEqual(coerceIncoming(f, managed), managed)
  assert.equal(coerceIncoming(f, ''), undefined)
})

test('收取侧 ③c 下拉开了 allow_custom：库里没有的也收', () => {
  const strict = { name: 'a', type: 'select', choices: [{ value: 'x' }] }
  const loose = { name: 'a', type: 'select', choices: [{ value: 'x' }], allow_custom: true }
  assert.equal(coerceIncoming(strict, 'D:/我自己的/weird.ckpt'), undefined)
  assert.equal(coerceIncoming(loose, 'D:/我自己的/weird.ckpt'), 'D:/我自己的/weird.ckpt')
})

test('收取侧 ④勾选：false 是值，不是没填', () => {
  const f = { name: 'a', type: 'boolean' }
  assert.equal(coerceIncoming(f, 'true'), true)
  assert.equal(coerceIncoming(f, '1'), true)
  assert.equal(coerceIncoming(f, 'false'), false)
  assert.equal(coerceIncoming(f, '0'), false)
  assert.equal(coerceIncoming(f, true), true)
  assert.equal(coerceIncoming(f, false), false)
  assert.equal(coerceIncoming(f, 'yes'), undefined)
})

test('收取侧 ⑤路径：两种形状都收，⛔ 只判形状不判存在', () => {
  const f = { name: 'a', type: 'file' }
  assert.equal(coerceIncoming(f, 'D:/models/gpt.ckpt'), 'D:/models/gpt.ckpt')
  const managed = { base: 'asset', path: 'v/models/x.ckpt' }
  assert.deepEqual(coerceIncoming(f, managed), managed)
  // 文件在不在、后缀对不对，都不是平台的事 —— 它不认识这个文件是什么
  assert.equal(coerceIncoming(f, '/根本不存在/x.bin'), '/根本不存在/x.bin')
  assert.equal(coerceIncoming(f, { base: 'asset', path: '' }), undefined)
  assert.equal(coerceIncoming(f, {}), undefined)
  assert.equal(coerceIncoming(f, ''), undefined)
  // ⚠ 老词 path 走同一条路
  assert.equal(coerceIncoming({ name: 'a', type: 'path' }, 'x.ckpt'), 'x.ckpt')
})

test('⛔ 名片没说清是哪一种 ⇒ 不收，绝不猜', () => {
  assert.equal(coerceIncoming({ name: 'a', type: 'vector' }, '0.5'), undefined)
  assert.equal(coerceIncoming({ name: 'a' }, '0.5'), undefined)
  assert.equal(coerceIncoming(null, '0.5'), undefined)
})

// ───────────────────────────────────────────────────────────────────────
//  repeat / multi：正交修饰，不是第六种类型
// ───────────────────────────────────────────────────────────────────────

test('repeat 不写 / 写 1 ⇒ 标量，⛔ 不是长度 1 的数组', () => {
  // 「一格」和「一格但装在数组里」发给引擎是两件事，而这个差别一路都不报错。
  assert.equal(repeatOf({}), 1)
  assert.equal(repeatOf({ repeat: 1 }), 1)
  assert.equal(coerceIncoming({ name: 'a', type: 'number' }, '0.5'), 0.5)
  assert.equal(coerceIncoming({ name: 'a', type: 'number', repeat: 1 }, '0.5'), 0.5)
})

test('⭐ repeat N ⇒ 值是一排；维数对不上整条不要', () => {
  // 八维情绪向量 = 数字 × repeat 8。⛔ 平台不认识「情绪有几维」——
  //   它只知道名片说了 8 格，那就必须来 8 个。
  const v8 = { name: 'emo', type: 'number', repeat: 8 }
  const eight = ['0', '0.1', '0', '0', '0', '0', '0', '0.9']
  assert.deepEqual(coerceIncoming(v8, eight), [0, 0.1, 0, 0, 0, 0, 0, 0.9])
  // ⛔ 不补零、不截断：少一维发过去，引擎多半照收，然后声音不对而没人知道
  assert.equal(coerceIncoming(v8, ['0.1']), undefined)
  assert.equal(coerceIncoming(v8, new Array(9).fill('0')), undefined)
  // 排里混进一个转不成的 ⇒ 整条不要，⛔ 不是把那一格悄悄换成 0
  assert.equal(coerceIncoming(v8, ['a', '0', '0', '0', '0', '0', '0', '0']), undefined)
  // 给了个标量 ⇒ 不收（不替名片把一个数摊成一排）
  assert.equal(coerceIncoming(v8, '0.5'), undefined)
})

test('⭐ multi：勾几项由用户定，长度不限', () => {
  // 辅助参考音频 = 下拉(平台音频库) × multi。跟 repeat 不是一回事：
  //   multi   几项由**用户**定
  //   repeat  几格由**名片**定死
  const f = { name: 'aux', type: 'select', source: 'audio', multi: true }
  assert.deepEqual(coerceIncoming(f, ['a.wav', 'b.wav', 'c.wav']), ['a.wav', 'b.wav', 'c.wav'])
  assert.deepEqual(coerceIncoming(f, ['a.wav']), ['a.wav'])
  assert.equal(coerceIncoming(f, []), undefined)
  assert.equal(coerceIncoming(f, 'a.wav'), undefined)
})

test('⭐ GSV 的辅助参考音频和 IndexTTS2 的情绪参考音频是同一个原语', () => {
  // Owner 2026-08-29 原话：「本质上是同一个输入」。
  // 判据：两台引擎各写各的名字，平台这边走的是**同一段代码**。
  const gsvAux = { name: 'aux_ref_audio_paths', type: 'select', source: 'audio', multi: true }
  const idxEmo = { name: 'emo_audio_prompt', type: 'select', source: 'audio', multi: true }
  assert.deepEqual(coerceIncoming(gsvAux, ['x.wav']), coerceIncoming(idxEmo, ['x.wav']))
  // ⛔ 平台没有「情绪参考音频」这种类型 —— 那是名片给格子起的名字
  assert.ok(!PARAM_TYPES.some(t => /emo|audio|ref/.test(t)))
})

// ---------------------------------------------------------------------------
//  模板本身必须是活的
// ---------------------------------------------------------------------------
//
// ⛔ engines/_TEMPLATE/manifest.json 是接入者**唯一会照抄的东西**，但它不在
//   registry 里（目录名以 _ 开头，registry.js 跳过），所以平时一条测试都跑不到
//   它 —— 它可以坏很久没人知道，而坏掉的形式是「照着模板写的名片装不上」。
//
// ⇒ 下面两条把模板拉回测试范围：它要解析得动，而且五种样式一种都不能少
//   （少一种，接入者就永远不知道平台支持那一种）。
test('⭐ 模板名片解析得动，而且五种样式一个都不缺', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { parseParamSchema } = require('./profile')
  // ⭐ 路径走 lib/paths.js 的 ENGINES_DIR，⛔ 不自己拼 __dirname/../../engines
  //   （硬约束：路径只有一个权威来源）
  const { ENGINES_DIR } = require('../paths')

  const file = path.join(ENGINES_DIR, '_TEMPLATE', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))

  // 解析得动 —— 抛出来就是模板坏了，照抄的人也会一样地坏
  const schema = parseParamSchema(manifest, manifest.defaults || {}, '_TEMPLATE')

  const types = new Set(schema.map(f => f.type))
  for (const t of PARAM_TYPES) {
    assert.ok(types.has(t),
      `模板里没有一个 ${t} 类型的样例格子 —— 接入者照抄模板就永远不会知道平台支持 ${t}`)
  }
  // repeat 是修饰不是类型，但同样只有模板写了别人才会用
  assert.ok(schema.some(f => f.repeat > 1), '模板里没有 repeat 的样例')
})

test('⭐ choices 写一串裸字符串也收得进来', () => {
  // 写 ["natural","news"] 是每个人的第一直觉。⛔ 因为「必须是对象」把这种
  // 名片挡在门外，代价不是作者被教育了一下，是他的引擎装不上。
  const { parseParamSchema } = require('./profile')
  const manifest = {
    id: 't',
    param_keys: ['style'],
    params: { schema: { style: { type: 'select', choices: ['natural', 'news'], default: 'news' } } }
  }
  const [f] = parseParamSchema(manifest, {}, 't')
  assert.deepEqual(f.choices, [
    { value: 'natural', label: 'natural' },
    { value: 'news', label: 'news' }
  ])
})
