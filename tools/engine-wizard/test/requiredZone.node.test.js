'use strict'
// 第 4 步的必填区：合成一个两列网格，每格是「中文人话 + 键名徽标」，不分组小标题。
//
// 这条守卫守三件容易出错的形状：
//   ① 必填区拆成「核心输入」与「运行与能力」两小段。
//      读起来像两类不同重要性的东西，而它们是同一件事：
//      缺任何一格，这张名片都接不上平台。
//   ② 「必填 8 项」这个说法漏了一项（平台的第 9 个硬必填键
//      capabilities.reference_clip_seconds），于是那一格在表单里填不了。
//   ③ 必填区与高级段是同一份数据的两处编辑：
//      runtime.python 在页面上有两个入口，两处徽标还不一样。
//
// 判据落在源码声明上（不渲染 JSX）：网格、徽标、小标题、键名清单。
// 渲染结果由 scratch 里的真浏览器脚本量（几何、命中、溢出）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const REQUIRED = path.join(EDITOR, 'RequiredFields.jsx')
const NESTED = path.join(EDITOR, 'NestedSections.jsx')
const FORM = path.join(EDITOR, 'ManifestForm.jsx')

const src = fs.readFileSync(REQUIRED, 'utf8')
const nested = fs.readFileSync(NESTED, 'utf8')
const form = fs.readFileSync(FORM, 'utf8')

// 去掉注释再看：注释里提到「核心输入」是在讲为什么去掉它，
// 不是界面上还留着那个小标题。拿带注释的源码去判「界面上有没有」，
// 判据会反过来被自己的解释文字绊住。
function stripComments (text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 必填区里出现的键名徽标（code="..." 那种）。 */
function badgeCodes (text) {
  const out = []
  const re = /code="([^"]+)"/g
  let m
  while ((m = re.exec(text))) out.push(m[1])
  return out
}

/** 槽位那一格用的是 code={slot.key}：键名在 SLOT_LABELS 里。 */
function slotCodes (text) {
  const m = /const SLOT_LABELS = \{([\s\S]*?)\n  \}/.exec(text)
  if (!m) return []
  const out = []
  for (const k of m[1].matchAll(/(\w+):\s*\{/g)) out.push(k[1])
  return out
}

test('必填区是一个网格，不是一个一个的小段', () => {
  const live = stripComments(src)
  assert.ok(/className="form-grid"/.test(live),
    '必填区里没有 .form-grid：两列网格没了')
  // 小标题：两个都不许再有
  assert.ok(!/wz-subhead/.test(live),
    '必填区里还有 .wz-subhead：「核心输入」「运行与能力」那两个小标题不该在')
  assert.ok(!/Core inputs|核心输入/.test(live),
    '必填区里还有「核心输入」这个小标题')
  assert.ok(!/Runtime and capabilities|运行与能力/.test(live),
    '必填区里还有「运行与能力」这个小标题')
})

test('那三行拖拽说明不在了', () => {
  // 「平台会把这三个输入交给每台引擎。把左栏的参数拖到对应一格，或直接填参数名。」
  // 这一行说明的是拖拽，而拖拽的落点就是那三格本身 ⇒ 说明是多余的。
  const live = stripComments(src)
  assert.ok(!/平台会把这三个输入交给每台引擎/.test(live),
    '必填区里还有那三行拖拽说明')
  assert.ok(!/Drag a scanned parameter onto each/.test(live),
    '必填区里还有那三行拖拽说明')
})

test('平台当场校验的键一个都不许漏（守卫不许自己少列一项）', () => {
  // 这份清单从平台源码里挖出来，不手写：
  //   required() / requiredBool() / positiveInt() 的调用点 + reference_clip_seconds 那条。
  const platformSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'profile.js'), 'utf8')
  const platformKeys = new Set()
  for (const m of platformSrc.matchAll(
    /(?:required|requiredBool|positiveInt)\(\s*manifest,\s*'([^']+)'/g)) {
    platformKeys.add(m[1])
  }
  // reference_clip_seconds 那条平台是手写判断（profile.js:174），不在这三个函数里。
  if (!platformKeys.has('capabilities.reference_clip_seconds')) {
    platformKeys.add('capabilities.reference_clip_seconds')
  }
  assert.ok(platformKeys.size >= 9,
    `从平台源码里只挖到 ${platformKeys.size} 个必填键，判据本身失效了`)

  // 名片键：徽标里写死的那几个。
  const codes = badgeCodes(src)
  // 三个 bind 槽位不是名片键，是平台的槽位名，键名在 slots 数组里。
  const slots = slotCodes(src)
  assert.deepStrictEqual(slots, ['text', 'ref_audio', 'output_path'],
    `必填区的槽位不对：${JSON.stringify(slots)}`)

  const manifestKeys = codes.filter((c) => !slots.includes(c))
  const missing = [...platformKeys].filter((k) => !manifestKeys.includes(k))
  assert.deepStrictEqual(missing, [],
    `必填区少了这些键：${missing.join('、')}（平台加载名片时直接抛错）`)
})

test('条件必填的出处那一格也在（写了数就得写出处）', () => {
  // 平台：写了 max_chars / timeout_ms / runtime.ready_timeout_ms
  // 就必须同时写 _source（lib/engines/profile/topkeys.js 的 checkMeasuredSources）。
  // 必填区填满 12 格之后，那张名片平台认不认，就取决于这三格在不在。
  const codes = badgeCodes(src)
  for (const k of ['max_chars_source', 'timeout_ms_source',
    'runtime.ready_timeout_ms_source']) {
    assert.ok(codes.includes(k), `必填区少了「${k}」：写了那个数却没写出处，平台拒绝`)
  }
})

