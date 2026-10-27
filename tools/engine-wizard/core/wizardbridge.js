'use strict'
// 向导的 HTTP 桥：把探测、克隆、装依赖、下模型、校验、参数反射挂到 /wizard/* 上。
// 探测阶段只读上游的文本文件，不 clone、不建目录；克隆在探测之后。
// 每个 handler 同步返回 true/false 表示是否接管，异步活放进 readBody 回调。

const fs = require('node:fs')
const path = require('node:path')

const { resolveEngine, parseRepoUrl } = require('./resolve')
const { runClone, buildClonePlan, projectRoot, removeTargetDir } = require('./clone')
const { runEnv, buildEnvPlan, suggestTorchUpgrade } = require('./env')
const { runDownload, unifyDest, fetchRemoteManifest, enrichManifestFiles, downloadFile,
  removePartialFiles } = require('./download')
const { describeModels, explainMissingInfo } = require('./models')
const { probeProject, planDependencies, probePyproject } = require('./probe')
const { inspectHardware, parseUvLock } = require('./hardware')
const { checks: verifyChecks, runChecks, runAudioCheck } = require('./verify')
const { reflectAndBuild } = require('./paramsFromReflect')
const https = require('node:https')

/**
 * 从 README 原文里挑出模型下载命令：只认下载工具的固定前缀（hf / huggingface-cli /
 * modelscope 的 download 子命令，以及 snapshot_download 调用），不做自然语言理解。
 * 命令不完整也照样给出来：平台不替它补全，补错了等于平台在编造上游的下载方式。
 *
 * @param {string} markdown README 原文
 * @returns {Array<{tool:string,repo:string,dir:(string|null),raw:string}>} 去重后的命令，按 README 里的顺序
 */
function extractDownloadCommands (markdown) {
  if (!markdown || typeof markdown !== 'string') return []
  const OUT = []
  const seen = new Set()
  // 除了 CLI 形态，还认 Python API 形态：snapshot_download("repo", local_dir=...)
  for (const m of markdown.matchAll(/^[ \t]*(?:\$|>|#{1,6}\s*)?((?:(?:uv tool install|pip install)[^\n]*\n[ \t]*)?(?:\b(?:hf|huggingface-cli|modelscope)[ \t]+download\b[^\n`]*|snapshot_download\s*\([^)\n]*\)))/gm)) {
    let cmd = m[1].trim().replace(/\s+/g, ' ')
    cmd = cmd.replace(/[`|]+$/, '').trim()
    if (!cmd || seen.has(cmd)) continue
    seen.add(cmd)
    // 目标目录由用户自选（--local-dir 之类），所以整条命令不能原样丢出去：
    // 原样就等于把目录写死成上游随手取的名字。拆成「工具 / 模型 / 目标目录」三段。
    const parts = parseDownloadCmd(cmd)
    if (!parts) continue
    OUT.push(parts)
  }
  return OUT
}

/**
 * 把一条下载命令拆成「工具 / 模型 / 目标目录」。认得出来的写法只有三种：
 *   hf download <org>/<repo> --local-dir=<dir>
 *   modelscope download --model <org>/<repo> --local_dir <dir>
 *   snapshot_download("<org>/<repo>", local_dir=...)
 * 认不出来的写法返回 null，界面上如实说「看不懂这条」：猜错等于平台替上游编了一个下载方式。
 */
function parseDownloadCmd (cmd) {
  // Python API 形态：snapshot_download("repo", local_dir='...')。
  //   它包在 python 代码里不是裸命令：这里只提取 repo 与 local_dir。
  const sd = cmd.match(/snapshot_download\s*\(\s*['"]([^'"]+)['"]/)
  if (sd) {
    const repo = sd[1]
    const dir = (cmd.match(/local_dir\s*=\s*['"]?([^'",\s)]+)['"]?/) || [])[1]
    // 只有 modelscope / huggingface 形状的 repo 才认
    if (!/^[^/]+[\/][^/]+/.test(repo)) return null
    return { tool: 'snapshot', repo, dir: dir || null, raw: cmd }
  }
  const ms = cmd.match(/^modelscope\s+download\b(.*)$/)
  if (ms) {
    const repo = (ms[1].match(/--model\s+([^\s]+)/) || [])[1]
    if (!repo) return null
    const dir = (ms[1].match(/--local_dir\s+([^\s]+)/)
      || ms[1].match(/--local-dir[=\s]+([^\s]+)/) || [])[1]
    return { tool: 'modelscope', repo, dir: dir || null, raw: cmd }
  }
  // 先排掉以 `-` 开头的 token（那是参数不是位置参数）：否则
  // `hf download --local-dir=x` 会把参数当成模型名，等于替上游编了一个不存在的模型。
  const rest = cmd.replace(/^(?:hf|huggingface-cli)\s+download\s+/, '')
  const toks = rest.split(/\s+/)
  const repo = toks.find((t) => t && !t.startsWith('-'))
  if (!repo || !/^[^\s/]+\/[^\s/]+/.test(repo)) return null
  const tail = rest.slice(rest.indexOf(repo) + repo.length)
  const dir = (tail.match(/--local-dir[=\s]+([^\s]+)/) || [])[1]
  return { tool: 'hf', repo, dir: dir || null, raw: cmd }
}

// 上游可能提供的模型下载入口文件名。这是探测清单，不是平台支持的下载方式：
// 平台不实现下载逻辑，只告诉用户「上游自己有个脚本可以跑」；清单之外读不到就如实说没找到。
const DOWNLOAD_SCRIPTS = [
  'download_models.py',
  'download_models.sh',
  'download.sh',
  'download.py',
  'download_weights.py',
  'download_ckpt.py',
  'download_checkpoints.sh',
]

// 许可证文件候选名（第 1 步候选清单），顺序即优先级。
// 只认「根目录有没有这个文件」，不读正文、不判类型、不猜是哪一种许可证。
const LICENSE_FILES = ['LICENSE', 'LICENSE.txt', 'LICENSE.md',
  'LICENCE', 'LICENCE.txt', 'COPYING', 'COPYING.txt']

function fetchRaw (owner, name, file, branch) {
  const ref = branch || 'main'
  return new Promise((resolve) => {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${file}`
    const req = https.get(url,
      { headers: { 'user-agent': 'aurivox-engine-wizard' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return }
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve(body))
      })
    req.on('error', () => resolve(null))
    req.setTimeout(20000, () => { req.destroy(); resolve(null) })
  })
}

// 仓库默认分支：raw.githubusercontent 的路径里要写分支名，写错整个探测全 404。
// 拿不到就用 main，再不行用 master。结果缓存 5 分钟：第 1 步要扫十几个候选文件，
// 每个都调一次 API 会撞速率限制。
const BRANCH_TTL_MS = 5 * 60 * 1000
const _branchCache = new Map()

function readDefaultBranch (owner, name) {
  const key = `${owner}/${name}`
  const hit = _branchCache.get(key)
  // 命中时也要返回 {branch, why} 形状：调用方按对象读 .branch，
  // 直接还 hit.value 会让它读到 undefined 或当场抛。
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) {
    return Promise.resolve({ branch: hit.value, why: hit.why || null })
  }

  return new Promise((resolve) => {
    const url = `https://api.github.com/repos/${owner}/${name}`
    const done = (value, why) => {
      _branchCache.set(key, { at: Date.now(), value, why: why || null })
      resolve({ branch: value, why: why || null })
    }
    const req = https.get(url, {
      headers: { 'user-agent': 'aurivox-engine-wizard', accept: 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode === 403 || res.statusCode === 429) {
        res.resume()
        return done(null, 'RATE_LIMITED')
      }
      if (res.statusCode !== 200) { res.resume(); return done(null, `HTTP_${res.statusCode}`) }
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let b = null
        try { b = JSON.parse(body).default_branch || null } catch (e) { /* 认不出就回退 */ }
        done(b, b ? null : 'NO_DEFAULT_BRANCH')
      })
    })
    req.on('error', () => done(null, 'NETWORK'))
    // 比 fetchRaw 短：分支拿不到可以回退，不该拖住整个探测
    req.setTimeout(5000, () => { req.destroy(); done(null, 'TIMEOUT') })
  })
}

