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

function isText (name) { return TEXT_RE.test(name) }
function isRef (name) { return REF_RE.test(name) || REF_EXACT_RE.test(name) }
function isOut (name) { return OUT_RE.test(name) || OUT_EXACT_RE.test(name) }

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
 * 给一个文件打三类分。
 * @returns {{file, flags, hasText, hasRef, hasOut, score, exactText, requiredText, names}}
 */
function scoreFile (file, list) {
  const names = list.map((p) => p.name)
  const textParams = list.filter((p) => isText(p.name))
  const refParams = list.filter((p) => isRef(p.name))
  const outParams = list.filter((p) => isOut(p.name))
  const exactText = list.find((p) => p.name === 'text') || null
  return {
    file,
    flags: list.length,
    hasText: textParams.length > 0,
    hasRef: refParams.length > 0,
    hasOut: outParams.length > 0,
    score: (textParams.length > 0 ? 1 : 0) + (refParams.length > 0 ? 1 : 0) + (outParams.length > 0 ? 1 : 0),
    exactText: !!exactText,
    requiredText: !!(exactText && exactText.required === true),
    names: names,
    textNames: textParams.map((p) => p.name),
    refNames: refParams.map((p) => p.name),
    outNames: outParams.map((p) => p.name),
  }
}

/**
 * 排出一张候选表。第一项是推荐入口，其后是同分候选（供界面在证据不足时让人点选）。
 *
 * @param {Array} params /wizard/discover 的参数表，每项带 name / source_file / required
 * @returns {{file:string|null, module:string|null, score:number, candidates:Array}}
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

  // 只留三类齐全的：缺任何一类都说明它不是「收文本、吐音频」的那个入口。
  const full = scored.filter((s) => s.score === 3)
  const rank = (a, b) =>
    Number(b.exactText) - Number(a.exactText) ||
    Number(b.requiredText) - Number(a.requiredText) ||
    a.flags - b.flags ||
    String(a.file).localeCompare(String(b.file))
  full.sort(rank)
  // 没有满分的退到两分（有的引擎把参考音频放进配置文件而不是开关），再退到有文本的。
  const pool = full.length ? full : scored.filter((s) => s.score >= 2).sort(rank)

  const candidates = pool.map((s) => ({
    file: s.file,
    module: moduleOf(s.file),
    score: s.score,
    flags: s.flags,
    text_names: s.textNames,
    ref_names: s.refNames,
    out_names: s.outNames,
  }))
  const top = candidates[0] || null
  return {
    file: top ? top.file : null,
    module: top ? top.module : null,
    score: top ? top.score : 0,
    candidates: candidates.slice(0, 3),
  }
}

module.exports = { pickEntry, moduleOf, scoreFile, isText, isRef, isOut }
