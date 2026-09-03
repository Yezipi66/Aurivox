// ============================================================
//  界面按 manifest.json 长 —— 用一台假引擎验（契约 §11 判据 9 / 11）
// ============================================================
//
// 判据 9 的原文：「**装一个假引擎**（只有名片、不真出声）：界面能正常长出
// 它的参数面板，且**不显示训练页** —— 证明界面确实在按名片长，不是按 GSV 长」
//
// ⭐ 为什么必须是假引擎、必须不出声：
//    真引擎会出声，出声就说明不了问题 —— 界面渲染对了，可能是读了
//    manifest.json，也可能是它还在按 GPT-SoVITS 那套写死的知识渲染、而这台
//    引擎恰好长得像。两种情况读数一模一样。
//    假引擎的参数、档位、能力全都跟现有两台不一样，界面但凡有一处还写死，
//    它当场就长歪。**这是一个有可能失败的实验。**
//
// ⚠ 这里测的是「面板里该有哪些格子、各自什么形状」，不是像素。
//    jsdom 在这个测试环境里跑不起来（node --test 不经 vite），所以把这些判断
//    全部关在纯函数里，才有会红的测试可写。真正的最后一道闸仍然是
//    `cd web && npm run build` + 真机点一遍。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  pickEngine,
  showsTrainingTab,
  fieldsForTier,
  schemaGap,
  initialParamValues,
  coerceParamValue,
  pathFields,
  paramsToSend,
  fieldLabel,
  fieldHelp,
  hasMappedKey,
  TIERS,
} from './engines.js'

// ------------------------------------------------------------
//  一台假引擎：只有 manifest.json，不真出声。
//
//  ⭐ 刻意跟盘上两台**处处不一样**：参数名没有一个重合、档位分布不同、
//     枚举值不同、supports_finetune 是 false。
//     界面上但凡还留着一处 GPT-SoVITS 的痕迹，这台引擎都会长歪。
// ------------------------------------------------------------
const FAKE = {
  id: 'silent-fake',
  label: 'Silent Fake',
  managed: false,
  base_url: 'http://127.0.0.1:59999',
  requires_reference_audio: false,
  reference_clip_seconds: null,
  max_chars: 7,
  hard_max_chars: 13,
  output_sample_rate: 8000,
  hot_swap_models: false,
  streaming: false,
  // 判据 11 的关键一格。
  supports_finetune: false,
  param_schema: [
    {
      name: 'wobble',
      type: 'number',
      default: 0.5,
      sends_always: true,
      min: 0,
      max: 1,
      step: 0.1,
      tier: 'common',
      label: { en: 'Wobble', zh: '抖动' },
      help: { en: 'How much wobble.', zh: '抖多少。' },
    },
    {
      name: 'flavour',
      type: 'enum',
      default: 'salty',
      sends_always: true,
      choices: [
        { value: 'salty', label: { en: 'Salty', zh: '咸' } },
        { value: 'sweet', label: { en: 'Sweet', zh: '甜' } },
      ],
      tier: 'common',
      label: { en: 'Flavour', zh: '口味' },
    },
    {
      name: 'goose_count',
      type: 'integer',
      default: 3,
      sends_always: false,
      min: 1,
      max: 9,
      step: 1,
      tier: 'advanced',
      label: { en: 'Goose Count', zh: '鹅数' },
    },
    {
      name: 'upside_down',
      type: 'boolean',
      default: false,
      sends_always: false,
      tier: 'advanced',
      label: { en: 'Upside Down', zh: '倒过来' },
    },
  ],
  param_keys: ['wobble', 'flavour', 'goose_count', 'upside_down'],
}

// 一台什么都不一样的第二台，用来验「选谁」这件事不带偏见。
const OTHER = {
  id: 'other-fake',
  label: 'Other Fake',
  supports_finetune: true,
  param_schema: [],
  param_keys: [],
}

// ============================================================
//  判据 9 上半句：界面能长出它的参数面板
// ============================================================

test('判据9：假引擎的参数面板，格子是从 manifest.json 里长出来的', () => {
  const common = fieldsForTier(FAKE, 'common')
  const advanced = fieldsForTier(FAKE, 'advanced')

  assert.deepEqual(common.map(f => f.name), ['wobble', 'flavour'])
  assert.deepEqual(advanced.map(f => f.name), ['goose_count', 'upside_down'])
})

test('判据9：面板上不该出现任何这张 manifest.json 没写的格子', () => {
  const all = TIERS.flatMap(t => fieldsForTier(FAKE, t)).map(f => f.name)
  assert.deepEqual([...all].sort(), [...FAKE.param_keys].sort())

  // ⭐ 反面：GPT-SoVITS 那几个手写死的参数，一个都不许漏进来。
  //   ⛔ 这不是在点名某台引擎 —— 是在证明「面板不是按谁长的」。
  for (const leaked of ['temperature', 'top_k', 'top_p', 'repetition_penalty', 'text_split_method']) {
    assert.ok(!all.includes(leaked), `假引擎的面板里冒出了 ${leaked}，说明界面还在按别的引擎长`)
  }
})

test('判据9：格子的初值来自 manifest.json 的 default', () => {
  assert.deepEqual(initialParamValues(FAKE), {
    wobble: 0.5,
    flavour: 'salty',
    goose_count: 3,
    upside_down: false,
  })
})

test('判据9：格子的名字和说明取自 manifest.json，跟着界面语言走', () => {
  const wobble = fieldsForTier(FAKE, 'common')[0]
  assert.equal(fieldLabel(wobble, 'zh'), '抖动')
  assert.equal(fieldLabel(wobble, 'en'), 'Wobble')
  assert.equal(fieldHelp(wobble, 'zh'), '抖多少。')
})

test('名片没写 label 就退到键名，⛔ 不能是空白格子', () => {
  assert.equal(fieldLabel({ name: 'bare' }, 'zh'), 'bare')
  // 说明可以没有，名字不行。
  assert.equal(fieldHelp({ name: 'bare' }, 'zh'), '')
})

test('名片只写了一种语言时，退到英文而不是留空', () => {
  const f = { name: 'x', label: { en: 'Only English' } }
  assert.equal(fieldLabel(f, 'zh'), 'Only English')
})

