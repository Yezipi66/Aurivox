'use strict'
//  RESOLVE：第 1 步：GitHub 链接 → engines/<id> 的 id
//  平台对「id」有硬约束：registry.js:83 跳过 `_`/`.` 开头；registry.js:59 要求 id 与目录名逐字相同。
//  只做解析和校验，不下载、不克隆、不猜。

const path = require('node:path')
const PLATFORM_NAMES = new Set([
  'engines', 'models', 'lib', 'web', 'pipeline', 'tools', 'docs', 'data', 'vendor',
  'server.js', 'package.json', 'package-lock.json', 'README.md', 'LICENSE',
  'NOTICE', 'requirements.txt', 'requirements-platform.txt',
  'start.bat', 'stop.bat', 'deploy.bat', 'bootstrap.ps1', 'start.ps1',
  '.env.example', '.gitattributes', '.gitignore',
  'state', 'assets', 'outputs', 'logs', 'venv',
])

const RESERVED_PREFIXES = ['_', '.']

const ILLEGAL_IN_DIRNAME = /[\\/:*?"<>|]/

/**
 * 解析 GitHub 链接。只接受能唯一定位一个仓库的形式。
 *
 * @param {string} input 用户粘进来的东西
 * @returns {{ok:true, owner:string, repo:string, url:string}
 *          | {ok:false, code:string, params?:object, error:string, example?:string}
 */
/** 从输入里取出主机名：报错文案要指名道姓说「gitlab.com 请换成 GitHub」。 */
function hostOf (raw) {
  const m = String(raw || '').match(/^[a-z]+:\/\/([^/?#]+)/i)
  return m ? m[1] : ''
}

function parseRepoUrl (input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) {
    return {
      ok: false, code: 'EMPTY_LINK',
      error: 'No link entered yet.', errorZh: '还没填链接。',
      example: 'https://github.com/owner/name',
    }
  }

  let rest = raw
  const m = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i)
  if (m) rest = m[1]
  else if (/^[\w.-]+\/[\w.-]+(?:\/.*)?$/.test(raw)) rest = raw  // owner/repo[/tree/..]
  else if (/^[\w.-]+$/.test(raw)) {
    return {
      ok: false, code: 'NO_OWNER',
      error: 'Repository name is missing. Use github.com/OWNER/REPO.', errorZh: '还缺仓库名。链接要写成 github.com/用户名/仓库名',
      params: { host: 'github.com' },
      example: 'https://github.com/owner/name',
    }
  } else {
    return {
      ok: false, code: 'NOT_GITHUB',
      error: `Only GitHub links are supported for now. ${hostOf(raw)} \u2014 use a GitHub repository URL.`,
    errorZh: `还只支持 GitHub 链接。${hostOf(raw)} 请换成 GitHub 上的仓库地址。`,
      params: { host: hostOf(raw) },
      example: 'https://github.com/owner/name',
    }
  }

  // 去掉 GitHub 特有的一切尾巴：/tree/main、/blob/xxx、?tab=readme、#anchor
  const parts = rest.split(/[?#]/)[0].split('/').filter(Boolean)
  if (parts.length < 2) {
    return {
      ok: false, code: 'NO_REPO',
      error: `The link only has an owner ("${parts[0] || ''}") and no repository. Use github.com/OWNER/REPO.`,
    errorZh: `链接里只有用户名 "${parts[0] || ''}"，缺仓库名。正确写法：github.com/用户名/仓库名`,
      params: { owner: parts[0] || '' },
      example: 'https://github.com/owner/name',
    }
  }
  const [owner, repoWithSuffix] = parts
  // 剥掉 .git 后缀：探测要读 <repo>/main/pyproject.toml，带后缀会 404。
  const repo = repoWithSuffix.replace(/\.git$/i, '')
  if (!repo) {
    return { ok: false, code: 'NO_REPO',
      error: 'The repository name is empty \u2014 something must come before ".git".', errorZh: '仓库名是空的，".git" 前面要有名字。',
      example: 'https://github.com/owner/name' }
  }
  // 剥掉 /tree/<branch>、/blob/<path> 等尾巴，只留仓库根。
  // 尾段取首词查清单：GitHub 尾段多为复数（/pulls/issues），用 \b 匹配不到。
  // GitHub 上「不是仓库根」的路径首词（照 github.com 的 URL 约定）
  const TAIL_FIRST_WORD = new Set([
    'tree', 'blob', 'commit', 'commits', 'compare', 'blame',
    'releases', 'release', 'tag', 'tags',
    'issues', 'issue', 'pulls', 'pull', 'pullrequest',
    'wiki', 'actions', 'graph', 'network', 'security',
    'discussions', 'stargazers', 'forks', 'watching',
    'settings', 'projects', 'releases', 'codespaces',
  ])

  let trimmed = null
  if (parts.length > 2) {
    const head = parts[2].toLowerCase()
    if (TAIL_FIRST_WORD.has(head)) {
      trimmed = parts.slice(2).join('/')
      parts.length = 2
    } else {
      return {
        ok: false, code: 'UNKNOWN_TAIL',
        error: `The "${parts[2]}" part of the link is not recognised. Paste the repository home URL.`,
    errorZh: `无法识别链接里的 "${parts[2]}"。请贴仓库首页的地址。`,
        params: { tail: parts[2] },
        example: `https://github.com/${owner}/${repo}`,
      }
    }
  }

  const out = {
    ok: true,
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
  }
  if (trimmed) {
    out.normalizedFrom = raw
    out.trimmedTail = trimmed
    // 归一化告知走 code + params，不拼中文句子（i18n 契约）。
    out.noteCode = 'TRIMMED_TAIL'
    out.noteParams = { tail: trimmed }
  }
  return out
}

/**
 * 从仓库名猜一个 id：**只是建议**，必须让用户确认。
 *
 * 为什么要猜：用户手里只有一个链接，让他在这一步再想「叫什么名字」
 * 是凭空多一道坎。但这不代表平台替他决定：他可以改。
 *
 * 规则只有一条：仓库名去掉 `.git` 后缀、压成合法目录名。
 * **不改大小写风格、不加前缀、不做去重**，
 *   那些都是产品决定，而 id 一旦落盘就是长期事实。
 */
function suggestId (repo) {
  if (typeof repo !== 'string') return null
  let s = repo.trim().replace(/\.git$/i, '')
  if (!s) return null
  s = s.replace(ILLEGAL_IN_DIRNAME, '-')       // 非法字符 → 连字符
  return s
}

/**
 * 校验一个 id 能不能当目录名：判据照 registry.js 的实际规则，不自己发明。
 */
function validateId (id) {
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, code: 'EMPTY', error: 'Directory name cannot be empty.', errorZh: '目录名不能为空。' }
  }
  const s = id.trim()
  if (s !== id) {
    return { ok: false, code: 'WHITESPACE',
      error: 'The directory name has surrounding whitespace; it must match the folder name exactly.', errorZh: '目录名前后有空格，必须和文件夹名完全一致。' }
  }
  for (const p of RESERVED_PREFIXES) {
    if (s.startsWith(p)) {
      return { ok: false, code: 'RESERVED_PREFIX',
        error: `The directory name must not start with "${p}".`, errorZh: `目录名不能以 "${p}" 开头。`,
        params: { prefix: p } }
    }
  }
  if (ILLEGAL_IN_DIRNAME.test(s)) {
    return { ok: false, code: 'ILLEGAL_CHAR',
      error: 'The directory name contains characters that cannot be used in folder names: \\ / : * ? " < > |', errorZh: '目录名含有不能放进文件夹名的字符：\\ / : * ? " < > |',
      params: { chars: '\\ / : * ? " < > |' } }
  }
  if (PLATFORM_NAMES.has(s)) {
    return { ok: false, code: 'RESERVED_NAME',
      error: `"${s}" is a name reserved by the platform; choose another.`, errorZh: `"${s}" 是平台保留的目录名，换一个。`,
      params: { name: s } }
  }
  return { ok: true, id: s }
}

/**
 * 主入口：链接 + 可选的 id → 全部就绪的一组值。
 *
 * @param {{url:string, id?:string}} input
 * @returns {{ok:true, owner, repo, cloneUrl, id, idSuggested}
 *          |{ok:false, code, error, example?}}
 */
function resolveEngine (input = {}) {
  const parsed = parseRepoUrl(input.url)
  if (!parsed.ok) return parsed

  const suggested = suggestId(parsed.repo)
  const given = input.id
  const idToCheck = (typeof given === 'string' && given.trim()) ? given.trim() : suggested
  const checked = validateId(idToCheck)
  if (!checked.ok) {
    return { ...checked, owner: parsed.owner, repo: parsed.repo,
      idSuggested: suggested }
  }

  return {
    ok: true,
    owner: parsed.owner,
    repo: parsed.repo,
    url: parsed.url,
    // cloneUrl 用 .git 后缀：GitHub 的裸链接对某些传输不友好
    cloneUrl: `${parsed.url}.git`,
    id: checked.id,
    idSuggested: suggested,
    normalizedFrom: parsed.normalizedFrom || null,
    trimmedTail: parsed.trimmedTail || null,
    noteCode: parsed.noteCode || null,
    noteParams: parsed.noteParams || null,
    // 用户自己填了 id 就说明他做过了决定：界面上不必再提示
    idConfirmed: typeof given === 'string' && given.trim() !== '' && given.trim() !== suggested,
    targetDir: null,
    // 给 engines 根的绝对路径 + 分隔符：前端 `enginesDir + sep + 目录名` ⇒ 实时、同源、跨平台。
    enginesDir: enginesDirOf(),
    pathSep: path.sep,
  }
}

/** engines 目录的绝对路径：拿不到就让前端不显示路径，绝不显示猜的/错的。 */
function enginesDirOf () {
  try {
    const { projectRoot } = require('./clone')
    const root = projectRoot()
    return root ? path.join(root, 'engines') : null
  } catch (e) {
    return null
  }
}

module.exports = { parseRepoUrl, suggestId, validateId, resolveEngine, ILLEGAL_IN_DIRNAME }