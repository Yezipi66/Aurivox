'use strict'
// installState —— ① 两份进度合并后的读写（env / models 两段互不干扰）
//              ② 「这台引擎装到哪了」的产物判据
//
// 守两件事，各有一条能变红的断言：
//   ① env 写盘不许抹掉 models 的 done（反过来也是）—— 两段合住一个文件，
//      最容易犯的错就是整份重写。
//   ② 对勾只由盘上的产物判：造出/删掉目录树 ⇒ 判据跟着变。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const IS = require('../core/installState.js')

// 守卫（lib/engines/enginesDirWriteGuard.node.test.js:148）要求路径上带临时
//   目录痕迹，否则并行跑会污染真的 engines/ ⇒ 变量名必须带 mkdtemp。
function mkdtempRoot () {
  const mkdtempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-install-'))
  fs.mkdirSync(path.join(mkdtempRootDir, 'engines'), { recursive: true })
  fs.writeFileSync(path.join(mkdtempRootDir, 'server.js'), '// anchor\n')
  return mkdtempRootDir
}

/** 造 engines/<id>/ + 任选内容 */
function mkEngine (root, id, files = []) {
  const mkdtempEngineDir = path.join(root, 'engines', id)
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  for (const f of files) {
    const p = path.join(mkdtempEngineDir, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'x')
  }
  return mkdtempEngineDir
}

