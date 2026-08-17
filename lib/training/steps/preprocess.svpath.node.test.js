// Guard for the SV feature step (2-get-sv.py).
//
// preprocess.js hands that script a PYTHONPATH so it can resolve the bare
// module names it imports. Those modules live in the INFERENCE RUNTIME, not in
// our own lib/inference, so moving the runtime silently invalidates the search
// root. Without this test the breakage only shows up when someone actually
// fine-tunes a v2Pro voice, and the symptom (missing SV features) is far away
// from the cause.
//
// This test needs no node_modules, no python and no weights: it reads the two
// files off disk and checks that the directory preprocess.js points at really
// contains the modules 2-get-sv.py asks for.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const PATHS = require('../../paths')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SV_SCRIPT = path.join(PATHS.GSV_CODE_DIR, 'prepare_datasets', '2-get-sv.py')

// Bare `import X` / `from X import ...` at the start of a line, ignoring
// dotted packages (those resolve through the gsv_code parent root instead).
function bareImports(source) {
  const names = new Set()
  for (const line of source.split(/\r?\n/)) {
    const m = /^\s*(?:import\s+([A-Za-z_]\w*)|from\s+([A-Za-z_]\w*)\s+import)\b/.exec(line)
    if (m) names.add(m[1] || m[2])
  }
  return names
}

function resolvesIn(dir, name) {
  return fs.existsSync(path.join(dir, name + '.py')) ||
         fs.existsSync(path.join(dir, name, '__init__.py'))
}

// Read the search roots out of preprocess.js itself rather than restating
// them here, so that editing preprocess.js is what this test reacts to.
function svSearchRoots() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'training', 'steps', 'preprocess.js'), 'utf8')
  const line = src.split(/\r?\n/).find(l => /PYTHONPATH/.test(l) && /2\b|gsvInfer|inferenceDir/.test(l))
  assert.ok(line, 'could not find the SV step PYTHONPATH line in preprocess.js')

  const roots = []
  for (const m of line.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
    const name = m[1]
    const decl = new RegExp(`const\\s+${name}\\s*=\\s*PATHS\\.([A-Z_]+)\\s*;`).exec(src)
    if (!decl) continue
    const value = PATHS[decl[1]]
    assert.ok(value, `preprocess.js reads PATHS.${decl[1]}, which paths.js does not export`)
    // `path.join(x, '..')` means the parent of that constant is the root.
    const parent = new RegExp(`path\\.join\\(\\s*${name}\\s*,\\s*['"]\\.\\.['"]`).test(line)
    roots.push(parent ? path.dirname(value) : value)
  }
  assert.ok(roots.length >= 2,
    `expected at least two search roots on the SV PYTHONPATH line, got ${roots.length}`)
  return roots
}

test('the SV step PYTHONPATH resolves every module 2-get-sv.py imports', () => {
  assert.ok(fs.existsSync(SV_SCRIPT), `2-get-sv.py not found at ${SV_SCRIPT}`)

  const roots = svSearchRoots()
  for (const r of roots) {
    assert.ok(fs.existsSync(r), `PYTHONPATH root does not exist: ${r}`)
  }

  // Modules that ship inside this repo, as opposed to pip packages.
  const local = ['sv', 'kaldi', 'ERes2NetV2', 'ERes2Net', 'ERes2Net_huge',
                 'fusion', 'pooling_layers']
  const wanted = [...bareImports(fs.readFileSync(SV_SCRIPT, 'utf8'))].filter(n => local.includes(n))

  assert.ok(wanted.length > 0,
    '2-get-sv.py no longer imports any in-repo module — update this test')

  const unresolved = wanted.filter(n => !roots.some(r => resolvesIn(r, n)))
  assert.deepStrictEqual(unresolved, [],
    `2-get-sv.py imports ${unresolved.join(', ')} but no PYTHONPATH root provides them.\n` +
    `roots: ${roots.join(path.delimiter)}`)
})

test('preprocess.js builds that PYTHONPATH from GSV_INFER_DIR, not INFERENCE_DIR', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'training', 'steps', 'preprocess.js'), 'utf8')
  const line = src.split(/\r?\n/).find(l => l.includes('PYTHONPATH') && l.includes('gsvInfer'))
  assert.ok(line, 'no PYTHONPATH line referencing gsvInfer found in preprocess.js')
  assert.ok(/GSV_INFER_DIR/.test(src),
    'preprocess.js should take the inference search root from PATHS.GSV_INFER_DIR')
  assert.ok(!/PATHS\.INFERENCE_DIR/.test(src),
    'preprocess.js still uses PATHS.INFERENCE_DIR as a python search root')
})
