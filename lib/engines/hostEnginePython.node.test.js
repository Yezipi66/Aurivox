'use strict'
// host.py 的 {engine_python}：runtime.python 是虚拟环境目录，展开出来必须是目录里的解释器。
//   展开成目录本身时，cli 形态每次合成都以 PermissionError 失败（把目录当命令执行）。
// 真跑一次 host.py 里的纯函数（不起服务、不装上游）：只读字面量测不出展开结果。
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { venvPythonRelPath } = require('./platformPaths')

const HOST = path.join(__dirname, 'host.py')
const PY = process.platform === 'win32' ? 'python' : 'python3'

function expand (profile, argv) {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("host", ${JSON.stringify(HOST)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'p = json.loads(sys.argv[1])',
    'print(json.dumps(m.build_cli_argv({"argv": json.loads(sys.argv[2]), "bind": {"text": "--text"}}, p, {"text": "hi"}, {})))',
  ].join('\n')
  const r = spawnSync(PY, ['-c', code, JSON.stringify(profile), JSON.stringify(argv)], { encoding: 'utf8' })
  if (r.error) return { skip: r.error.message }
  assert.equal(r.status, 0, r.stderr)
  return { argv: JSON.parse(r.stdout) }
}

test('{engine_python} 展开成虚拟环境里的解释器，不是虚拟环境目录', (t) => {
  const root = path.resolve(__dirname, '..', '..')
  const profile = { dir: path.join(root, 'engines', 'demo'), runtime: { python: 'engines/demo/.venv' } }
  const r = expand(profile, ['{engine_python}', '-m', 'demo.cli', 'synth'])
  if (r.skip) { t.skip(`本机没有 ${PY}：${r.skip}`); return }
  assert.equal(r.argv[0], path.join(root, 'engines', 'demo', '.venv', venvPythonRelPath(process.platform)))
  assert.deepStrictEqual(r.argv.slice(1), ['-m', 'demo.cli', 'synth', '--text', 'hi'])
})