// 探测用哪个分支：API 给得出就用 API 的；给不出返回 branch 为 null，
// 由 fetchWithBranchFallback 按 main、master 依次试。
async function resolveProbeBranch (owner, name) {
  const r = await readDefaultBranch(owner, name)
  if (r.branch) return { branch: r.branch, source: 'api' }
  return { branch: null, source: r.why || 'unknown' }
}

// 按候选顺序试：先探测到的分支，再 main，再 master。
async function fetchWithBranchFallback (owner, name, file, probed) {
  const tried = []
  if (probed) tried.push(probed)
  if (!tried.includes('main')) tried.push('main')
  if (!tried.includes('master')) tried.push('master')
  for (const b of tried) {
    // eslint-disable-next-line no-await-in-loop
    const t = await fetchRaw(owner, name, file, b)
    if (t !== null) return t
  }
  return null
}

/** POST /wizard/probe {url}：探测上游（只读文本文件） */
function handleProbe (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/probe')) return false
  readBody(req, async (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const parsed = parseRepoUrl(body.url)
    if (!parsed.ok) { json(res, 400, parsed); return }

    // 先定分支：API 给不出时由 fetchWithBranchFallback 按 main、master 依次试。
    const probeBranch = await resolveProbeBranch(parsed.owner, parsed.repo)
    const notes = []
    if (probeBranch.source !== 'api') {
      notes.push(`未能从 GitHub 读到默认分支（${probeBranch.source}），按 main 与 master 依次尝试。`)
    }

    // 候选清单固定，一个都不多读
    const CANDIDATES = ['pyproject.toml', 'uv.lock', 'requirements.txt',
      'environment.yml', 'setup.py']
    const texts = {}
    const found = []
    for (const f of CANDIDATES) {
      const t = await fetchWithBranchFallback(parsed.owner, parsed.repo, f, probeBranch.branch)
      if (t !== null) { found.push(f); texts[f] = t }
    }

    // 许可证文件：许可证不是 pyproject 的字段，多数仓库根目录只有一个 LICENSE。
    // 取到正文一并交给 probeProject，由它读头部识别是哪种许可证；识别不出就只报「有这个文件」。
    let licenseFile = null
    let licenseText = null
    for (const f of LICENSE_FILES) {
      // eslint-disable-next-line no-await-in-loop
      const t = await fetchWithBranchFallback(parsed.owner, parsed.repo, f, probeBranch.branch)
      if (t !== null) { licenseFile = f; licenseText = t; break }
    }

    // 上游自己的模型下载入口：模型放在哪个仓库、要下哪几个文件、用哪个工具，
    // 上游自己最清楚，所以这里只探测不代列。两种形态都认：根目录有下载脚本，
    // 或 README 里直接给了命令；认不到才如实说「上游没给」。
    const dlScripts = []
    for (const f of DOWNLOAD_SCRIPTS) {
      const t = await fetchWithBranchFallback(parsed.owner, parsed.repo, f, probeBranch.branch)
      if (t !== null) {
        dlScripts.push({ kind: 'script', file: f,
          head: t.split('\n').slice(0, 12).join('\n') })
      }
    }
    let readmeCmds = []
    if (dlScripts.length === 0) {
      const rd = (await fetchWithBranchFallback(parsed.owner, parsed.repo, 'README.md', probeBranch.branch)) || ''
      readmeCmds = extractDownloadCommands(rd).map((cmd) => ({
        ...cmd,
        repo: cmd.repo || `${parsed.owner}/${parsed.repo}`,
      }))
    }

    // 无论有没有 pyproject 都走 probeProject：包名来自 setup.py 的 name=、
    // 许可证来自根目录的 LICENSE / COPYING，都不是 pyproject 的字段 ⇒ 由它决定读得到哪个。
    const r = probeProject({
      pyproject: texts['pyproject.toml'],
      requirements: texts['requirements.txt'],
      setupPy: texts['setup.py'],
      licenseFile,
      licenseText,
      filenames: found,
    })
    // 统一返回契约：所有 /wizard/* 端点成功时都带 ok:true，前端据此判成功，少了它界面会把成功当失败。
    const noPy = !texts['pyproject.toml']
    json(res, 200, {
      ok: true,
      ...r,
      // 没有 pyproject 时，如实说清「哪些还读不到」：哪些读到了由 r.meta 自己说话。
      note: noPy
        ? 'No pyproject.toml in this repository. Package name and license are still '
          + 'read from setup.py and the license file when present; the console command '
          + 'cannot be read from these files.'
        : null,
      noteZh: noPy
        ? '这个仓库没有 pyproject.toml。包名与许可证仍会从 setup.py 和许可证文件读出'
          + '（如果它们存在），而运行命令无法从这些文件里读到。'
        : null,
      license_file: licenseFile,
      found_files: found,
      downloader: dlScripts,
      downloader_cmds: readmeCmds,
      notes,
    })
  })
  return true
}

/**
 * GET /wizard/hardware：单独暴露硬件检测（排查用，也给界面复用）。
 * 检测失败不能让端点挂掉：退 CPU 是一个有意义的答案，而不是 500。
 */
function handleHardware (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/hardware')) return false
  try {
    json(res, 200, inspectHardware())
  } catch (e) {
    json(res, 200, {
      gpus: [], recommended: 'cpu', confidence: 'unknown',
      reason: `Detection failed (${e.message}) — falling back to CPU`,
    reasonZh: `检测本身出错了（${e.message}）⇒ 退 CPU 版`,
      caveat: 'Detection is best-effort, not a guarantee',
    caveatZh: '检测是尽力而为，不是保证',
      options: require('./hardware').BACKEND_PREFERENCE,
    })
  }
  return true
}


/**
 * POST /wizard/deps  {url}
 *  第 2 步的数据源：读上游的依赖清单 + uv.lock，跟本机比出绿/黄/白。不装任何东西。
 * 依赖清单读 pyproject.toml 与 requirements.txt：只放 requirements.txt 的仓库
 *   只靠提示语是读不到东西的，所以这里真的去读。
 */
