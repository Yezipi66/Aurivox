'use strict'
// 向导的 HTTP 桥：把探测、克隆、装依赖、下模型、校验、参数反射挂到 /wizard/* 上。
// 探测阶段只读上游的文本文件，不 clone、不建目录；克隆在探测之后。
// 每个 handler 同步返回 true/false 表示是否接管，异步活放进 readBody 回调；
//   handler 不许写成 async：async 对不匹配的 URL 也返回 Promise，中间件会当成已处理并中断。
// 前缀端点必须显式排除被它包含的长前缀端点：中间件是「第一个返回 true 的赢」，
//   调表里的顺序挡不住前缀包含关系。

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const { resolveEngine, parseRepoUrl } = require('./resolve')
const { runClone, buildClonePlan, projectRoot, removeTargetDir } = require('./clone')
const { runEnv, buildEnvPlan, suggestTorchUpgrade } = require('./env')
const { runDownload, fetchRemoteManifest, enrichManifestFiles, downloadFile, downloadFileFromUrl,
  removePartialFiles, normalizeSource, gatedResult, destPath, subdirIsSafe } = require('./download')
const hfToken = require('./hfToken')
const { describeModels, explainMissingInfo } = require('./models')
const { probeProject, planDependencies, probePyproject, isPipInstallable } = require('./probe')
const { inspectHardware, parseUvLock } = require('./hardware')
const { deviceOptions } = require('../../../lib/engines/deviceValue')
const { checks: verifyChecks, runChecks, runAudioCheck } = require('./verify')
const { reflectAndBuild } = require('./paramsFromReflect')
const { engineDirForRead } = require('./wizardRoot')
const https = require('node:https')

/**
 * 从 README 原文里挑出模型下载命令：只认下载工具的固定前缀（hf / huggingface-cli /
 * modelscope 的 download 子命令，以及 snapshot_download 调用），不做自然语言理解。
 * 命令不完整也照样给出来：平台不替它补全，补错了等于平台在编造上游的下载方式。
 *
 * @param {string} markdown README 原文
 * @returns {Array<{tool:string,source:string,repo:string,dir:(string|null),raw:string}>}
 *   去重后的命令，按 README 里的顺序。source 是下载来源（hf / modelscope / unknown），见 parseDownloadCmd。
 */
