// SV 特征步（2-get-sv.py）的搜索根守卫。
// preprocess.js 给这条脚本一条 PYTHONPATH，让它能找到自己 import 的裸模块名；
// 这些模块在推理运行时里，不在本项目的 lib/inference，运行时目录一挪搜索根就失效。
// 本用例只读盘上的两个文件：不需要 node_modules、Python 与权重。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const PATHS = require('../../paths')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SV_SCRIPT = path.join(PATHS.GSV_CODE_DIR, 'prepare_datasets', '2-get-sv.py')

// 脚本里行首的裸模块名 import（`import X` 与 `from X import ...`）。
// 带点的包名不算：它们由 gpt-sovits 的父目录解析，不走这些搜索根。
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

// 搜索根从 preprocess.js 里读出来，不在这里重抄一遍：
// 这样改动 preprocess.js 时，本用例才会跟着变红。
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
    // `path.join(x, '..')` 表示取那个常量的父目录作为根。
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

  // 只查那些应当由搜索根提供的模块名，不是 pip 包。
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
