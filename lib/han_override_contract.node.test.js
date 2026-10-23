// 逐字汉字语言覆盖的契约守卫（@N 下标形式）。
//
// 前端那一侧的行为由 web/src/lib/hanLanguage.stale.node.test.js 覆盖。
// 这里守的是跨进程的那部分契约：
//
//  * 引擎必须丢弃前端已经剪掉的那些条目：请求体未必由前端构造，可能来自别处；
//  * 两边对「什么是汉字」的定义必须一致，否则选择器给出的选项引擎会静默忽略；
//  * 每个调用点都必须把 @N 下标所指的文本传进去。
//
// 下面每条断言都验证过在对应缺陷存在时会红。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const TEXTPRE = 'engines/gpt-sovits/infer/TTS_infer_pack/TextPreprocessor.py'
const HANLANG = 'web/src/lib/hanLanguage.js'

test('the engine ignores a Han-language override that landed on a non-Han character', () => {
  const src = read(TEXTPRE)
  assert.match(
    src,
    /forced_lang and not _HAN_RE\.match\(seg_text\[i\]\)/,
    'a stale @N from a saved recipe would still route a kana through the ' +
      'Chinese pipeline; the web-side pruning cannot protect a payload the ' +
      'web side did not build'
  )
})

test('both sides use the identical definition of a Han character', () => {
  // 这里一旦分叉，最坏的表现是静默的：选择器画出一个用户能选的字，
  // 引擎随后把这条选择丢掉，两边都不报错。
  const jsMatch = read(HANLANG).match(/export const HAN_RE = \/\[([^\]]+)\]\/u/)
  assert.ok(jsMatch, 'HAN_RE is no longer declared in the expected form')
  const pyMatch = read(TEXTPRE).match(/_HAN_RE = re\.compile\(r'\[([^\]]+)\]'\)/)
  assert.ok(pyMatch, '_HAN_RE is no longer declared in the expected form')
  assert.equal(
    pyMatch[1],
    jsMatch[1],
    'the Han character class drifted between the picker and the engine'
  )
})

test('the language override payload only ever names zh/yue/ja', () => {
  const src = read(TEXTPRE)
  assert.match(src, /_ML_OVERRIDE_LANGS = \("zh", "yue", "ja"\)/)
  assert.match(read(HANLANG), /export const HAN_LANGS = \['zh', 'yue', 'ja'\]/)
})

test('every call site passes the text the @N indices refer to', () => {
  const { scan } = require('../tools/guard_han_text_arg.cjs')
  const problems = scan()
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('the call-site guard actually fires on a violation', () => {
  // 从没见过红的检查不算检查：构造出守卫要抓的那个错误写法，确认它被报出来。
  const { scan } = require('../tools/guard_han_text_arg.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hanguard-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'offender.jsx'),
      'const map = normalizeAssignments(forced, direction)\n' +
      'const payload = buildLangOverrides(direction, forced)\n'
    )
    const problems = scan(dir)
    assert.equal(problems.length, 2, 'guard missed a two-argument call')
    const joined = problems.join('\n')
    assert.match(joined, /normalizeAssignments\(\) called with 2 arguments/)
    assert.match(joined, /buildLangOverrides\(\) called with 2 arguments/)

    // 修正后的写法不报：这条守卫是有分辨力的，不是恒红。
    fs.writeFileSync(
      path.join(dir, 'offender.jsx'),
      'const map = normalizeAssignments(forced, direction, text)\n' +
      'const payload = buildLangOverrides(direction, forced, text)\n'
    )
    assert.deepEqual(scan(dir), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the call-site guard parses nested calls and commas inside arguments', () => {
  // 朴素的正则会把 f(a, g(b, c)) 里的逗号数成三个参数，守卫就会在真有问题的代码上放行。
  const { topLevelArgs } = require('../tools/guard_han_text_arg.cjs')
  const src = "buildLangOverrides(dir, row.hanForced || [], (a && a.trim()) ? a : b)"
  assert.deepEqual(
    topLevelArgs(src, src.indexOf('(')),
    ['dir', 'row.hanForced || []', '(a && a.trim()) ? a : b']
  )
  const two = "normalizeAssignments(pick(forced, {a: 1, b: 2}), direction)"
  assert.equal(topLevelArgs(two, two.indexOf('(')).length, 2)
})