function extractDownloadCommands (markdown) {
  if (!markdown || typeof markdown !== 'string') return []
  const OUT = []
  const seen = new Set()
  const blocks = fencedBlocks(markdown)
  // 除了 CLI 形态，还认 Python API 形态：snapshot_download("repo", local_dir=...)，
  //   前面可以有赋值（model_dir = ...）与库名前缀（huggingface_hub.snapshot_download）。
  for (const m of markdown.matchAll(/^[ \t]*(?:\$|>|#{1,6}\s*)?((?:(?:uv tool install|pip install)[^\n]*\n[ \t]*)?(?:\b(?:hf|huggingface-cli|modelscope)[ \t]+download\b[^\n`]*|(?:\w+\s*=\s*)?(?:\w+\.)*snapshot_download\s*\([^)\n]*\)))/gm)) {
    let cmd = m[1].trim().replace(/\s+/g, ' ')
    cmd = cmd.replace(/[`|]+$/, '').trim()
    if (!cmd || seen.has(cmd)) continue
    seen.add(cmd)
    // 目标目录由用户自选（--local-dir 之类），所以整条命令不能原样丢出去：
    // 原样就等于把目录写死成上游随手取的名字。拆成「工具 / 模型 / 目标目录」三段。
    const parts = parseDownloadCmd(cmd, contextOf(markdown, blocks, m.index))
    if (!parts) continue
    OUT.push(parts)
  }
  return OUT
}

/**
 * 文档正文里的模型仓库网页链接。很多上游不写下载命令，只在文字里贴一个
 * HF / 魔搭的模型页，权重由代码在首次推理时自己拉。这里只认 URL 形状，
 * 不判断这个仓库是不是权重：候选交给人选，平台不替他做决定。
 *
 * @param {string} markdown 文档原文
 * @returns {Array<{tool:string, repo:string, url:string}>}
 */
function extractRepoLinks (markdown) {
  if (!markdown || typeof markdown !== 'string') return []
  const out = []
  const seen = new Set()
  // 只收两段路径；后面的 /tree/main、/resolve/…、查询串都剥掉。
  const RE = /https?:\/\/(?:www\.)?(huggingface\.co|modelscope\.cn)\/[A-Za-z0-9_./-]+/gi
  const SKIP = new Set(['spaces', 'datasets', 'docs', 'api', 'blog', 'models',
    'collections', 'tasks', 'join', 'settings', 'organizations', 'login', 'pricing',
    'inference-endpoints', 'studios', 'studies'])
  for (const m of markdown.matchAll(RE)) {
    const host = String(m[1] || '').toLowerCase()
    const raw = String(m[0] || '').replace(/[)\].,;:>'"]+$/, '')
    let parts = []
    try { parts = new URL(raw).pathname.split('/').filter(Boolean) } catch (e) { continue }
    let tool = null
    let repo = null
    if (host === 'huggingface.co') {
      if (parts.length < 2 || SKIP.has(parts[0].toLowerCase())) continue
      tool = 'hf'
      repo = `${parts[0]}/${parts[1]}`
    } else {
      if (parts.length < 3 || parts[0].toLowerCase() !== 'models') continue
      if (SKIP.has(parts[1].toLowerCase())) continue
      tool = 'modelscope'
      repo = `${parts[1]}/${parts[2]}`
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) continue
    const key = `${tool}|${repo.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ tool, repo,
      url: tool === 'hf' ? `https://huggingface.co/${repo}` : `https://modelscope.cn/models/${repo}` })
  }
  return out
}

// README 里每个围栏代码块（ 或 ~~~）的起止下标。没闭合的块延伸到文末。
function fencedBlocks (markdown) {
  const out = []
  let open = null
  for (const m of markdown.matchAll(/^[ \t]*(```|~~~)[^\n]*$/gm)) {
    if (open === null) { open = m.index; continue }
    out.push([open, m.index + m[0].length])
    open = null
  }
  if (open !== null) out.push([open, markdown.length])
  return out
}

// 一条命令的「同一段代码」：落在围栏代码块里就是整个块，否则是它所在的那一行。
//   snapshot_download 的来源要看 import，而 import 通常写在同一个代码块的前几行。
function contextOf (markdown, blocks, index) {
  for (const [a, b] of blocks) {
    if (index >= a && index < b) return markdown.slice(a, b)
  }
  const lineStart = markdown.lastIndexOf('\n', index) + 1
  const lineEnd = markdown.indexOf('\n', index)
  return markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd)
}

/**
 * snapshot_download 属于哪个库：同名函数 modelscope 与 huggingface_hub 都有，
 * 只能看同一段代码里是从哪个库导入的。
 *   认得的写法： from <库>[.子模块] import ... snapshot_download（含括号换行的写法），
 *   以及 <库>.snapshot_download(...)。
 *   两个库都出现、或都没出现 ⇒ 'unknown'，交给使用者选：猜错的代价是去另一个站点下同名仓库。
 *
 * @param {string} code 同一段代码
 * @returns {'hf'|'modelscope'|'unknown'}
 */
function snapshotSourceOf (code) {
  const text = String(code || '')
  const imports = (lib) => {
    const re = new RegExp(`\\bfrom\\s+${lib}(?:\\.[\\w.]+)?\\s+import\\s+(\\([^)]*\\)|[^\\n]*)`, 'g')
    for (const m of text.matchAll(re)) {
      if (/\bsnapshot_download\b/.test(m[1])) return true
    }
    return new RegExp(`\\b${lib}(?:\\.\\w+)*\\.snapshot_download\\s*\\(`).test(text)
  }
  const ms = imports('modelscope')
  const hf = imports('huggingface_hub')
  if (ms && !hf) return 'modelscope'
  if (hf && !ms) return 'hf'
  return 'unknown'
}

/**
 * 把一条下载命令拆成「工具 / 模型 / 目标目录」。认得出来的写法只有三种：
 *   hf download <org>/<repo> --local-dir=<dir>
 *   modelscope download --model <org>/<repo> --local_dir <dir>
 *   snapshot_download("<org>/<repo>", local_dir=...)
 * 认不出来的写法返回 null，界面上如实说「看不懂这条」：猜错等于平台替上游编了一个下载方式。
 *
 * 返回值的 source 是下载来源：hf / modelscope 两种 CLI 自带来源；snapshot_download
 *   按 context（同一段代码）里的 import 判，判不出是 'unknown'（见 snapshotSourceOf）。
 *
 * @param {string} cmd 一条命令
 * @param {string} [context] 命令所在的那段代码，缺省只看命令本身
 */
function parseDownloadCmd (cmd, context) {
  // Python API 形态：snapshot_download("repo", local_dir='...')。
  //   它包在 python 代码里不是裸命令：这里只提取 repo 与 local_dir。
  const sd = cmd.match(/snapshot_download\s*\(\s*['"]([^'"]+)['"]/)
  if (sd) {
    const repo = sd[1]
    const dir = (cmd.match(/local_dir\s*=\s*['"]?([^'",\s)]+)['"]?/) || [])[1]
    // 只有 modelscope / huggingface 形状的 repo 才认
    if (!/^[^/]+[\/][^/]+/.test(repo)) return null
    const source = snapshotSourceOf(`${context || ''}\n${cmd}`)
    return { tool: 'snapshot', source, repo, dir: dir || null, raw: cmd }
  }
  const ms = cmd.match(/^modelscope\s+download\b(.*)$/)
  if (ms) {
    const repo = (ms[1].match(/--model\s+([^\s]+)/) || [])[1]
    if (!repo) return null
    const dir = (ms[1].match(/--local_dir\s+([^\s]+)/)
      || ms[1].match(/--local-dir[=\s]+([^\s]+)/) || [])[1]
    return { tool: 'modelscope', source: 'modelscope', repo, dir: dir || null, raw: cmd }
  }
  // 先排掉以 - 开头的 token（那是参数不是位置参数）：否则
  // hf download --local-dir=x 会把参数当成模型名，等于替上游编了一个不存在的模型。
  const rest = cmd.replace(/^(?:hf|huggingface-cli)\s+download\s+/, '')
  const toks = rest.split(/\s+/)
  const repo = toks.find((t) => t && !t.startsWith('-'))
  if (!repo || !/^[^\s/]+\/[^\s/]+/.test(repo)) return null
  const tail = rest.slice(rest.indexOf(repo) + repo.length)
  const dir = (tail.match(/--local-dir[=\s]+([^\s]+)/) || [])[1]
  return { tool: 'hf', source: 'hf', repo, dir: dir || null, raw: cmd }
}

// 上游可能提供的模型下载入口文件名。这是探测清单，不是平台支持的下载方式：
// 平台不实现下载逻辑，只告诉用户「上游自己有个脚本可以跑」；清单之外读不到就如实说没找到。
// 安装脚本不在这份清单里：上游文档探测只负责找下载入口，不把同时安装环境的脚本
// 混进下载命令。第一档的本地清单单独收录它们，并标出安装环境这一事实。
const DOWNLOAD_SCRIPTS = [
  'download_models.py',
  'download_models.sh',
  'download.sh',
  'download.py',
  'download_weights.py',
  'download_ckpt.py',
  'download_checkpoints.sh',
]

// 第 3 步第一档：引擎自带的下载 / 部署入口。安装脚本也算一种，但第 2 步可能已经
//   跑过它建环境，所以清单里要带 installs_env 与 already_deployed，让人自己判断，
//   平台不替他决定要不要重跑。
const ENGINE_ENTRY_SCRIPTS = Object.freeze([...DOWNLOAD_SCRIPTS, 'install.sh', 'install.ps1'])
const DOWNLOAD_GROUP_RE = /^(download|setup|prepare|init-models|fetch-models|models|install)$/i

// 子目录脚本的扫描口径。根目录固定名字之外，上游也会把下载脚本放进自己的包目录。
// 只认名字明确指向下载的脚本，并跳过示例、测试、第三方与运行时目录，
// 避免把训练数据脚本或格式转换工具列成候选。
const SCRIPT_CANDIDATE_SKIP_DIRS = Object.freeze(new Set([
  'node_modules', '__pycache__', '.venv', 'venv', 'env', 'site-packages',
  'tests', 'test', 'testing', 'examples', 'example', 'docs', 'doc',
  'third_party', 'runtime', 'backends', 'docker', 'Docker', 'archive',
  'cli_tests', 'recipes', 'assets', 'notebooks', 'build', 'dist',
  '.git', '.github', '.idea', '.vscode',
]))
const SCRIPT_CANDIDATE_NAME_RE = /^(?:download|fetch)[_-]?(?:models?|weights?|ckpts?|checkpoints?)?\.(?:py|sh|ps1|js)$/i

// 启动阶段自行拉取的资源：只读源码，找下载类调用以及其中的仓库标识。
const RUNTIME_DOWNLOAD_CALL_RE = /\b(?:snapshot_download|hf_hub_download|from_pretrained)\s*\(/
const REPO_LITERAL_RE = /['"]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)['"]/
// 多行调用把仓库标识写在下一行：snapshot_download( 换行 repo_id="org/model"。
// 仓库标识也可能写在函数形参的默认值或模块常量里，下载调用那一行只见变量名：
//   例如 snapshot_download(repo_id=path_or_id)，而 path_or_id 的来源是
//   hf_model_id: str = "org/repo"。因此参数名按语义匹配、类型注解可有可无，
//   仍然只认带名字的赋值，不拿窗口里的任意字面量当仓库。
const RUNTIME_REPO_ARG_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^=,\n)]+)?\s*=\s*['"]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)['"]/g
const RUNTIME_REPO_ARG_NAME_RE = /(?:repo|model|checkpoint|ckpt|pretrain|hf|hub)/i
// 「语言 → 仓库」这类映射的值：一个文件里几十个仓库，键名与仓库语义无关，
//   上面两条判据（实参名、单值常量）都看不到它们。
const MAPPING_REPO_RE = /['"][A-Za-z0-9_-]+['"]\s*:\s*['"]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)['"]/g
// 字面量带斜杠时也可能是本地目录，而不是模型仓库标识。
const LOCAL_PATH_HEAD_RE = /^(?:\.{1,2}\/|\/|[A-Za-z]:[\\/]|checkpoints?|models?|pretrained_models|weights?|ckpts?|assets?|data|dataset|cache|hf_cache|outputs?|tmp|temp|src|runtime|third_party|local)/i

function scriptInstallsEnv (file) {
  return /^install\./i.test(String(file || '').split('/').pop())
}

// Windows 自带 PowerShell 的绝对路径：父进程 PATH 未必带着它。
function powershellPath () {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try { if (fs.existsSync(full)) return full } catch { /* 读不到就退回名字 */ }
  return 'powershell.exe'
}

// 跑上游下载脚本的时间上限：权重动辄几 GB，按 30 分钟给；超时就杀掉，不留半个进程。
const RUN_SCRIPT_TIMEOUT_MS = 30 * 60 * 1000

// 安装文档的候选位置：README 只写「去 docs 看」时，命令在这类文件里。
//   固定几个常见位置先试；都不中再列 docs/ 的一层子目录（按语言分子目录的仓库很常见）。
const DOC_CANDIDATES = [
  'docs/en/install.md',
  'docs/install.md',
  'docs/en/installation.md',
  'INSTALL.md',
  'INSTALLATION.md',
  'docs/INSTALL.md',
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

// 探测阶段对 api.github.com 的公共请求头。未认证只有 60 次/小时，连续探测
// 十来个仓库就会触发限流；配置了 GITHUB_TOKEN 或 GH_TOKEN 时走认证额度。
// 令牌只从进程环境读，不写进任何响应或日志。
function githubHeaders (extra) {
  const h = { 'user-agent': 'aurivox-engine-wizard', accept: 'application/vnd.github+json', ...(extra || {}) }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) h.authorization = `Bearer ${token}`
  return h
}

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
      headers: githubHeaders(),
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

// 顶层 python 包目录：packaging 元数据（pyproject 的 name/scripts、setup.py 的 name）
//   全无时，用「哪个顶层目录里有 __init__.py」兜底猜包名。只在包名读不出时才跑
//   （省请求）：一次 contents API 列顶层条目，再对每个目录 raw 探一下 __init__.py。
//   认不出（限流、网络、仓库空）返回空数组：包名维持「读不出来」，不硬猜。
function packageDirsFromEntries (entries) {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((e) => e && e.type === 'dir' && typeof e.name === 'string' && e.name)
    .map((e) => e.name)
}

// 上游把权重打包进 GitHub release 时，仓库里既没有下载脚本，README 也不列文件。
//   只读「最新一个 release」的资产清单，不猜 tag、不翻历史版本。
//   认不出（没有 release、断网）返回 null；限流单独回 {limited:true}，让界面如实说明。
function readReleaseAssets (owner, name) {
  return new Promise((resolve) => {
    const url = `https://api.github.com/repos/${owner}/${name}/releases/latest`
    const req = https.get(url, {
      headers: githubHeaders(),
    }, (res) => {
      if (res.statusCode === 403 || res.statusCode === 429) {
        res.resume()
        resolve({ limited: true })
        return
      }
      if (res.statusCode !== 200) { res.resume(); resolve(null); return }
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(body)
          const assets = (Array.isArray(j.assets) ? j.assets : [])
            .filter((a) => a && typeof a.name === 'string' && a.name)
            .map((a) => ({ name: a.name, size: Number(a.size) || 0,
              url: typeof a.browser_download_url === 'string' ? a.browser_download_url : '' }))
            .filter((a) => a.url)
          resolve(assets.length ? { tag: j.tag_name || '', assets } : null)
        } catch (e) { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(8000, () => { req.destroy(); resolve(null) })
  })
}

function listContents (owner, name, branch, subPath = '') {
  const tail = subPath ? `/${String(subPath).replace(/^\/+|\/+$/g, '')}` : ''
  return new Promise((resolve) => {
    const url = `https://api.github.com/repos/${owner}/${name}/contents${tail}?ref=${encodeURIComponent(branch)}`
    const req = https.get(url, {
      headers: githubHeaders(),
    }, (res) => {
      if (res.statusCode === 403 || res.statusCode === 429) {
        res.resume()
        resolve({ limited: true })
        return
      }
      if (res.statusCode !== 200) { res.resume(); resolve(null); return }
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          const arr = JSON.parse(body)
          resolve(Array.isArray(arr) ? arr : null)
        } catch (e) { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    // 比 fetchRaw 短一档：这是兜底路径，不该拖住整个探测
    req.setTimeout(8000, () => { req.destroy(); resolve(null) })
  })
}

async function listPackageDirs (owner, name, probed) {
  // 分支定不出时按 main、master 依次试，与 fetchWithBranchFallback 同一口径
  const tried = []
  if (probed) tried.push(probed)
  if (!tried.includes('main')) tried.push('main')
  if (!tried.includes('master')) tried.push('master')
  for (const b of tried) {
    // eslint-disable-next-line no-await-in-loop
    const entries = await listContents(owner, name, b)
    if (entries === null) continue
    const dirs = packageDirsFromEntries(entries)
    const out = []
    for (const d of dirs) {
      // eslint-disable-next-line no-await-in-loop
      if (await fetchRaw(owner, name, `${d}/__init__.py`, b) !== null) out.push(d)
    }
    return out
  }
  return []
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
    let readmeText = ''
    if (dlScripts.length === 0) {
      readmeText = (await fetchWithBranchFallback(parsed.owner, parsed.repo, 'README.md', probeBranch.branch)) || ''
      readmeCmds = extractDownloadCommands(readmeText).map((cmd) => ({
        ...cmd,
        repo: cmd.repo || `${parsed.owner}/${parsed.repo}`,
      }))
    }

    // 很多上游只在 README 里放一句「去 docs 看安装」，命令写在单独的安装文档里。
    //   这里按有界清单再找一遍：先试几个固定位置，再列 docs/ 的一层子目录找 install*。
    //   用的是同一个提取器与同一条判据，只是取材范围宽了一点。
    const docsScanned = []
    const docTexts = []
    if (dlScripts.length === 0 && readmeCmds.length === 0) {
      const taken = new Set()
      const collect = async (path) => {
        if (!path || taken.has(path)) return 0
        taken.add(path)
        const text = await fetchWithBranchFallback(parsed.owner, parsed.repo, path, probeBranch.branch)
        docsScanned.push(path)
        if (!text) return 0
        docTexts.push(text)
        const found = extractDownloadCommands(text).map((cmd) => ({
          ...cmd,
          repo: cmd.repo || `${parsed.owner}/${parsed.repo}`,
          from: path,
        }))
        readmeCmds.push(...found)
        return found.length
      }
      for (const p of DOC_CANDIDATES) {
        // eslint-disable-next-line no-await-in-loop
        if (await collect(p) > 0) break
      }
      if (readmeCmds.length === 0) {
        // docs/ 下常按语言分子目录（en / zh_CN …），每个子目录各有一份 install.md。
        const dirs = await listContents(parsed.owner, parsed.repo, probeBranch.branch, 'docs')
        if (dirs && dirs.limited) {
          notes.push('GitHub API 触发限流，docs 子目录这次没读全；固定位置的安装文档仍会尝试。')
        }
        for (const e of (Array.isArray(dirs) ? dirs : []).filter((x) => x && x.type === 'dir').slice(0, 6)) {
          // eslint-disable-next-line no-await-in-loop
          if (await collect(`docs/${e.name}/install.md`) > 0) break
        }
      }
    }

    // 同一个仓库可能同时出现在 README 与安装文档里：按「工具 + 仓库 + 目录」去重。
    const seenCmd = new Set()
    readmeCmds = readmeCmds.filter((c) => {
      const k = [c.tool, c.repo, c.dir || ''].join('|')
      if (seenCmd.has(k)) return false
      seenCmd.add(k)
      return true
    })

    // 上游只贴模型页、不给下载命令时，把链接作为候选交给人选。
    //   已在命令里出现的仓库不再重复列；平台不判断哪个是权重仓库。
    const repoLinks = extractRepoLinks([readmeText, ...docTexts].join('\n'))
      .filter((l) => !readmeCmds.some((c) => c.repo === l.repo))

    // 上游把权重打包进 release 时，脚本与 README 里都找不到下载入口。
    //   只在两条主路径都没有结果时才多打这一次 API，避免拖慢常规探测。
    let releaseAssets = null
    if (dlScripts.length === 0 && readmeCmds.length === 0) {
      const rel = await readReleaseAssets(parsed.owner, parsed.repo)
      if (rel && rel.limited) {
        notes.push('GitHub API 触发限流，release 资产这次没读到；结果不是「上游没有」。')
        releaseAssets = null
      } else {
        releaseAssets = rel
      }
    }

    // 无论有没有 pyproject 都走 probeProject：包名来自 setup.py 的 name=、
    // 许可证来自根目录的 LICENSE / COPYING，都不是 pyproject 的字段 ⇒ 由它决定读得到哪个。
    let r = probeProject({
      pyproject: texts['pyproject.toml'],
      requirements: texts['requirements.txt'],
      setupPy: texts['setup.py'],
      licenseFile,
      licenseText,
      filenames: found,
    })
    // 包名读不出来时，兜底扫顶层 python 包目录（目录里有 __init__.py 的），
    //   扫到候选再带进 probeProject 重新探测一次：只为了把候选交给它的兜底分支。
    //   扫不到（限流 / 网络 / 空仓库）就保持「读不出来」，不硬猜。
    if (!r.meta.packageName) {
      // eslint-disable-next-line no-await-in-loop
      const dirs = await listPackageDirs(parsed.owner, parsed.repo, probeBranch.branch)
      if (dirs.length > 0) {
        r = probeProject({
          pyproject: texts['pyproject.toml'],
          requirements: texts['requirements.txt'],
          setupPy: texts['setup.py'],
          licenseFile,
          licenseText,
          filenames: found,
          packageDirs: dirs,
        })
      }
    }
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
      repo_links: repoLinks,
      docs_scanned: docsScanned,
      release_assets: releaseAssets,
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
    const hw = inspectHardware()
    // device_options 是给第 5 步的下拉用的：本机有哪几块卡、能不能选。
    //   换算成引擎认的写法不在这里做，那是下发前的事。
    json(res, 200, { ...hw, device_options: deviceOptions(hw.gpus) })
  } catch (e) {
    json(res, 200, {
      gpus: [], recommended: 'cpu', confidence: 'unknown',
      // 探测失败时下拉至少还有「自动」与 CPU 两项，界面不空着
      device_options: deviceOptions([]),
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
 * POST /wizard/deps  {url} 或 {id}
 *  第 2 步的数据源：读上游的依赖清单 + uv.lock，跟本机比出绿/黄/白。不装任何东西。
 * 数据源二选一：
 *   ① {id} 且 engines/<id>/ 存在 ⇒ 从本地目录读（选已有引擎时走这里，不联网）；
 *   ② 否则 {url} ⇒ 远程读（克隆前的第 2 步预检走这里）。
 *   目录在时以目录为准：本地文件才是真的（可能与远端不同），也省一次网络。
 * 依赖清单读 pyproject.toml 与 requirements.txt：只放 requirements.txt 的仓库
 *   只靠提示语是读不到东西的，所以这里真的去读。
 * 标准清单读不出依赖但仓库可 pip 安装（pyproject 带构建段、或有 setup.py / setup.cfg）：
 *   平台不解析 setup.py（那是任意 Python，读不完也读不全），改用平台自己的装法
 *   uv pip install -e .，由 pip 自己读包构建配置，此处照「装包本体」放行。
 */
function handleDeps (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/deps')) return false
  readBody(req, async (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    body = body || {}

    const readLocal = (dir, f) => {
      try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null }
    }
    let py = null
    let reqText = null
    let lockText = null
    let setupPy = false
    let setupCfg = false
    let dir = null
    if (body.id) {
      const d = engineDirForRead(String(body.id))
      if (fs.existsSync(d)) {
        dir = d
        py = readLocal(d, 'pyproject.toml')
        reqText = readLocal(d, 'requirements.txt')
        lockText = readLocal(d, 'uv.lock')
        setupPy = readLocal(d, 'setup.py') !== null
        setupCfg = readLocal(d, 'setup.cfg') !== null
      }
    }
    if (!dir) {
      const parsed = parseRepoUrl(body.url)
      if (!parsed.ok) { json(res, 400, parsed); return }

      // 分支同样走回退：分支写错整个请求全 404。
      const probeBranch = await resolveProbeBranch(parsed.owner, parsed.repo)
      const get = async (f) => {
        const t = await fetchWithBranchFallback(parsed.owner, parsed.repo, f, probeBranch.branch)
        return t
      }
      // 依赖来源：pyproject.toml 优先，其次 requirements.txt；外加 lock（只锁 torch 版本，
      //   不当依赖列表）。setup.py / setup.cfg 只问「在不在」：在就说明仓库可 pip 安装，
      //   平台用自己的装法 uv pip install -e .，由 pip 读包构建配置，平台不解析 setup.py。
      const got = await Promise.all([
        get('pyproject.toml'), get('requirements.txt'), get('uv.lock'),
        get('setup.py'), get('setup.cfg')])
      py = got[0]; reqText = got[1]; lockText = got[2]
      setupPy = got[3] !== null; setupCfg = got[4] !== null
    }

    const pyHasDeps = py ? probePyproject(py).dependencies.length > 0 : false
    const pipInstallable = isPipInstallable(py, { setupPy, setupCfg })
    // 两处都读不到依赖，且仓库也说不清「可 pip 安装」⇒ 确实读不到，如实说。
    //   但要分清「文件压根不在」和「文件在、里面没写依赖」：两者表象一样，
    //   处理方式却不同（后者往往换个文件就有了），说混了会让人白查。
    if (!pyHasDeps && !reqText && !pipInstallable) {
      json(res, 200, { ok: false, code: 'NO_DEPENDENCY_MANIFEST',
        error: 'No dependency list in pyproject.toml or requirements.txt.\n'
          + (py ? 'pyproject.toml was found, but it declares no dependencies. ' : '')
          + 'It may live in uv.lock, a subdirectory, or a file named differently. '
          + 'Follow the upstream instructions to install.',
        errorZh: 'pyproject.toml、requirements.txt 里都没有依赖声明。\n'
          + (py ? '（pyproject.toml 在，但里面没有写依赖列表。）\n' : '')
          + '它可能放在 uv.lock、子目录里，或换了别的文件名；请按上游说明自行安装。' })
      return
    }

    // 本机检测：失败也不让整个请求失败（CI 上没 GPU 也要能跑）
    let hardware = null
    try { hardware = inspectHardware() } catch { hardware = null }

    // requirements 这一路：有 requirements.txt 就用它。
    //   没有但仓库可 pip 安装 ⇒ planDependencies 会出「装包本体」的空依赖计划，
    //   由平台自己的装法 uv pip install -e . 兜底，不再硬报「读不到依赖」。
    const base = planDependencies(py, { hardware, requirements: reqText,
      setupPy, setupCfg })
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

/** 下载位置非法时统一拒绝。返回 true 表示响应已发出。 */
function rejectBadSubdir (res, subdir) {
  if (subdirIsSafe(subdir)) return false
  json(res, 400, { ok: false, code: 'BAD_SUBDIR',
    error: 'The destination must be a relative path inside the weights folder.',
    errorZh: '下载位置只能是权重目录内的相对路径。' })
  return true
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
    // 读侧：本 checkout 优先，主仓库兜底（wizardRoot.js）
    const dir = engineDirForRead(id)
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
//   克隆完成后悔了 ⇒ 撤销克隆。
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
      // 计划里带上 torch 版本与本机后端的匹配结论；判断是离线查表，不依赖网络。
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
    //   axios/XMLHttpRequest 不能，所以前端必须用 fetch；格式 data: {json}\n\n 是标准 SSE。
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
    const recordEnvResult = (r) => {
      try {
        const { markEnvResult } = require('./installState')
        markEnvResult(input.root || projectRoot() || '', envId, r)
      } catch (e) { /* 记录写不进不拦住安装 */ }
    }
    // 一次安装里若有多个只有源码包的依赖，并行构建会在 Windows 上触发
    //   egg-info 临时目录的拒绝访问错误。执行期间把构建并发限制为一。
    const builds = require('./uvBuildPolicy')
    builds.beginSerialBuilds()
    // 第 2 步开始执行时写入进行中标记：venv 建好后解释器已经可以启动，
    //   若仅以解释器能否启动为判据，安装尚未完成便会被报作已完成。
    try {
      const { markEnvRunning } = require('./installState')
      markEnvRunning(input.root || projectRoot() || '', envId, true)
    } catch (e) { /* 状态写不进不拦住安装 */ }
    runEnv(input).then((r) => {
      builds.endSerialBuilds()
      forget()
      // 安装失败时把本机后端的结论一并带出：声明的 torch 版本不可用，
      //   界面与直接调端点的人都能看到可替换的版本与可选后端，不必从 stderr 里找。
      if (!r.ok) {
        try {
          const suggestion = suggestTorchUpgrade(input)
          if (suggestion) r.torchSuggestion = suggestion
        } catch (e) { /* 建议取不到不影响失败结论 */ }
      }
      recordEnvResult(r)
      send('done', r)
      res.end()
    }).catch((e) => {
      builds.endSerialBuilds()
      forget()
      const r = { ok: false, code: 'BRIDGE_FAILED', error: (e && e.message) || String(e) }
      recordEnvResult(r)
      send('done', r)
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
function handleDownloadManifest (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/download/manifest')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  const repo = url.searchParams.get('repo')
  const rawTool = url.searchParams.get('tool')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  if (!repo) { json(res, 400, { ok: false, error: '?repo= is required' }); return true }
  // 来源必须明说：缺省当成 HF 的话，魔搭镜像会被列成 HF 的清单，下载时再去 HF 下。
  const tool = normalizeSource(rawTool)
  if (!tool) {
    json(res, 400, { ok: false, code: 'UNKNOWN_SOURCE',
      error: `?tool= must be hf or modelscope (got ${JSON.stringify(rawTool || '')}).`,
      errorZh: '下载来源未知，请选择 Hugging Face 或魔搭（ModelScope）。' })
    return true
  }
  const root = url.searchParams.get('root') || projectRoot() || ''
  // 上游把模型放在子目录里时（checkpoints/s2-pro 这类），清单核对也要在同一层看。
  const subdir = url.searchParams.get('subdir') || ''
  if (rejectBadSubdir(res, subdir)) return true
  const token = tool === 'hf' ? hfToken.readToken() : null
  fetchRemoteManifest(repo, tool, undefined, { token }).then(async (result) => {
    if (!result.ok) {
      if (tool === 'hf' && (result.status === 401 || result.status === 403)) {
        json(res, 200, gatedResult(result.status, repo, !!token, null))
        return
      }
      json(res, 200, { ok: false, error: result.error || 'Failed to fetch remote manifest' })
      return
    }
    const enriched = await enrichManifestFiles(result.files, repo, tool, root, id, subdir)
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

// ---- 第 3 步第一档：引擎自带的下载 / 部署入口 ------------------------------
// 分工：引擎知道自己缺什么、去哪里拉；平台只负责把入口找出来、执行、显示进度。
// 平台不解释命令、不解析输出、不判断哪一份权重该保留。找不到才退到仓库清单逐文件
// 下载，再退到手贴文件直链。
function readLocalManifest (dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch { return null }
}

function scriptArgvFor (dir, file) {
  const ext = path.extname(file).toLowerCase()
  const venvPython = process.platform === 'win32'
    ? path.join(dir, '.venv', 'Scripts', 'python.exe')
    : path.join(dir, '.venv', 'bin', 'python')
  if (ext === '.py') return [fs.existsSync(venvPython) ? venvPython : 'python', file]
  if (ext === '.sh') return ['bash', file]
  if (ext === '.js') return ['node', file]
  return [powershellPath(), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]
}

/**
 * 子目录里的下载脚本候选。只读目录与文件名，不读内容、不执行；
 * 已知的根目录脚本不重复列出。返回正斜杠的相对路径。
 */
function scanEngineScriptCandidates (dir, known = new Set()) {
  const out = []
  const walk = (rel, depth) => {
    if (depth > 3 || out.length >= 24) return
    const full = rel ? path.join(dir, ...rel.split('/')) : dir
    let list
    try { list = fs.readdirSync(full, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const child = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (SCRIPT_CANDIDATE_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        walk(child, depth + 1)
      } else if (e.isFile() && SCRIPT_CANDIDATE_NAME_RE.test(e.name) && !known.has(child)) {
        out.push(child)
      }
    }
  }
  walk('', 0)
  return out.sort()
}

/**
 * 引擎在启动或首次推理时自行拉取的资源。只读 Python 源码，
 * 找下载类调用与其中的仓库标识；平台不据此执行任何命令。
 */
function scanRuntimeDownloads (dir, limit = 12) {
  const { findPyFiles } = require('./pyFiles')
  const skipDir = (n) => SCRIPT_CANDIDATE_SKIP_DIRS.has(n) || n.startsWith('.')
  const skipFile = (n) => /^(?:__init__|setup|conftest)\.py$|^test_|^.*_test\.py$/i.test(n)
  const files = findPyFiles(dir, { skipDir, skipFile })
  const out = []
  const seen = new Set()
  for (const rel of files) {
    if (out.length >= limit) break
    const full = path.join(dir, ...rel.split('/'))
    let text
    try {
      if (fs.statSync(full).size > 256 * 1024) continue
      text = fs.readFileSync(full, 'utf8')
    } catch { continue }
    const lines = text.split(/\r?\n/)
    let hasCall = false
    let firstCall = null
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      const line = lines[i]
      if (!RUNTIME_DOWNLOAD_CALL_RE.test(line)) continue
      hasCall = true
      const call = (line.match(RUNTIME_DOWNLOAD_CALL_RE) || [''])[0].replace(/\s*\($/, '')
      if (!firstCall) firstCall = call
      const inline = line.match(REPO_LITERAL_RE)
      // 当前行已有仓库标识时以它为准；只有多行调用才往后看实参名，
      //   否则窗口会把下一行另一个调用的 repo_id 算到本行头上。
      if (inline) {
        const repo = inline[1]
        if (LOCAL_PATH_HEAD_RE.test(repo) || seen.has(repo)) continue
        seen.add(repo)
        out.push({ file: rel, line: i + 1, call, repo })
        continue
      }
      const window = lines.slice(i, i + 7).join('\n')
      for (const m of window.matchAll(RUNTIME_REPO_ARG_RE)) {
        if (out.length >= limit) break
        const repo = m[2]
        if (!RUNTIME_REPO_ARG_NAME_RE.test(m[1])) continue
        if (LOCAL_PATH_HEAD_RE.test(repo) || seen.has(repo)) continue
        seen.add(repo)
        out.push({ file: rel, line: i + 1, call, repo, via: 'named-argument' })
      }
    }
    if (!hasCall || out.length >= limit) continue
    // 仓库标识写在下载调用之前的模块常量里时，上面的窗口看不到它。
    //   仍要求同一份文件里确实有下载类调用，且参数名带模型语义。
    const whole = lines.join('\n')
    for (const m of whole.matchAll(RUNTIME_REPO_ARG_RE)) {
      if (out.length >= limit) break
      const repo = m[2]
      if (!RUNTIME_REPO_ARG_NAME_RE.test(m[1])) continue
      if (LOCAL_PATH_HEAD_RE.test(repo) || seen.has(repo)) continue
      seen.add(repo)
      const at = whole.slice(0, m.index).split('\n').length
      out.push({ file: rel, line: at, call: firstCall, repo, via: 'named-argument' })
    }
    for (const m of whole.matchAll(MAPPING_REPO_RE)) {
      if (out.length >= limit) break
      const repo = m[1]
      if (LOCAL_PATH_HEAD_RE.test(repo) || seen.has(repo)) continue
      seen.add(repo)
      const at = whole.slice(0, m.index).split('\n').length
      out.push({ file: rel, line: at, call: firstCall, repo, via: 'mapping-value' })
    }
  }
  return out
}

/**
 * 上游把「装完依赖后还要敲的命令」写在文档里（常见位置 docs/install.md），
 * 例如 MeloTTS 的 `python -m unidic download`。这类命令不在依赖清单里，平台
 * 不会自动执行，但对能不能出声是必需的。只认 `python -m <模块> download`
 * 这种明确指向资源下载的形式，示例用法一概不认。
 */
const DOC_STEP_FILES = ['docs/install.md', 'docs/INSTALL.md', 'docs/installation.md',
  'docs/setup.md', 'install.md', 'INSTALL.md', 'README.md']
const DOC_DOWNLOAD_RE = /^\s*(?:python3?|py)\s+-m\s+([A-Za-z0-9_.]+)\s+(download|install)\s*$/i

function scanDocDownloadCommands (dir) {
  const out = []
  const seen = new Set()
  for (const rel of DOC_STEP_FILES) {
    const f = path.join(dir, rel)
    if (!fs.existsSync(f)) continue
    let lines = []
    try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/) } catch { continue }
    lines.forEach((line, i) => {
      const m = line.match(DOC_DOWNLOAD_RE)
      if (!m) return
      const key = m[1] + ' ' + m[2].toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push({ file: rel, line: i + 1, cmd: line.trim().slice(0, 120),
        argv: ['{engine_python}', '-m', m[1], m[2].toLowerCase()] })
    })
  }
  return out
}

/** 按优先级列出这一台引擎自带的下载入口；GET 与 POST 用同一份构造，避免两边漂移。 */
function buildEngineDownloadEntries (root, id) {
  const dir = path.join(root, 'engines', id)
  if (!fs.existsSync(dir)) return []
  const manifest = readLocalManifest(dir)
  const entries = []
  const post = manifest && manifest.models && manifest.models.post_download
  if (post && Array.isArray(post.command) && post.command.length) {
    entries.push({
      key: 'manifest', kind: 'manifest', priority: 0,
      labelZh: '名片声明的补齐命令', labelEn: 'Command declared in the manifest',
      argv: post.command.slice(),
      noteZh: '由引擎名片声明，平台只执行并显示进度。',
      noteEn: 'Declared by the engine manifest; the platform only runs it and shows progress.',
    })
  }
  const envReady = fs.existsSync(path.join(dir, '.venv'))
  for (const f of ENGINE_ENTRY_SCRIPTS) {
    if (!fs.existsSync(path.join(dir, ...f.split('/')))) continue
    const installs = scriptInstallsEnv(f)
    entries.push({
      key: 'script:' + f, kind: 'script', priority: 1,
      labelZh: f, labelEn: f,
      argv: scriptArgvFor(dir, f),
      installs_env: installs,
      already_deployed: installs && envReady,
      noteZh: installs && envReady
        ? '该脚本同时安装环境，而引擎环境已存在：第 2 步可能已经部署过，重复执行会重建环境。'
        : (installs ? '该脚本同时安装环境，执行后环境不再由平台按名片建立。' : ''),
      noteEn: installs && envReady
        ? 'This script also installs the environment, which already exists; step 2 may have run it.'
        : '',
    })
  }
  for (const rel of scanEngineScriptCandidates(dir, new Set(ENGINE_ENTRY_SCRIPTS))) {
    const installs = scriptInstallsEnv(rel)
    entries.push({
      key: 'script:' + rel, kind: 'script', priority: 1,
      labelZh: rel, labelEn: rel,
      argv: scriptArgvFor(dir, rel),
      installs_env: installs,
      already_deployed: installs && envReady,
      needs_review: true,
      noteZh: '盘上找到的候选下载脚本，权重落点由引擎自己决定。执行前请确认它下载的是模型权重，而不是训练数据或格式转换工具。',
      noteEn: 'A candidate download script found on disk; the engine decides where files go. Confirm it downloads model weights before running.',
    })
  }
  try {
    const { collectCliHelp } = require('./cliHelp')
    const { moduleWithRoot } = require('./entryPick')
    const cli = collectCliHelp({ dir })
    const flags = cli && cli.ok && Array.isArray(cli.flags) ? cli.flags : []
    const groups = [...new Set(flags.map((f) => f && f.subcommand)
      .filter((g) => g && DOWNLOAD_GROUP_RE.test(g)))]
    for (const g of groups) {
      const hit = flags.find((f) => f && f.subcommand === g && f.source_file)
      if (!hit) continue
      const mod = moduleWithRoot(hit.source_file).module
      if (!mod) continue
      entries.push({
        key: 'cli:' + g, kind: 'cli', priority: 2,
        labelZh: `命令行子命令 ${g}`, labelEn: `CLI subcommand ${g}`,
        argv: ['{engine_python}', '-m', mod, g, '--model-dir', '{checkpoints}'],
        may_overwrite: true,
        needs_review: true,
        noteZh: '引擎自带的下载子命令可能整仓同步并覆盖已下载的主权重；命令由平台按子命令名拼成，参数与落点请在执行前核对。',
        noteEn: 'This subcommand may sync a whole repository and overwrite downloaded weights.',
      })
    }
  } catch { /* 命令行读不出来时只给前两类，不影响退回路径 */ }

  // 文档里的补齐命令不是权重下载入口：单独列出来，但不能用它挡住下面的
  // 「运行时从 HF 取权重」兜底，否则 MeloTTS 这类引擎又只剩一条词典命令。
  const primaryCount = entries.length
  for (const c of scanDocDownloadCommands(dir)) {
    entries.push({
      key: 'doc:' + c.file + ':' + c.line, kind: 'doc-command', priority: 2,
      labelZh: '文档里的补齐命令：' + c.cmd,
      labelEn: 'Setup command from the docs: ' + c.cmd,
      argv: c.argv,
      needs_review: true,
      noteZh: '来自 ' + c.file + ':' + c.line + '。上游把这一步写在安装文档里，'
        + '平台只负责把它列出来，执行前请确认它下载的是运行期资源。',
      noteEn: 'Found in ' + c.file + ':' + c.line + '. The upstream lists this step in its '
        + 'installation docs; confirm it fetches runtime resources before running.',
    })
  }

  // 还有一类引擎：不带下载命令、也不写下载脚本，运行时用 huggingface_hub 按需拉权重。
  //   落到哪里由 hub 决定（HF 缓存），不是引擎目录里的 checkpoints，所以
  //   「模型仓库」那条路把它下到 checkpoints 也不会被读到。四类都为空时补一条可执行入口：
  //   用引擎自己的解释器把仓库拉进缓存，之后运行时直接命中。
  const declaredModels = (manifest && manifest.models && Array.isArray(manifest.models.required))
    ? manifest.models.required : []
  if (primaryCount === 0 && declaredModels.length === 0) {
    const engineKey = String(id).toLowerCase().replace(/[^a-z0-9]/g, '')
    const rankOf = (repo) => {
      const tail = String(repo).split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '')
      return tail.includes(engineKey) ? 0 : 1
    }
    const pools = scanRuntimeDownloads(dir, 24).filter((h) => h && h.repo)
    // 仓库名与引擎同名的排在前面（多语言引擎会一次列出一堆），
    //   顺序保持扫描到的先后，也就是源码里的书写顺序，不另排一次。
    const mine = pools.filter((h) => rankOf(h.repo) === 0)
    const picked = (mine.length ? mine : pools).slice(0, mine.length ? 8 : 3)
    picked.forEach((h, idx) => {
      entries.push({
        // priority 逐条递增：末尾统一按 priority 再按 key 排序，
        //   同优先级会被 key 的字典序重排，列表顺序与源码里的书写顺序不一致。
        key: 'hf:' + h.repo, kind: 'hf-runtime', priority: 3 + idx,
        labelZh: '预下载到 HF 缓存：' + h.repo,
        labelEn: 'Pre-download into the HF cache: ' + h.repo,
        argv: ['{engine_python}', '-c',
          "from huggingface_hub import snapshot_download; snapshot_download('" + h.repo + "')"],
        needs_review: true,
        noteZh: '这类引擎运行时自己从 Hugging Face 取权重，落点是 HF 缓存而不是引擎目录的 checkpoints，'
          + '平台的权重落点判定对它不适用。这条命令只负责把该仓库取到本机，之后运行时直接命中缓存。'
          + '其余仓库的 ID 见下方「运行时会拉取」清单。',
        noteEn: 'This engine fetches weights from Hugging Face at run time, into the HF cache '
          + 'rather than the engine checkpoints folder, so the platform weight check does not apply. '
          + 'This command only pulls that repo so later runs hit the cache. '
          + 'Other repo IDs are listed under runtime downloads below.',
      })
    })
  }
  return entries.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))
}

function expandEngineArgv (argv, root, id, dir, manifest) {
  const { resolveCheckpointsRel } = require('./checkpointsPath')
  const rel = resolveCheckpointsRel(manifest, id) || path.join('engines', id, 'checkpoints')
  const venvPython = process.platform === 'win32'
    ? path.join(dir, '.venv', 'Scripts', 'python.exe')
    : path.join(dir, '.venv', 'bin', 'python')
  const platformVenv = process.platform === 'win32'
    ? path.join(root, 'venv', 'Scripts', 'python.exe')
    : path.join(root, 'venv', 'bin', 'python')
  const map = {
    engine_python: fs.existsSync(venvPython) ? venvPython
      : (fs.existsSync(platformVenv) ? platformVenv : (process.platform === 'win32' ? 'python' : 'python3')),
    checkpoints: path.resolve(root, rel).replace(/\\/g, '/'),
    engine_dir: dir.replace(/\\/g, '/'),
    root: path.resolve(root).replace(/\\/g, '/'),
  }
  return argv.map((w) => String(w).replace(/\{([a-z_]+)\}/g,
    (m, k) => (map[k] === undefined ? m : map[k])))
}

// GET /wizard/download-entries?id=   列出第一档入口
function handleDownloadEntries (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/download-entries')) return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  const root = url.searchParams.get('root') || projectRoot() || ''
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  const dir = path.join(root, 'engines', id)
  json(res, 200, {
    ok: true,
    entries: buildEngineDownloadEntries(root, id),
    // 启动阶段自行拉取的资源不在任何仓库清单里。平台只把这份事实交出去，
    // 不替引擎执行；界面如何呈现与是否提示接入者声明，由界面决定。
    runtime_hints: fs.existsSync(dir) ? scanRuntimeDownloads(dir) : [],
  })
  return true
}

// POST /wizard/engine-download {id, key}  执行第一档入口，SSE 逐行透传
function handleEngineDownload (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/engine-download')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = String(body.id || '')
    const root = body.root || projectRoot() || ''
    if (!id || /[\\/]/.test(id) || id === '..' || path.isAbsolute(id)) {
      json(res, 400, { ok: false, code: 'BAD_ID', error: 'Invalid engine id', errorZh: '引擎 id 不合法。' })
      return
    }
    const dir = path.join(root, 'engines', id)
    if (!fs.existsSync(dir)) {
      json(res, 400, { ok: false, code: 'NO_ENGINE', error: `引擎目录不存在：${id}` })
      return
    }
    const entry = buildEngineDownloadEntries(root, id).find((e) => e.key === String(body.key || ''))
    if (!entry) {
      json(res, 400, { ok: false, code: 'NO_ENTRY', error: '没有这个入口', errorZh: '没有这个入口，请重新读取入口清单。' })
      return
    }
    const argv = expandEngineArgv(entry.argv, root, id, dir, readLocalManifest(dir))
    if (argv.some((w) => /\{[a-z_]+\}/.test(w))) {
      json(res, 400, { ok: false, code: 'BAD_PLACEHOLDER', error: '命令里有未展开的占位符' })
      return
    }
    const { childEnvFor } = require('./envInstall')
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    send('argv', { argv: argv.map(String), cwd: dir })
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: dir, windowsHide: true, shell: false,
        env: childEnvFor(root, undefined),
      })
    } catch (e) {
      send('done', { ok: false, code: 'SPAWN_FAILED', error: e.message })
      res.end()
      return
    }
    let finished = false
    const finish = (ok, payload) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      send('done', { ok, ...payload })
      res.end()
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退出 */ }
      finish(false, { code: 'TIMEOUT', error: 'Stopped after the time limit.', errorZh: '超过时间上限，已停止。' })
    }, RUN_SCRIPT_TIMEOUT_MS)
    if (typeof res.on === 'function') {
      res.on('close', () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        try { child.kill() } catch { /* 已经退出 */ }
      })
    }
    const onData = (buf, isErr) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) send('line', { text: line, err: !!isErr })
      }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('error', (e) => finish(false, { code: 'SPAWN_FAILED', error: e.message }))
    child.on('close', (code) => finish(code === 0, { status: code, code: code === 0 ? 'OK' : 'EXIT_' + code }))
  })
  return true
}

// POST /wizard/run-script {id, file, args}  第 3 步：跑上游自带的下载脚本
//   上游脚本自己知道目录结构（权重放哪、叫什么），跑它最不容易错。
//   平台只做三件事：按扩展名选解释器、在引擎目录里跑、把输出原样透传；
//   脚本结束后由前端重新扫盘更新清单。不解析脚本、不改写它写的任何路径。
function handleRunScript (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/run-script')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = String(body.id || '')
    const file = String(body.file || '')
    const root = body.root || projectRoot() || ''
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }
    if (!file) { json(res, 400, { ok: false, error: 'file is required' }); return }
    // id 会拼进工作目录，和脚本路径一样不许越界。
    if (/[\\/]/.test(id) || id === '..' || path.isAbsolute(id)) {
      json(res, 400, { ok: false, code: 'BAD_ID', error: 'Invalid engine id', errorZh: '引擎 id 不合法。' })
      return
    }

    // 只跑引擎目录里真实存在的 .py / .sh / .js：不许 ..、不许绝对路径。
    //   这条口子等于让使用者在本机执行一条下载脚本，越界就等于能跑任意路径。
    const rel = file.replace(/\\/g, '/')
    if (rel.split('/').includes('..') || path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
      json(res, 400, { ok: false, code: 'BAD_PATH',
        error: 'The script path must stay inside the engine folder.',
        errorZh: '脚本路径必须留在引擎目录内。' })
      return
    }
    const engineDir = path.join(root, 'engines', id)
    const abs = path.join(engineDir, rel)
    const ext = path.extname(rel).toLowerCase()
    if (!['.py', '.sh', '.js'].includes(ext)) {
      json(res, 400, { ok: false, code: 'BAD_SCRIPT',
        error: `Only .py / .sh / .js scripts can be run (got ${JSON.stringify(ext || '')}).`,
        errorZh: '只支持运行 .py / .sh / .js 脚本。' })
      return
    }
    if (!fs.existsSync(abs)) {
      json(res, 400, { ok: false, code: 'NO_SCRIPT', error: `${file} does not exist`, errorZh: `找不到 ${file}` })
      return
    }

    // 解释器：.py 用引擎自己的 venv（依赖装在那里），.sh 用 bash，.js 用 node。
    const venv = process.platform === 'win32'
      ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
      : path.join(engineDir, '.venv', 'bin', 'python')
    // venv 还没建（第 2 步没跑）时退到平台自己的解释器，再退到 PATH 上的 python：
    //   脚本可能只做下载，不该因为引擎环境还没装就不能跑。
    const platformVenv = process.platform === 'win32'
      ? path.join(root, 'venv', 'Scripts', 'python.exe')
      : path.join(root, 'venv', 'bin', 'python')
    const interp = ext === '.py'
      ? (fs.existsSync(venv) ? venv : (fs.existsSync(platformVenv) ? platformVenv : (process.platform === 'win32' ? 'python' : 'python3')))
      : (ext === '.sh' ? 'bash' : 'node')
    const extra = Array.isArray(body.args) ? body.args.map((a) => String(a)) : []

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    send('argv', { argv: [interp, rel, ...extra], cwd: path.relative(root, engineDir) || '.' })

    let child
    try {
      child = spawn(interp, [abs, ...extra], { cwd: engineDir, windowsHide: true, shell: false })
    } catch (e) {
      send('done', { ok: false, code: 'SPAWN_FAILED', error: e.message })
      res.end()
      return
    }
    // error 与 close 可能都来，超时与客户端断开也会来收尾：只发一次 done。
    let finished = false
    const finish = (ok, payload) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      send('done', { ok, ...payload })
      res.end()
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch (e) { /* 已经退出 */ }
      send('line', { text: 'Stopped after the time limit.', err: true })
      finish(false, { code: 'TIMEOUT', error: 'Stopped after the time limit.', errorZh: '超过时间上限，已停止。' })
    }, RUN_SCRIPT_TIMEOUT_MS)
    // 使用者关掉页面或点了停止，连接一断就杀掉子进程，不留后台下载。
    if (typeof res.on === 'function') {
      res.on('close', () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        try { child.kill() } catch (e) { /* 已经退出 */ }
      })
    }
    const onData = (buf, isErr) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) send('line', { text: line, err: !!isErr })
      }
    }
    child.stdout.on('data', (b) => onData(b, false))
    child.stderr.on('data', (b) => onData(b, true))
    child.on('error', (e) => {
      finish(false, { code: 'SPAWN_FAILED', error: e.message, errorZh: '脚本没能启动：' + e.message })
    })
    child.on('close', (code) => {
      finish(code === 0, { status: code, code: code === 0 ? 'OK' : 'EXIT_' + code })
    })
  })
  return true
}

