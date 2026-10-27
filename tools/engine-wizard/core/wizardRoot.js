'use strict'
// 向导的「项目根」解析：克隆、环境、权重、名片的落盘全部落在 <项目根>/engines/ 下。
//
// 两种运行位面，根的含义不一样：
//   ① 主仓库里跑（正式 server.js，或在主仓库根起的 dev server）⇒ 根没有歧义。
//   ② git worktree 里跑（研究工作树的独立 dev server）⇒ worktree 也是一份完整
//      checkout、也有 server.js，照旧把自己当根。但用户的真实资产
//      （已建好的环境、已下的权重、engines/ 下的其他引擎）都在主仓库里。
//      照 worktree 的路径找，症状就是「环境建好了徽标还说没建好」
//      「同目录下的其他引擎都探测不了」。
//
// 判据：git worktree 的 .git 是一个**文件**（内容 gitdir: <主仓库>/.git/worktrees/<名字>），
// 主仓库的 .git 是**目录**。解析出主仓库根、并确认它确实是本平台（有 server.js）后
// 把根改指主仓库；解析不出来（不是 worktree、或主仓库不是本平台）就维持原样。
//
// 显式覆盖：环境变量 WIZARD_PROJECT_ROOT 优先级最高（部署想钉死根时用）。
// 各端点 URL 上的 ?root= / body.root 仍然最优先，那是每次请求级的覆盖。

const fs = require('node:fs')
const path = require('node:path')

// 从 startDir 向上找 server.js 作锚点（与 clone.js 原来的逻辑同一套）。
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
  const dotGit = path.join(checkout, '.git')
  let st
  try { st = fs.lstatSync(dotGit) } catch (e) { return null }
  // .git 是目录 ⇒ 这里已经是主仓库，不用归位。
  if (!st.isFile()) return null
  let text
  try { text = fs.readFileSync(dotGit, 'utf8').trim() } catch (e) { return null }
  const m = /^gitdir:\s*(.+)$/m.exec(text)
  if (!m) return null
  const gitdir = path.resolve(checkout, m[1])
  // gitdir 形如 <主仓库>/.git/worktrees/<名字>：向上找到名为 .git 的**目录**，
  // 它的上一层就是主仓库根。
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

/**
 * 向导的项目根。顺序：环境变量覆盖 → server.js 锚点 → worktree 归位主仓库。
 * 解析不出时返回 null，调用方按「没有根」处理。
 */
function wizardRoot () {
  const override = process.env.WIZARD_PROJECT_ROOT
  if (override && override.trim()) {
    try { return fs.realpathSync(path.resolve(override.trim())) } catch (e) { /* 不存在就当没给 */ }
  }
  const base = findWithServerJs(__dirname)
  if (!base) return null
  return mainRepoOf(base) || base
}

// 引擎目录按 id 定位：主仓库优先，本 checkout 兜底。
//   worktree 里跑向导时，真实资产（克隆、环境、权重）在主仓库；
//   但各 checkout 自己的 engines/ 下也可能有引擎（测试夹具、历史残留），
//   一票否掉本地会让测试与离线场景全灭。按 id 找：主仓库有就用主仓库的，
//   否则本 checkout 的，都没有就给主仓库的路径（克隆这类「还没落盘」的
//   场景本来就该落到主仓库）。
function enginesDir (id) {
  const main = wizardRoot()
  const local = findWithServerJs(__dirname)
  const tryIn = (root) => (root && fs.existsSync(path.join(root, 'engines', String(id))))
    ? path.join(root, 'engines', String(id))
    : null
  return tryIn(main) || tryIn(local)
    || path.join(main || local || process.cwd(), 'engines', String(id))
}

// 引擎所在 checkout 的仓库根（engines/<id> 上退两级）。
// runtime.python / runtime.cwd 这类相对路径按引擎所在的那份 checkout 解析：
// 引擎在哪，它的 .venv 和相对路径就在哪。
function engineRoot (id) {
  return path.resolve(path.dirname(path.dirname(enginesDir(id))))
}

module.exports = { wizardRoot, mainRepoOf, findWithServerJs, enginesDir, engineRoot }