// ============================================================
//  判据 11：训练页只对 supports_finetune: true 显示
// ============================================================

test('判据11：假引擎 supports_finetune 是 false ⇒ 不显示训练页', () => {
  assert.equal(showsTrainingTab(FAKE), false)
})

test('判据11：写了 true 的引擎才显示训练页', () => {
  assert.equal(showsTrainingTab(OTHER), true)
})

test('判据11：还没选出引擎时不显示 —— 少显示可以刷新，多显示会让人白填一张表', () => {
  assert.equal(showsTrainingTab(null), false)
  assert.equal(showsTrainingTab(undefined), false)
})

test('判据11：⛔ 名片没写 supports_finetune 不等于支持', () => {
  assert.equal(showsTrainingTab({ id: 'x' }), false)
  // 也不接受「像 true 的东西」——只认布尔真值。
  assert.equal(showsTrainingTab({ id: 'x', supports_finetune: 'true' }), false)
  assert.equal(showsTrainingTab({ id: 'x', supports_finetune: 1 }), false)
})

// ============================================================
//  选哪一台
// ============================================================

test('上次选的那台还在，就还选它', () => {
  assert.equal(pickEngine([OTHER, FAKE], 'silent-fake').id, 'silent-fake')
})

test('上次选的那台不在了（比如卸了），退到列表第一台', () => {
  assert.equal(pickEngine([OTHER, FAKE], 'engine-that-was-removed').id, 'other-fake')
})

test('一台都没装时返回 null，⛔ 不返回一个编出来的默认 id', () => {
  assert.equal(pickEngine([], 'anything'), null)
  assert.equal(pickEngine(null, null), null)
})

// ============================================================
//  param_schema 是空的：说清是哪一种空
// ============================================================

test('名片没写 params.schema 但有 param_keys ⇒ 说出来，不画一个空面板', () => {
  const gap = schemaGap({ id: 'quiet', param_schema: [], param_keys: ['a', 'b', 'c'] })
  assert.ok(gap, '真机上确实有这种引擎，静默画空面板会让人以为它调不了')
  assert.equal(gap.param_key_count, 3)
  // 提示里要说清去改哪个文件 —— ⛔ 不能只说「暂无参数」。
  assert.ok(gap.message.includes('manifest.json'))
  assert.ok(gap.message.includes('params.schema'))
})

test('两样都空 = 这台引擎真的没参数，不提示', () => {
  assert.equal(schemaGap({ id: 'q', param_schema: [], param_keys: [] }), null)
})

test('schema 写了就不提示', () => {
  assert.equal(schemaGap(FAKE), null)
})

// ============================================================
//  值的类型：界面收到的是字符串，引擎要的是数
// ============================================================

test('数字格子把字符串翻成数', () => {
  const f = { type: 'number', default: 0.5 }
  assert.equal(coerceParamValue(f, '0.75'), 0.75)
})

test('整数格子不许把 3.7 塞过去', () => {
  const f = { type: 'integer', default: 3 }
  assert.equal(coerceParamValue(f, '5'), 5)
  assert.equal(coerceParamValue(f, '3.7'), 3)
})

test('⛔ 输入框清空的一瞬间不能变成 0 —— 那跟「用户特意设成 0」长得一样', () => {
  const f = { type: 'number', default: 0.5 }
  assert.equal(coerceParamValue(f, ''), 0.5)
  assert.equal(coerceParamValue(f, 'abc'), 0.5)
})

test('枚举只认 manifest.json 列出的选项', () => {
  const f = fieldsForTier(FAKE, 'common')[1]
  assert.equal(coerceParamValue(f, 'sweet'), 'sweet')
  assert.equal(coerceParamValue(f, 'umami'), 'salty', '没列出来的值要退回 default，不能原样发给引擎')
})

test('布尔格子', () => {
  const f = { type: 'boolean', default: false }
  assert.equal(coerceParamValue(f, true), true)
  assert.equal(coerceParamValue(f, 'true'), true)
  assert.equal(coerceParamValue(f, false), false)
})

// ============================================================
//  发出去的请求体
// ============================================================

test('UI 建议值不等于调用默认值：完全没动过就一个键都不发', () => {
  const sent = paramsToSend(FAKE, initialParamValues(FAKE), new Set())
  assert.deepEqual(sent, {})
})

test('用户明确动过的值才发，包括 false 和 0', () => {
  const values = { ...initialParamValues(FAKE), goose_count: 0, enabled: false }
  const engine = { ...FAKE, param_schema: [
    ...FAKE.param_schema,
    { name: 'enabled', type: 'boolean', default: true },
  ] }
  const sent = paramsToSend(engine, values, new Set(['goose_count', 'enabled']))
  assert.deepEqual(sent, { goose_count: 0, enabled: false })
})

test('当前模式隐藏的参数保留在 UI 状态中但不发送', () => {
  const engine = { id: 'modeful', param_schema: [
    { name: 'mode', type: 'select' },
    { name: 'prompt_text', type: 'text', only_when: { mode: 'zero_shot' } },
  ] }
  const values = { mode: 'preset', prompt_text: 'keep for later' }
  const sent = paramsToSend(engine, values, new Set(['mode', 'prompt_text']))
  assert.deepEqual(sent, { mode: 'preset' })
  assert.equal(values.prompt_text, 'keep for later')
})

test('⛔ 名片不认识的键一律不发 —— 服务端会静默忽略，表现是「我明明调了却没效果」', () => {
  const sent = paramsToSend(FAKE, { ...initialParamValues(FAKE), temperature: 1.0, made_up: 9 }, new Set(['made_up']))
  assert.ok(!('temperature' in sent))
  assert.ok(!('made_up' in sent))
})

// ============================================================
//  引擎列表还没回来的那一瞬间
// ============================================================
//
// 界面的第一帧一定走这条路（engine 是 null）。这几条不是补齐覆盖率 ——
// GenerateTab 里每一个函数都会在第一帧被调用一次，任何一个在 null 上炸掉，
// 整张页面就是白屏，而且只在冷启动时出现。