function handleDeps (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/deps')) return false
  readBody(req, async (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const parsed = parseRepoUrl(body.url)
    if (!parsed.ok) { json(res, 400, parsed); return }

    // 分支同样走回退：分支写错整个请求全 404。
    const probeBranch = await resolveProbeBranch(parsed.owner, parsed.repo)
    const get = async (f) => {
      const t = await fetchWithBranchFallback(parsed.owner, parsed.repo, f, probeBranch.branch)
      return t
    }
    // 三个来源一起读：依赖列表两个（pyproject 优先）+ lock（只锁 torch 版本）
    const [py, reqText, lockText] = await Promise.all([
      get('pyproject.toml'), get('requirements.txt'), get('uv.lock')])

    // 两份依赖清单都没有 ⇒ 确实读不到，如实说。
    const pyHasDeps = py ? probePyproject(py).dependencies.length > 0 : false
    if (!pyHasDeps && !reqText) {
      json(res, 200, { ok: false, code: 'NO_DEPENDENCY_MANIFEST',
        error: 'This repository has no dependency list: no pyproject.toml and no '
          + 'requirements.txt.\nIt may live in uv.lock, a subdirectory, or a file named '
          + 'differently. Follow the upstream instructions to install.',
        errorZh: '这个仓库读不到依赖列表：既没有 pyproject.toml，也没有 requirements.txt。\n'
          + '它可能放在 uv.lock、子目录里，或换了别的文件名；请按上游说明自行安装。' })
      return
    }

    // 本机检测：失败也不让整个请求失败（CI 上没 GPU 也要能跑）
    let hardware = null
    try { hardware = inspectHardware() } catch { hardware = null }

    const base = planDependencies(py, { hardware, requirements: reqText })
    if (!base.ok) { json(res, 200, base); return }

    // 把 lock 里的 torch 系并进去：pyproject 只写版本区间，真正锁死 wheel 的是 lock。
    // lock 只用来判 torch 后端，不当依赖列表来源：它锁的是全部传递依赖，
    // 拿它当清单会把传递依赖全列成顶层依赖。
    if (lockText) {
      const rows = parseUvLock(lockText)
      const lockedNames = rows.map((r) => r.name)
      const { judgeTorchSpec } = require('./hardware')
      const torchRow = base.deps.torch.packages.find((p) => p.isMain)
      if (torchRow && hardware) {
        const lockedTorch = rows.find((r) => r.name === 'torch')
        if (lockedTorch) {
          const j = judgeTorchSpec(lockedTorch.spec, hardware.recommended,
            { lockedPackages: lockedNames })
          torchRow.spec = lockedTorch.spec
          torchRow.verdict = j.verdict
          torchRow.why = j.why
          base.verdict = j.verdict
        }
      }
      base.locked = rows
    }
    json(res, 200, base)
  })
  return true
}

function json (res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * 兜住 readBody 回调里的异常。必须兜：readBody 不接回调的返回值，cb 一旦是 async 箭头，
 * 它返回的 Promise 无人接管，回调里任何一次 throw 都变成 unhandledRejection，
 * 一个字节都回不去，连接一直挂着（症状是「点了没反应」，不是报错）。
 * 兜住之后回出去的一定是合法 JSON：半个响应或空 body 会被前端报成「响应格式错误」。
 *
 * @param {object} res HTTP 响应
 * @param {Function} cb readBody 回调，通常是 async 箭头
 */
function respondSafely (res, cb) {
  return (err, body) => {
    Promise.resolve()
      .then(() => cb(err, body))
      .catch((e) => {
        // 已经写过响应头就不能再写：只把连接收掉，否则前端会看到不完整的 JSON。
        if (res.headersSent) { try { res.end() } catch { /* 已断开 */ } return }
        json(res, 500, { ok: false, code: 'BRIDGE_FAILED',
          error: (e && e.message) || String(e) })
      })
  }
}

/** 读请求体：有上限，超了就断（防止一个 manifest 把内存吃光） */
function readBody (req, cb, limit = 2 * 1024 * 1024) {
  let body = ''
  let tooBig = false
  req.on('data', (c) => {
    body += c
    if (body.length > limit) { tooBig = true; req.destroy() }
  })
  req.on('end', () => {
    if (tooBig) {
      cb(null, { tooBig: true }); return
    }
    if (!body.trim()) { cb(null, {}); return }
    try { cb(null, JSON.parse(body)) } catch (e) { cb(e, null) }
  })
}

// GET /wizard/state          当前状态（哪些步骤能走、哪些卡住）
function handleState (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/state')) return false

  // 这一层不 require 平台的 registry：那东西一 require 就去扫全盘，在一个「问问进度」的 GET 里太重。
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) {
    json(res, 200, { ok: true, state: 'idle',
      message: 'No link entered yet.' })
    return true
  }
  // 只报「这一步能不能走」，具体判定交给各步自己的模块
  let state = 'start'
  try {
    const dir = path.join(__dirname, '..', '..', '..', 'engines', id)
    state = fs.existsSync(path.join(dir, 'manifest.json'))
      ? 'manifest_done' : 'cloned_or_empty'
  } catch { state = 'start' }
  json(res, 200, { ok: true, state, id })
  return true
}

// POST /wizard/resolve      第 1 步：链接 → id
function handleResolve (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/resolve')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    if (body.tooBig) { json(res, 413, { ok: false, error: 'body too big' }); return }
    json(res, 200, resolveEngine({ url: body.url, id: body.id }))
  })
  return true
}

// 正在进行的克隆（id → AbortController），供取消端点使用
const cloneAbortControllers = new Map()

// POST /wizard/clone        第 2 步
// execute 必须显式 true：默认只回计划。
// 显式排除 /wizard/clone/cancel 与 /wizard/clone/remove：短前缀会把那两个长前缀端点
//   一并匹配掉，于是同名 handler 永远拿不到请求。中间件是「第一个返回 true 的赢」，
//   调表里的顺序挡不住前缀包含关系。
function handleClone (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/clone')) return false
  if (req.url.startsWith('/wizard/clone/cancel')) return false
  if (req.url.startsWith('/wizard/clone/remove')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const input = {
      id: body.id,
      cloneUrl: body.cloneUrl,
      branch: body.branch,
      depth: body.depth,
      execute: body.execute === true,
      ...(body.depth === 1 ? { depth: 1 } : {}),
    }
    if (!input.execute) {
      const r = buildClonePlan(input)
      json(res, r.ok ? 200 : 400, r)
      return
    }
    const ac = new AbortController()
    input.signal = ac.signal
    const id = String(input.id || '')
    if (id) cloneAbortControllers.set(id, ac)
    runClone(input).then((r) => {
      if (id) cloneAbortControllers.delete(id)
      json(res, r.ok ? 200 : 400, r)
    }).catch((e) => {
      if (id) cloneAbortControllers.delete(id)
      json(res, 500, { ok: false, code: 'BRIDGE_FAILED',
        error: (e && e.message) || String(e) })
    })
  })
  return true
}

// POST /wizard/clone/remove  {id}  删掉目标目录
// 两个用途共用这一个端点：目标目录已存在（之前克隆过）要重来 ⇒ 清除后重试克隆；
//   克隆完成后悔了 ⇒ 撤销克隆。显式排除 /wizard/clone/cancel，理由同 handleClone。
function handleCloneRemove (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/clone/remove')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const r = removeTargetDir(String(body.id || ''))
    json(res, r.ok ? 200 : 400, r)
  })
  return true
}

// POST /wizard/clone/cancel  {id}  取消正在进行的克隆
function handleCloneCancel (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/clone/cancel')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = String(body.id || '')
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return true }
    const ac = cloneAbortControllers.get(id)
    if (!ac) {
      json(res, 200, { ok: true, id, cancelled: false,
        note: 'No active clone found for this id.' })
      return
    }
    ac.abort()
    cloneAbortControllers.delete(id)
    json(res, 200, { ok: true, id, cancelled: true })
  })
  return true
}

// 正在进行的装依赖（id → AbortController），供取消端点使用。与 cloneAbortControllers
//   同一形状：装依赖可能跑几十分钟，取消按钮必须能杀掉那个进程，而不只是断掉前端的流。
const envAbortControllers = new Map()

