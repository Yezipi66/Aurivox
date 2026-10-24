'use strict'
// checkpointsPath：权重落盘路径只有一处答案。
//
// 守三件事，各有一条能变红的断言：
//   ① 落盘路径的相对写法是 engines/<id>/checkpoints：写错这一处，
//      第 3 步下载、第 5 步判断、第 4 步声明会各说各的，
//      症状是「第 3 步说下好了、第 5 步说目录不存在」。
//   ② 引擎 id 带路径分隔符时拒绝出路径：拼出来的路径必须仍落在 engines/<id>/ 里，
//      否则一个 id 就能把权重写到 engines/ 之外。
//   ③ installState 报出来的 checkpoints_path 与落盘路径同一个值：
//      第 4 步自动填的就是这个字段，它与第 3 步写盘处不一致的话，闭环就是断的。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { checkpointsRelPath, checkpointsAbsPath } = require('../core/checkpointsPath.js')
const { installState } = require('../core/installState.js')

// 守卫（lib/engines/enginesDirWriteGuard.node.test.js 的 offenders）要求路径上带临时
//   目录痕迹，否则并行跑会污染真的 engines/ ⇒ 变量名必须带 mkdtemp。
function mkdtempRoot () {
  const mkdtempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-cppath-'))
  fs.mkdirSync(path.join(mkdtempRootDir, 'engines'), { recursive: true })
  fs.writeFileSync(path.join(mkdtempRootDir, 'server.js'), '// anchor\n')
  return mkdtempRootDir
}

// ① 相对路径的写法
test('落盘路径是 engines/<id>/checkpoints（相对项目根）', () => {
  assert.equal(checkpointsRelPath('index-tts'), 'engines/index-tts/checkpoints')
  assert.equal(checkpointsRelPath('my.engine'), 'engines/my.engine/checkpoints')
})

test('绝对路径由相对路径加项目根拼出来，落在同一处', () => {
  const root = mkdtempRoot()
  const abs = checkpointsAbsPath(root, 'index-tts')
  assert.equal(abs, path.join(root, 'engines', 'index-tts', 'checkpoints'))
})

// ② id 不许带路径分隔符
test('引擎 id 带路径分隔符时不出路径（不许写到 engines/ 之外）', () => {
  assert.equal(checkpointsRelPath('../escape'), null)
  assert.equal(checkpointsRelPath('a/b'), null)
  assert.equal(checkpointsRelPath('a\\b'), null)
  assert.equal(checkpointsRelPath('..'), null)
  assert.equal(checkpointsRelPath('.'), null)
  assert.equal(checkpointsRelPath(''), null)
  assert.equal(checkpointsRelPath(null), null)
})

test('id 不合法时绝对路径也是空，不给半个路径', () => {
  const root = mkdtempRoot()
  assert.equal(checkpointsAbsPath(root, '../escape'), null)
})

// ③ installState 报出来的路径与落盘路径同源
test('installState 的 checkpoints_path 与落盘路径同一个值', () => {
  const root = mkdtempRoot()
  fs.mkdirSync(path.join(root, 'engines', 'index-tts', 'checkpoints'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engines', 'index-tts', 'checkpoints', 'gpt.pth'), 'x')
  const st = installState(root, 'index-tts')
  assert.equal(st.checkpoints_path, checkpointsRelPath('index-tts'))
  assert.equal(
    path.resolve(root, st.checkpoints_path),
    checkpointsAbsPath(root, 'index-tts'))
})

test('installState 的 artifacts.checkpointsDir 指向同一个目录', () => {
  const root = mkdtempRoot()
  fs.mkdirSync(path.join(root, 'engines', 'index-tts'), { recursive: true })
  const st = installState(root, 'index-tts')
  assert.equal(st.artifacts.checkpointsDir, checkpointsAbsPath(root, 'index-tts'))
})

test('第 3 步的判据看的就是这个目录：目录里有文件才算数', () => {
  const root = mkdtempRoot()
  const cpDir = checkpointsAbsPath(root, 'index-tts')
  fs.mkdirSync(cpDir, { recursive: true })

  // 空目录 ⇒ 说不出来
  assert.equal(installState(root, 'index-tts').steps.models.ready, null)

  // 放一个非空文件 ⇒ 在
  fs.writeFileSync(path.join(cpDir, 'gpt.pth'), 'x')
  const st = installState(root, 'index-tts')
  assert.equal(st.steps.models.ready, true)
  assert.equal(st.steps.models.why, 'present')
})

test('installState 里不出现任何具体引擎名', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'installState.js'), 'utf8')
  for (const name of ['index-tts', 'indextts2', 'cosyvoice2', 'gpt-sovits', 'spark-tts']) {
    assert.ok(!src.includes(name), 'installState.js 里不该出现引擎名：' + name)
  }
})

test('checkpointsPath.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'checkpointsPath.js'), 'utf8')
  // 口径与 download.node.test.js 同一条：只看活代码，注释里的举例不算。
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})
