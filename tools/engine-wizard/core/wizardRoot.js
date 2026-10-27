'use strict'
// 向导的「根」解析：读和写分开定。
//
// 规则（PR #13 初审①）：
//   写：一律落在本 checkout（本 worktree）。只有显式设了环境变量 WIZARD_PROJECT_ROOT
//       才写到那里；不靠 .git 文件自动猜主仓库。worktree 是拿来隔离实验的，
//       在里面点一次保存就改了主仓库工作区（主仓库此刻可能在别的分支上），等于没隔离。
//   读：可以跨仓库。按 WIZARD_PROJECT_ROOT → 本 checkout → 主仓库的顺序找，
//       先找到的胜出。所以本 checkout 里同名的名片盖住主仓库那份：改了能读到自己改的。
//       跨仓库读是为了「环境、权重在主仓库，worktree 里看不到」这类只读资产。
//
// 判据：git worktree 的 .git 是一个文件（gitdir: <主仓库>/.git/worktrees/<名字>），
// 主仓库的 .git 是目录。
//
// 每个函数都收一个可选的 opts：{ from, env }，from 是向上找 server.js 的起点，
// env 默认 process.env。测试靠它在临时仓库里复现 worktree，不用改全局状态。

const fs = require('node:fs')
const path = require('node:path')

// 从 startDir 向上找 server.js 作锚点（与 clone.js 原来的 projectRoot 同一套）。
function findWithServerJs (startDir) {
  let dir = startDir
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'server.js'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

// checkout 若是 git worktree，返回主仓库根；不是 worktree 就返回 null。
function mainRepoOf (checkout) {
  if (!checkout) return null
  const dotGit = path.join(checkout, '.git')
  let st
  try { st = fs.lstatSync(dotGit) } catch (e) { return null }
  // .git 是目录 ⇒ 这里已经是主仓库。
  if (!st.isFile()) return null
  let text
  try { text = fs.readFileSync(dotGit, 'utf8').trim() } catch (e) { return null }
  const m = /^gitdir:\s*(.+)$/m.exec(text)
  if (!m) return null
  const gitdir = path.resolve(checkout, m[1].trim())
  // gitdir 形如 <主仓库>/.git/worktrees/<名字>：向上找到名为 .git 的目录，上一层就是主仓库根。
  let dir = gitdir
  for (let i = 0; i < 6; i++) {
    let dst
    try { dst = fs.statSync(dir) } catch (e) { return null }
    if (dst.isDirectory() && path.basename(dir) === '.git') {
      const main = path.dirname(dir)
      // 确认主仓库确实是本平台，防止解析错位指到无关仓库。
      return fs.existsSync(path.join(main, 'server.js')) ? main : null
    }
    dir = path.dirname(dir)
  }
  return null
}

// 本 checkout 的根（worktree 里跑就是 worktree 自己）。
function checkoutRoot (opts = {}) {
  return findWithServerJs(opts.from || __dirname)
}

// 显式覆盖：WIZARD_PROJECT_ROOT。不存在的路径当没给，不静默建目录。
function overrideRoot (opts = {}) {
  const env = opts.env || process.env
  const v = env.WIZARD_PROJECT_ROOT
  if (!v || !String(v).trim()) return null
  try { return fs.realpathSync(path.resolve(String(v).trim())) } catch (e) { return null }
}

/** 写操作的根：显式覆盖 → 本 checkout。绝不自动归位主仓库。 */
function writeRoot (opts = {}) {
  return overrideRoot(opts) || checkoutRoot(opts)
}

/** 读操作依次查找的根（去重，先到先得）。 */
function readRoots (opts = {}) {
  const local = checkoutRoot(opts)
  const list = [overrideRoot(opts), local, mainRepoOf(local)].filter(Boolean)
  const seen = new Set()
  const out = []
  for (const r of list) {
    let key = r
    try { key = fs.realpathSync(r) } catch (e) { /* 拿不到就用原样 */ }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/**
 * 读用的引擎目录：按 readRoots 顺序找第一个存在的 engines/<id>。
 * 都没有时给写根下的路径（还没落盘的引擎，将来也会写在那里）。
 */
function engineDirForRead (id, opts = {}) {
  for (const root of readRoots(opts)) {
    const d = path.join(root, 'engines', String(id))
    if (fs.existsSync(d)) return d
  }
  const w = writeRoot(opts)
  return path.join(w || process.cwd(), 'engines', String(id))
}

/** 名片读哪一份：按 readRoots 顺序找第一个有 manifest.json 的；都没有返回 null。 */
function manifestPathForRead (id, opts = {}) {
  for (const root of readRoots(opts)) {
    const f = path.join(root, 'engines', String(id), 'manifest.json')
    if (fs.existsSync(f)) return f
  }
  return null
}

// 引擎所在 checkout 的仓库根（engines/<id> 上退两级）。
// runtime.python / runtime.cwd 这类相对路径按引擎所在的那份 checkout 解析：
// 引擎在哪，它的 .venv 和相对路径就在哪。
function engineRoot (id, opts = {}) {
  return path.resolve(path.dirname(path.dirname(engineDirForRead(id, opts))))
}

module.exports = {
  findWithServerJs, mainRepoOf, checkoutRoot, overrideRoot,
  writeRoot, readRoots, engineDirForRead, manifestPathForRead, engineRoot,
}