// POST /wizard/env          第 3 步
// 显式排除 /wizard/env/cancel，理由同 handleClone：短前缀会吃掉长前缀端点。
function handleEnv (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/env')) return false
  if (req.url.startsWith('/wizard/env/cancel')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const input = {
      id: body.id,
      manifest: body.manifest,
      execute: body.execute === true,
      backend: body.backend,
      exclude: Array.isArray(body.exclude) ? body.exclude : [],
      // 使用者接受「升级 torch 到本机后端上可用版本」这条建议。
      //   torchSuggestion 由前端回传（它来自上一次计划里的那份建议），
      //   后端不自己重新探测来决定版本。
      upgradeTorch: body.upgradeTorch === true,
      torchSuggestion: body.torchSuggestion || null,
      // 使用者为某些包选定的版本（包名⇒版本号）。
      //   改版本要改清单本身，所以这一步不能靠排除实现。
      versionOverrides: (body.versionOverrides && typeof body.versionOverrides === 'object')
        ? body.versionOverrides : {},
      // root 与其他端点同一口径：给了就用，没给走 projectRoot()。
      //   测试与夹具需要它（测试不许写真仓库的 engines/）。
      root: body.root,
    }
    // 只出计划（execute:false）时走普通 JSON 响应：快的请求不该用流。
    if (!input.execute) {
      // 计划里带上 torch 版本与本机后端的匹配结论。
      //   判断是离线查表（后端对 torch 版本有下界，方向单向），
      //   不依赖网络 ⇒ 计划响应不会被网络拖慢，也不会因网络不通而漏掉提示。
      //   已经接受升级时不重复判断：建议前端已经拿着（它在执行请求里回传）。
      const suggestion = suggestTorchUpgrade(input.upgradeTorch === true ? null : input)
      const r = buildEnvPlan(input)
      if (suggestion && r.ok) r.torchSuggestion = suggestion
      json(res, r.ok ? 200 : 400, r)
      return
    }
    // 执行（execute:true）走 SSE 流式：装依赖要几分钟到几十分钟，普通 JSON 响应
    //   的意思是「前端等到全部装完」。流式让前端边装边看：每步开始推一个 step 事件，
    //   每行输出推一个 line。浏览器 fetch 能读 SSE（resp.body.getReader()），
    //   axios/XMLHttpRequest 不能，所以前端必须用 fetch；格式 `data: {json}\n\n` 是标准 SSE。
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // 必须关掉中间层的缓冲：vite 的 dev 中间件若缓冲，前端就等不到行。
      //   'x-accel-buffering': 'no' 是 nginx 约定；vite/node 原生也认 no-cache。
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
// 取消通道：前端点「取消」打这个端点 ⇒ abort ⇒ runEnv 杀进程树。
//   与前端的流断开无关：SSE 断了进程照跑，必须由服务端这一侧杀它。
    const ac = new AbortController()
    input.signal = ac.signal
    const envId = String(input.id || '')
    if (envId) envAbortControllers.set(envId, ac)
    // 解除挂起的监听：流结束时（done / BRIDGE_FAILED）必须摘掉注册，
    // 否则这个 AbortController 会一直挂在 id 上，下次重跑发现 id 已被占。
    const forget = () => { if (envId) envAbortControllers.delete(envId) }
    input.onStep = (i, total, step, argv) => {
      send('step', { i, total, argv: argv.join(' '), cwd: step.cwd })
    }
    input.onLine = (text, isErr) => {
      send('line', { text: text.replace(/\r?\n$/, ''), err: !!isErr })
    }
    runEnv(input).then((r) => {
      forget()
      send('done', r)
      res.end()
    }).catch((e) => {
      forget()
      send('done', { ok: false, code: 'BRIDGE_FAILED',
        error: (e && e.message) || String(e) })
      res.end()
    })
  })
  return true
}

// POST /wizard/env/cancel  {id}  取消正在进行的装依赖
// 与 handleCloneCancel 同构，但语义不同：克隆取消后删掉整个目标目录；装依赖取消后
//   引擎环境是不完整的，那个环境由重跑时先删 .venv 处理（env.js 的 hasPartialVenvMark
//   / markPartialVenv），所以这里只 abort，不删目录。
function handleEnvCancel (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/env/cancel')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = String(body.id || '')
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return true }
    const ac = envAbortControllers.get(id)
    if (!ac) {
      json(res, 200, { ok: true, id, cancelled: false,
        note: 'No active install found for this id.' })
      return
    }
    ac.abort()
    envAbortControllers.delete(id)
    json(res, 200, { ok: true, id, cancelled: true })
  })
  return true
}

// GET /wizard/download/files?id=  第 3 步：逐文件校验（不依赖 manifest）
//   直接列 engines/<id>/checkpoints/ 下的文件，返回文件名 + 大小。下载就是下载，
//   和名片没有关系。前端据此显示三态：已下载 / 未下载 / 不完整（大小为 0 或很小）
function handleDownloadFiles (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/download/files')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  const root = url.searchParams.get('root') || projectRoot() || ''
  const dir = path.join(root, 'engines', id, 'checkpoints')
  let files = []
  try {
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir).map((name) => {
        const stat = fs.statSync(path.join(dir, name))
        return { name, size: stat.size, isDir: stat.isDirectory() }
      }).filter((f) => !f.isDir)
    }
  } catch (e) { /* 读不到 ⇒ 空列表 */ }
  json(res, 200, { ok: true, files })
  return true
}

// GET /wizard/download/manifest?id=&repo=&tool=  第 3 步：获取远端文件列表
//   调用 fetchRemoteManifest 获取文件列表，再用 enrichManifestFiles 补本地状态
//   返回 { ok: true, files: [{ name, size, sha256, status, repo, tool, note, noteZh }] }
//   必须带 repo/tool：前端单文件下载完成后会重新调本端点刷新，刷新后整表覆盖。
//   不带 repo 就等于把表里每一项的来源抹掉，重下/续传按钮和仓库列会一起变成「未知」。
//
// 这里不写 async：async 函数对不匹配的请求也返回 Promise，中间件会据此当成已处理。
// 异步活一律塞进 readBody 回调或 .then() 里。
function handleDownloadManifest (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/download/manifest')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  const repo = url.searchParams.get('repo')
  const tool = url.searchParams.get('tool') || 'hf'
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  if (!repo) { json(res, 400, { ok: false, error: '?repo= is required' }); return true }
  const root = url.searchParams.get('root') || projectRoot() || ''
  fetchRemoteManifest(repo, tool).then(async (result) => {
    if (!result.ok) {
      json(res, 200, { ok: false, error: result.error || 'Failed to fetch remote manifest' })
      return
    }
    const enriched = await enrichManifestFiles(result.files, repo, tool, root, id)
    json(res, 200, { ok: true, files: enriched })
  }).catch((e) => {
    // 若异常发生在 json() 之后（例如 enrich 里又抛了），响应头已经写出去了，
    //   再写一次会抛 ERR_HTTP_HEADERS_SENT，把真正的错误盖掉。
    //   前端按 content-type 守卫判断，半个响应同样算「响应格式错误」
    //   ⇒ 只能收连接，不能补第二次 writeHead。
    if (res.headersSent) { try { res.end() } catch { /* 已断开 */ } return }
    json(res, 200, { ok: false, error: (e && e.message) || String(e) })
  })
  return true
}

