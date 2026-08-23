'use strict'

// ===========================================================================
//  钉子测试 · 纯函数（分段 / 种子 / 命名）
// ===========================================================================
// 契约 §12 第 0 步。这个文件不改任何行为，只把「今天的实际表现」钉死，
// 让后面每一刀砍下去时，「GPT-SoVITS 的行为有没有被改坏」由测试回答。
//
// ⚠ 为什么用 vm 把函数从 server.js 里挖出来，而不是 require：
//   splitJapaneseText / forceSplitLong / resolveSeed / newGenId /
//   genBaseName / normSource 这六个都是纯函数，但它们住在 server.js 里，
//   而 server.js 一被 require 就会建 Express、监听端口、扫资产。
//   为了不动一行行为代码（第 0 步的硬约束），这里把函数源码读出来，
//   在隔离的 vm 上下文里求值。
//
//   这不是长期方案，是脚手架：契约 §12 第 1 步会把分段搬进 lib/text/ 下的
//   真模块，届时把 loadPureFns() 换成一行 require 即可，
//   下面的断言一个字都不用改 —— 它们钉的是行为，不是位置。
//
// ⚠ 这个文件本身也上了保险：函数从 server.js 消失或改名，
//   loadPureFns() 会显式抛错，而不是静默跳过。
//   恒真通过的测试比没有测试更危险。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SERVER_JS = path.resolve(__dirname, '..', '..', 'server.js')
const WANTED = ['splitJapaneseText', 'forceSplitLong', 'resolveSeed', 'newGenId', 'genBaseName', 'normSource']

// 从源码里按大括号配对切出一个顶层函数声明。
function cutFunction (src, name) {
  const head = new RegExp(`^function\\s+${name}\\s*\\(`, 'm')
  const m = head.exec(src)
  if (!m) {
    throw new Error(
      `钉子测试失效：server.js 里找不到顶层函数 ${name}()。` +
      '如果它已经搬进了模块，请把本文件的 loadPureFns() 换成 require 那个模块。',
    )
  }
  const start = m.index
  // 先跳过参数表 —— 参数默认值里可能有 `{}`（如 `options = {}`），
  // 直接找第一个 `{` 会把函数体切成空的。
  let p = src.indexOf('(', start)
  let pd = 0
  for (; p < src.length; p++) {
    const c = src[p]
    if (c === '(') pd++
    else if (c === ')') { pd--; if (pd === 0) break }
  }
  let i = src.indexOf('{', p)
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`钉子测试失效：切 ${name}() 时大括号没配平`)
}

function loadPureFns () {
  const src = fs.readFileSync(SERVER_JS, 'utf8')
  const bodies = WANTED.map((n) => cutFunction(src, n)).join('\n\n')
  // 在当前 realm 里求值（不是 vm 沙箱）：跨 realm 的数组原型不同，
  // deepStrictEqual 会以「结构相同但不是同一个 Array」为由失败，
  // 那种红是噪音，不是信号。这几个函数是纯函数，没有闭包依赖。
  // eslint-disable-next-line no-new-func
  return new Function(`${bodies}\nreturn { ${WANTED.join(', ')} }`)()
}

const P = loadPureFns()

// --------------------------------------------------------------------------
//  钉子 1：分段数与每段边界
//  为什么是它：分段规则一改，音频节奏就变 —— 而且不会报错。
// --------------------------------------------------------------------------

test('nail: 短文本不足 softLimit 时只有一段，原文一字不动', () => {
  assert.deepEqual(P.splitJapaneseText('你好。', { softLimit: 45, hardLimit: 90 }), ['你好。'])
})

test('nail: 句末标点是切点，且标点跟着前一句走', () => {
  assert.deepEqual(
    P.splitJapaneseText('今天很好。明天更好。后天最好。', { softLimit: 6, hardLimit: 12 }),
    ['今天很好。', '明天更好。', '后天最好。'],
  )
})

test('nail: 贪心装箱 —— 装得下就并进同一段', () => {
  assert.deepEqual(
    P.splitJapaneseText('今天很好。明天更好。后天最好。', { softLimit: 12, hardLimit: 24 }),
    ['今天很好。明天更好。', '后天最好。'],
  )
})

test('nail: 七种句末标点都算切点（。！？…♪ 与半角 ! ?）', () => {
  assert.deepEqual(
    P.splitJapaneseText('啊。哦！呃？嗯…唔♪咦!哇?', { softLimit: 2, hardLimit: 4 }),
    ['啊。', '哦！', '呃？', '嗯…', '唔♪', '咦!', '哇?'],
  )
})

test('nail: 没有句末标点时整段视为一句', () => {
  assert.deepEqual(P.splitJapaneseText('没有任何标点的一句话', { softLimit: 45, hardLimit: 90 }), ['没有任何标点的一句话'])
})

test('nail: 空白输入返回空数组（不是 [""]）', () => {
  assert.deepEqual(P.splitJapaneseText('', { softLimit: 45, hardLimit: 90 }), [])
  assert.deepEqual(P.splitJapaneseText('   \n  ', { softLimit: 45, hardLimit: 90 }), [])
})

test('nail: CRLF 归一化 + 整体 trim；⚠ 段内换行留在下一段段首', () => {
  // ⚠ 这条记录的是「今天的实际表现」，不是「应该的表现」：
  //   整段首尾的空白被 trim 掉了，但句子之间的换行会留在**下一段的段首**
  //   （得到 '\n乙。' 而不是 '乙。'）。段文本是原样发给引擎的，
  //   所以这个前导换行确实进了推理输入。
  //   第 0 步只钉不修 —— 要改的话是单独一刀，改完这条断言也要跟着改。
  assert.deepEqual(P.splitJapaneseText('  甲。\r\n乙。  ', { softLimit: 4, hardLimit: 8 }), ['甲。', '\n乙。'])
})

