'use strict'
// ============================================================================
//  WIZARD BRIDGE —— 把六步挂到 HTTP 上
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
//  ⛔ 纪律：⛔ 本文件**不做**任何业务判断，只做「路由 + 转交」+ 读文件。
// ============================================================================

const fs = require('node:fs')
const path = require('node:path')

const { resolveEngine, parseRepoUrl } = require('./resolve')
const { runClone, buildClonePlan } = require('./clone')
const { runEnv, buildEnvPlan } = require('./env')
const { runDownload, unifyDest, fetchRemoteManifest, checkFileStatus, downloadFile } = require('./download')
const { describeModels, explainMissingInfo } = require('./models')
const { probeProject, detectDependencyFile, planDependencies } = require('./probe')
const { inspectHardware, parseUvLock } = require('./hardware')
const { checks: verifyChecks, runChecks, runAudioCheck } = require('./verify')
const https = require('node:https')

/**
 * ⭐ 第 2 步的探测：**只读上游那几个文本文件**，⛔ 不 clone、不建目录。
 *
 * ⚠ 为什么走 https 直读而不是先 clone 下来再读：
 *   第 3 步才是克隆（PLAN_v2 §二的顺序）。⛔ 如果探测就 clone，
 *   那目录会先变非空 —— 正好把第 3 步的前提破坏掉。
 *
 * ⛔ 只读这几个文件，一个别的都不读：
 *   pyproject.toml / uv.lock / requirements.txt / environment.yml / setup.py
 *   ⛔ 不下载仓库、不执行上游任何代码。
 */
/**
 * ⭐⭐ 从 README 原文里挑出**模型下载命令**（形态二：上游没脚本，只写了命令）
 *
 * ⚠ 只认**下载工具的固定前缀** —— ⛔ 不做自然语言理解、不猜：
 *   hf download / huggingface-cli download / modelscope download
 *   这三个是 TTS 项目实际在用的（实测某上游 README 里就是 hf download）。
 * ⛔ 命令不完整（没带仓库名）也照样给出来 —— ⛔ 平台不替它补全，
 *   补错了等于平台在编造上游的下载方式。
 *
 * @param {string} markdown README 原文
 * @returns {string[]} 去重后的命令（保持 README 里的顺序）
 */
