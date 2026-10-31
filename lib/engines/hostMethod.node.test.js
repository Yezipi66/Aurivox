'use strict'
// host.py 的 validate_request：method 不在名片的方法表里时由宿主 400。
// 服务层对单方法引擎不抢答，这条 400 就是那条规则的落点；这里真跑一次 Python 纯函数。
// 名片夹具都显式写 call.seed："none"：host.py 对没写 seed 的名片直接拒绝启动（契约 §5.2.1），
// 而这里要测的是 method，不是 seed。

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const HOST = path.join(__dirname, 'host.py')
const PY = process.platform === 'win32' ? 'python' : 'python3'

function validate (profile, body) {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("host", ${JSON.stringify(HOST)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'p = json.loads(sys.argv[1]); b = json.loads(sys.argv[2])',
    'plan = m.SeedPlan((p.get("call") or {}).get("seed"))',
    'print(json.dumps(m.validate_request(b, p, plan)))',
  ].join('\n')
  const r = spawnSync(PY, ['-c', code, JSON.stringify(profile), JSON.stringify(body)], { encoding: 'utf8' })
  if (r.error) return { skip: r.error.message }
  assert.equal(r.status, 0, r.stderr)
  return { result: JSON.parse(r.stdout) }
}

test('单方法引擎收到别的 method ⇒ 400，并列出可用方法', (t) => {
  const profile = { id: 'engine-x', call: { method: 'only', seed: 'none' }, params: {} }
  const r = validate(profile, { method: 'other', text: 'hi' })
  if (r.skip) { t.skip(`本机没有 ${PY}：${r.skip}`); return }

  assert.equal(r.result[0], 400)
  assert.match(r.result[1], /'method'='other' is not available on engine-x/)
  assert.deepStrictEqual(r.result[2].available_methods, ['only'])
})

test('单方法引擎收到同名 method ⇒ 放行', (t) => {
  const profile = { id: 'engine-x', call: { method: 'only', seed: 'none' }, params: {} }
  const r = validate(profile, { method: 'only', text: 'hi' })
  if (r.skip) { t.skip(`本机没有 ${PY}：${r.skip}`); return }

  assert.equal(r.result, null)
})

test('多方法引擎收到表外 method ⇒ 400，并列出方法表', (t) => {
  const profile = { id: 'engine-y', call: { methods: { zero_shot: {}, vc: {} }, default_method: 'zero_shot', seed: 'none' }, params: {} }
  const r = validate(profile, { method: 'nope', text: 'hi' })
  if (r.skip) { t.skip(`本机没有 ${PY}：${r.skip}`); return }

  assert.equal(r.result[0], 400)
  assert.deepStrictEqual(r.result[2].available_methods, ['vc', 'zero_shot'])
})
