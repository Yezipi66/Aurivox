// 第 3 步的下载来源判定：一条下载命令的文件该去 HF 还是魔搭（ModelScope）下。
//
// 显示命令、列清单、清单逐行回写的 tool 都从 sourceOf 取，
//   三处各写一份判据的话，snapshot_download 会出现「显示魔搭、清单列 HF、下载去 HF」。
// 后端 core/download.js 的 normalizeSource 认同样的两个值；认不出的一律不下载。
//
// Node 的 ESM 解析器要求带扩展名，本文件不引入别的模块，测试可以直接 import。

export const SOURCES = Object.freeze(['hf', 'modelscope'])

export const SOURCE_LABELS = Object.freeze({
  hf: { en: 'Hugging Face', zh: 'Hugging Face' },
  modelscope: { en: 'ModelScope', zh: '魔搭（ModelScope）' },
})

/** 使用者手选来源时用的键：同一个仓库在不同命令形态下是两条命令，各选各的。 */
export function choiceKey (c) {
  return `${(c && c.tool) || ''}|${(c && c.repo) || ''}`
}

/**
 * 一条下载命令的来源。
 *   hf / modelscope 两种 CLI 自带来源；snapshot_download 用后端探测时按 import 判出的 source。
 *   判不出（source 为 unknown 或缺失）时看使用者有没有手选过；都没有就是 'unknown'，
 *   界面据此让使用者选，不默认成任何一边。
 *
 * @param {{tool?:string, source?:string, repo?:string}} c 探测给出的命令
 * @param {Object<string,string>} [choices] 使用者手选的来源，键见 choiceKey
 * @returns {'hf'|'modelscope'|'unknown'}
 */
export function sourceOf (c, choices) {
  if (!c) return 'unknown'
  if (SOURCES.includes(c.source)) return c.source
  if (c.tool === 'hf' || c.tool === 'modelscope') return c.tool
  const picked = choices && choices[choiceKey(c)]
  return SOURCES.includes(picked) ? picked : 'unknown'
}

/**
 * 上游那条命令把模型放进了 checkpoints 下的哪一层。
 *   README 常写 `--local-dir checkpoints/s2-pro`（同一个父目录里并排放几个模型）。
 *   返回值是 checkpoints 之后的相对路径；没有这一层就是空串。
 *   带 .. 或盘符的一律当没有：不让下载把文件写到别处。
 */
export function subdirOf (c) {
  const raw = String((c && c.dir) || '').replace(/\\/g, '/')
  const parts = raw.split('/').filter((s) => s && s !== '.' && s !== './')
  const at = parts.indexOf('checkpoints')
  if (at < 0) return ''
  const tail = parts.slice(at + 1)
  if (tail.some((s) => s === '..' || /^[A-Za-z]:/.test(s))) return ''
  return tail.join('/')
}

/**
 * 给使用者看的命令。按 sourceOf 判出的来源写 import，来源未知时原样显示上游那一行。
 *
 * @returns {{display: string, source: string}}
 */
export function buildCommand (c, choices) {
  const source = sourceOf(c, choices)
  const repo = (c && c.repo) || ''
  const sub = subdirOf(c)
  const dest = sub ? `checkpoints/${sub}` : 'checkpoints'
  if (c && c.tool === 'snapshot') {
    if (source === 'unknown') return { display: c.raw || `snapshot_download('${repo}')`, source }
    const lib = source === 'modelscope' ? 'modelscope' : 'huggingface_hub'
    return {
      display: `python -c "from ${lib} import snapshot_download; snapshot_download('${repo}', local_dir='${dest}')"`,
      source,
    }
  }
  if (source === 'modelscope') {
    return { display: `modelscope download --model ${repo} --local_dir ${dest}`, source }
  }
  if (source === 'hf') {
    return { display: `hf download ${repo} --local-dir=${dest}`, source }
  }
  return { display: (c && c.raw) || repo, source }
}

// 模型页链接有固定形状，认出来就能当一个仓库用，不必再让人补一条下载命令。
// 与后端 extractRepoLinks 同一口径：只认 URL 形状，不判断链接里装的是不是权重。
const REPO_LINK_SKIP = new Set(['spaces', 'datasets', 'docs', 'api', 'blog', 'models',
  'collections', 'tasks', 'join', 'settings', 'organizations', 'login', 'pricing',
  'inference-endpoints', 'studios', 'studies'])

/**
 * 把一条 URL 解析成模型仓库。认不出（单文件直链、其它站点、非模型页）返回 null，
 * 由调用方按单文件下载处理。
 *
 * @param {string} raw
 * @returns {{tool:string, repo:string, url:string}|null}
 */
export function repoLinkFromUrl (raw) {
  let u = null
  try { u = new URL(String(raw || '').trim()) } catch (e) { return null }
  if (!['http:', 'https:'].includes(u.protocol)) return null
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const parts = u.pathname.split('/').filter(Boolean)
  let tool = null
  let repo = null
  if (host === 'huggingface.co') {
    if (parts.length < 2 || REPO_LINK_SKIP.has(parts[0].toLowerCase())) return null
    tool = 'hf'
    repo = `${parts[0]}/${parts[1]}`
  } else if (host === 'modelscope.cn') {
    if (parts.length < 3 || parts[0].toLowerCase() !== 'models') return null
    if (REPO_LINK_SKIP.has(parts[1].toLowerCase())) return null
    tool = 'modelscope'
    repo = `${parts[1]}/${parts[2]}`
  } else return null
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null
  return {
    tool, repo,
    url: tool === 'hf' ? `https://huggingface.co/${repo}` : `https://modelscope.cn/models/${repo}`,
  }
}

/** 仓库网页地址：表格里的仓库列与授权提示里的链接用它。来源未知时返回 null。 */
export function repoPageUrl (source, repo) {
  if (!repo) return null
  if (source === 'modelscope') return `https://modelscope.cn/models/${repo}`
  if (source === 'hf') return `https://huggingface.co/${repo}`
  return null
}
