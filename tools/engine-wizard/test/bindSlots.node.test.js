'use strict'
// bind 槽位：平台的固定词表，界面不许自己抄一份。
//
// 这条守卫守的是「平台认哪几个槽位」这一件事：
//   平台 lib/engines/hostProfile.js 的 BIND_SLOTS 是唯一权威（3 个：
//   text / ref_audio / output_path）。
//   界面手抄过一份 6 个的（多出 ref_text / ref_lang / text_lang / out）。
//   那 4 个平台在加载名片时才拒（hostProfile.js:230 抛
//   ENGINE_HOST_CONTRACT_INVALID），不是填的时候拒
//   ⇒ 使用者填完、保存成功、平台加载时才炸。
//
// 判据：界面上的槽位清单必须逐个来自平台的 BIND_SLOTS，且不多不少。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const EDITOR = path.join(ROOT, 'tools/engine-wizard/editor')
const SPEC = path.join(ROOT, 'tools/engine-wizard/core/specbridge.js')
const REQUIRED = path.join(ROOT, 'tools/engine-wizard/editor/RequiredFields.jsx')

const { BIND_SLOTS } = require(path.join(ROOT, 'lib/engines/hostProfile'))

const specSrc = fs.readFileSync(SPEC, 'utf8')
const requiredSrc = fs.readFileSync(REQUIRED, 'utf8')

