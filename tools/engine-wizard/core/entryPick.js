'use strict'

// 推理入口判定：从扫描出来的参数表里，认出「哪一个源文件是拿来做推理的」。
//
// 判据是一个文件里同时声明了三类参数：
//   ① 文本输入（这个文件收要合成的文本）
//   ② 参考音频（零样本引擎的声纹来源）
//   ③ 输出落点（生成结果写到哪里）
// 辅助脚本不满足这个组合：转模型的脚本收不到文本，网页界面不收命令行文本，
// 部署客户端只收远端地址与日志目录。所以这三条同时成立时，它就不是辅助脚本。
//
// 同分时的次序（都是「更像推理入口」的证据，不引入引擎名）：
//   声明了与平台词同名的 text > 该 text 必填 > 参数少（辅助脚本的参数通常远多于推理入口）
//
// 本文件不含任何具体引擎名：判据只看参数名与它们的组合。

// 文本输入的候选名。text 排在最前，它是平台词；其余是常见别名。
//   分隔符两种都认：上游既有 target_text 也有 target-text。
const TEXT_RE = /^(text|input[-_]?text|gen[-_]?text|target[-_]?text|prompt)$/i
// 参考音频：以 ref/reference/prompt 打头并落在音频类名词上，或直接是 voice/spk/speaker。
const REF_RE = /(ref|reference|prompt|speaker|spk)[-_]?(audio|wav|wave|speech|voice)/i
const REF_EXACT_RE = /^(voice|spk|speaker|ref_audio|ref_wav|reference_audio)$/i
// 输出落点：output/save/out 与 dir/path/file/audio 的组合。
const OUT_RE = /(output|save|out)[-_]?(dir|path|file|audio)/i
const OUT_EXACT_RE = /^(output|out_dir|save_dir|outdir|savedir)$/i
// 调用的模型：能指定「用哪份权重」也是推理入口的特征。辅助脚本通常不收模型，
//   它要么打远端服务、要么只做格式转换。词表按 dest 与开关两种写法都覆盖。
const MODEL_RE = /^(model|ckpt|checkpoint|checkpoints|weight|weights|pretrained|base_model)$|^model[-_](dir|path|file|name)s?$|^(ckpt|checkpoint)[-_](dir|path|file)s?$/i

// 开关名归一化：上游把同一个参数写成 --model-dir、--model_dir、--modelDir 都常见，
//   匹配一律在下划线小写写法上做。落盘时仍用原名，名片里保留上游的写法。
function norm (name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

function isText (name) { return TEXT_RE.test(name) }
function isRef (name) { return REF_RE.test(name) || REF_EXACT_RE.test(name) }
function isOut (name) { return OUT_RE.test(name) || OUT_EXACT_RE.test(name) }
function isModel (name) { return MODEL_RE.test(name) }

/**
 * 源文件路径 → `python -m` 用的模块名。
 * 按工程目录拼，不去盘上探测：探测会挑中同名的别的东西。
 * 例如 cli/inference.py → cli.inference；包入口 __main__.py → 包名本身。
 */
function moduleOf (relFile) {
  const p = String(relFile || '').replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!p.endsWith('.py')) return null
  const parts = p.slice(0, -3).split('/').filter(Boolean)
  if (!parts.length) return null
  if (parts[parts.length - 1] === '__main__') parts.pop()
  return parts.length ? parts.join('.') : null
}

/**
 * 给一个文件打四类分：收文本、收参考音频、收输出落点、收模型。
 * 四类来自「一个推理入口最少要能回答的四件事」：合什么、像谁、写哪里、用哪份权重。
 * 辅助脚本通常缺其中一两类：转模型的脚本不收文本，网页界面不收命令行文本，
 *   部署客户端只收远端地址与日志目录。
 * @returns {{file, flags, hasText, hasRef, hasOut, hasModel, score, exactText, requiredText, names}}
 */