// /wizard/download/file  第 3 步单文件操作
//   POST   { id, root, file } 下载单个文件，SSE 流式返回进度
//   DELETE { id, root, name, size, sha256 } 删掉判为不完整的那个文件
function handleDownloadFile (req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return false
  if (!req.url || !req.url.startsWith('/wizard/download/file')) return false
  if (req.method === 'DELETE') { handleDeletePartialFile(req, res); return true }
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const { id, file } = body
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }
    if (!file || !file.name) { json(res, 400, { ok: false, error: 'file.name is required' }); return }
    const root = body.root || projectRoot() || ''
    const repo = body.repo || ''
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    // 取消通道：同一台引擎的每一轮下载共用一个 AbortController。
    //   挂在 id 上而不是每个请求各自一份：并发下载时「取消」要停掉整轮，
    //   只停一个请求、其余照跑，界面上看着像没取消。
    //
    //   用引用计数而不是「建了就一直挂着」：一轮下载全部完成后要把 controller 摘掉，
    //   否则下一轮下载会捡上一个已经结束那一轮的 controller，
    //   语义上就乱了（那一轮已经结束，abort 它没有意义）。
    const dlId = String(id)
    let entry = downloadAbortControllers.get(dlId)
    if (!entry) {
      entry = { ac: new AbortController(), count: 0 }
      downloadAbortControllers.set(dlId, entry)
    }
    entry.count += 1
    const ac = entry.ac
    // 本次请求结束（无论成功失败）就把计数减一；这一轮没有在途请求了才摘掉 controller。
    //   被取消时 controller 已经 aborted，此时直接删掉是对的：
    //   取消后不应该再有新的下载挂到这个 id 上（前端会重新开一轮）。
    const forget = () => {
      const cur = downloadAbortControllers.get(dlId)
      if (!cur) return
      cur.count = Math.max(0, cur.count - 1)
      if (cur.count === 0 || cur.ac.signal.aborted) {
        downloadAbortControllers.delete(dlId)
      }
    }
    downloadFile(file, repo, root, id, (text, isErr) => {
      send('line', { text, err: !!isErr })
    }, (p) => {
      send('progress', { file: file.name, percent: Math.round((p.downloaded / p.total) * 100), downloaded: p.downloaded, total: p.total })
    }, undefined, ac.signal).then((r) => {
      forget()
      send('done', r)
      res.end()
    }).catch((e) => {
      forget()
      send('done', { ok: false, code: 'BRIDGE_FAILED',
        error: (e && e.message) || String(e) })
      res.end()
    })
  })
  return true
}

// 第 3 步的取消通道：按引擎 id 挂 AbortController。
//   一台引擎的一轮下载（可能同时有好几个文件在途）共用一个 controller，
//   取消一次就停掉这一轮的全部请求。
const downloadAbortControllers = new Map()

// POST /wizard/download/cancel  {id}  取消正在进行的下载
// 与 handleEnvCancel 同构，语义不同：取消下载不删任何东西，
//   已经下载完成的文件保留，未完成的文件由下载侧自己删除（download.js 的 abort 处理）。
//   「暂停」是另一层：它只停前端的派单，不终止在途的请求。
function handleDownloadCancel (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/download/cancel')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = String(body.id || '')
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return true }
    const entry = downloadAbortControllers.get(id)
    if (!entry) {
      json(res, 200, { ok: true, id, cancelled: false,
        note: 'No active download found for this id.' })
      return
    }
    entry.ac.abort()
    downloadAbortControllers.delete(id)
    json(res, 200, { ok: true, id, cancelled: true })
  })
  return true
}

// DELETE /wizard/download/file：删掉不完整的文件
//   判据用后端的 checkFileStatus（大小 + 上游 sha），不在前端按大小猜。
//   判为 ok 与 missing 的都不删：删 ok 会让使用者白下一遍。
function handleDeletePartialFile (req, res) {
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const { id, name, size, sha256 } = body
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }
    if (!name) { json(res, 400, { ok: false, error: 'name is required' }); return }
    const root = body.root || projectRoot() || ''
    removePartialFiles([{ name, size: size || null, sha256: sha256 || null }], root, id)
      .then((r) => {
        if (r.deleted.length === 0) {
          const needsVerify = (r.skipped || []).some((s) => s.code === 'NEEDS_VERIFY')
          json(res, 200, {
            ok: false,
            code: needsVerify ? 'NEEDS_VERIFY' : 'NOT_PARTIAL',
            error: needsVerify
              ? 'Cannot prove this file is complete or damaged: the remote gave '
                + 'no SHA-256 to compare against. Nothing was deleted.'
              : 'The file is not partial — nothing was deleted.',
            errorZh: needsVerify
              ? '无法证明这个文件是好的还是坏的：远端没有给出 SHA-256 可比对。'
                + '未删除任何内容。请重下（用续传）让平台重新校验。'
              : '该文件是完整的，未删除任何内容。',
          })
          return
        }
        json(res, 200, { ok: true, deleted: r.deleted, bytes: r.bytes })
      })
      .catch((e) => {
        json(res, 500, { ok: false, code: 'DELETE_FAILED',
          error: (e && e.message) || String(e) })
      })
  })
}

// GET /wizard/download/progress?id=  第 3 步：读断点续传进度
//   前端刷新后恢复下载状态用。返回已完成的命令列表。
function handleDownloadProgress (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/download/progress')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  const { readProgress } = require('./download')
  const root = url.searchParams.get('root') || projectRoot() || ''
  const done = [...readProgress(root, id)]
  json(res, 200, { ok: true, done })
  return true
}

// POST /wizard/download  {id, root, argv}  第 3 步：执行下载（SSE 流式）
//   统一落盘：调用方（前端）负责把命令里的 local_dir 替换成 engines/<id>/checkpoints/，
//   本端点只负责执行 + 透传输出。SSE 流式：每行输出推一个 line 事件，结束推 done。
function handleDownload (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/download')) return false
  // 显式排除 /wizard/download/cancel，理由同 handleEnv：短前缀会吃掉长前缀端点。
  //   把 cancel 排在 handleDownload 前面还不够：这个中间件是「第一个返回 true 的赢」，
  //   handleDownload 对 cancel 也会返回 true，抢在前面就把它吃掉了。
  if (req.url.startsWith('/wizard/download/cancel')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const input = {
      id: body.id,
      root: body.root,
      argv: body.argv,
      timeoutMs: body.timeoutMs,
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    input.onLine = (text, isErr) => {
      send('line', { text: text.replace(/\r?\n$/, ''), err: !!isErr })
    }
    input.onProgress = (p) => {
      send('progress', { file: p.file, percent: p.percent, downloaded: p.downloaded, total: p.total })
    }
    runDownload(input).then((r) => {
      send('done', r)
      res.end()
    }).catch((e) => {
      send('done', { ok: false, code: 'BRIDGE_FAILED',
        error: (e && e.message) || String(e) })
      res.end()
    })
  })
  return true
}

// GET /wizard/models?id=    第 4 步：只列，不下
function handleModels (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/models')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }

  // 不在这里 require profile：describeModels 内部用平台自己的 resolveEngineProfile，
  //   权威实现只有那一份，这里再 require 一次只会多一份「我以为它怎么用」的猜测。
  const r = describeModels(id)
  if (!r.ok) { json(res, r.code === 'NO_PROFILE' ? 404 : 400, r); return true }
  const { resolveEngineProfile } = require(
    path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'profile.js'))
  json(res, 200, { ...r, gaps: explainMissingInfo(resolveEngineProfile(id)) })
  return true
}