test('nail: 超长单句在软标点（、，）上强切，且每段不超 hardLimit', () => {
  const out = P.splitJapaneseText('甲甲甲甲，乙乙乙乙，丙丙丙丙。', { softLimit: 6, hardLimit: 10 })
  assert.ok(out.length >= 2, `期望被强切成多段，实际: ${JSON.stringify(out)}`)
  for (const s of out) assert.ok(s.length <= 10, `段超出 hardLimit: ${s}`)
  assert.equal(out.join(''), '甲甲甲甲，乙乙乙乙，丙丙丙丙。')
})

test('nail: 连软标点都没有的超长句按字数硬切，切片长度 = softLimit', () => {
  assert.deepEqual(
    P.splitJapaneseText('一'.repeat(25), { softLimit: 10, hardLimit: 20 }).map((s) => s.length),
    [10, 10, 5],
  )
})

test('nail: 分段是无损的 —— 拼回去等于归一化后的原文', () => {
  const text = '今天天气很好。我们出去走走，顺便吃点东西！明天呢？明天再说…'
  for (const softLimit of [6, 12, 20, 45]) {
    const out = P.splitJapaneseText(text, { softLimit, hardLimit: softLimit * 2 })
    assert.equal(out.join(''), text, `softLimit=${softLimit} 时分段不是无损的`)
  }
})

test('nail: 不传 options 时的默认值是 softLimit=30 / hardLimit=60', () => {
  assert.deepEqual(P.splitJapaneseText('一'.repeat(100)).map((s) => s.length), [30, 30, 30, 10])
})

// --------------------------------------------------------------------------
//  钉子 4：种子解析
//  为什么是它：种子一乱，「同种子同结果」这条承诺就没了，且不报错。
// --------------------------------------------------------------------------

test('nail: 合法非负整数原样透传（含 0）', () => {
  assert.equal(P.resolveSeed(0), 0)
  assert.equal(P.resolveSeed(42), 42)
  assert.equal(P.resolveSeed('42'), 42)
  assert.equal(P.resolveSeed(4294967295), 4294967295)
})

test('nail: -1 与非法值一律换成 [0, 2^32-1] 内的具体整数，绝不留 -1', () => {
  for (const bad of [-1, '-1', undefined, null, NaN, 'abc', {}]) {
    const s = P.resolveSeed(bad)
    assert.ok(Number.isInteger(s), `resolveSeed(${String(bad)}) 不是整数: ${s}`)
    assert.ok(s >= 0 && s <= 0xffffffff, `resolveSeed(${String(bad)}) 越界: ${s}`)
  }
})

test('nail: ⚠ 小数种子的两种写法结果不同（数字 1.5 → 随机；字符串 "1.5" → 1）', () => {
  // ⚠ 记录实际表现，不是主张它应该如此：
  //   typeof 1.5 === 'number' ⇒ 不走 parseInt ⇒ 不是整数 ⇒ 换成随机种子；
  //   而 '1.5' 是字符串 ⇒ 走 parseInt ⇒ 截断成 1。
  //   同一个值，写成数字和写成字符串会得到不同的音频。
  assert.equal(P.resolveSeed('1.5'), 1)
  const n = P.resolveSeed(1.5)
  assert.ok(Number.isInteger(n) && n >= 0 && n <= 0xffffffff)
})

// --------------------------------------------------------------------------
//  钉子 3：id 与命名规则
//  为什么是它：改了会让历史记录对不上。
// --------------------------------------------------------------------------

test('nail: ⚠ newGenId 的时间戳被截断在「分」的十位 —— 精度只到 10 分钟', () => {
  // ⚠ 记录实际表现：ISO 串取 slice(0,15) 落在分钟的第一位上，
  //   于是 04:05 和 04:09 生成的 id 前缀完全相同（都是 ...T04-0）。
  //   后果：按 id 名排序 ≠ 按时间排序（同一个十分钟内顺序由随机后缀决定）。
  //   唯一性仍由 5 位随机后缀保证，所以不是数据安全问题，但排序会乱。
  //   第 0 步只钉不修。
  const id = P.newGenId()
  assert.match(id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d_[a-z0-9]{1,5}$/)
  assert.equal(id.split('_')[0].length, 15)
  assert.ok(!/[:.\\/*?"<>|]/.test(id), `id 含文件名非法字符: ${id}`)
})

test('nail: newGenId 连开多个不会全同（随机后缀有效）', () => {
  const ids = new Set(Array.from({ length: 50 }, () => P.newGenId()))
  assert.ok(ids.size > 1, 'newGenId 在同一毫秒内完全相同 —— 随机后缀失效了')
})

test('nail: genBaseName 同时吃正反斜杠，非字符串一律回空串', () => {
  assert.equal(P.genBaseName('D:\\Project\\a\\b\\GPT_x.ckpt'), 'GPT_x.ckpt')
  assert.equal(P.genBaseName('/home/u/models/SoVITS_y.pth'), 'SoVITS_y.pth')
  assert.equal(P.genBaseName('bare.wav'), 'bare.wav')
  for (const bad of ['', null, undefined, 0, {}, []]) assert.equal(P.genBaseName(bad), '')
})

test('nail: normSource 的三个归口与默认值', () => {
  for (const s of ['compare', 'comparerefs', 'compare_refs', 'COMPARE']) assert.equal(P.normSource(s), 'comparerefs')
  for (const s of ['broker', 'openai', 'speech', 'OpenAI']) assert.equal(P.normSource(s), 'broker')
  for (const s of ['generate', '', null, undefined, 'whatever']) assert.equal(P.normSource(s), 'generate')
})