test('engine 是 null 时，面板长不出格子，但也不许炸', () => {
  for (const nothing of [null, undefined]) {
    assert.deepEqual(fieldsForTier(nothing, 'common'), [])
    assert.deepEqual(fieldsForTier(nothing, 'advanced'), [])
    assert.deepEqual(initialParamValues(nothing), {})
    assert.deepEqual(paramsToSend(nothing, { a: 1 }, new Set(['a'])), {})
    assert.equal(showsTrainingTab(nothing), false)
  }
})

test('engine 是 null 时不提示「名片没写 schema」—— 那会冤枉一张还没读到的名片', () => {
  assert.equal(schemaGap(null), null)
  assert.equal(schemaGap(undefined), null)
})

test('问一个不存在的档位，返回空而不是全部', () => {
  assert.deepEqual(fieldsForTier(FAKE, 'nonexistent-tier'), [])
})

test('名片没写 tier 的参数落进 advanced，⛔ 不是凭空消失', () => {
  // 规则跟后端 lib/engines/profile.js:556 是同一条。
  // ⚠ 这条一开始是红的：前端写的是 `f.tier === tier`，没写 tier 的参数
  //   在两档里同时查无此格 —— 名片作者写了一格，界面上怎么也找不到。
  const e = { id: 'x', param_schema: [{ name: 'lonely', type: 'number', default: 1 }], param_keys: ['lonely'] }
  assert.deepEqual(fieldsForTier(e, 'common').map(f => f.name), [])
  assert.deepEqual(fieldsForTier(e, 'advanced').map(f => f.name), ['lonely'])
  const all = TIERS.flatMap(t => fieldsForTier(e, t)).map(f => f.name)
  assert.deepEqual(all, ['lonely'], '每个参数必须**恰好**出现在一档里，不能重复也不能掉出去')
})

test('每个参数恰好出现一次 —— 重复出现和消失一样糟', () => {
  const all = TIERS.flatMap(t => fieldsForTier(FAKE, t)).map(f => f.name)
  assert.equal(new Set(all).size, all.length, '有参数同时长在两档里')
  assert.equal(all.length, FAKE.param_schema.length)
})

// ============================================================
//  这个文件自己的守卫
// ============================================================

test('⛔ engines.js 里不许出现任何具体引擎的名字', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, 'engines.js'), 'utf-8')
  // 只看代码，注释里可以举例说明（注释是写给加引擎的人看的）。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !l.trim().startsWith('//')).join('\n')
  for (const name of ['gpt-sovits', 'gpt_sovits', 'GPT-SoVITS', 'indextts', 'IndexTTS']) {
    assert.ok(!code.includes(name),
      `engines.js 的代码里出现了 ${name}。界面按 manifest.json 长，就不该认识任何一台具体引擎`)
  }
  // 参数名同理：写死一个参数名就等于写死了一台引擎的形状。
  for (const p of ['temperature', 'top_k', 'sovits', 'text_split_method']) {
    assert.ok(!code.includes(p), `engines.js 的代码里出现了参数名 ${p}`)
  }
})


// ---- type: path —— 「这个参数的值是一个文件」 ------------------------------
//
// 这一种是 2026-08-29 加的。它替掉的是「平台认识什么是权重」这件事：
// 以前平台知道有 GPT 和 SoVITS 两个槽（个数写死是 2、名字写死、还要配对），
// 现在它只知道「这一格的值是一个文件」，有几格、叫什么全由引擎自己说。

const FILEY = {
  id: 'filey-fake',
  label: 'Filey',
  param_schema: [
    { name: 'brain_file', type: 'path', default: '', tier: 'common', sends_always: false,
      label: { en: 'Brain file', zh: '脑子文件' } },
    { name: 'voice_file', type: 'path', default: '', tier: 'advanced', sends_always: false },
    { name: 'wobble', type: 'number', default: 0.5, tier: 'common', sends_always: true },
  ],
}

const FILELESS = {
  id: 'fileless-fake',
  label: 'Fileless',
  param_schema: [
    { name: 'wobble', type: 'number', default: 0.5, tier: 'common', sends_always: true },
  ],
}

test('需要挑文件的引擎，认得出它有哪几格是文件', () => {
  assert.deepEqual(pathFields(FILEY).map(f => f.name), ['brain_file', 'voice_file'])
})

test('⭐ 不需要挑文件的引擎，一格都不长', () => {
  assert.deepEqual(pathFields(FILELESS), [])
  assert.deepEqual(pathFields(null), [])
  assert.deepEqual(pathFields({}), [])
})

test('⭐ 个数不是 2 也完全正常 —— 平台不许对个数有任何期待', () => {
  const one = { id: 'one', param_schema: [{ name: 'only_file', type: 'path', default: '', tier: 'common' }] }
  assert.equal(pathFields(one).length, 1)
})

test('文件格子照样按档位分屏，跟别的格子一视同仁', () => {
  assert.ok(fieldsForTier(FILEY, 'common').some(f => f.name === 'brain_file'))
  assert.ok(fieldsForTier(FILEY, 'advanced').some(f => f.name === 'voice_file'))
})

test('清空一个文件格子，就是清空 —— ⛔ 不许弹回默认值', () => {
  // 这是用户表达「这一项我不要」的唯一方式。退回默认值等于他清不掉。
  const f = { name: 'brain_file', type: 'path', default: 'D:/预设.ckpt' }
  assert.equal(coerceParamValue(f, ''), '')
  assert.equal(coerceParamValue(f, null), '')
  assert.equal(coerceParamValue(f, undefined), '')
})

test('文件格子收字符串，也收配方里那种 {base, path} 形状', () => {
  const f = { name: 'brain_file', type: 'path', default: '' }
  assert.equal(coerceParamValue(f, 'D:/模型/a.ckpt'), 'D:/模型/a.ckpt')
  assert.deepEqual(coerceParamValue(f, { base: 'asset', path: 'x/a.ckpt' }),
    { base: 'asset', path: 'x/a.ckpt' })
})