function scoreFile (file, list) {
  const names = list.map((p) => norm(p.name))
  const textParams = list.filter((p) => isText(norm(p.name)))
  const refParams = list.filter((p) => isRef(norm(p.name)))
  const outParams = list.filter((p) => isOut(norm(p.name)))
  const modelParams = list.filter((p) => isModel(norm(p.name)))
  const exactText = list.find((p) => norm(p.name) === 'text') || null
  return {
    file,
    flags: list.length,
    hasText: textParams.length > 0,
    hasRef: refParams.length > 0,
    hasOut: outParams.length > 0,
    hasModel: modelParams.length > 0,
    score: (textParams.length > 0 ? 1 : 0) + (refParams.length > 0 ? 1 : 0) +
      (outParams.length > 0 ? 1 : 0) + (modelParams.length > 0 ? 1 : 0),
    exactText: !!exactText,
    requiredText: !!(exactText && exactText.required === true),
    names: names,
    textNames: textParams.map((p) => p.name),
    refNames: refParams.map((p) => p.name),
    outNames: outParams.map((p) => p.name),
    modelNames: modelParams.map((p) => p.name),
    // 这个源文件涉及哪些子命令。只有一个时才当它是入口的子命令：
    //   一个文件挂多个子命令时（cli_v2 那种），不能替使用者选其中一个。
    groups: [...new Set(list.map((p) => p.group).filter((g) => g && g !== '(root)'))],
  }
}

/**
 * 排出一张候选表。第一项是推荐入口，其后是同分候选（供界面在证据不足时让人点选）。
 *
 * @param {Array} params /wizard/discover 的参数表，每项带 name / source_file / required / group
 * @returns {{file, module, subcommand, score, ambiguous, confidence, candidates}}
 *   ambiguous 为真表示第一与第二名的证据完全相同：这时不替使用者挑，
 *   界面应当把这几个摆出来让人点。confidence 是同一件事的文字形式，供不在界面上时留痕。
 */
function pickEntry (params) {
  const byFile = new Map()
  for (const p of (params || [])) {
    if (!p || !p.name) continue
    // 只认命令行来源：python 反射得来的是「可 import 的类」，不是可执行入口。
    if (p.source && p.source !== 'cli') continue
    const f = p.source_file
    if (!f) continue
    if (!byFile.has(f)) byFile.set(f, [])
    byFile.get(f).push(p)
  }

  const scored = []
  for (const [file, list] of byFile) scored.push(scoreFile(file, list))

  // 四类齐全优先；没有满分的退到三类（有的引擎把模型或参考音频写在配置文件里，
  //   命令行上看不到），再退到两类。两类以下不给建议：证据不足时宁可不推荐，
  //   也不替使用者按文件名顺序挑一个。
  const rank = (a, b) =>
    b.score - a.score ||
    Number(b.exactText) - Number(a.exactText) ||
    Number(b.requiredText) - Number(a.requiredText) ||
    a.flags - b.flags ||
    String(a.file).localeCompare(String(b.file))
  const best = scored.filter((s) => s.score >= 3).sort(rank)
  const pool = best.length ? best : scored.filter((s) => s.score >= 2).sort(rank)

  // 前两名在「分数、文本同名、文本必填、参数个数」上完全一致时，证据分不出高下。
  //   此刻的先后只由上面那条字典序决定，那是排序的确定性，不是证据。
  const tie = (a, b) => !!a && !!b &&
    a.score === b.score && a.exactText === b.exactText &&
    a.requiredText === b.requiredText && a.flags === b.flags
  const ambiguous = pool.length > 1 && tie(pool[0], pool[1])

  const candidates = pool.map((s) => ({
    file: s.file,
    module: moduleOf(s.file),
    subcommand: s.groups.length === 1 ? s.groups[0] : null,
    score: s.score,
    flags: s.flags,
    text_names: s.textNames,
    ref_names: s.refNames,
    out_names: s.outNames,
    model_names: s.modelNames,
  }))
  const top = candidates[0] || null
  const confidence = !top ? 'none' : ambiguous ? 'low' : top.score === 4 ? 'high' : 'medium'
  return {
    file: top ? top.file : null,
    module: top ? top.module : null,
    subcommand: top ? top.subcommand : null,
    score: top ? top.score : 0,
    confidence,
    ambiguous,
    candidates: candidates.slice(0, 3),
  }
}

module.exports = { pickEntry, moduleOf, scoreFile, norm, isText, isRef, isOut, isModel }