// /wizard/download/file  第 3 步单文件操作
//   POST   { id, root, repo, file:{name,size,sha256,tool} } 下载单个文件，SSE 流式返回进度。
//          repo 为空、来源认不出都在开流之前回 400：开了流再报错，前端只看到一个失败的文件，
//          看不出是请求本身就缺了东西。
//   DELETE { id, root, name, size, sha256 } 删掉判为不完整的那个文件
function handleDownloadFile (req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return false
  if (!req.url || !req.url.startsWith('/wizard/download/file')) return false
  if (req.method === 'DELETE') { handleDeletePartialFile(req, res); return true }
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const { id, file } = body
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }
    // 落盘子目录：上游把可选模型并排放时，文件要落在对应那一层。
    const subdir = typeof body.subdir === 'string' ? body.subdir : ''
    if (rejectBadSubdir(res, subdir)) return
    if (!file || !file.name) { json(res, 400, { ok: false, error: 'file.name is required' }); return }
    const root = body.root || projectRoot() || ''
    const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
    if (!repo) {
      json(res, 400, { ok: false, code: 'MISSING_REPO', error: 'repo is required',
        errorZh: '请求里缺少仓库（repo），无法下载。' })
      return
    }
    const source = normalizeSource(file.tool)
    if (!source) {
      json(res, 400, { ok: false, code: 'UNKNOWN_SOURCE',
        error: `file.tool must be hf or modelscope (got ${JSON.stringify(file.tool || '')}).`,
        errorZh: '下载来源未知，请选择 Hugging Face 或魔搭（ModelScope）。' })
      return
    }
    // 令牌在这里读、只交给下载层，不进 SSE 事件，也不进任何日志。
    const token = source === 'hf' ? hfToken.readToken() : null
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    const dl = acquireDownloadAbort(id)
    downloadFile(subdir ? { ...file, subdir } : file, repo, root, id, (text, isErr) => {
      send('line', { text, err: !!isErr })
    }, (p) => {
      send('progress', { file: file.name, percent: Math.round((p.downloaded / p.total) * 100), downloaded: p.downloaded, total: p.total })
    }, undefined, dl.signal, { token }).then((r) => {
      dl.release()
      send('done', r)
      res.end()
    }).catch((e) => {
      dl.release()
      send('done', { ok: false, code: 'BRIDGE_FAILED',
        error: (e && e.message) || String(e) })
      res.end()
    })
  })
  return true
}