/**
 * GET /wizard/verify/checks?id=<id>&audio=A|B[&request=<json>]
 *   跑第 5 步的校验。audio 默认 B（只验宿主谈得拢，不合成）；
 *   audio=A 时要真合成一次，这时才会产出音频本体供波形用。
 *   request 是 A 级要的请求体（引擎方言的键名，平台不编）。
 */
function handleVerifyChecks (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/verify/checks')) return false
  const url = new URL(req.url, 'http://localhost')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return true }

  const audioLevel = url.searchParams.get('audio') === 'A' ? 'A' : 'B'
  let request = null
  const rawRequest = url.searchParams.get('request')
  if (rawRequest) {
    try { request = JSON.parse(rawRequest) } catch (e) {
      json(res, 400, { ok: false, error: `request 不是合法 JSON：${e.message}` }); return true
    }
  }

  const r = runChecks(id, { deep: true })
  // runChecks 在名片解析不出时只回 {ok, code, error, errorZh}，没有 checks 字段。
  //   直接往 r.checks 上挂会抛 TypeError，变成 HTTP 500 而不是如实报错。
  if (!r.checks) {
    r.checks = {}
  }
  const audio = runAudioCheck(id, { audio: audioLevel, request })
  // A 级合成成功时 audio_path 已由 verify_audio.py 给出；B 级不合成，
  // 磁盘上可能留着上次的 A 级产物，能找到就带上。
  if (!audio.audio_path) {
    const found = findVerifyAudio(id)
    if (found) audio.audio_path = found
  }
  r.checks.audio = audio
  json(res, r.ok ? 200 : 400, r)
  return true
}

/** 找 engines/<id>/.wizard-verify-audio/ 下第一个 wav，返回绝对路径；找不到返回 null。 */
function findVerifyAudio (id) {
  try {
    const dir = audioDirFor(id)
    if (!dir) return null
    if (!fs.existsSync(dir)) return null
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.wav'))
    if (files.length === 0) return null
    return path.join(dir, files[0])
  } catch { /* 读不到就当没有 */ return null }
}

/**
 * 算出 engines/<id>/.wizard-verify-audio/ 的绝对路径。
 * id 里带路径分隔符或 .. 的要拒掉：归一化之后可能逃出 engines/<id>/，
 *   那就是越权读。save.js 的 validateId 判越界也是这个做法。
 */
function audioDirFor (id) {
  const enginesDir = path.resolve(projectRoot(), 'engines')
  const dir = path.resolve(enginesDir, String(id), '.wizard-verify-audio')
  // 必须在 engines/<id>/ 之内：先比前缀，再确认不是 engines 本身
  const insideEngines = dir.startsWith(enginesDir + path.sep)
  if (!insideEngines) return null
  const idPart = path.resolve(enginesDir, String(id))
  if (idPart === enginesDir) return null
  return dir
}

// GET /wizard/verify/audio?id=<id>
//   把 verify_audio.py 写出的音频文件送前端，供 Player.jsx 画波形。
//   只允许读 engines/<id>/.wizard-verify-audio/ 下的 wav，
//   越权路径一律拒（见 audioDirFor）。
function handleVerifyAudio (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/verify/audio')) return false
  const url = new URL(req.url, 'http://localhost')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return true }
  const dir = audioDirFor(id)
  if (!dir) { json(res, 400, { ok: false, error: 'invalid id' }); return true }
  let audioFile = null
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.wav'))
      if (files.length > 0) audioFile = path.join(dir, files[0])
    }
  } catch { /* 读不到就如实报 */ }
  if (!audioFile || !fs.existsSync(audioFile)) {
    json(res, 404, { ok: false, error: 'no audio file found' }); return true
  }
  // 读之前再确认一次：文件本身不能是符号链接，也不能经由 junction 指到别处。
  // 基准必须是 enginesDir 自己，不能拿 dir 做基准：dir 与文件可以同时被同一个 junction
  // 穿过（engines/<id>/.wizard-verify-audio 整个是指向外面的联接），那样
  // realFile.startsWith(realDir) 恒真，守卫自证为空。
  try {
    const enginesReal = fs.realpathSync(path.resolve(projectRoot(), 'engines'))
    const fileReal = fs.realpathSync(audioFile)
    if (!fileReal.startsWith(enginesReal + path.sep)) {
      json(res, 400, { ok: false, error: 'audio file is outside the engines directory' }); return true
    }
    // 还要落在本引擎自己的目录下：跨引擎读同样不该允许
    const idReal = fs.realpathSync(path.resolve(projectRoot(), 'engines', String(id)))
    if (!fileReal.startsWith(idReal + path.sep)) {
      json(res, 400, { ok: false, error: 'audio file belongs to another engine' }); return true
    }
  } catch (e) {
    json(res, 404, { ok: false, error: `cannot resolve audio file: ${e.message}` }); return true
  }
  const data = fs.readFileSync(audioFile)
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': data.length })
  res.end(data)
  return true
}

/**
 * POST /wizard/verify  {id, deep?, audio?, request?}
 *  调平台的四道校验，本文件不自己做判断
 */
function handleVerify (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/verify')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = body.id
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }

    if (body.audio) {
      const r = runAudioCheck(id, { audio: body.audio, request: body.request })
      json(res, r.ok ? 200 : 400, r)
      return
    }
    const r = runChecks(id, { deep: body.deep !== false })
    json(res, 200, r)
  })
  return true
}

