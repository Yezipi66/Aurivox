'use strict'
// requirements 里的 --extra-index-url 会让 uv 默认只查第一个含该包的源。
// uv 在报错里给出 unsafe-best-match 的解法，安装层应按提示重试一次。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runEnv } = require('../core/envInstall.js')

function makeRoot () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-index-retry-'))
  fs.writeFileSync(path.join(root, 'server.js'), '// anchor\n')
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'requirements.txt'), [
    '--extra-index-url https://example.org/simple/',
    'onnxruntime==1.18.0',
  ].join('\n'))
  return root
}

const ok = () => ({ ok: true, code: 'OK', status: 0, stdout: 'Installed', stderr: '' })

test('多索引解析失败时按 uv 提示重试，成功命令记入断点', async () => {
  const root = makeRoot()
  try {
    const calls = []
    let installs = 0
    const runStep = async (step, r, timeout, argv) => {
      calls.push(argv.slice())
      if (argv.includes('venv')) return ok()
      installs += 1
      if (installs === 1) {
        return {
          ok: false, code: 'ENV_FAILED', status: 1, stdout: '',
          stderr: 'hint: `onnxruntime` was found on https://example.org/simple/, '
            + 'but not at the requested version. If all indexes are equally trusted, '
            + 'use `--index-strategy unsafe-best-match`.',
        }
      }
      return ok()
    }
    const lines = []
    const r = await runEnv({
      id: 'demo', root, execute: true, runStep,
      probeImport: () => true,
      onLine: (text) => lines.push(text),
    })
    assert.strictEqual(r.ok, true, '重试成功就不该把整步报成失败')
    assert.strictEqual(installs, 2, '要真的重试一次')
    const retry = calls.find((a) => a.includes('--index-strategy'))
    assert.ok(retry, '重试命令要带 uv 给出的参数')
    assert.deepStrictEqual(retry.slice(retry.indexOf('--index-strategy'), retry.indexOf('--index-strategy') + 2),
      ['--index-strategy', 'unsafe-best-match'])
    assert.ok(r.stepsRun.some((s) => s.ok && String(s.argvKey).includes('unsafe-best-match')),
      '成功的那条命令要写进断点记录')
    assert.ok(lines.some((l) => l.includes('unsafe-best-match')), '重试要有一行可见输出')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('其它失败不重试，也不放宽索引策略', async () => {
  const root = makeRoot()
  try {
    const calls = []
    const runStep = async (step, r, timeout, argv) => {
      calls.push(argv.slice())
      if (argv.includes('venv')) return ok()
      return { ok: false, code: 'ENV_FAILED', status: 1, stdout: '', stderr: 'Failed to build a-package==1.0' }
    }
    const r = await runEnv({ id: 'demo', root, execute: true, runStep, probeImport: () => true })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(calls.filter((a) => a.includes('pip')).length, 1, '不该重试')
    assert.ok(!calls.some((a) => a.includes('--index-strategy')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('重试仍失败时，报的是重试后的真实错误，不是第一次的索引错误', async () => {
  const root = makeRoot()
  try {
    let installs = 0
    const runStep = async (step, r, timeout, argv) => {
      if (argv.includes('venv')) return ok()
      installs += 1
      if (installs === 1) {
        return { ok: false, code: 'ENV_FAILED', status: 1, stdout: '',
          stderr: 'not at the requested version. use `--index-strategy unsafe-best-match`' }
      }
      return { ok: false, code: 'ENV_FAILED', status: 1, stdout: '',
        stderr: 'Failed to build a-package==1.0' }
    }
    const r = await runEnv({ id: 'demo', root, execute: true, runStep, probeImport: () => true })
    assert.strictEqual(r.ok, false)
    assert.match(r.error, /Failed to build a-package/)
    assert.ok(!r.error.includes('not at the requested version'),
      '第一次的索引错误不能冒充最终原因')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('安装失败的执行结果要带出本机后端的 torch 建议', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'wizardbridge.js'), 'utf8')
  const at = src.indexOf('function handleEnv ')
  const body = src.slice(at, at + 7000)
  assert.match(body, /if \(!r\.ok\) \{[\s\S]{0,260}suggestTorchUpgrade\(input\)/)
  assert.match(body, /r\.torchSuggestion = suggestion/)
})

test('源码包缺构建期依赖时，按 uv 提示约束 setuptools 后重试', async () => {
  const root = makeRoot()
  try {
    const calls = []
    let installs = 0
    let constraintText = null
    let constraintPath = null
    const runStep = async (step, r, timeout, argv) => {
      calls.push(argv.slice())
      if (argv.includes('venv')) return ok()
      installs += 1
      if (installs === 1) {
        return { ok: false, code: 'ENV_FAILED', status: 1, stdout: '',
          stderr: "ModuleNotFoundError: No module named 'pkg_resources'\n"
            + "hint: This error likely indicates that openai-whisper depends on pkg_resources, "
            + "but doesn't declare it as a build dependency." }
      }
      const at = argv.indexOf('--build-constraints')
      if (at > 0) {
        constraintPath = argv[at + 1]
        constraintText = fs.readFileSync(constraintPath, 'utf8')
      }
      return ok()
    }
    const r = await runEnv({ id: 'demo', root, execute: true, runStep, probeImport: () => true })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(installs, 2)
    assert.ok(calls.some((a) => a.includes('--build-constraints')))
    assert.match(constraintText || '', /setuptools<81/)
    assert.ok(!fs.existsSync(constraintPath), '临时约束文件要清掉')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('同一轮先多索引、再构建依赖，两次重试按次序叠加', async () => {
  const root = makeRoot()
  try {
    let installs = 0
    const cmds = []
    const runStep = async (step, r, timeout, argv) => {
      if (argv.includes('venv')) return ok()
      installs += 1
      cmds.push(argv.slice())
      if (installs === 1) {
        return { ok: false, code: 'ENV_FAILED', status: 1, stdout: '',
          stderr: 'not at the requested version, use --index-strategy unsafe-best-match' }
      }
      if (installs === 2) {
        return { ok: false, code: 'ENV_FAILED', status: 1, stdout: '',
          stderr: "No module named 'pkg_resources'" }
      }
      return ok()
    }
    const r = await runEnv({ id: 'demo', root, execute: true, runStep, probeImport: () => true })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(installs, 3)
    assert.ok(cmds[1].includes('--index-strategy'))
    assert.ok(cmds[2].includes('--index-strategy'), '后一次要沿用它')
    assert.ok(cmds[2].includes('--build-constraints'))
    assert.ok(r.stepsRun.some((s) => s.ok && String(s.argvKey).includes('--build-constraints')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