// POST /wizard/download/url {id, url, name?, subdir?, size?}  第 3 步：直链兜底
//   上游只给了单文件链接（release 资产、自建网盘直链）时走这里。落盘、HTML
//   误判守卫、大小核对、写 .tmp 再改名全部复用 downloadFileFromUrl，不另起一套。
//   平台只收一条 http(s) 文件地址，用自己的下载器取文件。
function handleDownloadUrl (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/download/url')) return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = String(body.id || '')
    const raw = String(body.url || '').trim()
    const root = body.root || projectRoot() || ''
    if (!id || /[\\/]/.test(id) || id === '..' || path.isAbsolute(id)) {
      json(res, 400, { ok: false, code: 'BAD_ID', error: 'Invalid engine id', errorZh: '引擎 id 不合法。' })
      return
    }
    let u = null
    try { u = new URL(raw) } catch (e) { /* 下面按 BAD_URL 拒绝 */ }
    if (!u || !['http:', 'https:'].includes(u.protocol)) {
      json(res, 400, { ok: false, code: 'BAD_URL',
        error: 'A direct http(s) file URL is required.', errorZh: '请填写 http(s) 文件直链。' })
      return
    }
    let name = String(body.name || '').trim()
    if (!name) {
      try { name = decodeURIComponent(path.posix.basename(u.pathname)) } catch (e) { name = '' }
    }
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..' || path.isAbsolute(name)) {
      json(res, 400, { ok: false, code: 'BAD_NAME',
        error: 'The file name cannot be read from this URL. Fill in the name.',
        errorZh: '这个链接读不出文件名，请补一个文件名。' })
      return
    }
    const subdir = typeof body.subdir === 'string' ? body.subdir : ''
    if (rejectBadSubdir(res, subdir)) return
    const overwrite = body.overwrite === true
    const file = { name, size: Number(body.size) || 0, subdir }
    const finalPath = destPath(root, id, subdir, name)
    if (!finalPath) {
      json(res, 400, { ok: false, code: 'NO_DEST',
        error: 'The weights folder cannot be resolved for this engine.',
        errorZh: '无法确定这台引擎的权重目录。' })
      return
    }
    const dl = acquireDownloadAbort(id)
    let finished = false
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    if (typeof res.on === 'function') {
      res.on('close', () => {
        if (finished) return
        finished = true
        dl.abort()
      })
    }
    // 与仓库文件同一套保留规则：已有同名文件又没有 .tmp 时不覆盖，
    //   确实要替换时由界面上的「重新下载」带上 overwrite。
    const tmpPath = finalPath + '.tmp'
    if (fs.existsSync(finalPath) && !fs.existsSync(tmpPath) && !overwrite) {
      const kept = {
        ok: true, code: 'KEPT_EXISTING', status: null, skipped: true,
        size: fs.statSync(finalPath).size,
        note: 'An existing file with this name was kept. Use re-download to overwrite it.',
        noteZh: '已存在同名文件，保留未覆盖。要替换请点「重新下载」，它会覆盖这一份。',
      }
      send('line', { text: kept.noteZh, err: false })
      send('done', kept)
      finished = true
      dl.release()
      res.end()
      return
    }
    if (overwrite) {
      try { fs.rmSync(finalPath, { force: true }) } catch (e) { /* 删不掉就让下载覆盖 */ }
    }
    const onLine = (text, isErr) => { send('line', { text, err: !!isErr }) }
    const onProgress = (p) => {
      send('progress', { file: name, percent: Math.min(100, Math.round((p.downloaded / p.total) * 100)),
        downloaded: p.downloaded, total: p.total })
    }
    try {
      downloadFileFromUrl(raw, file, '', root, id, onLine, onProgress, 0, false, dl.signal, null)
        .then((r) => {
          dl.release()
          if (finished) return
          finished = true
          send('done', r)
          res.end()
        })
        .catch((e) => {
          dl.release()
          if (finished) return
          finished = true
          send('done', { ok: false, code: 'BRIDGE_FAILED', error: (e && e.message) || String(e) })
          res.end()
        })
    } catch (e) {
      dl.release()
      finished = true
      send('done', { ok: false, code: 'BRIDGE_FAILED', error: (e && e.message) || String(e) })
      res.end()
    }
  })
  return true
}