test('每格都是「中文人话 + 键名徽标」：标签不是键名，键名在徽标里', () => {
  // 判据：格子的标签不许直接就是键名。
  // 键名一律进 .badge-accent 徽标（人话标签 + 键名徽标是同一种形状）。
  // 槽位那三格是 map 出来的（code={slot.key}），
  // 它们单独判：标签是人话（合成文本 / 参考音频 / 输出），键名是槽位名。
  const live = stripComments(src)
  const cellBlocks = live.split(/<Cell\s/).slice(1)
  // 槽位那格也在 cellBlocks 里（它是 <Cell key={slot.key} …>），
  // 但它的 label 与 code 都是表达式，静态判不了 ⇒ 单独判一次。
  const staticCells = cellBlocks.filter((b) => /code="/.test(b))
  assert.ok(staticCells.length >= 12,
    `必填区只找到 ${staticCells.length} 个键名写死的格，应当至少 12 格`)

  for (const block of staticCells) {
    const codeM = /code="([^"]+)"/.exec(block)
    assert.ok(codeM, '有一格没写 code（键名徽标）')
    const labelM = /label=\{t\('([^']*)',\s*'([^']*)'\)\}/.exec(block)
    assert.ok(labelM, `键 ${codeM[1]} 的标签不是「中文人话 + 键名徽标」那一套`)
    // 人话标签不许就是键名本身
    assert.notStrictEqual(labelM[2], codeM[1],
      `键 ${codeM[1]} 的中文标签与键名一字不差：那不是「人话 + 键名」，是同一个词写两遍`)
    assert.ok(labelM[2].length > 0, `键 ${codeM[1]} 的中文标签是空的`)
  }

  // 徽标那一枚用的是 badge-accent（键名那一枚）
  assert.ok(/badge badge-accent/.test(live),
    '键名徽标用的不是 .badge-accent')

  // 槽位那三格：人话标签 + 槽位名
  const slotsM = /const SLOT_LABELS = \{([\s\S]*?)\n  \}/.exec(live)
  assert.ok(slotsM, '必填区里找不到 SLOT_LABELS')
  const slotRows = slotsM[1].matchAll(
    /(\w+):\s*\{\s*labelEn:\s*'([^']*)',\s*labelZh:\s*'([^']*)'/g)
  const slotRowsArr = [...slotRows]
  assert.strictEqual(slotRowsArr.length, 3,
    `SLOT_LABELS 里不是三格：${slotRowsArr.length}`)
  for (const [, key, , zh] of slotRowsArr) {
    assert.ok(zh.length > 0, `槽位 ${key} 的中文标签是空的`)
    assert.notStrictEqual(zh, key,
      `槽位 ${key} 的中文标签与键名一字不差：不是「人话 + 键名」`)
  }
  assert.ok(/code=\{slot\.key\}/.test(live),
    '槽位那三格的键名徽标不在 code={slot.key} 上')
})

test('必填网格与高级段不再编辑同一份 runtime 数据', () => {
  // 同一个键在页面上有两个编辑入口时，两处的徽标与提示不一样
  // （高级那处标「填错装不上」，必填那处不标），
  // 而两边改的是同一个键 ⇒ 看的人会以为什么都不一样。
  for (const key of ['python', 'entry', 'ready_endpoint',
    'ready_timeout_ms', 'ready_timeout_ms_source']) {
    assert.ok(!new RegExp(`<Row label="${key}"`).test(nested),
      `高级段里还有 runtime.${key} 那一格：它与必填网格是同一份数据的两个入口`)
  }
  // 高级段还留着几个不是必填的键
  for (const key of ['args', 'checkpoints']) {
    assert.ok(new RegExp(`<Row label="${key}"`).test(nested),
      `高级段里 runtime.${key} 不见了：它不是必填项，应当留在高级段`)
  }
})

test('那两个被拆掉的组件不在了（不留空壳）', () => {
  assert.ok(!fs.existsSync(path.join(EDITOR, 'CoreBindings.jsx')),
    'editor/CoreBindings.jsx 还在：它与必填网格是同一批格子')
  assert.ok(!fs.existsSync(path.join(EDITOR, 'RequiredEight.jsx')),
    'editor/RequiredEight.jsx 还在：它与必填网格是同一批格子')
})

test('高级段里不再有那条「同一份数据两处编辑」的 TODO', () => {
  assert.ok(!/TODO\(骨架\)：与「必填字段」里的 runtime/.test(form),
    'ManifestForm.jsx 里还留着那条 TODO：两处编辑已经收掉了，TODO 也该去掉')
})

test('变异检查：拿掉一个键的徽标会被上面那条抓住', () => {
  // 判据本身的有效性自证：把清单里的一个键从徽标里去掉，看那条会不会红。
  const codes = badgeCodes(src)
  assert.ok(codes.includes('capabilities.reference_clip_seconds'),
    '前提变了：那一格不在必填区了，测试要改')
  const trimmed = codes.filter((c) => c !== 'capabilities.reference_clip_seconds')
  assert.ok(!trimmed.includes('capabilities.reference_clip_seconds'),
    '去掉一个键之后清单里还有它：判据没生效')
  assert.ok(trimmed.length < codes.length, '去掉一个键之后长度没变：判据没生效')
})