// POST /wizard/params      第 4 步：反射 → parameters[] 草稿 + 映射候选
// 这一步能离线跑：第 4 步写名片时，源码（第 1 步克隆）、环境（第 2 步）、权重（第 3 步）
//   全部已在磁盘上 ⇒ 不需要联网。
// 这条端点只产草稿，绝不写 manifest.json：parameters[] 与 map_candidates 都是候选，
//   界面逐条确认后才可能进表单；落盘是 POST /wizard/save 的事。
// 不新增任何平台侧校验逻辑：反射器报什么就传什么，partial / warnings / excluded 原样带出去。
// 这里不写 async：async function 无论 URL 匹不匹配都返回 Promise ⇒ 中间件一见到 Promise
//   就 break 出循环并 next() ⇒ 本函数对所有请求都被提前中断 ⇒ 请求穿透到 vite 的
//   HTML fallback ⇒ 200 + text/html ⇒ 第 4 步参数反射永远拿不到 JSON。
//   异步活全在 readBody 的回调里做；函数本身同步返回 true/false。
function handleParams (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/params')) return false
  // 锚定：startsWith 会把 /wizard/paramsxyz、/wizard/params/extra 一起吃掉。
  //   前缀必须整串匹配（后面只许跟 ? 查询串）：与 handleProfile 的
  //      '/wizard/profile/' 同一类判据（长/短前缀互吃的坑）。
  const tail = req.url.slice('/wizard/params'.length)
  if (tail !== '' && tail[0] !== '?') return false
  readBody(req, respondSafely(res, async (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    if (body.tooBig) { json(res, 413, { ok: false, error: 'body too big' }); return }

    const { buildSpec } = require('./paramsFromReflect')
    const spec = buildSpec(body)
    if (!spec.ok) { json(res, 400, { ok: false, code: 'BAD_SPEC', error: spec.error }); return }

    // 第 2 步：上游 CLI 的官方原话（argparse help= 整份摊开）。抓不到不影响反射：
    //   那是一个答案（这台引擎的 CLI 不在盘上 / 没有 CLI），如实带 note 出去。
    // 扫描目录必须就是这台引擎自己的目录（spec.value.sys_path[0]）：扫它的上级会递归
    //   扫遍 engines/ 下每一台引擎、tools/、lib/ 的 argparse 文件，别的引擎的 flag
    //   会被当成这台引擎的官方原话摊开，静默误导。引擎自己目录下的其它 argparse
    //   脚本仍会进来，它们是这台引擎的源码；不按目录名再筛一层：「哪个 CLI 才是
    //   用户会敲的那个」是人的判断，平台的活是摊开全部 + 标出来源文件。
    let cli = null
    try {
      const { collectCliHelp } = require('./cliHelp')
      cli = collectCliHelp({
        dir: spec.value.sys_path[0],
        python: spec.value.python,
      })
    } catch (e) {
      cli = { ok: false, error: `抓 CLI 原话失败：${e.message}`, sources: [], flags: [], by_dest: {} }
    }

    // 反射失败（ok:false）是一个答案，不是端点出错 ⇒ 一律 200。反射器永远以 0 退出，
    //   正是为了让「跑完了但没结果」与「跑挂了」能分开。
    // opts.manifest：把名片原文传下去，靠它补上 call.bind 指向的真实入参（反射器读不到
    //   bind，而那是这台引擎真实必填的 text / output_path）。不传的后果不是报错，
    //   是「界面上少两格必填」，且没有任何信号。
    const r = reflectAndBuild(spec.value, {
      methods: body.methods,
      existing: body.existing,
      existingMaps: body.existingMaps,
      timeoutMs: body.timeoutMs,
      manifest: spec.manifest,
    })
    if (!r.ok) { json(res, 200, r); return }
    // 把草稿按「用户操作流」排成三块（①已自动填 ②必须你填 ③可以不管）
    //   只是重排 + 贴上游原话，不改 parameters[] 的内容，也不删任何一条。
    let organized = null
    try {
      const { organizeDraft } = require('./cliHelp')
      organized = organizeDraft(r, cli && cli.ok ? cli : null)
    } catch (e) {
      organized = { ok: false, error: `分区失败：${e.message}`, blocks: [] }
    }
    json(res, 200, { ...r, cli, organized })
  }))
  return true
}

// POST /wizard/cli-args：走命令行（cli 形态）的草稿生成。
// 与 /wizard/params（反射函数签名）并列的另一条路：不 import 引擎、不读函数签名，
//   直接以上游命令行的 --flag 为参数，所以 flag 即参数，官方 help 直接挂它上面；
//   几乎每台引擎都有 CLI，不用管它内部是什么 Python 类。
// 入参 {id}（引擎目录名 engines/<id>/）；出参 {ok, subcommands, args, suggested_call}：
//   subcommands 上游有哪些子命令（synth/infer/batch…），用户选一个；args 该子命令的
//   flag 列表，每条 {name, flag, style, help, required, is_tool}；suggested_call
//   建议的 cli 形态 call 段骨架（只是骨架，人确认后才落盘）。
// 一条 flag 都不删、help 原样递出、不预设哪个子命令是对的：全列出。
// 与 handleParams 同：同步返回 true（URL 匹配即接管），readBody 在回调里异步处理。
function handleCliArgs (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/cli-args')) return false
  const tail = req.url.slice('/wizard/cli-args'.length)
  if (tail !== '' && tail[0] !== '?') return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    if (body.tooBig) { json(res, 413, { ok: false, error: 'body too big' }); return }

    const { buildSpec } = require('./paramsFromReflect')
    // forCli：cli 扫描定位目录即可，不走反射的 call.module/class 前置校验
    //   （那会把新建名片直接 BAD_SPEC 堵死）。
    const spec = buildSpec(body, { forCli: true })
    if (!spec.ok) { json(res, 400, { ok: false, code: 'BAD_SPEC', error: spec.error }); return }

    // 引擎目录 = sys_path[0]（kind=cli 时就是 engines/<id>）
    const dir = spec.value.sys_path && spec.value.sys_path[0]
    let cli = null
    try {
      const { collectCliHelp } = require('./cliHelp')
      cli = collectCliHelp({ dir, python: spec.value.python })
    } catch (e) {
      cli = { ok: false, error: `扫 CLI 失败：${e.message}`, flags: [], by_dest: {}, sources: [] }
    }

    const { buildCliDraft } = require('./cliDraft')
    const draft = buildCliDraft(cli, { subcommand: body.subcommand || null })
    json(res, 200, draft)
  })
  return true
}

// POST /wizard/discover：自动探测引擎形态并发现参数
// 平台不假设引擎形态，先探测再决定：
//   1. 读 engines/<id>/ 看有没有 argparse 源码 → 有则跑 cli 扫描
//   2. 读名片看 call.kind 或看有没有 python class → 是 python 则跑反射
//   3. 两者都有 → 都跑，结果经 paramDigest 合并
//   4. 都没有 → 返回 {ok:false, error:'未能发现参数，请手工填写'}
// 探不到如实报，不假装。python 反射失败（venv 未配好等）如实说明。
function handleDiscover (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/discover')) return false
  const tail = req.url.slice('/wizard/discover'.length)
  if (tail !== '' && tail[0] !== '?') return false
  readBody(req, async (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    if (body.tooBig) { json(res, 413, { ok: false, error: 'body too big' }); return }

    const id = body.id
    if (!id || typeof id !== 'string') {
      json(res, 400, { ok: false, error: 'id is required' })
      return
    }

    const dir = path.join(__dirname, '..', '..', '..', 'engines', id)
    if (!fs.existsSync(dir)) {
      json(res, 404, { ok: false, error: `引擎目录不存在：${id}` })
      return
    }

    const notes = []
    let manifest = {}
    const mf = path.join(dir, 'manifest.json')
    if (fs.existsSync(mf)) {
      try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')) } catch { manifest = {} }
    }

    let cliHelpResult = null
    let cliDraft = null
    let hasCli = false
    try {
      const { findCliFiles } = require('./cliHelp')
      const cliFiles = findCliFiles(dir)
      hasCli = cliFiles.length > 0
      if (hasCli) {
        notes.push(`发现 ${cliFiles.length} 个 argparse 源文件：${cliFiles.join(', ')}`)
        const { collectCliHelp } = require('./cliHelp')
        cliHelpResult = collectCliHelp({ dir })
        if (cliHelpResult.ok && cliHelpResult.flags && cliHelpResult.flags.length > 0) {
          const { buildCliDraft } = require('./cliDraft')
          cliDraft = buildCliDraft(cliHelpResult)
          notes.push(`CLI 扫描得到 ${cliDraft.args ? cliDraft.args.length : 0} 个 flag`)
        } else if (cliHelpResult.ok) {
          notes.push('CLI 源文件里没有 add_argument 调用')
        } else {
          notes.push(`CLI 扫描失败：${cliHelpResult.error}`)
        }
      } else {
        notes.push('没有发现 argparse 源文件')
      }
    } catch (e) {
      notes.push(`CLI 探测异常：${e.message}`)
    }

    let hasPython = false
    let pythonDraft = null
    let pythonSpec = null
    try {
      const { buildSpec } = require('./paramsFromReflect')
      // 不用 forCli：需要完整的 call.module/class 校验
      pythonSpec = buildSpec({ id })
      if (pythonSpec.ok) {
        hasPython = true
        notes.push(`名片声明了 python 类：${pythonSpec.value.module}.${pythonSpec.value.class}`)
      } else {
        if (pythonSpec.error && pythonSpec.error.includes('call.module')) {
          notes.push('名片没有声明 python 类（call.module / call.class 缺失）')
        } else if (pythonSpec.error && pythonSpec.error.includes('runtime.python')) {
          notes.push('名片没有配置 runtime.python（引擎环境未就绪）')
        } else {
          notes.push(`python 形态探测失败：${pythonSpec.error}`)
        }
      }
    } catch (e) {
      notes.push(`python 形态探测异常：${e.message}`)
    }

    if (!hasCli && !hasPython) {
      json(res, 200, {
        ok: false,
        error: '未能发现参数，请手工填写',
        notes,
      })
      return
    }

    if (hasPython && pythonSpec && pythonSpec.ok) {
      const pyExe = pythonSpec.value.python
      // pyExe 可能指向目录而非可执行文件，必须确认是文件后再用
      const pyReady = pyExe && fs.existsSync(pyExe) && fs.statSync(pyExe).isFile()
      if (!pyReady) {
        notes.push('引擎环境未就绪，先完成第 2 步')
      } else {
        try {
          const { reflectAndBuild } = require('./paramsFromReflect')
          pythonDraft = reflectAndBuild(pythonSpec.value, { manifest })
          if (pythonDraft.ok) {
            const count = pythonDraft.parameters ? pythonDraft.parameters.length : 0
            notes.push(`python 反射得到 ${count} 个参数`)
            if (pythonDraft.warnings && pythonDraft.warnings.length > 0) {
              notes.push(`python 反射有 ${pythonDraft.warnings.length} 条警告`)
            }
          } else {
            notes.push(`python 反射失败：${pythonDraft.error}`)
            // 反射失败不影响 cli 路的结果
          }
        } catch (e) {
          notes.push(`python 反射异常：${e.message}`)
        }
      }
    }

    const { merge } = require('./paramDigest')
    const cliArgs = cliDraft && cliDraft.ok ? cliDraft.args : []
    const pythonParams = pythonDraft && pythonDraft.ok ? pythonDraft.parameters : []
    const { params, groups } = merge(cliArgs, pythonParams)

    const source = hasCli && hasPython ? 'both' : (hasCli ? 'cli' : 'python')

    json(res, 200, {
      ok: true,
      source,
      params,
      groups,
      suggested_call: cliDraft && cliDraft.ok ? cliDraft.suggested_call : null,
      notes,
      counts: {
        cli: cliArgs.length,
        python: pythonParams.length,
        total: params.length,
      },
    })
  })
  return true
}

