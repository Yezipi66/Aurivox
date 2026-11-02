// 「引擎配置」那一段的清单与纯函数（OptionalConfig.jsx 渲染；文件名不叫 optionalConfig.js，大小写不敏感的文件系统上会和组件撞名，可单独测）。
//
// 每一项缺着时平台都有答案（两侧兜底，见 lib/engines/profile.js 的 DEFAULTS）。
// 写了数就必须写出处（平台 checkMeasuredSources 的规矩）：添加时出处先记 estimated。
// 第 5 步试运行不改这里：量到的两项超时只存在本机（lib/engines/localTimings.js），
// 名片里写的值原样留着，平台在本机上按本机的值用。

// 不填时平台的答案。数值与 lib/engines/profile.js 的 DEFAULTS 一致（有守卫测试钉住）。
export const PLATFORM_DEFAULTS = Object.freeze({
  timeout_ms: 300000,
  max_chars: 50,
  ready_timeout_ms: 240000,
})

// 平台通用宿主的启动脚本（与 lib/engines/profile.js 的 isSharedHost 同一判据）。
export const SHARED_HOST_RE = /(^|[\\/])lib[\\/]engines[\\/]host\.py$/

// 启动两件套的惯例值：环境目录与第 2 步建环境的推导同款，启动脚本是平台通用宿主。
export function launchConventions (id) {
  return {
    python: `engines/${id}/.venv`,
    entry: '../../lib/engines/host.py',
  }
}

// 给名片的 runtime 打补丁：空串与 undefined 视为删除，删光了整段去掉。纯函数，基于传入的最新名片。
export function withRuntimePatch (manifest, patch) {
  const cur = manifest || {}
  const next = { ...(cur.runtime || {}), ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k]
  const out = { ...cur, runtime: Object.keys(next).length ? next : undefined }
  if (out.runtime === undefined) delete out.runtime
  return out
}

// 引擎目录与启动脚本两格都没写 ⇒ 填惯例值；写过任何一格 ⇒ 原样返回同一个对象（不触发重渲染）。
export function withLaunchConventions (manifest, conv) {
  const rt = (manifest && manifest.runtime) || {}
  if (!conv || rt.python !== undefined || rt.entry !== undefined) return manifest
  return withRuntimePatch(manifest, { python: conv.python, entry: conv.entry })
}

export function get (obj, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

// path 名片键路径；kind 控件；source 出处键（写了数就得写）；fallback 不填时平台怎么办。
export const OPTIONAL_KEYS = [
  { path: 'max_chars', kind: 'number', source: 'max_chars_source',
    en: 'Longest text per request', zh: '单次请求最长字符数',
    fallbackEn: `default ${PLATFORM_DEFAULTS.max_chars}`, fallbackZh: `默认 ${PLATFORM_DEFAULTS.max_chars}` },
  { path: 'timeout_ms', kind: 'number', source: 'timeout_ms_source',
    en: 'Request timeout (ms)', zh: '单次请求超时（毫秒）',
    fallbackEn: `default ${PLATFORM_DEFAULTS.timeout_ms}`, fallbackZh: `默认 ${PLATFORM_DEFAULTS.timeout_ms}` },
  { path: 'runtime.ready_timeout_ms', kind: 'number', source: 'runtime.ready_timeout_ms_source',
    en: 'Ready timeout (ms)', zh: '就绪等待（毫秒）',
    fallbackEn: `default ${PLATFORM_DEFAULTS.ready_timeout_ms}`, fallbackZh: `默认 ${PLATFORM_DEFAULTS.ready_timeout_ms}` },
  { path: 'runtime.ready_endpoint', kind: 'text',
    en: 'Ready endpoint', zh: '就绪端点',
    fallbackEn: '/health with the shared host', fallbackZh: '通用宿主默认 /health' },
  { path: 'capabilities.requires_reference_audio', kind: 'bool',
    en: 'Needs reference audio', zh: '是否需要参考音频',
    fallbackEn: 'yes', fallbackZh: '是',
    // 界面预填「是」：多数开源 TTS 是零样本。这只是通用判断，不表示平台能识别这台引擎。
    defaultKind: 'prefill',
    hintEn: 'Defaults to "yes" (applies to most zero-shot TTS); confirm against the engine docs if unsure.',
    hintZh: '此处默认填「是」（多数零样本 TTS 适用）；是否适用请按引擎说明确认。',
    ctrlTitleEn: 'Written into the file. Left unset, the wizard prefills yes for a new engine.',
    ctrlTitleZh: '这个值会写进文件。新建引擎时向导预填「是」。' },
  { path: 'capabilities.reference_clip_seconds', kind: 'range',
    en: 'Reference audio duration (s)', zh: '参考音频时长（秒）',
    fallbackEn: 'no limit', fallbackZh: '不限制',
    hintEn: 'blank means no limit', hintZh: '留空默认无限制',
    // 这一项的提示说明「为什么值得填」：不填时平台不拦，填了才拦。
    noteEn: 'A longer reference recording means slower feature extraction, higher memory usage, and a longer wait for the first audio byte.',
    noteZh: '参考音频越长，特征提取越慢，内存占用越高，首字节延迟也越高。' },
  // 默认是常量别名：不填这个键就是 file（hostProfile.js 里 call.returns 缺省为 'file'），所以 file 这条直接标「（默认）」，
  //   不单列一条「不填」；选它即不填这个键。
  { path: 'call.returns', kind: 'select', options: ['file', 'bytes', 'generator'], defaultValue: 'file',
    defaultKind: 'constant',
    en: 'How the engine returns audio', zh: '音频返回方式',
    fallbackEn: 'writes a file', fallbackZh: '写成文件',
    ctrlTitleEn: 'Left out, the platform always writes the result to a file. Choosing this entry leaves the key out.',
    ctrlTitleZh: '不填这个键时，平台固定按「写成文件」处理，结果写到输出文件。选这一项就是不填。',
    optionLabels: {
      file: { en: 'writes a file (default)', zh: '写成文件（默认）' },
      bytes: { en: 'returns bytes', zh: '返回字节' },
      generator: { en: 'yields chunks', zh: '逐块生成' },
    } },
  { path: 'call.generator_sample_rate', kind: 'number', when: (m) => get(m, 'call.returns') === 'generator',
    en: 'Generator sample rate (Hz)', zh: '生成器采样率（Hz）',
    fallbackEn: 'required for generator output', fallbackZh: '生成器形态必填' },
  { path: 'runtime.args', kind: 'list',
    en: 'Extra start arguments', zh: '额外启动参数',
    fallbackEn: 'shared host: --profile-json / --host / --port', fallbackZh: '通用宿主默认 --profile-json / --host / --port' },
  // 不填时就是平台安装目录（即项目根）。只有引擎自己的资产按它目录解路径时才需要填 engines/<id>。
  // 证据：envCheck.js 的 checkEngineEnvShallow()、spawnEngine.js 的 spawnFromPlan()、launchPlan.js 的 buildLaunchPlan() 均以平台安装目录（项目根）作为默认 rootDir。
  { path: 'runtime.cwd', kind: 'text',
    en: 'Working directory', zh: '工作目录',
    fallbackEn: 'project root', fallbackZh: '项目根',
    hintEn: 'project root; absolute paths work', hintZh: '相对项目根，可填绝对路径',
  },
  { path: 'call.init_args', kind: 'json',
    en: 'Constructor arguments', zh: '构造参数',
    fallbackEn: 'none', fallbackZh: '无',
    hintEn: 'only when the engine class needs it', hintZh: '仅当引擎类构造函数需要时填写',
  },
]

export const SOURCES = ['estimated', 'measured', 'upstream']

// 按键路径写一个值；undefined = 删掉这个键，删空的段一并删掉。原对象不动。
export function setPath (obj, keyPath, value) {
  const keys = keyPath.split('.')
  const root = { ...(obj || {}) }
  let cur = root
  const chain = [root]
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = { ...(cur[keys[i]] || {}) }
    cur = cur[keys[i]]
    chain.push(cur)
  }
  const last = keys[keys.length - 1]
  if (value === undefined) delete cur[last]
  else cur[last] = value
  for (let i = keys.length - 2; i >= 0; i--) {
    const parent = chain[i]
    if (parent[keys[i]] && Object.keys(parent[keys[i]]).length === 0) delete parent[keys[i]]
  }
  return root
}

