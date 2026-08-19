// Runs auto_language_test.py as part of `npm test`.
//
// That file is a 31-case regression suite for the Auto language router and the
// per-position overrides, and until 2026-08-17 nothing ever executed it: the
// runner only collects *.node.test.js, so a full green run said nothing about
// it. It had been sitting there with a test that asserted a known defect,
// waiting for a fix that would flip it -- and a green suite would never have
// told anyone. This bridge closes that gap.
//
// The Python file deliberately imports nothing beyond the standard library
// (it pulls the routing functions out of TextPreprocessor.py with `ast`), so
// any Python 3 on the machine can run it -- no venv, no torch, no weights.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const SUITE = path.join(__dirname, 'auto_language_test.py')

// The project venv first (that is what the app itself runs), then whatever is
// on PATH. Windows and POSIX layouts both listed explicitly rather than shelled
// out to, because the runner must not depend on a shell.
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

test('the Auto language router suite passes', (t) => {
  assert.ok(fs.existsSync(SUITE), 'auto_language_test.py is missing')
  const python = findPython()
  if (!python) {
    // A skip is a lie unless it names what is missing and why that is
    // acceptable. Here it is: there is no Python at all on this machine, so
    // the app itself cannot run either.
    t.skip('no Python 3 interpreter found (checked venv/ and PATH); ' +
           'the engine cannot run on this machine either')
    return
  }
  const result = spawnSync(python, [SUITE], { cwd: ROOT, encoding: 'utf8' })
  assert.ok(!result.error, `failed to launch ${python}: ${result.error && result.error.message}`)
  assert.equal(
    result.status,
    0,
    'auto_language_test.py failed:\n' + (result.stderr || '') + (result.stdout || ''),
  )
  // The suite prints its own count. Assert it is not empty, so a file that
  // silently stops collecting tests cannot pass as green.
  const ran = /Ran (\d+) tests?/.exec(result.stderr || '')
  assert.ok(ran, 'could not read the test count from the Python suite output')
  assert.ok(Number(ran[1]) >= 36, `the Python suite shrank to ${ran[1]} tests`)
})
