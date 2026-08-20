// Contract guards for per-position Han-language overrides (r12b-fix6).
//
// The behaviour of the web side is tested in
// web/src/lib/hanLanguage.stale.node.test.js. What cannot be tested there is
// the part of the contract that spans the process boundary:
//
//   * the engine must drop the same entries the web side prunes, because the
//     payload can also arrive from a saved recipe that predates the fix;
//   * both sides must agree on what counts as a Han character, or the picker
//     offers a selection the engine silently ignores;
//   * no call site may forget to pass the text the @N indices refer to.
//
// Each assertion below was confirmed red against the pre-fix tree.
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
  // Divergence here is silent in the worst way: the picker draws a character
  // the user can select, and the engine then drops the selection with no error
  // anywhere. U+F900-U+FAFF was on the web side only until 2026-08-17.
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
  // C10: a check that has never been seen red is not a check. Build the exact
  // mistake the guard exists to catch and confirm it is reported.
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

    // ...and does NOT fire on the corrected form, so it is discriminating and
    // not simply always-red.
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
  // A naive regex counts the comma in `f(a, g(b, c))` and calls it three
  // arguments. That would make the guard pass on real code that is wrong.
  const { topLevelArgs } = require('../tools/guard_han_text_arg.cjs')
  const src = "buildLangOverrides(dir, row.hanForced || [], (a && a.trim()) ? a : b)"
  assert.deepEqual(
    topLevelArgs(src, src.indexOf('(')),
    ['dir', 'row.hanForced || []', '(a && a.trim()) ? a : b']
  )
  const two = "normalizeAssignments(pick(forced, {a: 1, b: 2}), direction)"
  assert.equal(topLevelArgs(two, two.indexOf('(')).length, 2)
})
