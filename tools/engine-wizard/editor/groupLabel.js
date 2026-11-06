// 分组名旁边那句中文注。纯函数，单独可测。
//
// 分组名是上游的子命令（`<引擎> synth --text ...` 里的 synth），是命令行上要敲的字，
//   **不能改写**：译成「合成」之后，用户照着界面敲 `<引擎> 合成` 会失败。
//   所以这里只加一层注，形如 `synth（合成）`：原名在前、注在括号里。
// 词表是平台给的释义，不是上游的 help；遇到表里没有的名字就只显示原名，不猜。
//   想少猜一层：给上游提的 help 是可选的下一步，别用同义词硬套。

const GLOSS = {
  '(root)': '顶层（无子命令）',
  synth: '合成语音',
  synthesis: '合成语音',
  infer: '推理',
  inference: '推理',
  generate: '生成',
  tts: '语音合成',
  vc: '音色转换',
  init: '初始化配置',
  config: '配置读写',
  download: '下载权重',
  check: '校验环境与权重',
  preprocess: '预处理',
  train: '训练',
  concat: '拼接音频',
  batch: '批处理',
  serve: '起服务',
  api: '接口服务',
  webui: '图形界面',
  test: '自检',
}

/**
 * 分组名 → 界面上的写法。原名永远在前，注只在括号里；表里没有就原样返回。
 * @param {string} name 上游子命令名，或平台的 '(root)'
 * @returns {string}
 */
export function groupLabel (name) {
  const raw = String(name == null ? '' : name).trim()
  if (!raw) return ''
  // '(root)' 是平台自己的占位，不是上游的子命令，命令行上没有这个词可以敲，
  //   所以它只留中文，不摆一个假的原名。
  if (raw === '(root)') return '顶层（无子命令）'
  const gloss = GLOSS[raw.toLowerCase()]
  return gloss ? `${raw}（${gloss}）` : raw
}

/** 这个分组名有没有释义（界面用它决定要不要提「名字取自上游子命令」）。 */
export function hasGloss (name) {
  const raw = String(name == null ? '' : name).trim().toLowerCase()
  return !!GLOSS[raw]
}