// /wizard/hf-token  第 3 步的 HF 访问令牌
//   GET    回 { ok, configured }：只说配置了没有，令牌本身永远不出这个进程。
//   POST   { token } 保存；DELETE 清除。两者都只回 { ok, configured }。
//   请求体解析失败时不回 err.message：新版 Node 的 JSON 报错会带上原文片段，原文里就是令牌。
function handleHfToken (req, res) {
  if (!req.url || !/^\/wizard\/hf-token(?:\?|$)/.test(req.url)) return false
  if (req.method === 'GET') {
    json(res, 200, { ok: true, configured: hfToken.hasToken() })
    return true
  }
  if (req.method === 'DELETE') {
    const r = hfToken.clearToken()
    json(res, r.ok ? 200 : 500, { ...r, configured: hfToken.hasToken() })
    return true
  }
  if (req.method !== 'POST') return false
  readBody(req, (err, body) => {
    if (err || !body || body.tooBig) {
      json(res, 400, { ok: false, code: 'BAD_JSON', error: 'The request body is not valid JSON.',
        errorZh: '请求格式错误。', configured: hfToken.hasToken() })
      return
    }
    const r = hfToken.writeToken(body.token)
    json(res, r.ok ? 200 : 400, { ...r, configured: hfToken.hasToken() })
  }, 16 * 1024)
  return true
}