test('⛔ 空着的文件格子不发这个键 —— 更不能发一个空字符串', () => {
  // 发空字符串的话，引擎会拿它当路径去开文件，报出来的错跟用户做的事对不上。
  const sent = paramsToSend(FILEY,
    { brain_file: '', voice_file: 'D:/b.pt', wobble: 0.5 },
    new Set(['brain_file', 'voice_file']))
  assert.ok(!('brain_file' in sent), '空的文件格子被发出去了')
  assert.equal(sent.voice_file, 'D:/b.pt')
})

test('填了的文件格子，值原样发出去 —— 平台不改写路径', () => {
  const sent = paramsToSend(FILEY, { brain_file: 'D:/模型/a.ckpt' }, new Set(['brain_file']))
  assert.equal(sent.brain_file, 'D:/模型/a.ckpt')
})

test('文件格子的初值也来自 manifest，不是界面自己编的', () => {
  assert.equal(initialParamValues(FILEY).brain_file, '')
})

// ------------------------------------------------------------
//  平台的词：名片 maps 铺了映射，那一格才长得出来
// ------------------------------------------------------------
//
// ⭐ 跟上面所有测试问的不是同一件事：
//     param_schema  引擎自己的参数 —— Advanced Settings 里那一袋，平台不认识
//     mapped_keys   平台的词（参考音频 / 参考转写 / 语种 / 辅助参考…）
//
//   后者不是引擎参数，永远不会出现在 param_schema 里，所以「按 schema 循环长
//   格子」这条路**管不到它** —— 这些格子此前是无条件画出来的。
//
//   真机实据：盘上两台引擎的 maps 一台 10 条、一台 4 条，后者没有辅助参考音频
//   那一条。而界面照样画着那个多选器：用户选得出来，值在拼请求体时被静默丢掉，
//   没有任何提示。
const MAPPED = { id: 'mapped-fake', mapped_keys: ['text', 'reference_audio', 'aux_reference_audio'] }
const BARE = { id: 'bare-fake', mapped_keys: ['text', 'reference_audio'] }

test('名片铺了这条映射 ⇒ 这一格长出来', () => {
  assert.equal(hasMappedKey(MAPPED, 'aux_reference_audio'), true)
})

test('名片没铺这条映射 ⇒ 这一格不长 —— ⛔ 不画一个发不出去的控件', () => {
  assert.equal(hasMappedKey(BARE, 'aux_reference_audio'), false)
  assert.equal(hasMappedKey(BARE, 'reference_text'), false)
})

test('两台引擎问同一个词，答案可以不同 —— 这正是「换引擎 = 换页面」', () => {
  assert.notEqual(
    hasMappedKey(MAPPED, 'aux_reference_audio'),
    hasMappedKey(BARE, 'aux_reference_audio'))
})

test('⭐ 名单没回来时 fail-open：跟今天一模一样，不凭空少格子', () => {
  // 旧后端不吐 mapped_keys、engine 还没读出来，都会走到这里。
  // 坏法不对称：多画一格 = 现状；少画一格 = 控件凭空消失且不报错。
  assert.equal(hasMappedKey(null, 'aux_reference_audio'), true)
  assert.equal(hasMappedKey({ id: 'old-backend' }, 'aux_reference_audio'), true)
  assert.equal(hasMappedKey({ id: 'junk', mapped_keys: 'nope' }, 'aux_reference_audio'), true)
})

test('⛔ 空名单是「一条都没铺」，不是「没回来」', () => {
  // [] 和 undefined 必须分开：前者是名片真的一条映射都没写。
  assert.equal(hasMappedKey({ id: 'empty', mapped_keys: [] }, 'text'), false)
})

// ============================================================
//  五种预设样式 —— 前端这一侧（2026-08-29）
// ============================================================
//
// ⛔⛔ 这一组存在的理由是**供给侧改了消费侧没跟上**那类事故：
//   后端把 `enum` 正名成 `select`、`path` 正名成 `file` 之后，前端这边如果
//   还只认老词，`coerceParamValue` 会掉进 `default:` 分支原样返回 ——
//   用户填的东西看起来好好的，发出去却是个字符串 '0.7' 或者干脆没发。
//   ⭐ 症状是「我明明调了却没效果」，**不报错**。
//
// ⇒ 五种样式每一种都要有一条会红的判据，⛔ 不用循环写：
//   循环写的话删掉一个分支只红一条，会被当成「边角坏了」而不是
//   「一整种类型没接上」。

test('五种样式：前端和后端是同一张表', async () => {
  const { PARAM_TYPES } = await import('./engines.js')
  // 后端那半边是 CommonJS，⛔ 不能直接 import
  const { createRequire } = await import('node:module')
  const back = createRequire(import.meta.url)('../../../lib/engines/paramTypes.js')
  assert.deepEqual(PARAM_TYPES, back.PARAM_TYPES,
    '前后端的类型表分叉了 —— 后端收得下、前端画不出的格子不会报错')
})

test('老名字前端也必须认得（缓存下来的旧 param_schema 会带着它们进来）', async () => {
  const { canonicalType } = await import('./engines.js')
  assert.equal(canonicalType('integer'), 'number')
  assert.equal(canonicalType('enum'), 'select')
  assert.equal(canonicalType('path'), 'file')
  assert.equal(canonicalType('string'), 'text')
  assert.equal(canonicalType('bool'), 'boolean')
})

test('① text：⛔ 不 trim 不截断 —— 用户打的空格可能就是他要的', async () => {
  const { coerceParamValue } = await import('./engines.js')
  const f = { name: 'p', type: 'text', default: '' }
  assert.equal(coerceParamValue(f, '  轻声细语  '), '  轻声细语  ')
  assert.equal(coerceParamValue(f, ''), '')
})

test('② number：int 那一味丢了，7.5 会悄悄发给只吃整数的引擎', async () => {
  const { coerceParamValue } = await import('./engines.js')
  assert.equal(coerceParamValue({ type: 'number', default: 1 }, '7.5'), 7.5)
  assert.equal(coerceParamValue({ type: 'number', int: true, default: 1 }, '7.5'), 7)
  assert.equal(coerceParamValue({ type: 'integer', default: 1 }, '7.9'), 7)
  // 输入框清空的一瞬间是 ''，⛔ 不能变成 0 —— 那跟「用户特意设成 0」一样
  assert.equal(coerceParamValue({ type: 'number', default: 1 }, ''), 1)
})

