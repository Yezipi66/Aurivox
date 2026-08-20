// Runs frontend_guards_test.py as part of `npm test`.
//
// That suite guards the four silent-failure fixes in the text front end:
//
//   1. seg_reconcile   -- the segmenter's pieces must add back up to the text
//                         it was given. On the real detector three of
//                         twenty-eight probe samples came back short: a comma
//                         between digits and Han, the space after a comma in
//                         Korean, the space after a question mark in English.
//                         A comma is a pause and a space is a word boundary,
//                         so this changed the prosody with no error anywhere
//                         and nothing the user could proofread -- the text on
//                         screen and the text being read aloud had become two
//                         different strings.
//   2. runtime_status  -- five places catch an exception, carry on with a
//                         worse result and print one line into a subprocess
//                         log. Each of them now also sets a status bit that a
//                         program can read back afterwards.
//   3. en_hyphen       -- qryword() had no step that knew what a hyphen was,
//                         so `re-run` was never found and came back predicted
//                         as R IY0 AO1 R N. Join before split, because split
//                         gives RE = R EY1, the re of do-re-mi.
//   4. wiring          -- english.py, chinese2.py and TextPreprocessor.py
//                         actually call all of the above. A rule enforced only
//                         inside a helper nobody calls is not enforced.
//
// Like auto_language_test.py this suite imports nothing beyond the standard
// library, so it needs no torch, no nltk, no wordsegment and no weights.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const SUITE = path.join(__dirname, 'frontend_guards_test.py')

function findPython() {
  const candidates = [
    path.join(ROOT, 'venv', 'Scripts', 'python.exe'),
    path.join(ROOT, 'venv', 'bin', 'python'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  for (const name of ['python3', 'python']) {
    const probe = spawnSync(name, ['-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'])
    if (!probe.error && probe.status === 0) return name
  }
  return null
}

test('the text front end guard suite passes', (t) => {
  assert.ok(fs.existsSync(SUITE), 'frontend_guards_test.py is missing')
  const python = findPython()
  if (!python) {
    t.skip('no Python 3 interpreter found (checked venv/ and PATH); ' +
           'the engine cannot run on this machine either')
    return
  }
  const result = spawnSync(python, [SUITE], { cwd: ROOT, encoding: 'utf8' })
  assert.ok(!result.error, `failed to launch ${python}: ${result.error && result.error.message}`)
  assert.equal(
    result.status,
    0,
    'frontend_guards_test.py failed:\n' + (result.stderr || '') + (result.stdout || ''),
  )
  const ran = /Ran (\d+) tests?/.exec(result.stderr || '')
  assert.ok(ran, 'could not read the test count from the Python suite output')
  assert.ok(Number(ran[1]) >= 34, `the Python suite shrank to ${ran[1]} tests`)
})