// 第 3 步的取消通道：按引擎 id 挂 AbortController。
//   一台引擎的一轮下载（可能同时有好几个文件在途）共用一个 controller，
//   取消一次就停掉这一轮的全部请求。
const downloadAbortControllers = new Map()

/**
 * 登记一次下载请求，返回这一轮共用的取消信号与它自己的中断句柄。
 * 整轮取消（/wizard/download/cancel）通过共享 controller 一次停掉全部在途请求；
 * 单个请求的客户端断开只 abort 自己，不牵连同轮的其它文件。
 */
function acquireDownloadAbort (id) {
  const key = String(id)
  let entry = downloadAbortControllers.get(key)
  if (!entry) {
    entry = { ac: new AbortController(), count: 0 }
    downloadAbortControllers.set(key, entry)
  }
  entry.count += 1
  const local = new AbortController()
  const onAbort = () => local.abort()
  entry.ac.signal.addEventListener('abort', onAbort, { once: true })
  let released = false
  const release = () => {
    if (released) return
    released = true
    const cur = downloadAbortControllers.get(key)
    if (!cur) return
    cur.ac.signal.removeEventListener('abort', onAbort)
    cur.count = Math.max(0, cur.count - 1)
    if (cur.count === 0 || cur.ac.signal.aborted) downloadAbortControllers.delete(key)
  }
  return { signal: local.signal, abort: () => local.abort(), release }
}

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
    const subdir = typeof body.subdir === 'string' ? body.subdir : ''
    if (rejectBadSubdir(res, subdir)) return
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }
    if (!name) { json(res, 400, { ok: false, error: 'name is required' }); return }
    const root = body.root || projectRoot() || ''
    removePartialFiles([{ name, size: size || null, sha256: sha256 || null, subdir }], root, id)
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
  if (req.url.startsWith('/wizard/download/cancel')) return false
  if (req.url.startsWith('/wizard/download-entries')) return false
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
  // runAudioCheck 是 async：stdio 形态的引擎要先拉一台临时宿主再验。
  //   handler 仍同步返回 true 接单（同 handleProbe 的模式），json 在异步体里回。
  void (async () => {
    const audio = await runAudioCheck(id, { audio: audioLevel, request })
    // A 级合成成功时 audio_path 已由 verify_audio.py 给出；B 级不合成，
    // 磁盘上可能留着上次的 A 级产物，能找到就带上。
    if (!audio.audio_path) {
      const found = findVerifyAudio(id)
      if (found) audio.audio_path = found
    }
    r.checks.audio = audio
    // 第 3 道只核对名片声明的文件。启动阶段自行拉取的资源另列一份，
    //   不把「名片声明的文件齐全」读成「运行所需资源齐全」。
    if (r.checks.checkpoints) {
      const root = projectRoot() || ''
      const dir = path.join(root, 'engines', id)
      r.checks.checkpoints.external = fs.existsSync(dir) ? scanRuntimeDownloads(dir) : []
    }
    json(res, r.ok ? 200 : 400, r)
  })()
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

