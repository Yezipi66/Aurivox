'use strict'
// ============================================================================
//  CLONE —— 第 2 步：把上游拉到 engines/<id>/
//
//  ⭐ 为什么这一步的判据不是「git 跑成功」
//  git clone 的失败有两种，形状完全不同：
//    · 网络/权限失败    ⇒ git 自己报错，可直接看
//    · ⛔ 目录非空     ⇒ 「装了一半才发现」的那一种
//  后者之所以危险，是因为它发生在**流程的后段**（名片已写、环境已建），
//  那时候失败，前面所有工作都得回滚。
//  ⇒ 本文件的第一个职责是**动手之前先证明目录是空的**，
//    而不是指望 git 替我们报这个错。
//
//  ⛔⛔ 关于深度克隆（--depth 1）
//  计划里的顺序是「先克隆，第 5 步才写名片」，所以我们**不知道**将来
//  要不要 checkout 到某个特定版本。已退役的 installPlan.js:117 记过
//  按 sha 浅取会被服务端拒绝（uploadpack.allowReachableSHA1InWant 不是
//  每个托管都开着）。
//  ⇒ **默认整仓克隆**，浅取交给用户显式要求。不猜。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/** 定位项目根 —— ⛔ 用 server.js 作锚点（ROOT_LAYOUT.md 说它是定位锚点 C7） */
function projectRoot (from) {
  let dir = from || __dirname
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'server.js'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

function engineDir (id, root) {
  return path.join(root, 'engines', id)
}

/**
 * ⭐ 动手之前先看目标目录。
 *
 * 判据来自 git 自己的行为（clone 拒绝非空目录），但**提前查**而不是等它报：
 * 等它报的时候，用户可能已经等了很久。
 *
 * @returns {{ok:true, dir:string, exists:boolean, entries:string[]}
 *          | {ok:false, code, error, entries?}}
 */
function inspectTarget (id, opts = {}) {
  const root = opts.root || projectRoot()
  if (!root) {
    return { ok: false, code: 'NO_ROOT',
      error: 'Project root not found (no server.js above). The wizard must run inside the project directory.', errorZh: '找不到项目根（向上没有 server.js）。向导需要在项目目录内运行。' }
  }
  const dir = engineDir(id, root)

  if (!fs.existsSync(dir)) {
    return { ok: true, dir, exists: false, entries: [] }
  }
  const entries = fs.readdirSync(dir)
  // ⛔ 一个空目录 = git 能直接往里放 ⇒ 没问题
  //   「目录不存在」也一样，git 会自己建
  return { ok: true, dir, exists: true, entries }
}

/**
 * ⭐ 决定能不能克隆 —— ⛔ 理由必须是用户看得懂的话，不是 git 的原话。
 *
 * @returns {{ok:true, dir} | {ok:false, code, error, entries?}}
 */
function checkClonable (id, opts = {}) {
  const info = inspectTarget(id, opts)
  if (!info.ok) return info
  if (info.entries.length === 0) return { ok: true, dir: info.dir }

  // ⛔ 非空 ⇒ 不许默默继续，也不许默默覆盖
  const listed = info.entries.slice(0, 8)
  return {
    ok: false,
    code: 'DIR_NOT_EMPTY',
    dir: info.dir,
    entries: info.entries,
    error: `engines/${id}/ already has ${info.entries.length} item(s):`
      + `${listed.join(', ')}${info.entries.length > 8 ? ' …' : ''}\n`
      + 'git clone requires an empty target directory.\n'
      + '  · Usually this means the engine was already cloned — check whether you need to reinstall.\n'
      + '  · To reinstall, remove the directory first (the platform will not delete it for you).\n',
    errorZh: `engines/${id}/ 里已经有 ${info.entries.length} 项：`
      + `${listed.map((e) => e).join('、')}${info.entries.length > 8 ? ' …' : ''}\n`
      + 'git clone 要求目标目录为空。\n'
      + '  · 通常表示该引擎已克隆过，请确认是否需要重新安装\n'
      + '  · 如需重新安装，请先移除该目录（平台不会自动删除）\n',
  }
}

/**
 * ⭐ 真正的克隆。**默认只打印计划，不动盘。**
 *
 * 理由跟 tools/install-engine.cjs 一样（它是项目已有的先例）：
 * 克隆要联网、要写盘；「敲错一个字就开始下载」不是一个好的默认值。
 */
function buildClonePlan (input = {}) {
  const id = input.id
  // ⛔⛔ 2026-10-04 实测踩到：cloneUrl 空时**不报错**，
  //    而是生成 `git clone '' engines/<id>` —— 一条必然失败的命令，
  //    还占掉了「看计划」这一步。⛔ 空就是空，当场说清。
  if (!input.cloneUrl || !String(input.cloneUrl).trim()) {
    return { ok: false, code: 'NO_CLONE_URL',
      error: 'No clone URL given.\n',
      errorZh: '没有 clone 地址。\n'
        + '请先执行「解析链接」，该步骤会从 GitHub 地址中取得 cloneUrl。' }
  }
  const clonable = checkClonable(id, input)
  if (!clonable.ok) {
    return { ok: false, code: clonable.code, error: clonable.error,
      entries: clonable.entries }
  }

  // ⛔⛔ **不接受 branch**（Owner 2026-10-04：「克隆就只克隆默认分支得了」）：
  //   之前那个分支框是**死控件** —— 探测打的是 /wizard/probe {url}，压根没用它，
  //   只有 clone 用；而用户「重读」时读的又是默认分支 ⇒ 填了分支，
  //   探测结果和实际克隆的代码对不上（2026-10-04 实测确认）。
  //   留 --branch 在 API 里 = 留一个前端碰不到的参数 ⇒ 删。
  const depth = input.depth === 1 ? ['--depth', '1'] : []

  const steps = [
    {
      kind: 'clone',
      argv: ['git', 'clone', ...depth, input.cloneUrl, `engines/${id}`],
      cwd: '.',
      needs_network: true,
      why: `Pull the upstream into engines/${id}/` + (depth.length
          ? ' (shallow clone, latest only \u2014 history cannot be checked out later)'
          : ' (full clone. A shallow clone would prevent checking out a specific version later)')
        + ', default branch',
      whyZh: `把上游拉进 engines/${id}/`
        + (depth.length ? '（浅克隆，仅取最新版，之后无法 checkout 到历史版本）'
          : '（完整克隆。浅克隆会导致之后无法 checkout 到指定版本）')
        + '，默认分支',
    },
  ]

  if (depth.length) {
    steps.push({
      kind: 'note',
      why: 'Shallow clone selected. To pin a specific version later, '
        + 'a full re-clone is required.',
      whyZh: '已选择浅克隆。若之后需要指定历史版本，'
        + '必须重新完整克隆。',
    })
  }

  steps.push({
    kind: 'gitignore',
    why: `The upstream source tree must be excluded via .gitignore \u2014 engines/${id} ` 
      + `holds thousands of files that would otherwise be committed.`,
    whyZh: `上游源码需要写入 .gitignore 排除，${id} 那一树有几千个文件，\n`
      + `否则会随提交进入版本库。`
  })

  return {
    ok: true,
    id,
    dir: clonable.dir,
    cloneUrl: input.cloneUrl,
    steps,
    execute: input.execute === true,
  }
}

/**
 * ⭐ 执行。**只有 execute:true 才会真的跑** ——
 * 默认仍然只返回计划（跟 install-engine.cjs 的默认行为一致）。
 */
function runClone (input = {}) {
  const plan = buildClonePlan(input)
  if (!plan.ok || !plan.execute) return plan

  const root = input.root || projectRoot()
  const argv = plan.steps[0].argv
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    encoding: 'utf-8',
    timeout: input.timeoutMs || 30 * 60 * 1000,   // 大仓库可能要很久
    windowsHide: true,
  })

  if (r.error) {
    return { ...plan, ok: false, code: 'SPAWN_FAILED',
      error: `Cannot launch git: ${r.error.message}`, errorZh: `起不动 git：${r.error.message}` }
  }
  if (r.status !== 0) {
    return {
      ...plan,
      ok: false,
      code: 'GIT_FAILED',
      error: (r.stderr || r.stdout || 'git 没有说为什么就退了').trim(),
      status: r.status,
    }
  }

  // ⛔ 只报「git 说成功了」，不报「克隆好了」——
  //   那要等第 4 步的自检（import 探针）才能下结论。
  return {
    ...plan,
    ok: true,
    gitStatus: r.status,
    note: 'git exited 0. That only means the files are in place — '
      + 'whether this engine actually works awaits the checks that come next.',
    noteZh: 'git 退出码 0。这只说明文件到位了，'
      + '「这台引擎能用吗」要等后面的校验。',
  }
}

module.exports = {
  projectRoot, engineDir, inspectTarget, checkClonable, buildClonePlan, runClone,
}