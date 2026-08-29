'use strict'

// 第 4 步（契约 §12）：按 pin 的 commit 拉上游。
//
// 这个文件**只算计划，不执行**。执行在 tools/install-engine.cjs。
// 分开的理由跟 launchPlan.js 一样：计划是纯函数，能在测试里逐条比对；
// 一旦把 spawn 混进来，「装出来的东西对不对」就只能靠真的装一遍来回答。
//
// ⭐ 这里是全平台唯一「严格要求 upstream.commit」的地方。合成路径不管这个
//    （见 profile.js 的 parseUpstream 注释）——「该拉哪一版」这个问题，
//    只有在安装那一刻才真正需要答案。

const path = require('path')

class InstallPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'InstallPlanError'
    this.code = code
    Object.assign(this, details)
  }
}

// 上游代码落在哪：就是引擎目录本身。
// 契约 §4 第 1 步「建目录 engines\<你的引擎id>\」，第 2 步「克隆上游」——
// 两步落在同一个目录，这也正是 engines/indextts2/ 今天的样子
// （indextts/ 与 pyproject.toml 都是上游的，跟我们的 manifest.json 并排）。
function engineDir(id) {
  return path.posix.join('engines', id)
}

// 名片没有 install 段是合法的：那表示这台引擎不用平台代装
// （例如 GPT-SoVITS 这种源码早已在仓库里的历史引擎）。
function parseInstall(manifest) {
  const raw = manifest.install
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InstallPlanError('ENGINE_INSTALL_INVALID',
      `引擎 ${manifest.id} 的 manifest.json 里 install 必须是一个对象`,
      { id: manifest.id, key: 'install' })
  }

  // 建环境的命令。名片必须自己说，平台不猜 ——
  // uv / poetry / pip -r / conda 各家都不一样，猜错的表现是装了一半才炸。
  const cmd = raw.env_command
  if (cmd !== undefined && cmd !== null) {
    if (!Array.isArray(cmd) || cmd.length === 0 ||
        cmd.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new InstallPlanError('ENGINE_INSTALL_INVALID',
        `引擎 ${manifest.id} 的 install.env_command 必须是一个非空的字符串数组` +
        '（argv 形式，例如 ["uv","sync"]）—— ' +
        '写成一整行命令会在带空格的路径上被拆错，那种错很难查。',
        { id: manifest.id, key: 'install.env_command', value: cmd })
    }
  }

  return {
    env_command: cmd ? cmd.map((s) => s.trim()) : null,
    // 上游仓库里真正要的那个子目录。null = 整个仓库。
    subdir: typeof raw.subdir === 'string' && raw.subdir.trim()
      ? raw.subdir.trim() : null,
  }
}

// 装一台引擎，一共就这几件事。每一步都带 why —— 一条看不懂用途的命令，
// 装的人没法判断它失败了要不要紧。
function buildInstallPlan(profile, manifest = {}) {
  const id = profile.id
  const up = profile.upstream

  if (!up || !up.url) {
    throw new InstallPlanError('ENGINE_UPSTREAM_MISSING',
      `引擎 ${id} 的 manifest.json 没写 upstream.url —— 不知道该从哪儿拉源码。`,
      { id })
  }

  // ⛔ 这是本文件存在的理由。契约 C10：「丢了它，安装脚本都不知道该拉哪一版。」
  if (!up.commit) {
    throw new InstallPlanError('ENGINE_UPSTREAM_UNPINNED',
      `引擎 ${id} 没有钉住上游版本（upstream.commit 是 null），无法安装。\n` +
      (up.commit_unknown_reason
        ? `  manifest.json 给的原因：${up.commit_unknown_reason}\n`
        : '') +
      '  ⛔ 平台不会替你拉最新版顶上：那样装出来的版本跟开发时用的可能不是同一个，\n' +
      '     而症状不会是报错，是声音不对、或者某个参数悄悄失效。\n' +
      `  要装它，先确定一个 commit 并写进 engines/${id}/manifest.json 的 upstream.commit。`,
      { id, url: up.url, reason: up.commit_unknown_reason || null })
  }

  const install = parseInstall(manifest)
  const dir = engineDir(id)
  const steps = []

  // ⛔ 这里**不能**用 git clone。安装的前提是「名片已经写好了」，也就是
  //    engines/<id>/manifest.json 已经躺在目标目录里 —— 而 git clone 拒绝
  //    拉进一个非空目录。用 init + fetch 就没这个限制，上游文件会落在
  //    我们的 manifest.json 旁边，正是 engines/indextts2/ 今天的样子。
  steps.push({
    kind: 'init',
    argv: ['git', 'init', '--quiet'],
    cwd: dir,
    why: `在 ${dir}/ 就地开一个临时仓库（manifest.json 已经在这个目录里，clone 进不来）`,
  })

  steps.push({
    kind: 'remote',
    argv: ['git', 'remote', 'add', 'origin', up.url],
    cwd: dir,
    why: `指向上游 ${up.url}`,
  })

  // 整仓 fetch，不用 --depth 1：按 sha 做浅取要服务端开
  // uploadpack.allowReachableSHA1InWant，不是每个托管都开着，
  // 失败的样子是一句很难懂的 git 报错。慢一点换一个到处都能跑的安装。
  steps.push({
    kind: 'fetch',
    argv: ['git', 'fetch', '--quiet', 'origin'],
    cwd: dir,
    why: '取上游历史（这一步最慢，大仓库可能要几分钟）',
    needs_network: true,
  })

  // 钉 sha，不钉分支也不钉标签：分支会移动，标签能被重新指向，
  // 只有 sha 能回答「半年后还能不能装回一模一样的版本」。
  steps.push({
    kind: 'checkout',
    argv: ['git', 'checkout', '--detach', up.commit],
    cwd: dir,
    why: `切到 manifest.json 钉住的那一版 ${up.commit.slice(0, 12)}…（不是默认分支的最新）`,
  })

  // C10：删 .git。理由不只是省空间 —— 上游仓库留在这里会变成嵌套仓库
  // （gitlink），本仓库既不跟踪它的内容，也无法保证它不被人 pull 走一版。
  // ⚠ 删掉之后 upstream.commit 就是**唯一**还知道这是哪一版的地方。
  steps.push({
    kind: 'drop-git',
    argv: null,
    remove: path.posix.join(dir, '.git'),
    cwd: '.',
    why: '删掉上游的 .git（C10：不进 git、不做嵌套仓库）—— ' +
         '删完之后，manifest.json 里那个 sha 就是唯一还记得版本的地方',
  })

  if (install && install.env_command) {
    steps.push({
      kind: 'env',
      argv: install.env_command,
      cwd: install.subdir ? path.posix.join(dir, install.subdir) : dir,
      why: '按上游自己的配方建这台引擎的 Python 环境' +
           '（每台引擎一套，与平台的环境完全隔离 —— C12.1）',
      needs_network: true,
    })
  }

  return {
    id,
    label: profile.label || id,
    dir,
    url: up.url,
    commit: up.commit,
    license: up.license || null,
    steps,
    // 装完之后该由谁来回答「装好了没有」——⛔ 不是这个工具。
    // 契约 §4 第 5 步的三道校验是独立的一件事，已经有 envCheck.js 在做。
    verify_hint: `node tools/dev/check-engine-env.cjs ${id}`,
  }
}

module.exports = { buildInstallPlan, parseInstall, engineDir, InstallPlanError }