// GET /wizard/verify/ref?id=<id>  第 5 步：平台能替使用者代填的试运行素材。
//   只回本机数据：参考音频与参考文本（从资产 segments.json 取第一条可用切片，
//   与合成主链路走同一个 firstRefAudio，不另造一套取法）。没有素材就如实回空，
//   由使用者自己填。默认试音文本是纯展示文案，归前端的 i18n，不在这里回。
function handleVerifyRef (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/verify/ref')) return false
  const tail = req.url.slice('/wizard/verify/ref'.length)
  if (tail !== '' && tail[0] !== '?') return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  const { validateId } = require('./save')
  const idErr = validateId(id)
  if (idErr) { json(res, 400, { ok: false, error: idErr }); return true }
  const { firstRefAudio } = require(
    path.join(__dirname, '..', '..', '..', 'lib', 'server', 'refAudio.js'))
  const seg = firstRefAudio(id)
  json(res, 200, {
    ok: true,
    reference_audio: seg ? seg.reference_audio : '',
    reference_text: seg ? seg.reference_text : '',
  })
  return true
}

/**
 * POST /wizard/verify  {id, deep?, audio?, request?}
 *  调平台的四道校验，本文件不自己做判断
 */
function handleVerify (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/verify')) return false
  // 锚定：/wizard/verify/measure 也以 /wizard/verify 开头，不锚定就被这里吃掉。
  const vtail = req.url.slice('/wizard/verify'.length)
  if (vtail !== '' && vtail[0] !== '?') return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = body.id
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }

    if (body.audio) {
      // runAudioCheck 可能要先拉临时宿主：stdio 形态没有常驻地址。
      void (async () => {
        const r = await runAudioCheck(id, { audio: body.audio, request: body.request })
        json(res, r.ok ? 200 : 400, r)
      })()
      return
    }
    const r = runChecks(id, { deep: body.deep !== false })
    json(res, 200, r)
  })
  return true
}

// POST /wizard/verify/measure  {id, request}  第 5 步：起一个后台试运行任务，立即返回
//   真起一次引擎（照平台启动计划），量冷启动到就绪、合成一段 max_chars 长文本的耗时，
//   留余量定本机上的 runtime.ready_timeout_ms / timeout_ms，存进本机记录（state/ 下），
//   不写名片，见 core/measure.js。任务、阶段、整体超时见 core/measureJob.js。
//   request 是合成请求体（text、reference_audio 等平台的词，或引擎方言），平台不编。
//   回 202 + 任务快照；同一台引擎已有任务进行中 ⇒ 409。
//   锚定整串：/wizard/verify/measure/progress 与 /cancel 有各自的 handler。
function handleVerifyMeasure (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/verify/measure')) return false
  const tail = req.url.slice('/wizard/verify/measure'.length)
  if (tail !== '' && tail[0] !== '?') return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    if (body.tooBig) { json(res, 413, { ok: false, error: 'body too big' }); return }
    if (!body.id) { json(res, 400, { ok: false, error: 'id is required' }); return }
    if (!body.request || !body.request.text) {
      json(res, 400, { ok: false, error: 'request.text is required（试运行要真合成一段）' }); return
    }
    const { startMeasureJob } = require('./measureJob')
    const r = startMeasureJob(String(body.id), body.request)
    json(res, r.ok ? 202 : (r.code === 'MEASURE_RUNNING' ? 409 : 400), r)
  })
  return true
}

// GET /wizard/verify/measure/progress?id=  第 5 步：读试运行任务的阶段与已用时间
//   从没跑过 ⇒ 200 + job:null（「没有任务」是一个答案，不是找不到端点）。
function handleVerifyMeasureProgress (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/verify/measure/progress')) return false
  const tail = req.url.slice('/wizard/verify/measure/progress'.length)
  if (tail !== '' && tail[0] !== '?') return false
  const url = new URL(req.url, 'http://x')
  const id = url.searchParams.get('id')
  if (!id) { json(res, 400, { ok: false, error: '?id= is required' }); return true }
  const { getMeasureJob } = require('./measureJob')
  json(res, 200, { ok: true, job: getMeasureJob(id) })
  return true
}

// POST /wizard/verify/measure/cancel  {id}  取消正在进行的试运行：abort ⇒ 收掉引擎进程
function handleVerifyMeasureCancel (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/verify/measure/cancel')) return false
  const tail = req.url.slice('/wizard/verify/measure/cancel'.length)
  if (tail !== '' && tail[0] !== '?') return false
  readBody(req, (err, body) => {
    if (err) { json(res, 400, { ok: false, code: 'BAD_JSON', error: err.message }); return }
    const id = String(body.id || '')
    if (!id) { json(res, 400, { ok: false, error: 'id is required' }); return }
    const { cancelMeasureJob } = require('./measureJob')
    json(res, 200, { id, ...cancelMeasureJob(id) })
  })
  return true
}

