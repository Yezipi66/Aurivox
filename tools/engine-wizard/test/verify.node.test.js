'use strict'
// verify（第 7 步）—— ⭐ 核心判据：**平台四道校验，一个都不许重写**
//
// （已改为中性表述）
//   因为第一次写 verify.js 时我把 envCheck 的签名猜成了 (id, env)，
//   ⛔ 而它真实的签名是 (profile, {rootDir}) ——
//   node 不会报错，只是读到一堆 undefined。**这种错只有真跑才抓得到。**

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { checks, runChecks, runAudioCheck } = require('../core/verify.js')

// ⛔ 用一台真引擎（⛔ 但测试里只当字符串用，不 import 它的任何东西）
const REAL = 'indextts2'

// ---------------------------------------------------------------------------
// ⭐ 清单 —— 四道，顺序照平台
// ---------------------------------------------------------------------------
test('⭐ 四道校验都在，顺序是装→起→权重→出声', () => {
  const ks = checks().map((c) => c.key)
  assert.deepStrictEqual(ks,
    ['env_shallow', 'env_deep', 'checkpoints', 'audio'])
})

test('⭐ 每道都要带 why（用户要知道这道在查什么）', () => {
  for (const c of checks()) {
    assert.ok(c.why && c.why.length > 8, `${c.key} 缺 why`)
    assert.ok(c.titleZh, `${c.key} 缺中文标题`)
  }
})

test('⭐ 「出声」那道要标成重的 —— 它会真的跑合成', () => {
  const audio = checks().find((c) => c.key === 'audio')
  assert.strictEqual(audio.cost, 'heavy',
    '⛔ 必须标明这道要真跑合成，别让用户以为它跟查盘一样快')
})

// ---------------------------------------------------------------------------
// ⭐ 真跑 —— 这才是抓到签名猜错的那条
// ---------------------------------------------------------------------------
test('⭐ 真跑前 3 道（不跑出声那道）', () => {
  const r = runChecks(REAL, { deep: true })
  assert.strictEqual(r.id, REAL)
  // ⛔ 浅层必须返回了东西 —— 签名猜错的话这里会是 undefined
  assert.ok(r.checks.env_shallow, '⛔ 浅层没返回结果 —— envCheck 签名可能又猜错了')
  assert.strictEqual(typeof r.checks.env_shallow.ok, 'boolean',
    `浅层没给 ok —— 拿到的是 ${JSON.stringify(r.checks.env_shallow).slice(0, 200)}`)
  assert.ok(Array.isArray(r.checks.env_shallow.problems),
    '⛔ 浅层没给 problems 数组')
})

test('⭐ 权重那道的 ready 必须是三态（⛔ 不许糊成布尔）', () => {
  const r = runChecks(REAL, { deep: false })
  const cp = r.checks.checkpoints
  assert.ok(cp, '⛔ 没有权重那道的结果')
  assert.ok([true, false, null].includes(cp.ready),
    `ready 只能是 true/false/null，拿到 ${JSON.stringify(cp.ready)}`)
  assert.ok(typeof cp.note === 'string' && cp.note.length > 4, '⛔ 三态各有各的说法')
  // ⛔ ready:null 时的说法必须点明「这不是齐，也不是缺」
  if (cp.ready === null) {
    assert.ok(cp.note.includes('说不出来'), cp.note)
  }
})

test('⭐ ⛔ 权重说不出来时，整轮**不能报通过**', () => {
  const r = runChecks(REAL, { deep: false })
  if (r.checks.checkpoints.ready === null) {
    assert.ok(r.problems.some((p) => p.includes('说不出来')),
      '⛔ 权重说不出来，却没进 problems —— 那等于偷偷当成通过了')
  }
})

// ---------------------------------------------------------------------------
// ⭐ 第 4 道「出声」—— A 级不给 request 就不许跑
// ---------------------------------------------------------------------------
test('⛔ ⭐ A 级没给 request ⇒ 不跑，并说清为什么不自己编一个', () => {
  const r = runAudioCheck(REAL, { audio: 'A' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_REQUEST')
  // ⛔ 理由必须说清「为什么平台不替你编」
  assert.ok(r.error.includes('方言'), r.error)
  assert.ok(r.expected_shape, '⛔ 要告诉用户请求体该长什么样')
})

test('⭐ B 级不需要 request —— 它只要合法响应', () => {
  const r = runAudioCheck(REAL, { audio: 'B' })
  // ⛔ 无论过没过，都不许崩、都要有 ok 和 level
  assert.strictEqual(typeof r.ok, 'boolean', JSON.stringify(r).slice(0, 200))
  assert.ok(r.level === 'B' || r.code, '⛔ 要么有 level，要么有 code —— 不能什么都不给')
})

test('⭐ ⛔ 名片没 runtime ⇒ 如实说「平台不负责起它」', () => {
  const r = runAudioCheck('definitely-not-installed-xyz', { audio: 'B' })
  assert.strictEqual(r.ok, false)
  assert.ok(['NO_PROFILE', 'NO_RUNTIME'].includes(r.code), r.code)
})

// ---------------------------------------------------------------------------
// 纪律
// ---------------------------------------------------------------------------
test('⛔ verify.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'verify.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

test('⛔ ⭐ 不许自己重写四道校验的判据（那等于两份事实）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'verify.js'), 'utf-8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  // 四道都必须 require 平台的实现，而不是自己算
  for (const m of ['envCheck.js', 'checkpoints.js', 'verifyAudio.js']) {
    assert.ok(code.includes(m), `⛔ 没有引用平台的 ${m}`)
  }
  // ⛔ 也不许出现「重跑一遍 import」这类自己实现的痕迹
  assert.ok(!/spawnSync.*verify_audio|exec.*import /.test(code),
    '⛔ 发现自己实现校验逻辑的痕迹')
})