function stripComments (text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('平台只认这三个槽位（这条守卫的前提是平台那份没变）', () => {
  assert.deepStrictEqual(BIND_SLOTS, ['text', 'ref_audio', 'output_path'],
    `平台的 BIND_SLOTS 变了：${JSON.stringify(BIND_SLOTS)}`)
})

test('/wizard/spec 把平台的槽位原样送出来', () => {
  const { buildSpec } = require(SPEC)
  const spec = buildSpec()
  assert.ok(Array.isArray(spec.bindSlots),
    '/wizard/spec 没有 bindSlots：界面就没有槽位清单的来源')
  assert.deepStrictEqual(spec.bindSlots, BIND_SLOTS,
    '/wizard/spec 的 bindSlots 与平台不一致')
})

test('specbridge 直接取平台那份，不自己抄一份', () => {
  // 手抄的那份与平台不同步时，界面会给出平台根本不认的槽位。
  assert.ok(/require\(['"]\.\.\/\.\.\/\.\.\/lib\/engines\/hostProfile['"]\)/.test(specSrc),
    'specbridge 没有 require 平台的 hostProfile：槽位清单是手抄的')
  assert.ok(/BIND_SLOTS/.test(specSrc),
    'specbridge 没有用 BIND_SLOTS')
})

test('界面里不许出现平台不认的槽位名', () => {
  // 那 4 个平台在加载名片时才拒（不是填的时候拒）。
  const NOT_PLATFORM = ['ref_text', 'ref_lang', 'text_lang', 'out']
  for (const name of NOT_PLATFORM) {
    // 只看活代码：注释里提一嘴「平台不认它」是解释，不算。
    const liveRequired = stripComments(requiredSrc)
    assert.ok(!new RegExp(`'${name}'`).test(liveRequired),
      `RequiredFields.jsx 里还有槽位 '${name}'：平台不认它`)
  }
})

test('必填区的槽位也照 spec 给的清单（不自己抄）', () => {
  const live = stripComments(requiredSrc)
  assert.ok(/bindSlots/.test(live),
    'RequiredFields.jsx 没有接 bindSlots')
  assert.ok(/SLOT_KEYS/.test(live),
    'RequiredFields.jsx 没有照 bindSlots 渲染槽位')
  // SLOT_KEYS 必须真的去问 bindSlots，而不是退回到自己那份。
  // 只判「bindSlots 这个词出现过」不够：把 SLOT_KEYS 改成
  // 「const SLOT_KEYS = Object.keys(SLOT_LABELS)」，那个词还在，但清单已经手抄了。
  // SLOT_KEYS 那个表达式可能跨行（`? bindSlots` 与 `: [...]` 各一行），
  // 所以要一直抓到下一个语句，而不是只抓第一行。
  const keysM = /const SLOT_KEYS =([\s\S]*?)\n  const slots =/.exec(live)
  assert.ok(keysM, '必填区里找不到 SLOT_KEYS')
  assert.ok(/bindSlots/.test(keysM[1]),
    'SLOT_KEYS 没有去问 bindSlots：槽位清单是自己抄的那份')
  // fallback 那份也必须逐字等于平台的那三个。
  // fallback 是三元表达式的 else 分支：`(cond) ? bindSlots : <写死的一份>`。
  // 写死的那份可以是一个数组字面量，也可以是 Object.keys(SLOT_LABELS)，
  // 两种都要能判，关键是它列出来的那几个必须逐字是平台的那几个。
  const fbM = /\?\s*[^:]*:\s*([^\n]+)/.exec(keysM[1])
  assert.ok(fbM, 'SLOT_KEYS 的 fallback 不是一份写死的清单')
  const fbExpr = fbM[1].trim()
  let fb = []
  const litM = /^\[([^\]]*)\]$/.exec(fbExpr)
  if (litM) {
    fb = litM[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  } else {
    assert.ok(/^Object\.keys\(SLOT_LABELS\)$/.test(fbExpr),
      `SLOT_KEYS 的 fallback 是别的表达式：${fbExpr}`)
    const labelsM = /const SLOT_LABELS = \{([\s\S]*?)\n  \}/.exec(live)
    assert.ok(labelsM, '必填区里找不到 SLOT_LABELS')
    fb = [...labelsM[1].matchAll(/(\w+):\s*\{/g)].map((m) => m[1])
  }
  assert.deepStrictEqual(fb, BIND_SLOTS,
    `SLOT_KEYS 的 fallback 与平台不一致：${JSON.stringify(fb)}`)
})

test('必填区那三格真的拿到了 spec 的清单', () => {
  // ManifestForm 把 spec.bindSlots 传给 RequiredFields：少这一步，
  // 界面就一直用自己那份 fallback（看着对，但平台改了就漂）。
  const formSrc = fs.readFileSync(path.join(EDITOR, 'ManifestForm.jsx'), 'utf8')
  const live = stripComments(formSrc)
  assert.ok(/<RequiredFields[\s\S]*?bindSlots=\{spec && spec\.bindSlots\}/.test(live),
    'ManifestForm.jsx 没把 spec.bindSlots 传给 RequiredFields')
})

test('变异检查：手抄一份 6 槽位的清单必须被抓住', () => {
  // 判据自证：把平台那份换成 6 个的，上面两条「界面里不许出现平台不认的槽位名」
  // 与「/wizard/spec 把平台的槽位原样送出来」必须红。
  const { buildSpec } = require(SPEC)
  const spec = buildSpec()
  const widened = spec.bindSlots.concat(['ref_text', 'ref_lang', 'text_lang', 'out'])
  assert.notDeepStrictEqual(widened, BIND_SLOTS,
    '前提变了：加宽后与平台一样，测试要改')
  // 界面照这份加宽的清单渲染 ⇒ 平台不认的槽位名就出现在界面上了
  const liveNested = stripComments(requiredSrc)
  const NOT_PLATFORM = ['ref_text', 'ref_lang', 'text_lang', 'out']
  for (const name of widened.filter((s) => !BIND_SLOTS.includes(s))) {
    assert.ok(NOT_PLATFORM.includes(name),
      `前提变了：${name} 不在「平台不认」那组里`)
    // 断言方向反过来：手抄的话活代码里会有这个字符串
    assert.ok(!new RegExp(`'${name}'`).test(liveNested),
      `活代码里出现了 '${name}'：界面会给平台不认的槽位`)
  }
})