// POST /wizard/params      第 4 步：反射 → parameters[] 草稿 + 映射候选
// 这一步能离线跑：第 4 步写名片时，源码（第 1 步克隆）、环境（第 2 步）、权重（第 3 步）
//   全部已在磁盘上 ⇒ 不需要联网。
// 这条端点只产草稿，绝不写 manifest.json：parameters[] 与 map_candidates 都是候选，
//   界面逐条确认后才可能进表单；落盘是 POST /wizard/save 的事。
// 不新增任何平台侧校验逻辑：反射器报什么就传什么，partial / warnings / excluded 原样带出去。
function handleParams (req, res) {
  if (req.method !== 'POST') return false
  if (!req.url || !req.url.startsWith('/wizard/params')) return false
  // 前缀必须整串匹配（后面只许跟 ? 查询串）：startsWith 会把 /wizard/params/extra 一起吃掉。
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
    //   正是为了让「执行结束但无结果」与「执行报错」能区分开。
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
//   4. 都没有 → 再做一次 python 类的静态扫描，有候选就交出去（让人先定入口，定完再扫）
//      连候选都没有才返回 {ok:false, error:'未能发现参数，请手工填写'}
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

    // 读侧：本 checkout 优先，主仓库兜底（wizardRoot.js）
    const dir = engineDirForRead(id)
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
    let entry = null
    // README 与打包声明点过名的模块：即便没有对应的源文件，也要进候选清单。
    let declaredModules = []
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
          // 推理入口：先看 README 里作者自己写的用法，认不出再按四类参数打分。
          //   README 的风格千差万别，认不出是常态，那时完全靠打分的结论。
          try {
            const {
              entriesFromReadme, entriesFromPyproject, entriesFromSetupPy, mergeEntries,
            } = require('./readmeEntry')
            const { pickEntry } = require('./entryPick')
            let fromReadme = null
            try {
              // 文档名的变体很多：README.md / readme.txt / README_zh.md / README.zh-CN.md。
              //   短名优先，这样同一目录里有主文档与中文版时先用主文档。
              const readmeName = fs.readdirSync(dir)
                .filter((f) => /^readme([._-][\w-]+)?(\.(md|txt|rst))?$/i.test(f))
                .sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
              if (readmeName) {
                fromReadme = entriesFromReadme(fs.readFileSync(path.join(dir, readmeName), 'utf8'))
                if (fromReadme.modules.length || fromReadme.files.length) {
                  notes.push(`README 提到：${[...fromReadme.modules, ...fromReadme.files].join(', ')}`)
                }
              }
            } catch { /* 没有 README 就只靠打分 */ }
            // 打包声明是最硬的证据：写的是「装好之后敲哪条命令」，写错了装不上。
            //   读不动（没有这两个文件、或格式不认识）时退回 README 与打分。
            let fromEntryPoints = null
            try {
              const parts = []
              for (const [name, read] of [
                ['pyproject.toml', entriesFromPyproject],
                ['setup.py', entriesFromSetupPy],
              ]) {
                const f = path.join(dir, name)
                if (fs.existsSync(f)) parts.push(read(fs.readFileSync(f, 'utf8')))
              }
              const merged = mergeEntries(...parts)
              if (merged.modules.length) {
                fromEntryPoints = merged
                notes.push(`打包声明提到入口：${merged.modules.join(', ')}`)
              }
            } catch { /* 声明读不动就只靠 README 与打分 */ }
            const asParams = (cliDraft.args || []).map((a) => ({
              source: 'cli', name: a.name, target: a.flag, kind: a.type || 'str',
              style: a.style, required: a.required === true,
              group: a.subcommand || '(root)', is_tool: a.is_tool === true,
              source_file: a.source_file || null,
            }))
            // src/ 本身是包的工程（src/__init__.py 存在）不能把 src 当布局层剥掉。
            const srcIsPackage = fs.existsSync(path.join(dir, 'src', '__init__.py'))
            declaredModules = [...new Set([
              ...((fromReadme && fromReadme.modules) || []),
              ...((fromEntryPoints && fromEntryPoints.modules) || []),
            ])]
            entry = pickEntry(asParams, { fromReadme, fromEntryPoints, srcIsPackage })
            if (entry.file) {
              const why = entry.source === 'entry-points'
                ? '打包声明'
                : (entry.source === 'readme' ? 'README' : '参数打分')
              notes.push(`推理入口：${entry.file}（依据：${why}，置信度 ${entry.confidence}）`)
            }
          } catch (e) {
            notes.push(`推理入口识别失败：${e.message}`)
          }
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

    // Python 形态的入口候选：名片还没写 call.module / call.class 时，反射根本跑不起来，
    //   入口那一格只能靠人背模块名。这里做一次静态扫描（只读文本，不 import），
    //   把「哪个类、哪个方法」摆出来；选中后写进名片，之后再扫描就能反射出参数。
    let pythonEntries = []
    if (!hasPython) {
      try {
        const { scanPythonEntries } = require('./pyClassScan')
        pythonEntries = scanPythonEntries(dir)
        if (pythonEntries.length) {
          notes.push(`静态扫描到 ${pythonEntries.length} 个 python 入口候选（未导入任何模块）`)
        }
      } catch (e) {
        notes.push(`python 入口静态扫描失败：${e.message}`)
      }
    }

    if (!hasCli && !hasPython) {
      // 纯库形态、名片里又还没声明类：把静态候选交出去，让人从清单里选一个。
      //   没有候选时照旧如实报「未能发现参数」。
      if (pythonEntries.length) {
        json(res, 200, {
          ok: true,
          source: 'python-static',
          params: [],
          groups: [],
          bind_candidates: [],
          entry: null,
          entry_candidates: [],
          python_entries: pythonEntries,
          declare_hints: { audio_params: [], weight_slots: [], output_formats: [], format_arg: null },
          suggested_call: null,
          notes,
          counts: { cli: 0, python: 0, total: 0 },
        })
        return
      }
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

    // 入口候选：即便识别不出结论，也要把全部 Python 源文件摆出来让人选。
    //   证据强度只用于排序，不用于删项；识别失败时使用者仍能从这里定下入口。
    let entryCandidates = []
    try {
      const { buildEntryCandidates } = require('./entryCandidates')
      const forScore = cliArgs.map((a) => ({
        name: a.name, source_file: a.source_file,
        group: a.subcommand || '(root)', required: a.required === true,
      }))
      entryCandidates = buildEntryCandidates(dir, forScore, {
        declaredModules,
        recommended: entry && entry.file,
      })
    } catch (e) {
      notes.push(`入口候选清单生成失败：${e.message}`)
    }
    const pythonParams = pythonDraft && pythonDraft.ok ? pythonDraft.parameters : []
    const { params, groups } = merge(cliArgs, pythonParams)

    const source = hasCli && hasPython ? 'both' : (hasCli ? 'cli' : 'python')

    json(res, 200, {
      ok: true,
      source,
      params,
      groups,
      // python 反射剔掉的 bind 槽位候选（text / output_path / output_dir）：
      //   交给前端自动填写去认 call.bind，output_path 才填得出来。
      bind_candidates: (pythonDraft && pythonDraft.ok && pythonDraft.bind_candidates) || [],
      // 推理入口的判定结果：{file, module, subcommand, score, source, confidence, ambiguous, candidates}
      //   source 是 readme 时表示命中了 README 里写的用法；ambiguous 为真表示证据并列，界面该让人点。
      entry,
      // 推理入口候选：{file, module, srcRoot, score, flags, groups, source, recommended}
      //   识别不出入口时这一份照样有值，界面据此给一个既能选又能输入的下拉。
      entry_candidates: entryCandidates,
      // python 形态的入口候选：{file, module, className, method, score, params}
      //   只在名片还没声明 python 类时给（有声明时反射结果更准）。
      python_entries: pythonEntries,
      // 可选能力的嗅探建议：音频类输入、多权重位、输出格式。只送建议，
      //   写不写进名片由前端按「已有声明不覆盖」决定；拿不准的不出现在这里。
      declare_hints: (() => {
        try {
          const h = require('./declareHints')
          const args = (cliDraft && cliDraft.ok && Array.isArray(cliDraft.args)) ? cliDraft.args : []
          return {
            audio_params: [...new Set(args.filter((a) => h.audioRoleFor(a.name)).map((a) => h.normWord(a.name)))],
            weight_slots: h.weightSlotHintsFrom(args.map((a) => ({ ...a, source: 'cli' }))),
            output_formats: h.formatHintsFrom(args),
            format_arg: h.formatArgNameFrom(args),
          }
        } catch { return { audio_params: [], weight_slots: [], output_formats: [], format_arg: null } }
      })(),
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
    // 名片按读根找（本 checkout 优先、主仓库兜底），本机记录按写根读：
    //   与第 5 步试运行写本机记录的位置是同一个根（core/measure.js）。
    const { writeRoot } = require('./wizardRoot')
    const profile = resolveEngineProfile(id, process.env, {
      enginesDir: /^[A-Za-z0-9._-]+$/.test(id) ? path.dirname(engineDirForRead(id)) : undefined,
      localRoot: writeRoot() || undefined,
    })
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
function handleInstallState (req, res) {
  if (req.method !== 'GET') return false
  if (!req.url || !req.url.startsWith('/wizard/install-state')) return false
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

/**
 * 删掉权重落点目录里的文件，供「从头重装本步」使用。
 *
 * 落点以名片为准（`runtime.checkpoints`），没声明时用统一落点。
 * 只删项目根之内的路径：名片是外部输入，`..` 与绝对路径都不能让它指到别处。
 */
function removeWeightsDir (root, id, dir) {
  const { resolveCheckpointsRel } = require('./checkpointsPath')
  const rel = resolveCheckpointsRel(readLocalManifest(dir), id)
  const abs = path.resolve(root, rel)
  const base = path.resolve(root)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { ok: false, code: 'BAD_PATH', rel, error: `权重落点不在项目目录内：${rel}` }
  }
  let existed = false
  try { existed = fs.existsSync(abs) } catch (e) { existed = false }
  if (!existed) return { ok: true, removed: false, rel, abs }
  try {
    fs.rmSync(abs, { recursive: true, force: true })
  } catch (e) {
    return {
      ok: false, code: 'WEIGHTS_REMOVE_FAILED', rel, abs,
      error: `删不掉 ${abs}：${(e && e.message) || String(e)}。若下载仍在进行，先停止再重试。`,
    }
  }
  return { ok: true, removed: true, rel, abs }
}

// POST /wizard/reset-progress   {id, section, removeVenv}  逃生口：从头重装本步
// 只清「哪些步骤算做完了」这份记录：
//    不删引擎目录里的源码、不删已下载的模型文件。
// section：'env'（第 2 步装依赖）/ 'models'（第 3 步下模型）/ 'all'
// removeWeights：仅对 models / all 有效。为 true 时删掉权重落点目录里的文件。
//    第 3 步的完成判据是「权重目录里有没有文件」，只清记录不会改变判定；
//    删目录是不可逆动作，所以同样由调用方显式要求。
// removeVenv：仅对 env / all 有效。为 true 时连 engines/<id>/.venv 一起删掉。
//    只清记录时，下一次安装会沿用已装了一半的环境，装坏的那个包不会被重装，
//    按钮看起来等于没生效；删 .venv 是破坏性动作，所以默认不删，由调用方显式要求。
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
      const section = body.section === 'models' ? 'models'
        : body.section === 'all' ? 'all' : 'env'
      const { resetProgress } = require('./installState')
      resetProgress(root, id, section)
      // 「从头重装本步」要连上一轮装出来的环境一起清：只清记录时，下一次安装会
      //   沿用已装了一半的 .venv，装坏的那个包不会被重装。删目录是不可逆动作，
      //   因此默认不删，调用方显式要求时才做。
      if (body.removeVenv === true && (section === 'env' || section === 'all')) {
        const { removeEngineVenv } = require('./envDetect')
        const v = removeEngineVenv(root, id)
        if (!v.ok) {
          json(res, 500, {
            ok: false, code: v.code, id, section, venvPath: v.dir, error: v.error,
            noteZh: '完成记录已清除，但环境目录没有删掉；按提示处理后重试。',
          })
          return
        }
        json(res, 200, { ok: true, id, section, venvRemoved: v.removed === true, venvPath: v.dir })
        return
      }
      if (body.removeWeights === true && (section === 'models' || section === 'all')) {
        const w = removeWeightsDir(root, id, dir)
        if (!w.ok) {
          json(res, 500, {
            ok: false, code: w.code, id, section, weightsPath: w.rel, error: w.error,
            noteZh: '下载记录已清除，但权重目录没有删掉；按提示处理后重试。',
          })
          return
        }
        json(res, 200, { ok: true, id, section, weightsRemoved: w.removed === true, weightsPath: w.rel })
        return
      }
      json(res, 200, { ok: true, id, section, venvRemoved: false, weightsRemoved: false })
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
  handleDownloadManifest, handleDownloadFile, handleDownloadUrl, handleDownloadCancel, handleRunScript, handleHfToken,
  handleDownloadEntries, handleEngineDownload,
  scanDocDownloadCommands,
  handleVerifyChecks, handleVerifyMeasure, handleVerifyMeasureProgress, handleVerifyMeasureCancel, handleVerifyRef, handleVerify, handleVerifyAudio, handleProfile, handleParams, handleCliArgs,
  handleDiscover,
  handleInstallState, handleResetProgress, handleCloneCancel, handleCloneRemove, handleEnvCancel,
  // 这两个导出给测试：第 3 步「上游自己的下载方式」全靠它们，
  //   让守卫测试能直接验证「拆成三段 + 不猜」。
  extractDownloadCommands, extractRepoLinks, parseDownloadCmd, snapshotSourceOf,
  buildEngineDownloadEntries, expandEngineArgv, scanEngineScriptCandidates, scanRuntimeDownloads,
  // 导给守卫测试：包名兜底链的两个函数。packageDirsFromEntries 是纯函数可直接验，
  //   listPackageDirs 走网络，只验它「三个分支都失败时返回空数组、不打 refute」。
  packageDirsFromEntries, listPackageDirs,
  // 导给守卫测试：async handler 挂死这条回归要直接验证它回的是合法 JSON。
  respondSafely,
  // 导给守卫测试：分支探测的缓存命中路径要能直接验（命中与未命中必须同形状）。
  __test__: { readDefaultBranch, resolveProbeBranch, _branchCache, githubHeaders },
}
