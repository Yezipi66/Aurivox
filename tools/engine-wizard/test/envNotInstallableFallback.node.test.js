'use strict'
// 上游的 pyproject.toml 只是一份工具配置（没有项目表、没有构建后端），把它当安装目标会
// 在构建阶段被 setuptools 拒绝。安装层遇到这类报错时改走同目录的 requirements.txt：
// 依赖版本交给 uv 解析，平台不猜版本、也不改上游声明。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runEnv } = require('../core/envInstall.js')

const MANIFEST = { install: { env_command: ['uv', 'pip', 'install', '-e', '.'] } }

// 上游画成最常见的那种：67 字节的 pyproject（只有 lint 配置）加上真正的 requirements.txt。
function makeRoot ({ withRequirements = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-not-installable-'))
  fs.writeFileSync(path.join(root, 'server.js'), '// anchor\n')
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pyproject.toml'),
    '[tool.isort]\nprofile = "black"\n\n[tool.black]\nline-length = 88\n')
  if (withRequirements) {
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'numpy\nsoundfile\n')
  }
  return root
}

const ok = () => ({ ok: true, code: 'OK', status: 0, stdout: 'Installed', stderr: '' })
const flatLayout = () => ({
  ok: false, code: 'ENV_FAILED', status: 1, stdout: '',
  stderr: 'error: Multiple top-level packages discovered in a flat-layout: '
    + "['egs', 'assets', 'runtime', 'zipvoice'].",
})

test('pyproject 不可安装时静默改走 requirements.txt，并记入断点', async () => {
  const root = makeRoot()
  try {
    const calls = []
    let installs = 0
    const runStep = async (step, r, timeout, argv) => {
      calls.push(argv.slice())
      if (argv.includes('venv')) return ok()
      installs += 1
      return installs === 1 ? flatLayout() : ok()
    }
    const lines = []
    const r = await runEnv({
      id: 'demo', root, manifest: MANIFEST, execute: true, runStep,
      probeImport: () => true,
      onLine: (text) => lines.push(text),
    })
    assert.strictEqual(r.ok, true, '回退成功后整步不该报失败')
    assert.strictEqual(installs, 2, '要真的换一条命令再跑一次')
    const retry = calls.find((a) => a.includes('-r'))
    assert.ok(retry, '重试命令要带 -r')
    assert.strictEqual(retry[retry.indexOf('-r') + 1], 'requirements.txt')
    assert.ok(!retry.includes('-e'), '重试命令里不该还留着 -e')
    assert.ok(r.stepsRun.some((s) => s.ok && String(s.argvKey).includes('-r requirements.txt')),
      '成功的那条命令要写进断点记录，重跑才不会又走 -e')
    assert.ok(lines.some((l) => l.includes('requirements.txt')),
      '换了命令要有一行可见输出，否则使用者不知道装的是哪一份清单')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('两种「不是可安装项目」的报错都认', async () => {
  for (const stderr of [
    'warning: `engines/demo` does not appear to be a Python project, as the '
      + '`pyproject.toml` does not include a `[build-system]` table, and neither '
      + '`setup.py` nor `setup.cfg` are present in the directory',
    'Caused by: Call to `setuptools.build_meta:__legacy__.build_editable` failed (exit code: 1)',
  ]) {
    const root = makeRoot()
    try {
      let installs = 0
      const seen = []
      const runStep = async (step, r, timeout, argv) => {
        if (argv.includes('venv')) return ok()
        seen.push(argv.slice())
        installs += 1
        return installs === 1 ? { ok: false, code: 'ENV_FAILED', status: 1, stdout: '', stderr } : ok()
      }
      const r = await runEnv({ id: 'demo', root, manifest: MANIFEST, execute: true, runStep,
        probeImport: () => true })
      assert.strictEqual(r.ok, true, `这类报错要回退：${stderr.slice(0, 40)}`)
      assert.ok(seen.some((a) => a.includes('-r')), '回退命令没出现')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('目录里没有 requirements.txt 时不回退，如实报错', async () => {
  const root = makeRoot({ withRequirements: false })
  try {
    let installs = 0
    const runStep = async (step, r, timeout, argv) => {
      if (argv.includes('venv')) return ok()
      installs += 1
      return flatLayout()
    }
    const r = await runEnv({ id: 'demo', root, manifest: MANIFEST, execute: true, runStep,
      probeImport: () => true })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(installs, 1, '没有可换的清单就不该重试')
    assert.match(r.error, /Multiple top-level packages/, '原始报错要原样带出来')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('别的构建失败（真编不出来）不触发回退', async () => {
  const root = makeRoot()
  try {
    let installs = 0
    const runStep = async (step, r, timeout, argv) => {
      if (argv.includes('venv')) return ok()
      installs += 1
      return { ok: false, code: 'ENV_FAILED', status: 1, stdout: '',
        stderr: 'error: command "cl.exe" failed: No such file or directory' }
    }
    const r = await runEnv({ id: 'demo', root, manifest: MANIFEST, execute: true, runStep,
      probeImport: () => true })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(installs, 1, '编译失败换清单也没用，不该重试')
    assert.match(r.error, /cl\.exe/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('本来就是 -r 的命令不会被再加一个 -r', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'envInstall.js'), 'utf8')
  const at = src.indexOf('function switchToRequirements')
  const body = src.slice(at, at + 900)
  assert.match(body, /argv\.includes\('-r'\)/, '要挡住已经走 -r 的命令')
  assert.match(body, /existsSync\(path\.join\(dir, 'requirements\.txt'\)\)/,
    '回退的前提是目录里真有 requirements.txt')
})