test('③ select：写死选项要卡，平台扫盘的一律放行', async () => {
  const { coerceParamValue } = await import('./engines.js')
  const fixed = { type: 'select', choices: [{ value: 'a' }, { value: 'b' }], default: 'a' }
  assert.equal(coerceParamValue(fixed, 'b'), 'b')
  assert.equal(coerceParamValue(fixed, 'zzz'), 'a')
  // 裸字符串的 choices 也要认（名片作者的第一直觉）
  assert.equal(coerceParamValue({ type: 'select', choices: ['a', 'b'], default: 'a' }, 'b'), 'b')
  // ⭐ source：有哪些要运行时扫盘才知道。拿一份可能过期的名单去卡，
  //   症状是「我明明选了它却没生效」，还不报错。
  const scanned = { type: 'select', source: 'audio', default: '' }
  assert.equal(coerceParamValue(scanned, '/a/whatever.wav'), '/a/whatever.wav')
  // allow_custom：名片明说了库里没有的也让填
  assert.equal(coerceParamValue({ type: 'select', choices: ['a'], allow_custom: true, default: '' }, 'zzz'), 'zzz')
})

test('④ boolean：只有真的 true 才是 true', async () => {
  const { coerceParamValue } = await import('./engines.js')
  const f = { type: 'boolean', default: false }
  assert.equal(coerceParamValue(f, true), true)
  assert.equal(coerceParamValue(f, 'true'), true)
  assert.equal(coerceParamValue(f, false), false)
  assert.equal(coerceParamValue(f, 'false'), false)
})

test('⑤ file：清空就是清空，⛔ 不许弹回默认值', async () => {
  const { coerceParamValue, isPathField } = await import('./engines.js')
  const f = { type: 'file', default: 'D:\\a.ckpt' }
  // 「清空这一格」是用户表达「这一项我不要」的唯一方式
  assert.equal(coerceParamValue(f, ''), '')
  // {base, path} 那种形状原样收下 —— 解析是 pathResolver 的活
  assert.deepEqual(coerceParamValue(f, { base: 'models', path: 'x.ckpt' }), { base: 'models', path: 'x.ckpt' })
  assert.equal(isPathField(f), true)
  assert.equal(isPathField({ type: 'path' }), true, '老名片写 path，前端也得画成文件格子')
  // ⚠ 「从平台库里挑」不是 file，是 select + source
  assert.equal(isPathField({ type: 'select', source: 'audio' }), false)
})

test('⭐ repeat：一排 N 个，长度对不上整条不要', async () => {
  const { coerceParamValue, repeatOf } = await import('./engines.js')
  const f = { type: 'number', repeat: 8, default: [0, 0, 0, 0, 0, 0, 0, 0] }
  assert.equal(repeatOf(f), 8)
  assert.deepEqual(coerceParamValue(f, ['1', '0', '0', '0', '0', '0', '0', '0.5']),
    [1, 0, 0, 0, 0, 0, 0, 0.5])
  // ⛔ 长度不对整条退回默认：发一条长度对不上的数组给引擎多半不报错，
  //   只是声音不对 —— 那比报错难查得多。
  assert.deepEqual(coerceParamValue(f, [1, 2]), f.default)
  assert.deepEqual(coerceParamValue(f, 0.5), f.default)
})

test('⛔ repeat 不写 / 写 1 ⇒ 是标量，不是长度 1 的数组', async () => {
  const { coerceParamValue, repeatOf } = await import('./engines.js')
  // 「一格」和「一格但装在数组里」发给引擎是两件事，而且一路不报错
  assert.equal(repeatOf({ type: 'number' }), 1)
  assert.equal(repeatOf({ type: 'number', repeat: 1 }), 1)
  assert.equal(coerceParamValue({ type: 'number', default: 0 }, '0.7'), 0.7)
})

test('⭐ multi vs repeat：几项由谁说了算', async () => {
  const { coerceParamValue, wantsArray } = await import('./engines.js')
  // multi 的长度由**用户**定，⛔ 不校验长度
  const multi = { type: 'select', source: 'audio', multi: true, default: [] }
  assert.equal(wantsArray(multi), true)
  assert.deepEqual(coerceParamValue(multi, ['a.wav', 'b.wav', 'c.wav']), ['a.wav', 'b.wav', 'c.wav'])
  assert.deepEqual(coerceParamValue(multi, ['a.wav']), ['a.wav'])
})

test('⭐⭐ only_when 是 fail-open：引用一个不存在的键，格子照常显示', async () => {
  const { isFieldVisible } = await import('./engines.js')
  const f = { name: 'emo_text', only_when: { use_emo_text: true } }
  assert.equal(isFieldVisible(f, { use_emo_text: true }), true)
  assert.equal(isFieldVisible(f, { use_emo_text: false }), false)
  // ⛔ 名片作者拼错一个键名 ⇒ 照常显示。多画一格他一眼看得见；
  //   少画一格他找不到，而且没有任何报错 —— 后者坏得多。
  //   ⚠ 与 showsTrainingTab 的 fail-closed 相反，是故意的。
  assert.equal(isFieldVisible(f, {}), true)
  assert.equal(isFieldVisible({ name: 'x' }, {}), true)
})

// ------------------------------------------------------------
//  「能不能换」不再决定「给不给看」
// ------------------------------------------------------------
test('⛔⛔ 不许再有"换不了就把下拉藏掉"这个函数', async () => {
  const mod = await import('./engines.js')
  // ⭐⭐ 2026-08-30 删。它拿「**能不能热换**」决定「**给不给选**」——
  //   这两件事没有关系。一台启动时装权重的引擎，盘上照样躺着好几个模型，
  //   把清单藏掉等于对用户说"你没有模型"，而这正是这轮要修的痛点本身。
  // ⭐ 现在的做法：候选照样列出来；**选中的那一份发不发得出去**，由名片
  //   在每个模型位上写没写"用哪个参数名发"来决定（见 modelPickers 那一层）。
  assert.equal(mod.showsModelPickers, undefined,
    'showsModelPickers 又回来了 —— 它把"装载方式"当成了"存在性"')
})