// 这一项该不该显示成一行：写了值就显示；
// 就绪端点在启动脚本不是通用宿主时平台答不出，生成器采样率在生成器形态下必填，这两种也显示。
export function rowVisible (m, item) {
  if (item.when && !item.when(m)) return false
  if (get(m, item.path) !== undefined) return true
  if (item.path === 'runtime.ready_endpoint') {
    const entry = get(m, 'runtime.entry')
    return !!entry && !SHARED_HOST_RE.test(entry)
  }
  if (item.path === 'call.generator_sample_rate') return true
  return false
}

// 添加一项时写进名片的起始值。
function initialValue (item) {
  if (item.kind === 'number') {
    const k = item.path.split('.').pop()
    return PLATFORM_DEFAULTS[k] !== undefined ? PLATFORM_DEFAULTS[k] : 24000
  }
  if (item.kind === 'bool') return true
  // 时长区间默认不限制：这一项缺着时平台不检查，填了才拦。
  // 起点值不许写死某台引擎的范围（某台引擎的区间是它自己的约束，不是通用默认）。
  if (item.kind === 'range') return null
  if (item.kind === 'select') return item.options[0]
  if (item.kind === 'list') return []
  if (item.kind === 'json') return {}
  if (item.path === 'runtime.ready_endpoint') return '/health'
  return ''
}

// 参考音频这一项新建时预填「是」并真写进文件（多数零样本 TTS 需要参考音频）。
export function prefillReferenceAudio (m) {
  const caps = m && typeof m.capabilities === 'object' && m.capabilities ? m.capabilities : null
  if (caps && 'requires_reference_audio' in caps) return m
  return setPath(m, 'capabilities.requires_reference_audio', true)
}
export function addItem (m, item) {
  let next = setPath(m, item.path, initialValue(item))
  if (item.source && get(next, item.source) === undefined) next = setPath(next, item.source, 'estimated')
  return next
}

export function removeItem (m, item) {
  let next = setPath(m, item.path, undefined)
  if (item.source) next = setPath(next, item.source, undefined)
  return next
}

// 平台替名片答了的那几项（lib/engines/profile.js 产出的 profile.defaulted），
//   且表单里此刻也没写：界面给它们挂「默认」。defaulted 是盘上这张名片的读数，
//   表单里已经写了值的以表单为准，不再算平台兜底。
export function platformDefaultedRows (m, defaulted) {
  const set = new Set(Array.isArray(defaulted) ? defaulted : [])
  return OPTIONAL_KEYS.filter((it) => set.has(it.path) && get(m, it.path) === undefined)
}

// 本机上第 5 步试运行量过的那几项（profile.value_sources 里记成 local 的）：
//   不在名片里、不算平台兜底，界面单独挂「本机测得」，并说明它在本机优先于名片。
//   表单里写没写都列出来：名片写了也照样被本机的值盖过，要让人看见。
export function localMeasuredRows (sources) {
  const src = sources && typeof sources === 'object' ? sources : {}
  return OPTIONAL_KEYS.filter((it) => src[it.path] === 'local')
}