// ① 两份进度合并后的读写
test('进度文件名就是 .wizard-install.json（不再写旧的那两个）', () => {
  assert.strictEqual(IS.INSTALL_FILE, '.wizard-install.json')
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1')
    IS.writeProgress(root, 'e1', 'env', new Set(['a']))
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'engines', 'e1')),
      ['.wizard-install.json'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('env 与 models 两段互不干扰（写一段不许抹掉另一段）', () => {
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1')
    IS.writeProgress(root, 'e1', 'env', new Set(['uv venv', 'uv sync']))
    IS.writeProgress(root, 'e1', 'models', new Set(['hf download x']))
    // 两段都还在
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'env')], ['uv venv', 'uv sync'])
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'models')], ['hf download x'])
    // 反过来再写一次 env，models 那段不许被抹掉（整份重写就会抹掉）
    IS.writeProgress(root, 'e1', 'env', new Set(['uv venv']))
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'models')], ['hf download x'],
      '⛔ 写 env 段把 models 段抹掉了 —— 这正是合并成一个文件后最容易犯的错')
    // 而 env 段确实是新的
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'env')], ['uv venv'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('不同引擎的进度互不干扰', () => {
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1')
    mkEngine(root, 'e2')
    IS.writeProgress(root, 'e1', 'env', new Set(['a']))
    IS.writeProgress(root, 'e2', 'env', new Set(['b']))
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'env')], ['a'])
    assert.deepStrictEqual([...IS.readProgress(root, 'e2', 'env')], ['b'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resetProgress 只清自己那一段（不删文件、不动另一段）', () => {
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1')
    IS.writeProgress(root, 'e1', 'env', new Set(['uv venv']))
    IS.writeProgress(root, 'e1', 'models', new Set(['hf download x']))
    IS.resetProgress(root, 'e1', 'env')
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'env')], [],
      '⛔ reset 后 env 段还有东西')
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'models')], ['hf download x'],
      '⛔ reset env 段把 models 段也清了')
    // 文件还在（不是 unlink 整个文件，另一段还在里面）
    assert.ok(fs.existsSync(IS.progressFile(root, 'e1')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resetProgress(section=all) 两段都清', () => {
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1')
    IS.writeProgress(root, 'e1', 'env', new Set(['a']))
    IS.writeProgress(root, 'e1', 'models', new Set(['b']))
    IS.resetProgress(root, 'e1', 'all')
    assert.strictEqual(IS.readProgress(root, 'e1', 'env').size, 0)
    assert.strictEqual(IS.readProgress(root, 'e1', 'models').size, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('损坏的进度文件 ⇒ 按「没有进度」处理（不抛）', () => {
  const root = mkdtempRoot()
  try {
    const d = mkEngine(root, 'e1')
    fs.writeFileSync(IS.progressFile(root, 'e1'), 'not json{{{')
    assert.strictEqual(IS.readProgress(root, 'e1', 'env').size, 0)
    // 写盘能自愈（重新写一份合法形状）
    IS.writeProgress(root, 'e1', 'env', new Set(['a']))
    assert.deepStrictEqual([...IS.readProgress(root, 'e1', 'env')], ['a'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resetProgress 只清进度记录，不动引擎目录里的任何文件', () => {
  const root = mkdtempRoot()
  try {
    const d = mkEngine(root, 'e1', ['manifest.json'])
    IS.writeProgress(root, 'e1', 'env', new Set(['a']))
    IS.resetProgress(root, 'e1', 'env')
    // 源码/名片一个字节都没少
    assert.ok(fs.existsSync(path.join(d, 'manifest.json')))
    assert.deepStrictEqual(fs.readdirSync(d), ['.wizard-install.json', 'manifest.json'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ② 「这台引擎装到哪了」—— 判据必须是盘上的产物
/** 假的 venv 探针（单测不许真 spawn python） */
const venvOk = new Set()

test('伪造目录树 ⇒ 对勾跟着变（克隆 / 名片 / 权重三段）', () => {
  const root = mkdtempRoot()
  try {
    // 什么都没有 ⇒ 一个勾都没有
    let s = IS.installState(root, 'e1', { spawnProbe: (id) => venvOk.has(id) })
    assert.deepStrictEqual(s.steps_done,
      { prepare: false, env: false, models: false, manifest: false, verify: false })

    // 克隆了（有内容）⇒ prepare 打勾
    const d = mkEngine(root, 'e1', ['README.md'])
    s = IS.installState(root, 'e1', { spawnProbe: (id) => venvOk.has(id) })
    assert.strictEqual(s.steps_done.prepare, true)
    assert.strictEqual(s.steps_done.env, false, '⛔ 只克隆了就算环境建好了？')

    // venv 能起来 ⇒ env 打勾
    venvOk.add('e1')
    s = IS.installState(root, 'e1', { spawnProbe: (id) => venvOk.has(id) })
    assert.strictEqual(s.steps_done.env, true)

    // venv 又起不来了（用户删了 .venv），env 勾必须消失
    venvOk.delete('e1')
    s = IS.installState(root, 'e1', { spawnProbe: () => false })
    assert.strictEqual(s.steps_done.env, false,
      '⛔ 环境没了还显示装好了 —— 那是个假绿灯')

    // 写了名片 ⇒ manifest 打勾
    mkEngine(root, 'e1', ['manifest.json'])
    fs.writeFileSync(path.join(d, 'manifest.json'), '{"id":"e1"}')
    s = IS.installState(root, 'e1', { spawnProbe: () => false })
    assert.strictEqual(s.steps_done.manifest, true)

    // 下了权重 ⇒ models 打勾
    fs.mkdirSync(path.join(d, 'checkpoints'), { recursive: true })
    s = IS.installState(root, 'e1', { spawnProbe: () => false })
    assert.strictEqual(s.steps_done.models, false, '⛔ 空 checkpoints 目录也算下好了？')
    fs.writeFileSync(path.join(d, 'checkpoints', 'm.safetensors'), 'x'.repeat(32))
    s = IS.installState(root, 'e1', { spawnProbe: () => false })
    assert.strictEqual(s.steps_done.models, true)

    // 权重是一个 0 字节的半截文件 ⇒ 如实报「有目录但空的」（ready=false）
    //   先删掉再写 0 字节：writeFileSync 不会截断已存在文件的旧内容
    fs.rmSync(path.join(d, 'checkpoints', 'm.safetensors'), { force: true })
    fs.writeFileSync(path.join(d, 'checkpoints', 'm.safetensors'), '')
    s = IS.installState(root, 'e1', { spawnProbe: () => false })
    assert.strictEqual(s.steps.models.ready, false, '⛔ 半截文件要如实报「有目录但空的」')
    // 「确实缺了」也算查过了（steps.js 的 stepDone 就是这个判据）⇒ done 为真
    assert.strictEqual(s.steps_done.models, true,
      '⛔ ready=false（确实缺了）不算查过 —— steps.js stepDone 明确算')
  } finally {
    venvOk.clear()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('空目录不算克隆（git 报 not empty 那个坑的反面）', () => {
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1')           // 建了目录，一个文件都没有
    const s = IS.installState(root, 'e1', { spawnProbe: () => true })
    assert.strictEqual(s.steps_done.prepare, false,
      '⛔ 空目录被当成克隆完成 —— 那正是 git clone 要拦的形状')
    // 而 env 也不该有勾（没有克隆就没有环境）
    assert.strictEqual(s.steps_done.env, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('verify 恒 false（这一步的检测逻辑尚未实现，不许伪装成对勾）', () => {
  const root = mkdtempRoot()
  try {
    const d = mkEngine(root, 'e1', ['manifest.json'])
    fs.writeFileSync(path.join(d, 'manifest.json'), '{}')
    fs.mkdirSync(path.join(d, 'checkpoints'), { recursive: true })
    fs.writeFileSync(path.join(d, 'checkpoints', 'm.bin'), 'xx')
    const s = IS.installState(root, 'e1', { spawnProbe: () => true })
    assert.strictEqual(s.steps_done.verify, false)
    assert.strictEqual(s.steps.verify.why, 'not-implemented')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('权重目录都没有 ⇒ 三态的 null（说不出来），不糊成 false', () => {
  const root = mkdtempRoot()
  try {
    mkEngine(root, 'e1', ['README.md'])
    const s = IS.installState(root, 'e1', { spawnProbe: () => true })
    assert.strictEqual(s.steps.models.ready, null,
      '⛔ 没有 checkpoints 目录要说「说不出来」，不是「缺了」')
    assert.strictEqual(s.steps_done.models, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('manifest.json 是坏 JSON ⇒ 不算打了勾（半个文件不是产物）', () => {
  const root = mkdtempRoot()
  try {
    const d = mkEngine(root, 'e1', ['README.md'])
    fs.writeFileSync(path.join(d, 'manifest.json'), '{"id":')
    const s = IS.installState(root, 'e1', { spawnProbe: () => true })
    assert.strictEqual(s.steps_done.manifest, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('installState 里不出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice', 'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'installState.js'), 'utf8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})
