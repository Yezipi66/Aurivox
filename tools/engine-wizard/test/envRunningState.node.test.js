const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// venv 建好后解释器就能启动，但依赖仍在安装。若只以解释器能否启动
//   为判据，第 2 步刚开始就会被报成已完成。这一组守卫盯住进行中标记的
//   写入、清理、过期与跨引擎隔离。

const ROOT = path.resolve(__dirname, '..', '..', '..')
const IS = require(path.join(ROOT, 'tools', 'engine-wizard', 'core', 'installState.js'))

function mkdtempRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-env-running-'))
}

function mkEngine (root, id) {
  const dir = path.join(root, 'engines', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), id)
  return dir
}

test('安装进行中即使 venv 可启动也不打勾', () => {
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1')
    IS.markEnvRunning(root, 'e1', true)
    const s = IS.installState(root, 'e1', { spawnProbe: () => true })
    assert.strictEqual(s.steps_done.env, false)
    assert.strictEqual(s.steps.env.why, 'install-running')
    assert.ok(s.artifacts.envRunning && s.artifacts.envRunning.at)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('执行结果写入后清掉进行中标记，成功与失败都一样', () => {
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1')
    IS.markEnvRunning(root, 'e1', true)
    IS.markEnvResult(root, 'e1', { ok: true, code: 'OK' })
    assert.strictEqual(IS.envRunning(root, 'e1'), null)
    IS.markEnvRunning(root, 'e1', true)
    IS.markEnvResult(root, 'e1', { ok: false, code: 'ENV_FAILED' })
    assert.strictEqual(IS.envRunning(root, 'e1'), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('重置第 2 步时一并清掉进行中标记', () => {
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1')
    IS.markEnvRunning(root, 'e1', true)
    IS.resetProgress(root, 'e1', 'env')
    const s = IS.installState(root, 'e1', { spawnProbe: () => true })
    assert.strictEqual(s.steps_done.env, true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('过期的进行中标记不再压住完成判定', () => {
  const root = mkdtempRoot()
  try {
    const dir = mkEngine(root, 'e1')
    const f = path.join(dir, IS.INSTALL_FILE)
    fs.writeFileSync(f, JSON.stringify({
      engine: 'e1', envRunning: { at: '2000-01-01T00:00:00.000Z' },
    }))
    assert.strictEqual(IS.envRunning(root, 'e1'), null)
    const s = IS.installState(root, 'e1', { spawnProbe: () => true })
    assert.strictEqual(s.steps_done.env, true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('另一台引擎的进行中标记不继承', () => {
  const root = mkdtempRoot()
  try {
    const dir = mkEngine(root, 'e1')
    fs.writeFileSync(path.join(dir, IS.INSTALL_FILE), JSON.stringify({
      engine: 'other', envRunning: { at: new Date().toISOString() },
    }))
    assert.strictEqual(IS.envRunning(root, 'e1'), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('env 端点在执行前写入进行中标记', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'tools', 'engine-wizard', 'core', 'wizardbridge.js'), 'utf8')
  const at = src.indexOf('markEnvRunning(input.root || projectRoot()')
  const runAt = src.indexOf('runEnv(input).then(')
  assert.ok(at > 0, '进行中标记没有接进 env 端点')
  assert.ok(at < runAt, '标记必须在执行之前写入')
})
