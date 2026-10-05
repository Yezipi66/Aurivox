'use strict'
// ============================================================================
//  RESOLVE —— 第 1 步：GitHub 链接 → engines/<id> 的 id
//
//  ⭐ 为什么它存在
//  平台对「id」有硬约束，而且是**已存在的**：
//  · registry.js:83 —— `_` 或 `.` 开头的目录被跳过（那是模板，不是引擎）
//  · registry.js:59 —— manifest.json 里的 id 必须与目录名**逐字相同**
//    否则报 ENGINE_MANIFEST_ID_MISMATCH
//  ⇒ 所以 id 一旦定错，后面每一步都在错的目录上干活。
//
//  ⛔⛔ 这个函数只做两件事：**解析** 和 **校验**。
//  它不下载、不克隆、不猜 —— 猜错的表现是「装了一半才发现目录名不对」。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

// ⛔ 平台自己的顶层目录/文件名 —— 取自 docs/ROOT_LAYOUT.md 的准入表。
// 拿来当引擎 id = 在项目的关键路径上放一个「引擎目录」，后果难查。
const path = require('node:path')
const PLATFORM_NAMES = new Set([
  'engines', 'models', 'lib', 'web', 'pipeline', 'tools', 'docs', 'data', 'vendor',
  'server.js', 'package.json', 'package-lock.json', 'README.md', 'LICENSE',
  'NOTICE', 'requirements.txt', 'requirements-platform.txt',
  'start.bat', 'stop.bat', 'deploy.bat', 'bootstrap.ps1', 'start.ps1',
  '.env.example', '.gitattributes', '.gitignore',
  'state', 'assets', 'outputs', 'logs', 'venv',
])

// ⛔ 平台的保留前缀（registry.js:83：`_` / `.` 开头不是引擎）
const RESERVED_PREFIXES = ['_', '.']

