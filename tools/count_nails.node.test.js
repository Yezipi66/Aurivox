/**
 * 「进度纵轴」这个数必须和契约里写的那个数对得上。
 *
 * ⭐⭐⭐ 这条测试是 2026-08-31 那次翻车的**闸**：
 *   §12.10 曾经写着「66 行 / 20 文件，真钉子 58」，而它给的量法
 *   （一行 grep）原样跑出来是 355 行 / 77 文件。我试了 10 种排除组合，
 *   **没有一种能复现那三个数** ⇒ 那个被称作"唯一真相"的数字，
 *   在写下的那一刻就已经不可复算了。
 *
 * ⇒ 现在：量法是 `tools/count_nails.cjs`（能跑），数字写在
 *   `docs/ENGINE_CONTRACT.md` 的 `<!-- NAILS: ... -->` 标记行里，
 *   **这条测试盯着两者相等**。
 *
 * ⛔ 禁令：这条测试红了，**不许改测试、不许改标记行去迁就**。
 *   红的含义只有两种：
 *     ① 你刚拔掉（或钉进）了钉子 ⇒ 去改契约那一行，顺手改台账的状态格；
 *     ② 你改了量法 ⇒ 去 §12.10 记一行"为什么改"。
 *   ⭐ 两种都要求你**动契约**。这正是它存在的目的：
 *     让"进度"这件事**没有办法只发生在代码里**。
 *
 * 预言（可证伪）：某次有人加了一个新的前端组件、里面写死了引擎名，
 *   他不会意识到自己钉了一颗钉子 —— 但这条测试会当场红，
 *   并且红在"契约说 22、实际 23"这句话上，⭐ 指向明确、不需要解释。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { countNails } = require('./count_nails.cjs')

const REPO = path.join(__dirname, '..')
const CONTRACT = path.join(REPO, 'docs', 'ENGINE_CONTRACT.md')

test('⭐⭐⭐ 契约里写的钉子数 = 脚本当场量出来的钉子数', () => {
  const doc = fs.readFileSync(CONTRACT, 'utf8')
  const m = doc.match(/<!--\s*NAILS:\s*code=(\d+)\s+files=(\d+)\s*-->/)
  assert.ok(m, 'docs/ENGINE_CONTRACT.md 里找不到 <!-- NAILS: code=N files=M --> 标记行 —— 进度纵轴又变回一个没人能复算的数了')
  const r = countNails(REPO)
  assert.equal(
    r.code, Number(m[1]),
    `契约说钉子 ${m[1]} 行，脚本量出来 ${r.code} 行。⛔ 不许改这条测试 —— 去改契约那一行（并顺手改 §12.10 台账的状态格）`,
  )
  assert.equal(
    r.files.length, Number(m[2]),
    `契约说 ${m[2]} 个文件，脚本量出来 ${r.files.length} 个`,
  )
})

test('⛔ 量法本身不许悄悄漂移：三条排除规则各自有理由，改了要被看见', () => {
  const { ROOTS, EXTRA_FILES, isTest, isCommentLine } = require('./count_nails.cjs')
  // ⭐ web/src 是纵轴的第三条腿（SCOPE §1 的验收原文是 lib\ + server.js + web\）。
  //   ⛔ 少了它就会出现"lib 归零了但前端还写死着引擎名"的假完工。
  assert.deepEqual(ROOTS, ['lib', 'web/src'], '纵轴的扫描范围变了 —— 去 §12.10 记一行为什么')
  assert.deepEqual(EXTRA_FILES, ['server.js'])
  // 测试文件里出现引擎名是**对的**（守卫必须点名），算进钉子会让纵轴永远归不了零。
  assert.ok(isTest('lib/foo.node.test.js'))
  assert.ok(isTest('lib/flow.integration.node.test.js'))
  assert.ok(isTest('lib/__testsupport__/brokerHarness.js'))
  assert.ok(!isTest('lib/routes/synthesis.js'))
  // 注释里提到引擎名通常是在解释"这里为什么不该写死它" —— 那是反钉子。
  assert.ok(isCommentLine('  // gpt-sovits 这个名字不许出现在这里'))
  assert.ok(isCommentLine('   * 见 gpt-sovits 的名片'))
  assert.ok(!isCommentLine("  const id = 'gpt-sovits'"))
})

test('⭐ 归零的定义：不是"grep 不到"，是这五个词在代码里一个都不剩', () => {
  const { PATTERN } = require('./count_nails.cjs')
  for (const w of ['gpt-sovits', 'gpt_sovits', '9880', 'legacyDefault', 'legacy_default']) {
    assert.ok(PATTERN.test(w), `${w} 从纵轴里掉出去了`)
  }
})