// GET /wizard/profile/<id>：第 4 步：从已有引擎导入
// 调用平台的 resolveEngineProfile(id)，返回解析后的 profile。
//   前端把解析后的 profile 转换回 manifest 格式，自动填写核心字段。
// 不自己解析 manifest：那是平台的事，这里只做转发。
function handleProfile (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/profile/')) return false

  const raw = req.url.slice('/wizard/profile/'.length).split('?')[0]
  let id
  try { id = decodeURIComponent(raw) } catch { id = raw }

  try {
    const { resolveEngineProfile } = require(
      path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'profile.js'))
    const profile = resolveEngineProfile(id)
    json(res, 200, { ok: true, profile })
  } catch (e) {
    json(res, 404, { ok: false, error: e.message, code: e.code })
  }
  return true
}

// GET /wizard/install-state?id=   「这台引擎现在装到哪了」
// 完成状态（流程条上的对勾）只由真实产物判，不由「用户点过什么」判；前端 App 挂载时
//   调它渲染对勾，不依赖 localStorage 里的 facts。
// 必须用 req.url，不是 req.path（Vite 的 connect 有时不给 req.path，会报 500
//   "path argument must be of type string"）。
// 判据全部是盘上的东西，不写死任何引擎名。
// 与 GET /wizard/installed（返回引擎列表那一个）不冲突：那个回答「装过哪些」，
//   这个回答「这一台装到哪了」。
// 不许写成 async handler：中间件见到 Promise 就 break + next()，排在本函数后面的
//   handler 会全部静默失效（同 handleParams 的头注）。
function handleInstallState (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/install-state')) return false
  // 前缀认的是整串（后面只许跟 ? 查询串）：与 handleParams 的 tail 检查同判据
  const tail = req.url.slice('/wizard/install-state'.length)
  if (tail !== '' && tail[0] !== '?') return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  const root = url.searchParams.get('root') || projectRoot() || ''
  try {
    const { installState } = require('./installState')
    json(res, 200, installState(root, id))
  } catch (e) {
    // 端点自己出问题不许把 500 摊给界面：如实说「判不出来」，
    //   而那正是所有步骤都没勾的理由，不是崩掉。
    json(res, 200, { ok: false, error: (e && e.message) || String(e), steps_done: {} })
  }
  return true
}

// POST /wizard/reset-progress   {id, section}  逃生口：从头重装本步
// 只清「哪些步骤算做完了」这份记录：
//    不删引擎目录里的源码、不删已装依赖、不删已下载的模型文件。
// section：'env'（第 2 步装依赖）/ 'models'（第 3 步下模型）/ 'all'
function handleResetProgress (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/reset-progress')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    if (body.tooBig) { json(res, 413, { ok: false, error: 'body too big' }); return }
    const id = body.id
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }
    const root = body.root || projectRoot() || ''
    try {
      // 目录不存在 ⇒ 没有进度可清，不许顺手写一个文件进去。
      //   那会在 engines/ 下凭空造一个引擎目录，而向导的约定是
      //   「engines/ 里只写真克隆出来的东西」。
      const { validateId } = require('./save')
      const idErr = validateId(id)
      if (idErr) { json(res, 400, { ok: false, code: 'BAD_ID', error: idErr }); return }
      const dir = path.join(root, 'engines', id)
      if (!fs.existsSync(dir)) {
        json(res, 200, { ok: true, id, section: body.section || 'env', cleared: 0,
          note: '引擎目录不存在，没有进度可清。' })
        return
      }
      const { resetProgress } = require('./installState')
      resetProgress(root, id, body.section)
      json(res, 200, { ok: true, id, section: body.section || 'env' })
    } catch (e) {
      json(res, 500, { ok: false, code: 'RESET_FAILED',
        error: (e && e.message) || String(e) })
    }
  })
  return true
}

module.exports = {
  handleState, handleResolve, handleProbe, handleDeps, handleHardware,
  handleClone, handleEnv, handleDownload, handleDownloadProgress, handleDownloadFiles, handleModels,
  handleDownloadManifest, handleDownloadFile, handleDownloadCancel,
  handleVerifyChecks, handleVerify, handleVerifyAudio, handleProfile, handleParams, handleCliArgs,
  handleDiscover,
  handleInstallState, handleResetProgress, handleCloneCancel, handleCloneRemove, handleEnvCancel,
  // 这两个导出给测试：第 3 步「上游自己的下载方式」全靠它们，
  //   让守卫测试能直接验证「拆成三段 + 不猜」。
  extractDownloadCommands, parseDownloadCmd,
  // 导给守卫测试：async handler 挂死这条回归要直接验证它回的是合法 JSON。
  respondSafely,
  // 导给守卫测试：分支探测的缓存命中路径要能直接验（命中与未命中必须同形状）。
  __test__: { readDefaultBranch, resolveProbeBranch, _branchCache },
}