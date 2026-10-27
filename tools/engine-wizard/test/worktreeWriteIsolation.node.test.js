'use strict'
// 守卫：在 git worktree 里跑向导，写操作不许打进主仓库（PR #13 初审①）。
//
// 做法：临时建一个「主仓库」（有 server.js、跟踪一张 engines/shared/manifest.json），
// 把真的 wizardRoot.js / save.js 拷进去提交，再 git worktree add 出一份 checkout。
// 在子进程里从 worktree 那份代码调 saveManifest / readManifestById，
// 这样 __dirname 就真的落在 worktree 里，跟实际运行位面一致。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CORE = path.join(__dirname, '..', 'core')

function git (cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`)
  return r.stdout
}

function hasGit () {
  return spawnSync('git', ['--version']).status === 0
}

// 主仓库 + worktree 一起建好，返回两个根。
function makeRepoWithWorktree () {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-wt-')))
  const main = path.join(base, 'main')
  const wt = path.join(base, 'wt')
  fs.mkdirSync(path.join(main, 'tools', 'engine-wizard', 'core'), { recursive: true })
  fs.writeFileSync(path.join(main, 'server.js'), '// 锚点\n')
  for (const f of ['wizardRoot.js', 'save.js']) {
    fs.copyFileSync(path.join(CORE, f), path.join(main, 'tools', 'engine-wizard', 'core', f))
  }
  fs.mkdirSync(path.join(main, 'engines', 'shared'), { recursive: true })
  fs.writeFileSync(path.join(main, 'engines', 'shared', 'manifest.json'),
    JSON.stringify({ id: 'shared', label: '主仓库版' }, null, 2) + '\n')
  // 只在主仓库有的引擎：读侧应能跨仓库找到它
  fs.mkdirSync(path.join(main, 'engines', 'mainonly'), { recursive: true })
  fs.writeFileSync(path.join(main, 'engines', 'mainonly', 'manifest.json'),
    JSON.stringify({ id: 'mainonly', label: '只在主仓库' }, null, 2) + '\n')
  git(main, ['init', '-q', '-b', 'main'])
  git(main, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
  git(main, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  git(main, ['worktree', 'add', '-q', wt, '-b', 'exp'])
  return { base, main, wt }
}

// 在子进程里从 worktree 的代码跑一段脚本，脚本的结果走 stdout 的 JSON。
function runInWorktree (wt, body, env = {}) {
  const script = `
    const save = require(${JSON.stringify(path.join(wt, 'tools', 'engine-wizard', 'core', 'save.js'))})
    const out = (${body})(save)
    process.stdout.write(JSON.stringify(out))
  `
  const childEnv = { ...process.env, ...env }
  if (!('WIZARD_PROJECT_ROOT' in env)) delete childEnv.WIZARD_PROJECT_ROOT
  const r = spawnSync(process.execPath, ['-e', script], { cwd: wt, encoding: 'utf8', env: childEnv })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}

const porcelain = (dir) => git(dir, ['status', '--porcelain']).trim()

test('worktree 里保存名片：写进 worktree，主仓库 git status 保持干净', { skip: !hasGit() }, () => {
  const { base, main, wt } = makeRepoWithWorktree()
  try {
    const r = runInWorktree(wt, `(s) => s.saveManifest({ id: 'zz-probe', label: 'x' })`)
    assert.equal(r.ok, true)
    assert.equal(r.path, path.join(wt, 'engines', 'zz-probe', 'manifest.json'))
    assert.ok(fs.existsSync(path.join(wt, 'engines', 'zz-probe', 'manifest.json')))
    assert.ok(!fs.existsSync(path.join(main, 'engines', 'zz-probe')))
    assert.equal(porcelain(main), '', '主仓库工作区被写脏了')

    // 覆盖一张主仓库也有的同名名片：同样只动 worktree
    const r2 = runInWorktree(wt,
      `(s) => s.saveManifest({ id: 'shared', label: 'worktree 版' }, { overwrite: true })`)
    assert.equal(r2.ok, true)
    assert.equal(r2.path, path.join(wt, 'engines', 'shared', 'manifest.json'))
    assert.equal(porcelain(main), '', '主仓库工作区被写脏了')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('同名名片优先读当前 checkout；本地没有的才去主仓库读', { skip: !hasGit() }, () => {
  const { base, main, wt } = makeRepoWithWorktree()
  try {
    // worktree 里把 shared 改掉（未提交），读回来必须是改过的那份
    fs.writeFileSync(path.join(wt, 'engines', 'shared', 'manifest.json'),
      JSON.stringify({ id: 'shared', label: 'worktree 版' }))
    // 删掉 worktree 里的 mainonly，模拟「只在主仓库有」
    fs.rmSync(path.join(wt, 'engines', 'mainonly'), { recursive: true })
    const r = runInWorktree(wt, `(s) => ({
      shared: s.readManifestById('shared'),
      mainonly: s.readManifestById('mainonly'),
      list: s.listInstalled(),
    })`)
    assert.equal(r.shared.manifest.label, 'worktree 版')
    assert.equal(r.shared.path, path.join(wt, 'engines', 'shared', 'manifest.json'))
    assert.equal(r.mainonly.ok, true)
    assert.equal(r.mainonly.path, path.join(main, 'engines', 'mainonly', 'manifest.json'))
    // 列表合并两边，同名只出现一次
    const ids = r.list.map((x) => x.id).sort()
    assert.deepEqual(ids, ['mainonly', 'shared'])
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('设了 WIZARD_PROJECT_ROOT 才写到那里', { skip: !hasGit() }, () => {
  const { base, main, wt } = makeRepoWithWorktree()
  try {
    const r = runInWorktree(wt, `(s) => s.saveManifest({ id: 'zz-explicit', label: 'x' })`,
      { WIZARD_PROJECT_ROOT: main })
    assert.equal(r.ok, true)
    assert.equal(r.path, path.join(main, 'engines', 'zz-explicit', 'manifest.json'))
    assert.ok(!fs.existsSync(path.join(wt, 'engines', 'zz-explicit')))
    // 显式给了才写：主仓库这时理应多出一个未跟踪目录
    assert.match(porcelain(main), /engines\/zz-explicit\//)
    // 不存在的路径当没给：回到本 checkout，不静默建目录
    const r2 = runInWorktree(wt, `(s) => s.saveManifest({ id: 'zz-bad', label: 'x' })`,
      { WIZARD_PROJECT_ROOT: path.join(base, 'nope') })
    assert.equal(r2.path, path.join(wt, 'engines', 'zz-bad', 'manifest.json'))
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('wizardRoot：主仓库里跑时读写同根；worktree 里写根是 worktree', { skip: !hasGit() }, () => {
  const wr = require(path.join(CORE, 'wizardRoot.js'))
  const { base, main, wt } = makeRepoWithWorktree()
  try {
    const env = {}
    assert.equal(wr.writeRoot({ from: main, env }), main)
    assert.deepEqual(wr.readRoots({ from: main, env }), [main])
    assert.equal(wr.mainRepoOf(wt), main)
    assert.equal(wr.writeRoot({ from: wt, env }), wt)
    assert.deepEqual(wr.readRoots({ from: wt, env }), [wt, main])
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
