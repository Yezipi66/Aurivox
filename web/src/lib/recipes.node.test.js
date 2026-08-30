// 配方存取这条路，用一台**假引擎**走一遍。
//
// 要守的那句话（用户能观察到的）：
//   「存一个配方，关掉，再打开 —— 每一格都还在原来的值上。」
// 不管是哪台引擎。
//
// 这条路 2026-08-29 之前是断的，而且断得无声：存进去了，打开时读不回来，
// 界面上不报错，参数悄悄变回默认值。原因是这个模块当年把 GPT-SoVITS 的
// 二十来个参数名写死在了一行里。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { recipeToGenerateParams, recipeParamBag, recipePath, recipeWeightPreview } from './recipes.js'

// 一台假引擎。参数名故意跟盘上任何一台都不重合 —— 只要这些值能原样往返，
// 就说明这个模块真的不认识键名。
const FAKE = 'silent-fake'
const FAKE_PARAMS = {
  wobble: 0.42,
  flavour: 'umami',
  goose_count: 7,
  upside_down: true,
}

function v4Recipe(extra = {}) {
  return {
    id: 'fake/calm',
    role: 'fake',
    name: 'calm',
    schema_version: 4,
    engine_id: FAKE,
    language: 'zh',
    reference_audio: { base: 'asset', path: 'fake/ref.wav' },
    reference_text: '参考文本',
    params: { seed: 1234 },
    engine_params: { [FAKE]: { ...FAKE_PARAMS } },
    gpt_ckpt: '',
    sovits_pth: '',
    ...extra,
  }
}

test('存进去的参数，打开配方时一个不少地回来', () => {
  const out = recipeToGenerateParams(v4Recipe(), '正文', FAKE)
  for (const [k, v] of Object.entries(FAKE_PARAMS)) {
    assert.equal(out[k], v, `${k} 没有回来 —— 用户会看到这一格变回默认值，且没有任何提示`)
  }
})

test('平台自己的通用键也回来（seed 存在 params 里，不在引擎格子里）', () => {
  const out = recipeToGenerateParams(v4Recipe(), '正文', FAKE)
  assert.equal(out.seed, 1234)
})

test('引擎格子压过 params —— 同一个键两边都有时以引擎格子为准', () => {
  // 后端为兼容仍会往 params 里写一份。两份漂了的时候，权威是引擎格子。
  const r = v4Recipe({ params: { seed: 1234, wobble: 999 } })
  assert.equal(recipeToGenerateParams(r, '', FAKE).wobble, 0.42)
})

test('没说是哪台引擎时，退到配方自己记的那台', () => {
  const out = recipeToGenerateParams(v4Recipe(), '', '')
  assert.equal(out.wobble, 0.42)
})

test('引擎未知时后端收进的 _unassigned 占位格，也读得回来', () => {
  // recipeStore 在 engine_id 为空时把参数收进 "_unassigned"。那批值不能丢。
  const r = v4Recipe({ engine_id: '', engine_params: { _unassigned: { ...FAKE_PARAMS } } })
  assert.equal(recipeToGenerateParams(r, '', FAKE).goose_count, 7)
})

test('v3 老配方（根本没有 engine_params）仍然读得回来', () => {
  const r = {
    id: 'x/y', role: 'x', schema_version: 3, language: 'ja',
    reference_audio: 'assets/x/ref.wav',
    params: { top_k: 20, temperature: 0.8, speed: 1.2, seed: -1 },
  }
  const out = recipeToGenerateParams(r, '', FAKE)
  assert.equal(out.top_k, 20)
  assert.equal(out.temperature, 0.8)
  // v3 存的是平台通用的 speed；老引擎界面上那一格叫 speed_factor。
  assert.equal(out.speed_factor, 1.2, 'v3 配方的语速丢了')
})

test('新配方里引擎自己的语速键不会被兼容那一条盖掉', () => {
  const r = v4Recipe({ engine_params: { [FAKE]: { speed: 9, speed_factor: 1.5 } } })
  assert.equal(recipeToGenerateParams(r, '', FAKE).speed_factor, 1.5)
})

test('平台自己那几样：路径要解析，缺省要给空容器不能给 undefined', () => {
  const out = recipeToGenerateParams(v4Recipe(), '正文', FAKE)
  assert.equal(out.ref_audio, 'assets/fake/ref.wav')
  assert.equal(out.reference_text, '参考文本')
  assert.equal(out.text_lang, 'zh')
  assert.equal(out.voice, 'fake')
  assert.equal(out.text, '正文')
  assert.deepEqual(out.aux_ref_audio_paths, [])
  assert.deepEqual(out.pron_overrides, {})
  assert.deepEqual(out.lang_overrides, {})
  assert.deepEqual(out.han_readings, {})
})