function extractDownloadCommands (markdown) {
  if (!markdown || typeof markdown !== 'string') return []
  const OUT = []
  const seen = new Set()
  // ⭐ 2026-10-06 扩展：除了 CLI（hf/modelscope download），还认
  //   Python API 形态 —— snapshot_download("repo", local_dir=...)
  //   （实测某上游只给了 Python API，没给 CLI 命令）。
  for (const m of markdown.matchAll(/^[ \t]*(?:\$|>|#{1,6}\s*)?((?:(?:uv tool install|pip install)[^\n]*\n[ \t]*)?(?:\b(?:hf|huggingface-cli|modelscope)[ \t]+download\b[^\n`]*|snapshot_download\s*\([^)\n]*\)))/gm)) {
    let cmd = m[1].trim().replace(/\s+/g, ' ')
    cmd = cmd.replace(/[`|]+$/, '').trim()
    if (!cmd || seen.has(cmd)) continue
    seen.add(cmd)
    // ⚠ 2026-10-05 Owner：「四条命令让用户自己选，下载之前可以探测一下有什么，
    //   用户可以自选目录，也就是 --local-dir=checkpoints 这里
    //   改一个 --local-dir=path/set/by/user 的事，魔搭那个也是同理的」
    //
    // ⛔ 所以**不能把整条命令原样丢出去** —— 原样就等于把目标目录
    //   写死成上游随手取的名（checkpoints / checkpoints_2）。
    // ✅ 拆成结构：① 用哪个工具 ② 下哪个模型 ③ 目标目录（**可改**）
    const parts = parseDownloadCmd(cmd)
    if (!parts) continue
    OUT.push(parts)
  }
  return OUT
}

/**
 * ⭐ 把一条下载命令拆成「工具 / 模型 / 目标目录」。
 *
 * ⛔ 只认已知的两种工具和它们的参数写法（实测 TTS 项目就这两种）：
 *     hf download <org>/<repo> --local-dir=<dir>
 *     modelscope download --model <org>/<repo> --local_dir <dir>
 * ⛔ 认不出来的写法 ⇒ 返回 null ⇒ 界面上**如实说「看不懂这条」**，
 *   ⛔ 绝不猜（猜错 = 平台替上游编了一个错的下载方式）。
 */
function parseDownloadCmd (cmd) {
  // ⭐ 形态③ Python API：snapshot_download("repo", local_dir='...')
  //   （实测某上游只给了 Python API，没给 CLI 命令）
  //   ⛔ 它包在 python 代码里，不是裸命令 —— 提取 repo + local_dir，
  //     向导负责把它包成一条可执行命令（python -c "..."）。
  const sd = cmd.match(/snapshot_download\s*\(\s*['"]([^'"]+)['"]/)
  if (sd) {
    const repo = sd[1]
    const dir = (cmd.match(/local_dir\s*=\s*['"]?([^'",\s)]+)['"]?/) || [])[1]
    // ⛔ 只有 modelscope / huggingface 形状的 repo 才认
    if (!/^[^/]+[\/][^/]+/.test(repo)) return null
    return { tool: 'snapshot', repo, dir: dir || null, raw: cmd }
  }
  // 形态① modelscope: --model <repo> [--local_dir <dir>]
  const ms = cmd.match(/^modelscope\s+download\b(.*)$/)
  if (ms) {
    const repo = (ms[1].match(/--model\s+([^\s]+)/) || [])[1]
    if (!repo) return null
    const dir = (ms[1].match(/--local_dir\s+([^\s]+)/)
      || ms[1].match(/--local-dir[=\s]+([^\s]+)/) || [])[1]
    return { tool: 'modelscope', repo, dir: dir || null, raw: cmd }
  }
  // 形态② hf / huggingface-cli: <org>/<repo> [--local-dir=<dir>]
  // ⚠ 2026-10-05 守卫抓到的 bug：原来用 `([^\s]+)` 抓第一个 token 当仓库名，
  //   ⛔ 于是 `hf download --local-dir=x` 会把 **`--local-dir=x` 当成模型名**。
  //   ⛔ 那等于平台替上游编了一个不存在的模型。
  // ✅ 所以必须先排掉以 `-` 开头的 token（那是参数，不是位置参数）。
  const rest = cmd.replace(/^(?:hf|huggingface-cli)\s+download\s+/, '')
  const toks = rest.split(/\s+/)
  const repo = toks.find((t) => t && !t.startsWith('-'))
  if (!repo || !/^[^\s/]+\/[^\s/]+/.test(repo)) return null
  const tail = rest.slice(rest.indexOf(repo) + repo.length)
  const dir = (tail.match(/--local-dir[=\s]+([^\s]+)/) || [])[1]
  return { tool: 'hf', repo, dir: dir || null, raw: cmd }
}

/**
 * ⭐ 上游可能提供的**模型下载入口**文件名。
 *
 * ⚠ 这是「探测清单」，⛔ 不是「平台支持的下载方式」——
 *   平台不实现任何下载逻辑，⛔ 只是告诉用户「上游自己有个脚本可以跑」。
 *   ⛔ 清单之外的（引擎自研的 downloader.py 等）读不到 ⇒ 如实说没找到。
 */
const DOWNLOAD_SCRIPTS = [
  'download_models.py',
  'download_models.sh',
  'download.sh',
  'download.py',
  'download_weights.py',
  'download_ckpt.py',
  'download_checkpoints.sh',
]

function fetchRaw (owner, name, file) {
  return new Promise((resolve) => {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/main/${file}`
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

/** POST /wizard/probe {url} —— ⭐ 探测上游（只读文本文件） */
function handleProbe (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/probe')) return false
  readBody(req, async (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const parsed = parseRepoUrl(body.url)
    if (!parsed.ok) { json(res, 400, parsed); return }

    // ⛔ 候选清单固定 —— 一个都不多读
    const CANDIDATES = ['pyproject.toml', 'uv.lock', 'requirements.txt',
      'environment.yml', 'setup.py']
    const texts = {}
    const found = []
    for (const f of CANDIDATES) {
      const t = await fetchRaw(parsed.owner, parsed.repo, f)
      if (t !== null) { found.push(f); texts[f] = t }
    }

    // ⭐⭐⭐ **上游自己的模型下载入口**（2026-10-05 Owner 定：
    //   「模型不再需要统一管理……不同引擎项目里面一定会有下载模型的代码的」）
    //
    // ⛔ 之前平台自己列一张表让人抄命令 —— 那是**重复造轮子**：
    //   上游知道自己的模型在哪个仓库、要下哪几个文件、用 hf 还是 modelscope。
    //
    // ⚠ 实测（2026-10-05，两个真上游）这件事有两种形态：
    //   ① **有脚本**：根目录有 download_models.py / download_weights.py 之类
    //   ② **写进 README**：没有脚本，但 README 里直接给了命令 ——
    //      实测某个上游就是 `hf download <org>/<repo> --local-dir=checkpoints`，
    //      根目录只有 tools/gpu_check.py，⛔ 没有任何下载脚本。
    //   ⇒ 两种都要认，⛔ 认不到才如实说「上游没给」。
    const dlScripts = []
    for (const f of DOWNLOAD_SCRIPTS) {
      const t = await fetchRaw(parsed.owner, parsed.repo, f)
      if (t !== null) {
        dlScripts.push({ kind: 'script', file: f,
          head: t.split('\n').slice(0, 12).join('\n') })
      }
    }
    // ② README 里的下载命令（形态二）
    let readmeCmds = []
    if (dlScripts.length === 0) {
      const rd = (await fetchRaw(parsed.owner, parsed.repo, 'README.md')) || ''
      readmeCmds = extractDownloadCommands(rd)
    }

    if (!texts['pyproject.toml']) {
      // ⛔ 没有 pyproject ⇒ 如实说「探测器用不上」，⛔ 不退回任何别的来源
      json(res, 200, {
        ok: true,
        meta: { dependencies: detectDependencyFile(found) },
        note: 'This repository has no pyproject.toml, so project metadata cannot be read.',
    noteZh: '这个仓库没有 pyproject.toml，读不到项目信息。'
          + '包名/入口/命令这些事实读不出来。\n'
          + '这不代表该仓库没有依赖，依赖也可能位于子目录中。'
      + '请改用带依赖清单的仓库，或按上游说明自行安装。',
        found_files: found,
        downloader: dlScripts,
        downloader_cmds: readmeCmds,
      })
      return
    }

    const r = probeProject({ pyproject: texts['pyproject.toml'], filenames: found })
    // ⭐ 统一返回契约：所有 /wizard/* 端点成功时都带 ok:true
    //   （前端据此判成功；少了它界面会把成功当失败 —— 实测踩过）
    json(res, 200, { ok: true, ...r, found_files: found,
      downloader: dlScripts, downloader_cmds: readmeCmds })
  })
  return true
}

/**
 * POST /wizard/deps  {url}
 *  ⭐ 第 2 步的数据源：读上游 pyproject + uv.lock，跟本机比出绿/黄/白。
 *  ⛔ 不装任何东西 —— 只回答「要装哪些包」。
 */
/**
 * GET /wizard/hardware —— ⭐ 单独暴露硬件检测（排查用，也给界面复用）
 *
 * ⛔ 检测失败**不能**让端点挂掉 —— 退 CPU 是一个有意义的答案，
 *   而不是 500（2026-10-03 实测踩过：这里抛出去，整个 /wizard/deps 也没了）。
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


function handleDeps (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/deps')) return false
  readBody(req, async (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const parsed = parseRepoUrl(body.url)
    if (!parsed.ok) { json(res, 400, parsed); return }

    const get = async (f) => {
      const t = await fetchRaw(parsed.owner, parsed.repo, f)
      return t
    }
    const [py, lockText] = await Promise.all([get('pyproject.toml'), get('uv.lock')])

    if (!py) {
      json(res, 200, { ok: false, code: 'NO_PYPROJECT',
        error: 'This repository has no pyproject.toml, so the dependency list cannot be read.\n',
    errorZh: '这个仓库没有 pyproject.toml，读不到依赖列表。\n'
          + '它可能在 uv.lock / requirements.txt 或子目录里。请换一份带依赖清单的仓库，或按上游说明自己安装。' })
      return
    }

    // ⭐ 本机检测 —— ⛔ 失败也不让整个请求失败（CI 上没 GPU 也要能跑）
    let hardware = null
    try { hardware = inspectHardware() } catch { hardware = null }

    const base = planDependencies(py, { hardware })
    if (!base.ok) { json(res, 200, base); return }

    // ⭐ 把 lock 里的 torch 系并进去 —— pyproject 只写 torch>=2.5.0，
    //   真正锁死 wheel 的是 lock（2026-10-04 实测：只看 pyproject 判不出后端）
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

/** 读请求体 —— ⛔ 有上限，超了就断（防止一个 manifest 把内存吃光） */
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

// ---------------------------------------------------------------------------
//  GET /wizard/state          当前状态（哪些步骤能走、哪些卡住）
// ---------------------------------------------------------------------------
function handleState (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/state')) return false

  // ⛔ 这一层不 require 平台的 registry —— 那东西一 require 就去扫全盘，
  //   在一个「问问进度」的 GET 里做太重了。
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) {
    json(res, 200, { ok: true, state: 'idle',
      message: 'No link entered yet.' })
    return true
  }
  // ⭐ 只报「这一步能不能走」，具体判定交给各步自己的模块
  let state = 'start'
  try {
    const dir = path.join(__dirname, '..', '..', '..', 'engines', id)
    state = fs.existsSync(path.join(dir, 'manifest.json'))
      ? 'manifest_done' : 'cloned_or_empty'
  } catch { state = 'start' }
  json(res, 200, { ok: true, state, id })
  return true
}

// ---------------------------------------------------------------------------
//  POST /wizard/resolve      第 1 步：链接 → id
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
//  POST /wizard/clone        第 2 步
//  ⛔ execute 必须显式 true —— 默认只回计划（跟 install-engine.cjs 一致）
// ---------------------------------------------------------------------------
function handleClone (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/clone')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const input = {
      id: body.id,
      cloneUrl: body.cloneUrl,
      branch: body.branch,
      depth: body.depth,
      execute: body.execute === true,
      // ⛔ 默认不许浅取/不许执行
      ...(body.depth === 1 ? { depth: 1 } : {}),
    }
    const r = input.execute ? runClone(input) : buildClonePlan(input)
    json(res, r.ok ? 200 : 400, r)
  })
  return true
}

// ---------------------------------------------------------------------------
//  POST /wizard/env          第 3 步
// ---------------------------------------------------------------------------
function handleEnv (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/env')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const input = {
      id: body.id,
      manifest: body.manifest,
      execute: body.execute === true,
      backend: body.backend,   // ⭐ 2026-10-06：前端 StepDeps 会传 backend（torch 后端选择）
    }
    // ⛔ 只出计划（execute:false）时走原来的 JSON 响应 —— 快的请求不该用流。
    if (!input.execute) {
      const r = buildEnvPlan(input)
      json(res, r.ok ? 200 : 400, r)
      return
    }
    // ⭐⭐ 执行（execute:true）走 **SSE 流式**：
    //   装依赖要几分钟到几十分钟，普通 JSON 响应的意思是「前端等到全部装完」。
    //   流式让前端**边装边看**：每步开始推一个 step 事件，每行输出推一个 line。
    //   ⛔ 浏览器 fetch 能读 SSE（resp.body.getReader()），
    //      axios/XMLHttpRequest 读不了 —— 所以前端必须用 fetch。
    //   ⛔ 格式：`data: {json}\n\n` 是标准 SSE；这里每一块都是完整 JSON 事件。
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // ⛔ 必须关掉中间层的缓冲 —— vite 的 dev 中间件若缓冲，前端就等不到行。
      //   'x-accel-buffering': 'no' 是 nginx 约定；vite/node 原生也认 no-cache。
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    // ⭐ onStep：每步开始（前端用来画「第 N/M 步」）
    input.onStep = (i, total, step, argv) => {
      send('step', { i, total, argv: argv.join(' '), cwd: step.cwd })
    }
    // ⭐ onLine：每行输出（前端用来画进度条 / 实时日志）
    input.onLine = (text, isErr) => {
      send('line', { text: text.replace(/\r?\n$/, ''), err: !!isErr })
    }
    runEnv(input).then((r) => {
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

// ---------------------------------------------------------------------------
//  GET /wizard/download/files?id=  第 3 步 —— 逐文件校验（不依赖 manifest）
// ---------------------------------------------------------------------------
// ⭐ 直接列 engines/<id>/checkpoints/ 下的文件，返回文件名 + 大小。
//   ⛔ 不依赖 manifest —— 下载就是下载，和名片没有任何关系。
//   ⭐ 前端据此显示三态：已下载 / 未下载 / 半截（大小为 0 或很小）
function handleDownloadFiles (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/download/files')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  const root = url.searchParams.get('root') || ''
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

// ---------------------------------------------------------------------------
//  GET /wizard/download/manifest?id=&repo=&tool=  第 3 步 —— 获取远端文件列表
// ---------------------------------------------------------------------------
//  ⭐ 调用 fetchRemoteManifest 获取文件列表，再逐个 checkFileStatus
//  ⭐ 返回 { ok: true, files: [{ name, size, sha256, status }] }
function handleDownloadManifest (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/download/manifest')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  const repo = url.searchParams.get('repo')
  const tool = url.searchParams.get('tool') || 'hf'
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  if (!repo) { json(res, 400, { ok: false, error: '?repo= is required' }); return true }
  const root = url.searchParams.get('root') || ''
  fetchRemoteManifest(repo, tool).then((files) => {
    const enriched = files.map((f) => {
      const st = checkFileStatus(f.name, f.size, f.sha256, root, id)
      return { name: f.name, size: f.size, sha256: f.sha256, status: st.status }
    })
    json(res, 200, { ok: true, files: enriched })
  }).catch((e) => {
    json(res, 200, { ok: true, files: [] })
  })
  return true
}

// ---------------------------------------------------------------------------
//  POST /wizard/download/file { id, root, file }  第 3 步 —— 单文件下载（SSE）
// ---------------------------------------------------------------------------
//  ⭐ 调用 downloadFile 下载单个文件，SSE 流式返回进度
function handleDownloadFile (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/download/file')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const { id, root, file } = body
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }
    if (!file || !file.name) { json(res, 400, { ok: false, error: 'file.name is required' }); return }
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
    downloadFile(file, repo, root, id, (text, isErr) => {
      send('line', { text, err: !!isErr })
    }).then((r) => {
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

// ---------------------------------------------------------------------------
//  GET /wizard/download/progress?id=  第 3 步 —— 读断点续传进度
// ---------------------------------------------------------------------------
// ⭐ 前端刷新后恢复下载状态用。返回已完成的命令列表。
function handleDownloadProgress (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/download/progress')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  const { readProgress } = require('./download')
  const root = url.searchParams.get('root') || ''
  const done = [...readProgress(root, id)]
  json(res, 200, { ok: true, done })
  return true
}

// ---------------------------------------------------------------------------
//  POST /wizard/download  {id, root, argv}  第 3 步 —— 执行下载（SSE 流式）
// ---------------------------------------------------------------------------
//  ⭐ 统一落盘：调用方（前端）负责把命令里的 local_dir 替换成
//     engines/<id>/checkpoints/，本端点只负责执行 + 透传输出。
//  ⭐ SSE 流式：下载要几分钟到几十分钟，普通 JSON 响应 = 前端等到全部下完。
//     流式让前端边下边看：每行输出推一个 line 事件，结束推 done。
function handleDownload (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/download')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const input = {
      id: body.id,
      root: body.root,
      argv: body.argv,
      timeoutMs: body.timeoutMs,
    }
    // ⛔ 只执行（没有 execute:false 的分支）—— 这个端点就是用来下载的
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    // ⭐ onLine：每行输出（前端用来画进度条 / 实时日志）
    input.onLine = (text, isErr) => {
      send('line', { text: text.replace(/\r?\n$/, ''), err: !!isErr })
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

// ---------------------------------------------------------------------------
//  GET /wizard/models?id=    第 4 步 —— ⛔ 只列，不下
// ---------------------------------------------------------------------------
function handleModels (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/models')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }

  // ⛔ 不在这里 require profile —— describeModels 内部会用平台自己的
  //   resolveEngineProfile（权威实现只有那一份）。这里再 require 一次
  //   只会多一份「我以为它怎么用」的猜测。
  const r = describeModels(id)
  if (!r.ok) { json(res, r.code === 'NO_PROFILE' ? 404 : 400, r); return true }
  const { resolveEngineProfile } = require(
    path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'profile.js'))
  json(res, 200, { ...r, gaps: explainMissingInfo(resolveEngineProfile(id)) })
  return true
}

/** GET /wizard/verify/checks —— 第 7 步：四道校验的清单 */
function handleVerifyChecks (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/verify/checks')) return false
  json(res, 200, { ok: true, checks: verifyChecks() })
  return true
}

/**
 * POST /wizard/verify  {id, deep?, audio?, request?}
 *  ⭐ 调平台的四道校验，⛔ 不自己判断（见 core/verify.js 的头注）
 */
function handleVerify (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/verify')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = body.id
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }

    // ---- 前三道（不跑出声那道）----
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

module.exports = {
  handleState, handleResolve, handleProbe, handleDeps, handleHardware,
  handleClone, handleEnv, handleDownload, handleDownloadProgress, handleDownloadFiles, handleModels,
  handleDownloadManifest, handleDownloadFile,
  handleVerifyChecks, handleVerify,
  // ⭐ 这两个导出给测试：第 3 步「上游自己的下载方式」全靠它们。
  //   ⛔ 不是给外部用的，是让守卫测试能直接验证「拆成三段 + 不猜」。
  extractDownloadCommands, parseDownloadCmd,
}