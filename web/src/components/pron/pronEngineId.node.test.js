/**
 * 刀 A1 的前端守卫：读音预览这条路上，engine_id 必须一路穿到底。
 *
 * ⭐⭐⭐ 这条守卫存在的理由：
 *   `legacyDefault` 删掉之后，后端 `/api/pron/preview` 在缺 engine_id 时返回
 *   400 `PRON_ENGINE_ID_MISSING`（lib/routes/pron.js:58-65），**不再**替调用方
 *   挑一台引擎顶上。前端这条链有 **5 个渲染点、4 层组件**，
 *   漏传任何一层的表现都是同一句话：
 *     「那个页面的读音预览安静地不工作」——没有报错、没有红字、没有日志。
 *   ⇒ 这种失败**人眼验不出来**（谁会挨个点开五个页面里的读音校对？），
 *     所以必须由一条**逐个点名**的守卫盯着。
 *
 * ⛔ 禁令：不许把这条测试改成"检查存在 engineId 这个词"。
 *   它必须逐个点名到具体渲染点 —— 泛化的检查在少了一个渲染点时照样绿。
 *
 * 预言（可证伪）：下一次有人新加一个渲染 <PronPanel> / <TextPrepModal> 的页面，
 *   他会忘了传 engineId。这条测试**不会**替他发现（它只认名单上的点）
 *   ⇒ 名单必须跟着新页面一起长。这是**故意**的取舍：
 *     宁可漏报新页面，也不要一条模糊到永远绿的守卫。
 */
// ⚠ `web/package.json` 是 `"type": "module"` ⇒ 这里只能用 import。
//   （我第一版写成 require，`node --test` 报的是一句光秃秃的 'test failed'
//     ——⭐ 顶层加载失败时看不到任何子测试名，别以为是断言写错了。）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', '..')
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')

const PRON = read('components/pron/PronProofing.jsx')

test('⭐⭐⭐ 三处 /api/pron/preview 调用都必须带 engine_id', () => {
  const calls = [...PRON.matchAll(/api\(\s*'\/api\/pron\/preview'[\s\S]{0,260}?\)/g)]
  assert.equal(calls.length, 3, `/api/pron/preview 的调用点从 3 个变成了 ${calls.length} 个 —— 新的那个也要带 engine_id，并把它加进这条守卫`)
  for (const [i, m] of calls.entries()) {
    assert.match(m[0], /engine_id:\s*engineId/, `第 ${i + 1} 处 /api/pron/preview 没带 engine_id`)
  }
})