test('⭐ 三张真名片都不再写那个引擎级的是非题，改成逐位说清换法', async () => {
  const { createRequire } = await import('node:module')
  const require_ = createRequire(import.meta.url)
  const fs = require_('node:fs')
  const path = require_('node:path')
  const { ENGINES_DIR } = require_('../../../lib/paths.js')
  // ⭐⭐⭐ 这条测试上一轮断言的正好**相反**（"三张真名片都还写着它"）。
  //   翻过来是因为那一位 2026-08-30 退休了：「能不能换一份模型」是**每个模型
  //   位各自的事**，硬提到引擎级之后，一台引擎两个位、一个一次调用能换一个
  //   要重开进程时，那一位没有正确答案 —— 那正是"下拉能选、声音不变、还不
  //   报错"的根。
  // ⚠ 平台对**别人的**老名片仍然照装（不麻烦上游作者是硬约束）；这里管的是
  //   我们自己盘上这两张，它们必须做示范，⛔ 不许留着一个已死的字段给人抄。
  //   _TEMPLATE 已在 c3f0ae8 随旧契约一起退役，不再遍历。
  for (const id of ['gpt-sovits', 'indextts2']) {
    const p = path.join(ENGINES_DIR, id, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(p, 'utf8'))
    assert.ok(!('hot_swap_models' in (m.capabilities || {})),
      `${id} 的名片还写着已经退休的 hot_swap_models —— 别人会照着抄`)
    // 有模型位的，每个位都必须说清换它走哪一步。
    // ⚠ weights 有两种合法写法：一张位的清单，或者只写个数（_TEMPLATE 写的是
    //   `"weights": 1`）。只写个数的没有位可查，跳过 —— ⛔ 别当成"没有位"。
    for (const w of (Array.isArray(m.weights) ? m.weights : [])) {
      const appliesAt = w.applies_at || (w.param ? 'call' : 'launch')
      assert.ok(appliesAt === 'launch' || appliesAt === 'call',
        `${id} 的模型位 ${w.name} 没说清换它要走哪一步`)
    }
  }
})

// ===========================================================================
//  进程徽章（契约 §12 第 5 步）
// ===========================================================================
// ⭐⭐⭐ 这一组测试盯的全是**说错话**，不是算错数。
//   这块代码算不出错 —— 它只是把服务端已经算完的东西翻成一句人话。
//   能出的错只有一种：**把三种"没在跑"说成同一句**，然后让人去点一个
//   不存在的启动按钮、或者以为一台好好的引擎挂了。

test('⛔⛔ 不管进程的机器不画徽章 —— ⛔ 不许说成"停着"', async () => {
  const { processBadge } = await import('./engines.js')
  // process === null 的意思是「这台机器不管引擎进程」（后端没装看管人），
  // ⛔ 不是「没在跑」。画成"停着"会让人去找一个根本不存在的启动按钮。
  assert.equal(processBadge({ id: 'x', process: null }), null)
  assert.equal(processBadge({ id: 'x' }), null, '字段缺席和 null 必须一样对待')
  assert.equal(processBadge(null), null, '列表还没回来')
})

test('⭐⭐ 没在跑要说"待命"，⛔ 不许是红的', async () => {
  const { processBadge } = await import('./engines.js')
  const b = processBadge({ id: 'x', online: false, process: { running: false } })
  // ⭐ 判据：这是新架构下的**正常状态**，不是故障。
  //   tone 一旦是 'bad'，用户每天开机都会看见一排红灯，然后学会无视所有红灯 ——
  //   包括真出事那次。
  assert.equal(b.tone, 'idle')
  assert.notEqual(b.tone, 'bad')
  assert.match(b.title, /正常/, '必须明说这是正常的，否则"待命"两个字还是像故障')
  assert.match(b.title, /自动/, '必须明说下次会自己起来，否则人会去找启动按钮')
})

test('⭐⭐ 引擎在跑但不是我们起的，必须单独说 —— 这是开发机的日常', async () => {
  const { processBadge } = await import('./engines.js')
  // ⛔ online 和 process 有意不合并：合并了这个状态就没法表达。
  const b = processBadge({ id: 'x', online: true, process: { running: false } })
  assert.equal(b.tone, 'unknown')
  assert.match(b.label, /外部/)
  assert.match(b.title, /不会去停它/, '必须告诉人平台不会插手，否则他不知道该信谁')
})

test('⭐⭐⭐ 正在装模型那几十秒必须盖过一切 —— 这是唯一会让人以为卡死的时刻', async () => {
  const { processBadge } = await import('./engines.js')
  // 换一次模型 = 带着新权重把进程整个重开，6 GB 起步。
  // 界面不吭声的话，正常人的反应是再点一次 —— 于是排队更长、更像卡死。
  const b = processBadge({
    id: 'x',
    process: { running: true, pid: 42, phase: 'launching', busy: true, launch_key: 'a' },
  })
  assert.equal(b.tone, 'busy')
  assert.match(b.label, /启动中/)
  // ⭐ phase 必须优先于 busy：两个都为真时，人需要知道的是"在装模型"，
  //   而不是"在合成" —— 后者会让他觉得马上就好。
  assert.doesNotMatch(b.label, /合成/)
  assert.match(b.title, /不用再点/, '这一句就是这个徽章存在的全部理由')
})

test('phase 到了 ready 就不再喊启动中', async () => {
  const { processBadge } = await import('./engines.js')
  const b = processBadge({ id: 'x', process: { running: true, pid: 7, phase: 'ready' } })
  assert.equal(b.tone, 'ok')
  assert.match(b.label, /在跑/)
})

test('⭐ 现在装的是哪一份模型必须写在悬停里 —— 这是换模型唯一看得见的证据', async () => {
  const { processBadge } = await import('./engines.js')
  const b = processBadge({
    id: 'x',
    process: { running: true, pid: 9, phase: 'ready', launch_key: 'indextts2::mymodel' },
  })
  // ⭐ 在这之前，"我选的模型到底装进去了没有"只能靠听声音猜 ——
  //   而选了不生效且不报错，正是这一轮要修的痛点本身。
  assert.match(b.title, /mymodel/)
})