/** 平台对文件夹名的真实限制：Windows 不允许这些字符 */
const ILLEGAL_IN_DIRNAME = /[\\/:*?"<>|]/

/**
 * 解析 GitHub 链接。⛔ 只接受能唯一定位一个仓库的形式。
 *
 * @param {string} input 用户粘进来的东西
 * @returns {{ok:true, owner:string, repo:string, url:string}
 *          | {ok:false, code:string, params?:object, error:string, example?:string}
 *
 *  ⭐⭐⭐ i18n 契约（2026-10-05 Owner：「这一句话没有做 i18n」）：
 *   ⛔⛔ **不要在后端拼中文句子**。后端只回 `code` + `params`，
 *      文案由前端 `t(en, zh)` 查表 —— 这是全项目唯一的做法。
 *      之前这里直接吐 '⛔ 只认 GitHub 链接。别的主机得问过才知道怎么拉，平台不替你猜。'
 *      ⇒ 前端 {res.error} 原样渲染 ⇒ ⛔ 切英文仍然是中文。
 *      ⛔ 而且那句话把**内部裁决**讲给用户听（"平台不替你猜"是设计原则，
 *         用户不关心）—— 那是写给自己看的，不是界面文案。
 *   ✅ 每个 error 都必须：① 有 code ② 文案只说「怎么做」③ 中文短语可被测试引用
 */
/** 从输入里取出主机名 —— 报错文案要指名道姓说「gitlab.com 请换成 GitHub」，
 *  不能只说「不是 GitHub」让用户自己猜（Owner 2026-10-05：用词要能直接变成动作）。 */
function hostOf (raw) {
  const m = String(raw || '').match(/^[a-z]+:\/\/([^/?#]+)/i)
  return m ? m[1] : ''
}

function parseRepoUrl (input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) {
    return {
      ok: false, code: 'EMPTY_LINK',
      error: '还没填链接。',
      example: 'https://github.com/owner/name',
    }
  }

  // 只收 GitHub —— ⛔ 不猜「可能是 GitLab/Gitee」
  // 那是个该问的问题，不是该猜的（【台账:44】猜错的表现是装了一半才炸）。
  let rest = raw
  const m = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i)
  if (m) rest = m[1]
  else if (/^[\w.-]+\/[\w.-]+(?:\/.*)?$/.test(raw)) rest = raw  // owner/repo[/tree/..]
  else if (/^[\w.-]+$/.test(raw)) {
    return {
      ok: false, code: 'NO_OWNER',
      error: '还缺仓库名。链接要写成 github.com/用户名/仓库名',
      params: { host: 'github.com' },
      example: 'https://github.com/owner/name',
    }
  } else {
    return {
      ok: false, code: 'NOT_GITHUB',
      // ⛔⛔ 原文案（2026-10-05 Owner 驳回）：
      //   '⛔ 只认 GitHub 链接。别的主机得问过才知道怎么拉，平台不替你猜。'
      //   两个毛病：① ⛔「平台不替你猜」是把**内部裁决**讲给用户听，
      //      用户不关心我们为什么这么设计，他只想知道该怎么填；
      //   ② ⛔ 硬编码中文 ⇒ 切英文仍然是中文。
      // ✅ 现在：⛔ 不解释原因，⛔ 只说「改成这样填」。
      error: `还只支持 GitHub 链接。${hostOf(raw)} 请换成 GitHub 上的仓库地址。`,
      params: { host: hostOf(raw) },
      example: 'https://github.com/owner/name',
    }
  }

  // ⛔ 去掉 GitHub 特有的一切尾巴：/tree/main、/blob/xxx、?tab=readme、#anchor
  const parts = rest.split(/[?#]/)[0].split('/').filter(Boolean)
  if (parts.length < 2) {
    return {
      ok: false, code: 'NO_REPO',
      error: `链接里只有用户名 "${parts[0] || ''}"，缺仓库名。正确写法：github.com/用户名/仓库名`,
      params: { owner: parts[0] || '' },
      example: 'https://github.com/owner/name',
    }
  }
  const [owner, repoWithSuffix] = parts
  // ⛔ 剥掉 .git 后缀 —— cloneUrl 一定带它（git clone 需要），
  //   但探测要读的是 <repo>/main/pyproject.toml，用带后缀的名字会全 404。
  //   （2026-10-04 实测：界面把 cloneUrl 传给探测端点 ⇒ 显示「没找到依赖清单」，
  //     而端点直接调是好的 —— 差别就在这个后缀。）
  const repo = repoWithSuffix.replace(/\.git$/i, '')
  if (!repo) {
    return { ok: false, code: 'NO_REPO',
      error: '仓库名是空的，".git" 前面要有名字。',
      example: 'https://github.com/owner/name' }
  }
  // ─────────────────────────────────────────────────────────────
  // ⭐ 归一化：Owner 2026-10-04 提的那条
  //   「一般的 Github 链接都是 https://github.com/owner/name/tree/main
  //     这样的，别人可能贪方便就复制下来了」
  //
  // ⛔ 之前这里**拒绝**（NOT_REPO_ROOT）—— 那是把用户的手工活推回给他。
  //   剥掉 /tree/<branch>、/blob/<branch>/<path>、以及 release/tag 路径，
  //   只留仓库根；⭐ 但要**回报剥掉了什么**，用户看得见我们改了他的输入。
  // ─────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────
  // ⭐ 归一化：Owner 2026-10-04 提的那条
  //   「一般的 Github 链接都是 https://github.com/owner/name/tree/main
  //     这样的，别人可能贪方便就复制下来了」
  //
  // ⛔ 之前这里**拒绝**（NOT_REPO_ROOT）—— 那是把用户的手工活推回给他。
  //
  // ⚠⚠ 两次踩过的坑，别再改回去：
  //   ① ⛔ 不要用 \b 做词边界 —— GitHub 尾段大多是复数（pulls/issues/actions），
  //      /pull\b/ 匹配不到 /pulls/。⇒ 改成「取首词，查清单」。
  //   ② ⛔ 别要求尾段后面必须还有 '/' —— /pulls 和 /releases 整个尾段就一个词。
  // ─────────────────────────────────────────────────────────────
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
      // ⛔ 认不出来的（拼错、别的结构）如实说，⛔ 不静默吞掉
      return {
        ok: false, code: 'UNKNOWN_TAIL',
        error: `无法识别链接里的 "${parts[2]}"。请贴仓库首页的地址。`,
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
  // ⭐ 剥掉了什么就说出来 —— 用户有权知道我们动过他的输入
  if (trimmed) {
    out.normalizedFrom = raw
    out.trimmedTail = trimmed
    // ⚠ 2026-10-05 Owner：「你这一句话没有做 i18n」⇒ ⛔ 后端不再拼中文句子。
    //   ⭐ 只回 code + params，文案归前端 t(en,zh)（StepPrepare 的 ERR_TEXT 同款表）。
    //   ⛔ 原文案：「已把链接末尾的 /tree/main 去掉，只用仓库根 —— 克隆要的是整个仓库…」
    //      —— 那是在解释我们的做法；用户只需要知道「我们改了什么、为什么」。
    out.noteCode = 'TRIMMED_TAIL'
    out.noteParams = { tail: trimmed }
  }
  // ⭐⭐⭐ **目标目录的完整绝对路径**（2026-10-05 Owner 要文案里出现真实路径）
  //
  // ⛔⛔ 前端曾经自己拼：window.location.pathname 撕 + 硬编码 '/' 分隔符 ——
  //   ⛔ 那是**错的**：Windows 上路径是 D:\Project\...，拼出来根本不对；
  //   ⛔ 而且硬编码 '/' 在 Linux/mac 上才对、Windows 上错 ⇒ 跨平台不兼容。
  //   ⛔ 更根本：前端根本不该知道文件系统长什么样。
  // ✅ 权威在 clone.js 的 engineDir()（它走 lib/paths.js 的 ENGINES_DIR，
  //   且支持 AURIVOX_APP_DIR / ENGINES_DIR 环境变量覆盖 ——
  //   打包分发时目录可能被挪到别处，只有后端算得对）。
  // ⚠ 2026-10-05：这里原来还有一段「算 targetDir」的代码，是**死代码** ——
  //   parseRepoUrl 阶段 out.id 还不存在（id 在 resolveEngine 里由
  //   suggestId/validateId 算出来），所以 validateId('') 永远失败。
  //   ⛔ 而且 resolveEngine 已经用 enginesDir + pathSep 给出了正确的路径，
  //   ⛔ 重复计算只会让两份真相分叉。⇒ 整段删掉。
  return out
}

/**
 * 从仓库名猜一个 id —— ⛔ **只是建议**，必须让用户确认。
 *
 * 为什么要猜：用户手里只有一个链接，让他在这一步再想「叫什么名字」
 * 是凭空多一道坎。但这不代表平台替他决定 —— 他可以改。
 *
 * 规则只有一条：仓库名去掉 `.git` 后缀、压成合法目录名。
 * ⛔ **不改大小写风格、不加前缀、不做去重** ——
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
 * 校验一个 id 能不能当目录名 —— ⛔ 判据照 registry.js 的实际规则，不自己发明。
 */
function validateId (id) {
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, code: 'EMPTY', error: '目录名不能为空。' }
  }
  const s = id.trim()
  if (s !== id) {
    return { ok: false, code: 'WHITESPACE',
      error: '目录名前后有空格，必须和文件夹名完全一致。' }
  }
  for (const p of RESERVED_PREFIXES) {
    if (s.startsWith(p)) {
      return { ok: false, code: 'RESERVED_PREFIX',
        error: `目录名不能以 "${p}" 开头。`,
        params: { prefix: p } }
    }
  }
  if (ILLEGAL_IN_DIRNAME.test(s)) {
    return { ok: false, code: 'ILLEGAL_CHAR',
      error: '目录名含有不能放进文件夹名的字符：\\ / : * ? " < > |',
      params: { chars: '\\ / : * ? " < > |' } }
  }
  if (PLATFORM_NAMES.has(s)) {
    return { ok: false, code: 'RESERVED_NAME',
      error: `"${s}" 是平台保留的目录名，换一个。`,
      params: { name: s } }
  }
  return { ok: true, id: s }
}

/**
 * ⭐ 主入口：链接 + 可选的 id → 全部就绪的一组值。
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
    // ⭐ url = **不带 .git** 的仓库根 —— 探测要读
    //   <owner>/<repo>/main/pyproject.toml，用带后缀的名字会全 404
    //   （2026-10-04 实测踩过：第 2 步一直拿不到依赖，因为少了这个字段）
    url: parsed.url,
    // ⛔ cloneUrl 用 .git 后缀 —— GitHub 的裸链接对某些传输不友好
    cloneUrl: `${parsed.url}.git`,
    id: checked.id,
    idSuggested: suggested,
    // ⭐ 归一化信息一并传下去（用户有权知道我们改了他的输入）
    normalizedFrom: parsed.normalizedFrom || null,
    trimmedTail: parsed.trimmedTail || null,
    // ⚠ 2026-10-05 i18n：归一化告知也走 code + params，⛔ 不传中文句子
    noteCode: parsed.noteCode || null,
    noteParams: parsed.noteParams || null,
    // ⭐ 用户自己填了 id 就说明他做过了决定 —— 界面上不必再提示
    idConfirmed: typeof given === 'string' && given.trim() !== '' && given.trim() !== suggested,
    // ⭐⭐⭐ **目标目录的完整绝对路径**（2026-10-05 Owner 要文案里出现真实路径）
    //
    // ⛔⛔ 前端曾经自己拼：拿 window.location.pathname 撕 + 硬编码 '/' 分隔符。
    //   ⛔ 那是**错的**：Windows 上路径是 D:\Project\...，拼出来根本不对；
    //   ⛔ 而且硬编码 '/' 只在 Linux/mac 上成立、Windows 上错 ⇒ **跨平台不兼容**；
    //   ⛔ 更根本：前端根本不该知道文件系统长什么样。
    // ✅ 权威在 clone.js 的 engineDir() —— 它走 lib/paths.js 的 ENGINES_DIR，
    //   支持 AURIVOX_APP_DIR / ENGINES_DIR 环境变量覆盖；
    //   打包分发时目录可能被挪到别处，只有后端算得对。
    //   （lib/paths.js 是全项目目录位置的权威，见它顶部的三条规矩。）
    targetDir: null,  // ⛔ 已改为 enginesDir + pathSep（见下面）
    // ⭐⭐⭐ **engines 目录的绝对路径 + 分隔符**（2026-10-05 Owner 抓到的不一致）
    //
    // ⛔⛔ 为什么不能只回 targetDir：那是**一次解析的快照**。
    //   用户随后改目录名，命令跟着变、文案却停在旧值 ⇒
    //   实测自相矛盾：命令写着新目录名，文案还写着旧的那个。
    //   ⛔ 前端自己拼也错两次：① 拼了就等于把平台假设写死在前端
    //   （Windows 是 \、Linux/mac 是 /）；② 目录名改了还得再发一次请求，
    //   那个空档期就会显示旧的或错的。
    // ✅ 所以给**两样**：engines 根的绝对路径 + 该平台的分隔符。
    //   前端只要 `enginesDir + sep + 目录名` ⇒ **实时、同源、跨平台**。
    enginesDir: enginesDirOf(),
    pathSep: path.sep,
  }
}

/**
 * ⭐ engines 目录的绝对路径（不含引擎 id）—— 权威在 clone.js 的 projectRoot()。
 * ⛔ 故意用 try/catch 包住：拿不到就让前端**不显示路径**，
 *   ⛔ 绝不显示一个猜的/错的路径（Owner：「宁可不显示，也不显示错的」）。
 */
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