test('⛔ 缺引擎时不许发请求 —— 三处都要有早退', () => {
  // 每一处调用前面 400 字符内必须有一句 `if (!engineId)`。
  // ⭐ 不检查它返回什么（三处返回形状不同：两处 setState 报错，一处返回错误项），
  //   只检查**它根本没发出去** —— 那才是这条守卫在保的东西。
  const idxs = [...PRON.matchAll(/api\(\s*'\/api\/pron\/preview'/g)].map(m => m.index)
  assert.equal(idxs.length, 3)
  for (const i of idxs) {
    const before = PRON.slice(Math.max(0, i - 400), i)
    assert.match(before, /if\s*\(\s*!engineId\s*\)/, `有一处 /api/pron/preview 在 engineId 缺席时照样发了出去`)
  }
})

test('⭐ engineId 必须进 HanReadingReview 的依赖签名', () => {
  // 换一台引擎 = 换一套 g2p ⇒ 已经问过的那一批读音全部作废。
  // ⛔ 少了这一段，用户换引擎后看到的是**上一台**引擎的建议读音，且永不刷新。
  const sig = PRON.match(/const selectionSignature = .*/)
  assert.ok(sig, '找不到 selectionSignature')
  assert.match(sig[0], /engineId/, 'selectionSignature 里没有 engineId —— 换引擎后读音建议不会刷新')
})

/**
 * 逐个点名：4 层组件签名 + 5 个渲染点。
 * ⭐ 每一行都是一次真实的"我差点漏掉"。
 */
const SIGNATURES = [
  ['components/pron/PronProofing.jsx', /function PronPanel\(\{[^}]*\bengineId\b/],
  ['components/pron/PronProofing.jsx', /function HanReadingReview\(\{[^}]*\bengineId\b/],
  ['components/pron/PronProofing.jsx', /function HanLangPicker\(\{[^}]*\bengineId\b/],
  ['components/pron/PronProofing.jsx', /function TextPrepModal\(\{[^}]*\bengineId\b/],
  ['components/assets/ReferenceTranscriptProofing.jsx', /function ReferenceTranscriptProofing\(\{[^}]*\bengineId\b/],
  ['components/assets/AssetsTab.jsx', /function AssetsTab\(\{\s*engine\b/],
  ['components/train/TrainingTab.jsx', /function TrainingTab\(\{\s*engine\b/],
  ['components/train/TrainingTab.jsx', /function AsrRowProof\(\{[^}]*\bengineId\b/],
  ['components/train/TrainingTab.jsx', /function AsrReviewPanel\(\{[^}]*\bengineId\b/],
  ['components/compare/ReferenceCompareTab.jsx', /function CompareRow\(\{[^}]*\bengineId\b/],
]

for (const [file, re] of SIGNATURES) {
  test(`⛔ 签名断链：${file} ${re.source.slice(0, 40)}`, () => {
    assert.match(read(file), re, `${file} 的这个组件签名上没有引擎 —— 链在这里断了`)
  })
}

/** 渲染点：`<组件` 之后 700 字符内必须出现 engineId=。 */
const RENDERS = [
  ['components/generate/GenerateTab.jsx', '<TextPrepModal'],
  ['components/compare/ReferenceCompareTab.jsx', '<TextPrepModal'],
  ['components/compare/ReferenceCompareTab.jsx', '<CompareRow'],
  ['components/assets/AssetsTab.jsx', '<ReferenceTranscriptProofing'],
  ['components/assets/ReferenceTranscriptProofing.jsx', '<TextPrepModal'],
  ['components/train/TrainingTab.jsx', '<AsrReviewPanel'],
  ['components/train/TrainingTab.jsx', '<AsrRowProof'],
  ['components/train/TrainingTab.jsx', '<PronPanel'],
  ['components/pron/PronProofing.jsx', '<HanLangPicker'],
  ['components/pron/PronProofing.jsx', '<HanReadingReview'],
  ['components/pron/PronProofing.jsx', '<PronPanel'],
]

for (const [file, tag] of RENDERS) {
  test(`⛔ 渲染点漏传：${file} ${tag}`, () => {
    const code = read(file)
    const idxs = [...code.matchAll(new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s>]', 'g'))].map(m => m.index)
    assert.ok(idxs.length > 0, `${file} 里找不到 ${tag}`)
    for (const i of idxs) {
      const block = code.slice(i, i + 700)
      assert.match(block, /engineId=/, `${file} 的 ${tag}（第 ${i} 字节）没传 engineId`)
    }
  })
}

test('⭐⭐⭐ App.jsx 必须把 engine 传给这两个原本拿不到它的页签', () => {
  // ⛔ TrainingTab / AssetsTab 在这一刀之前**根本没有** engine prop
  //   —— 它们里面的读音校对一直靠后端挑默认引擎，那条路已经删了。
  const app = read('App.jsx')
  assert.match(app, /<TrainingTab\s+engine=\{engine\}/, 'App.jsx 没把 engine 传给 TrainingTab')
  assert.match(app, /<AssetsTab\s+engine=\{engine\}/, 'App.jsx 没把 engine 传给 AssetsTab')
})

test('⛔ 全仓库不许再有裸的 /api/advanced-params 读取', () => {
  // 写入（POST）那一路是 `api('/api/advanced-params', {` —— 那个是对的，不在此列。
  // 读取必须带 ?engine_id=。⛔ 裸读会让后端无从判断该给哪台引擎的默认值。
  // ⚠ 必须先去掉注释：这一刀的注释里**原样引用了**旧写法
  //   （「这里过去是 `api('/api/advanced-params')`」）——
  //   ⭐ 不去注释的话，一条正确的守卫会被自己的说明文字咬红。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const f of ['components/generate/GenerateTab.jsx', 'components/compare/ReferenceCompareTab.jsx']) {
    const code = stripComments(read(f))
    assert.doesNotMatch(
      code,
      /api\('\/api\/advanced-params'\)/,
      `${f} 里还有裸读 /api/advanced-params`,
    )
  }
})