test('正在合成', async () => {
  const { processBadge } = await import('./engines.js')
  const b = processBadge({ id: 'x', process: { running: true, pid: 3, busy: true } })
  assert.equal(b.tone, 'busy')
  assert.match(b.label, /合成中/)
})

test('英文也得说得出这几句', async () => {
  const { processBadge } = await import('./engines.js')
  // ⚠ 只断言"不含中文"，⛔ 不断言具体英文措辞 —— 那种断言只会锁死文案。
  const cases = [
    { online: false, process: { running: false } },
    { online: true, process: { running: false } },
    { process: { running: true, phase: 'launching' } },
    { process: { running: true, busy: true } },
    { process: { running: true } },
  ]
  for (const e of cases) {
    const b = processBadge(Object.assign({ id: 'x' }, e), 'en')
    assert.ok(b, '每一种状态英文下都得有话说')
    assert.doesNotMatch(b.label, /[\u4e00-\u9fa5]/, `英文徽章里混进了中文：${b.label}`)
    assert.doesNotMatch(b.title, /[\u4e00-\u9fa5]/, `英文悬停里混进了中文：${b.title}`)
  }
})

test('⭐⭐⭐ 进程状态没变时，必须原样把旧数组还回去', async () => {
  const { mergeProcessState } = await import('./engines.js')
  // ⭐ 这是这个函数的全部意义。服务端每次都吐一个**新的** process 对象，
  //   所以引用比较永远说"变了"。判据必须是内容。
  //   还不回旧数组的话，每 8 秒产出一个新数组 ⇒ 所有 useEffect([engines])
  //   跟着重跑 ⇒ 整棵树每 8 秒重画一遍。
  const engines = [{ id: 'a', label: 'A', process: { running: true, pid: 1 } }]
  const fresh = [{ id: 'a', process: { running: true, pid: 1 } }] // 内容一样，对象不同
  assert.equal(mergeProcessState(engines, fresh), engines, '同一个数组都没还回来')
})

test('⭐⭐ 变了就更新，且只动 process 一个字段', async () => {
  const { mergeProcessState } = await import('./engines.js')
  const engines = [{ id: 'a', label: '原来的名字', params: { schema: [1] }, process: { running: false } }]
  const out = mergeProcessState(engines, [
    { id: 'a', label: '新名字', params: { schema: [] }, process: { running: true, pid: 9 } },
  ])
  assert.notEqual(out, engines)
  assert.equal(out[0].process.pid, 9)
  // ⛔ 名片和参数表一概不采纳 —— 那是另一件事。混进来会让用户填了一半的
  //   参数面板在轮询到的某一秒被换掉。
  assert.equal(out[0].label, '原来的名字')
  assert.deepEqual(out[0].params.schema, [1])
})

test('⭐ 只有变了的那台换身份，没变的那几台原样带过去', async () => {
  const { mergeProcessState } = await import('./engines.js')
  const a = { id: 'a', process: { running: true } }
  const b = { id: 'b', process: { running: false } }
  const out = mergeProcessState([a, b], [
    { id: 'a', process: { running: true } },
    { id: 'b', process: { running: true, pid: 3 } },
  ])
  assert.equal(out[0], a, '没变的那台不该换对象')
  assert.notEqual(out[1], b)
})

test('⚠ 新列表里没提到的引擎原样留着 —— ⛔ 不许翻成"停着"', async () => {
  const { mergeProcessState } = await import('./engines.js')
  // 一次拉取漏掉某台（并发装卸、或者后端半路出错）不代表它停了。
  const engines = [{ id: 'a', process: { running: true, pid: 1 } }]
  assert.equal(mergeProcessState(engines, []), engines)
})

test('⚠ 拿到不是数组的东西时不许炸，也不许清空', async () => {
  const { mergeProcessState } = await import('./engines.js')
  const engines = [{ id: 'a', process: { running: true } }]
  assert.equal(mergeProcessState(engines, null), engines)
  assert.equal(mergeProcessState(engines, undefined), engines)
  assert.equal(mergeProcessState(null, []), null)
})

test('不管进程的机器：process 从有到 null 也算变化', async () => {
  const { mergeProcessState } = await import('./engines.js')
  const engines = [{ id: 'a', process: { running: true } }]
  const out = mergeProcessState(engines, [{ id: 'a', process: null }])
  assert.notEqual(out, engines)
  assert.equal(out[0].process, null)
})

// ============================================================
//  合并成一枚的引擎徽章（2026-08-30）
// ============================================================
//
// Owner：「你现在右上角的指示灯越来越多了，是非常不好的兆头…你再加是想变成
//   飞机仪表盘嘛」。三枚（底模齐 / 进程 / Connected）并成一枚。
//
// ⭐⭐⭐ 下面第二条是这一组里唯一真正重要的：**待命绝不许画成红的**。
//   引擎改成「用到才起」之后，「没在跑」是设计如此、是常态；老那枚
//   Connected/Unreachable 在这个世界里天天红 —— 而一枚天天红的灯的唯一效果
//   是训练人忽略所有红灯，包括真的那次。

const CK_OK = { declared: true, ready: true, abs_path: 'D:/x/checkpoints' }
const CK_BAD = { declared: true, ready: false, abs_path: 'D:/x/checkpoints', missing: ['config.yaml', 'bpe.model'] }

test('引擎还没读出来 ⇒ 不画，⛔ 不画成离线', async () => {
  const { engineBadge } = await import('./engines.js')
  assert.equal(engineBadge(null, { engine_online: false }), null)
})

test('⭐⭐⭐ 待命是灰的，⛔ 绝不许是红的（按需起停之后「没在跑」是常态）', async () => {
  const { engineBadge } = await import('./engines.js')
  const b = engineBadge(
    { id: 'indextts2', label: 'IndexTTS2', checkpoints: CK_OK, online: false, process: { running: false } },
    { engine_online: false },
  )
  assert.equal(b.tone, 'idle', '待命画成 bad ⇒ 每天一排红灯 ⇒ 学会无视所有红灯')
  assert.ok(b.label.includes('IndexTTS2'))
  assert.ok(b.label.includes('待命'))
  assert.ok(/正常/.test(b.title), '悬停必须明说这是正常的')
})