test('辅助参考音频这一串路径也要解析', () => {
  const r = v4Recipe({
    params: { aux_ref_audio_paths: [{ base: 'asset', path: 'fake/a.wav' }, 'D:/外部/b.wav', null] },
  })
  assert.deepEqual(recipeToGenerateParams(r, '', FAKE).aux_ref_audio_paths,
    ['assets/fake/a.wav', 'D:/外部/b.wav'])
})

test('平台自己的键不会被当成引擎参数漏进袋子', () => {
  // 漏进去的后果：它们会被当成引擎参数发给引擎，宽松的静默忽略、严格的 400。
  const r = v4Recipe({ params: { pron_overrides: { 行: 'xing' }, seed: 1 } })
  const out = recipeToGenerateParams(r, '', FAKE)
  assert.deepEqual(out.pron_overrides, { 行: 'xing' })
  // 它只能以整形过的那一份出现，⛔ 不能再有第二份没整形的。
  assert.equal(Object.keys(out).filter(k => k === 'pron_overrides').length, 1)
})

test('空配方 / 缺字段不炸', () => {
  for (const r of [null, undefined, {}, { params: null }, { engine_params: 'nope' }]) {
    const out = recipeToGenerateParams(r, '', FAKE)
    assert.equal(typeof out, 'object')
    assert.equal(out.voice, '')
  }
})

test('recipePath 三种形状', () => {
  assert.equal(recipePath({ base: 'asset', path: 'a/b.wav' }), 'assets/a/b.wav')
  assert.equal(recipePath({ base: 'asset', path: 'assets/a/b.wav' }), 'assets/a/b.wav')
  assert.equal(recipePath({ base: 'external', path: 'D:/x.wav' }), 'D:/x.wav')
  assert.equal(recipePath('已经是字符串.wav'), '已经是字符串.wav')
  assert.equal(recipePath(null), '')
  assert.equal(recipePath({ base: 'asset' }), '')
})

test('recipeParamBag 只合并，不加工', () => {
  assert.deepEqual(recipeParamBag(v4Recipe(), FAKE), { seed: 1234, ...FAKE_PARAMS })
})

// ---- 守住「不认识键名」这件事本身 -----------------------------------------

const SRC = readFileSync(fileURLToPath(new URL('./recipes.js', import.meta.url)), 'utf8')
const CODE = SRC.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

test('⛔ 这个模块的代码里不许再出现任何一台引擎的参数名', () => {
  // 这一条就是 2026-08-29 之前那个洞的形状：一行写死二十来个 GSV 参数名。
  // ⚠ speed / speed_factor 是例外，它们是 v3 老配方的兼容那一条，有注释说明。
  const banned = [
    'top_k', 'top_p', 'temperature', 'repetition_penalty', 'text_split_method',
    'sample_steps', 'if_sr', 'batch_size', 'batch_threshold', 'split_bucket',
    'fragment_interval', 'parallel_infer', 'streaming_mode', 'overlap_length',
    'min_chunk_length', 'emo_alpha', 'interval_silence', 'max_text_tokens_per_segment',
  ]
  const found = banned.filter(k => CODE.includes(k))
  assert.deepEqual(found, [], `这些引擎参数名又被写死进来了：${found.join(', ')}`)
})

// ⭐⭐ 「保存为配方」的预览。原来是写死的两行 ⇒ 换一台引擎就永远显示
//   「（无）（无）」，等于对用户说"你没有模型"，正是这一轮要消灭的那句谎话。
test('⭐ 存进去了才列出来', () => {
  const p = recipeWeightPreview({ gpt_ckpt: 'a/b/x.ckpt', sovits_pth: 'a/b/y.pth' })
  assert.equal(p.storable, true)
  assert.deepEqual(p.rows.map(r => r.path), ['a/b/x.ckpt', 'a/b/y.pth'])
})

test('⭐ 只存下一个 ⇒ 只列一行，⛔ 另一行不显示成"无"', () => {
  const p = recipeWeightPreview({ gpt_ckpt: 'a/b/x.ckpt', sovits_pth: '' })
  assert.equal(p.rows.length, 1)
  assert.equal(p.storable, true)
})

test('⭐⭐ 一个都存不进 ⇒ storable=false（界面要说原因，不是显示"无"）', () => {
  assert.deepEqual(recipeWeightPreview({}), { rows: [], storable: false })
  assert.deepEqual(recipeWeightPreview(null), { rows: [], storable: false })
  assert.deepEqual(recipeWeightPreview({ gpt_ckpt: '', sovits_pth: '' }), { rows: [], storable: false })
})

test('⛔ 也不许出现任何一台引擎的 id', () => {
  for (const id of ['gpt-sovits', 'indextts2', 'GPT-SoVITS', 'IndexTTS2']) {
    assert.ok(!CODE.includes(id), `${id} 被写死进了配方搬运层`)
  }
})
