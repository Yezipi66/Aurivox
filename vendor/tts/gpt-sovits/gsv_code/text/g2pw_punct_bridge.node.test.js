// Runs g2pw_punct_test.py as part of `npm test`.
//
// That suite guards the layer that restores full-width punctuation before g2pW
// inference. Without it, a half-width full stop stops looking like the end of a
// sentence to a model trained on full-width Chinese, and the polyphone right
// before it is read wrong -- g2pW('了一半.') answers liao3 where
// g2pW('了一半。') answers le5.
//
// It also guards the pair-up: the model echoes punctuation back verbatim, so
// the full-width marks have to be converted back before the phoneme table sees
// them. chinese2.py asserts `c in punctuation`, and that list is half-width
// only, so skipping the return trip raises AssertionError on every Chinese line.
//
// Like auto_language_test.py this file imports nothing beyond the standard
// library (it lifts the functions out of chinese2.py with `ast`), so it needs
// no torch, no transformers and no g2pW weights.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const SUITE = path.join(__dirname, 'g2pw_punct_test.py')

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

test('the g2pW punctuation round trip suite passes', (t) => {
  assert.ok(fs.existsSync(SUITE), 'g2pw_punct_test.py is missing')
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
    'g2pw_punct_test.py failed:\n' + (result.stderr || '') + (result.stdout || ''),
  )
  const ran = /Ran (\d+) tests?/.exec(result.stderr || '')
  assert.ok(ran, 'could not read the test count from the Python suite output')
  assert.ok(Number(ran[1]) >= 13, `the Python suite shrank to ${ran[1]} tests`)
})
