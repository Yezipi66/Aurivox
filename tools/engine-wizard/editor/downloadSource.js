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
 * 给使用者看的命令。按 sourceOf 判出的来源写 import，来源未知时原样显示上游那一行。
 *
 * @returns {{display: string, source: string}}
 */
export function buildCommand (c, choices) {
  const source = sourceOf(c, choices)
  const repo = (c && c.repo) || ''
  if (c && c.tool === 'snapshot') {
    if (source === 'unknown') return { display: c.raw || `snapshot_download('${repo}')`, source }
    const lib = source === 'modelscope' ? 'modelscope' : 'huggingface_hub'
    return {
      display: `python -c "from ${lib} import snapshot_download; snapshot_download('${repo}', local_dir='checkpoints')"`,
      source,
    }
  }
  if (source === 'modelscope') {
    return { display: `modelscope download --model ${repo} --local_dir checkpoints`, source }
  }
  if (source === 'hf') {
    return { display: `hf download ${repo} --local-dir=checkpoints`, source }
  }
  return { display: (c && c.raw) || repo, source }
}

/** 仓库网页地址：表格里的仓库列与授权提示里的链接用它。来源未知时返回 null。 */
export function repoPageUrl (source, repo) {
  if (!repo) return null
  if (source === 'modelscope') return `https://modelscope.cn/models/${repo}`
  if (source === 'hf') return `https://huggingface.co/${repo}`
  return null
}