test('底模缺 ⇒ 红，且盖过进程状态（你不动手它永远起不来）', async () => {
  const { engineBadge } = await import('./engines.js')
  const b = engineBadge(
    { id: 'e', label: 'E', checkpoints: CK_BAD, online: false, process: { running: false } },
    { engine_online: false },
  )
  assert.equal(b.tone, 'bad')
  assert.ok(b.label.includes('底模缺 2'))
  assert.ok(b.title.includes('D:/x/checkpoints'), '悬停必须给出该往哪儿放')
})

test('⭐ 底模齐不再占灯面，但必须还在悬停里', async () => {
  const { engineBadge } = await import('./engines.js')
  const b = engineBadge(
    { id: 'e', label: 'E', checkpoints: CK_OK, online: true, process: { running: true, pid: 42 } },
    { engine_online: true },
  )
  assert.equal(b.tone, 'ok')
  assert.ok(!b.label.includes('底模齐'), '永远绿的灯不携带信息 ⇒ 不占格子')
  assert.ok(b.title.includes('D:/x/checkpoints'), '⛔ 但不许连悬停一起丢掉')
})

test('⭐⭐⭐ 启动中 ⇒ 橙，且悬停里那句「不用再点一次」必须还在', async () => {
  const { engineBadge } = await import('./engines.js')
  const b = engineBadge(
    { id: 'e', label: 'E', checkpoints: CK_OK, online: false, process: { running: true, phase: 'loading', launch_key: 'Akafuyu/model/v2' } },
    { engine_online: false },
  )
  assert.equal(b.tone, 'busy')
  assert.ok(b.label.includes('启动中'))
  assert.ok(b.title.includes('不用再点一次'), '这句话是这枚灯存在的全部理由')
  assert.ok(b.title.includes('Akafuyu/model/v2'), '现在装的是哪一份 —— A 那件事唯一看得见的证据')
})

test('合成中 ⇒ 橙', async () => {
  const { engineBadge } = await import('./engines.js')
  const b = engineBadge(
    { id: 'e', label: 'E', checkpoints: CK_OK, online: true, process: { running: true, busy: true } },
    { engine_online: true },
  )
  assert.equal(b.tone, 'busy')
  assert.ok(b.label.includes('合成中'))
})

test('不是本平台起的 ⇒ 说出来，⛔ 不合并成「在跑」', async () => {
  const { engineBadge } = await import('./engines.js')
  const b = engineBadge(
    { id: 'e', label: 'E', checkpoints: CK_OK, online: true, process: { running: false } },
    { engine_online: true },
  )
  assert.ok(b.label.includes('外部进程'))
})

// ⭐⭐⭐ 2026-08-30 刀 4：下面两条原本钉的是「老那套 Connected/Unreachable
//   一个字没丢」。⛔ 不是为了让测试变绿才翻 —— 它钉住的是一个**错形状**：
//   engine_online = 往某个端口探一下活。端口是第六项：推理只需要
//   输入+参数+权重+环境，端口是 HTTP 外壳的产物。一台用命令行跑的引擎
//   （大多数）在这枚灯下永远显示"连不上"，而它其实好好的。
//   而且引擎是**用完即走的进程**，"它现在在不在线"根本是个不存在的问题。
//   ⇒ 现在断言的是它的反面：**平台不管进程时，不许画任何在线状态**。
test('⭐⭐⭐ 不管进程的机器：⛔ 不许画在线/离线 —— 那问的是不存在的问题', async () => {
  const { engineBadge } = await import('./engines.js')
  for (const health of [{ engine_online: true }, { engine_online: false }, null]) {
    const b = engineBadge({ id: 'e', label: 'E', checkpoints: CK_OK, process: null }, health)
    assert.equal(b.tone, 'idle', '⛔ 平台不知道 ≠ 引擎坏了；不知道就别画红也别画绿')
    assert.equal(b.label, 'E', '⛔ 灯面上不许出现"已连接/连不上"这类探活结论')
    assert.ok(!/已连接|连不上|connected|unreachable/i.test(b.label + b.title))
  }
})

test('⛔ engineBadge 整个函数里不许再读 engine_online', async () => {
  const fs = await import('node:fs')
  const url = await import('node:url')
  const p = url.fileURLToPath(new URL('./engines.js', import.meta.url))
  const src = fs.readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.equal((src.match(/engine_online/g) || []).length, 0,
    '⛔ 端口探活的结论不许再进任何一枚灯')
})

test('⛔ 顶栏关于当前引擎只许有一枚灯', async () => {
  const fs = await import('node:fs')
  const url = await import('node:url')
  const p = url.fileURLToPath(new URL('../App.jsx', import.meta.url))
  // ⭐ 先剥注释再找 —— 这个仓库栽过两次「守卫在注释里为真」。
  const src = fs.readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  const n = (re) => (src.match(re) || []).length
  assert.equal(n(/engineBadge\s*\(/g), 1, '引擎徽章只许出现一次')
  assert.equal(n(/checkpointBadge\s*\(/g), 0, '底模已并进 engineBadge，⛔ 不许再单独画一枚')
  assert.equal(n(/processBadge\s*\(/g), 0, '进程已并进 engineBadge，⛔ 不许再单独画一枚')
  assert.equal(n(/engine_online\s*\?/g), 0, '⛔ 不许再有一枚直接读 engine_online 的灯 —— 那枚在按需起停之后天天红')
})

test('⭐ 平台不认识任何一种业务身份', async () => {
  const { PARAM_TYPES } = await import('./engines.js')
  // 五种样式里没有「权重」「参考音频」「情绪」。
  // IndexTTS2 的情绪参考音频和 GSV 的辅助参考音频走的是同一段代码。
  for (const t of PARAM_TYPES) {
    assert.ok(!/weight|ckpt|ref|emo|voice|model/.test(t),
      `${t} 是一个业务身份，不是一种样式 —— 平台一旦认识它，就得替所有引擎维护它`)
  }
})
