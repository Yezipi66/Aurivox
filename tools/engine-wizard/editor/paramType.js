// 扫到的参数类型 → 界面参数类型的映射。左栏参数池与中栏落点共用，放这里才能单独测。
// 两套词不同：界面参数类型是平台那五种（text / number / select / boolean / file），
// 统一层的类型名是 str / int / bool / array。

// 统一层的类型名到界面参数类型的对应。
// 映射不到就落到 text：扫不出类型的参数仍然是文本参数。
const KIND_TO_TYPE = {
  str: 'text',
  string: 'text',
  int: 'number',
  integer: 'number',
  float: 'number',
  number: 'number',
  bool: 'boolean',
  boolean: 'boolean',
}

/**
 * 从扫到的参数推出界面参数类型。
 *
 * @param {object} p 扫到的参数
 * @returns {string} 界面参数类型，五种之一
 */
export function paramTypeOf (p) {
  if (!p) return 'text'
  // 上游给了候选值就是下拉：argparse 的 choices= 与 click.Choice 都在这里，
  //   按 str 落成输入框等于把候选丢掉，使用者还得回上游抄一遍。
  if (Array.isArray(p.choices) && p.choices.length) return 'select'
  if (p.kind === 'array') return 'text'
  // 收文件的参数：统一层的类型名只有 str/int/bool/array，不会直接给 file，
  //   只能从开关名与说明里认。--model-dir / --prompt-wav 这类落进 text 会变成
  //   一个手填路径的文本框，合成页上给不出「选择文件」控件。
  if (looksLikeFile(p)) return 'file'
  return KIND_TO_TYPE[String(p.kind || '').toLowerCase()] || 'text'
}

/**
 * 扫到的参数是不是收一个文件路径。
 *   argparse 的 type=Path / FileType、click.Path、说明里的 "path to ... file"
 *   都在这里认；目录参数（含 dir/folder）也算 file，合成页的文件控件同样适用。
 */
export function looksLikeFile (p) {
  if (!p) return false
  if (String(p.kind || '').toLowerCase() === 'file') return true
  const name = String(p.name || '').toLowerCase()
  const target = String(p.target || '').toLowerCase()
  const help = String(p.help || '').toLowerCase()
  // 目录或文件的写法：--model-dir / --model-path / --prompt-wav / --checkpoint-file。
  //   --model-name / --model-type 是字符串，不能因为带 model 就认成文件。
  const PATHISH = /(^|[-_])(file|path|dir|folder|wav|audio)([-_]|$)/
  const WEIGHTISH = /(^|[-_])(model|ckpt|checkpoint|weights)([-_]|$)(dir|path|file|folder|[-_]|$)/
  if (PATHISH.test(name) || PATHISH.test(target)) return true
  if (WEIGHTISH.test(name) || WEIGHTISH.test(target)) return true
  if (/\b(path to|file path|audio file|wav file|model file|checkpoint dir|checkpoint path)\b/.test(help)) return true
  return false
}
