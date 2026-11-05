'use strict'

const { moduleToFiles } = require('./readmeEntry')

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
const REF_RE = /(ref|reference|prompt|speaker|spk)[-_]?(audio|wav|wave|speech|voice|flac|mp3)/i
const REF_EXACT_RE = /^(voice|spk|speaker|ref_audio|ref_wav|reference_audio)$/i
// 输出落点：output/save/out 与 dir/path/file/audio 的组合，以及直接落在音频后缀上的写法。
//   后者（`--save_wav`、`--output_wav`）在参数少的引擎上很常见：模型写死在代码里，
//   命令行上只有文本与保存路径，漏掉这一条就只剩一分，低于推荐门槛。
const OUT_RE = /(output|save|out)[-_]?(dir|path|file|audio|wav|wave|flac|mp3|ogg)/i
const OUT_EXACT_RE = /^(output|out_dir|save_dir|outdir|savedir|wav|wav_out|out_wav)$/i
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
 * 文件 → 模块名，同时指出它是不是 src 布局。
 *
 * src 布局（源码在 src/ 下、安装时把 src 加进路径）下，文件是 src/a/b/c.py，
 * 而正确模块名是 a.b.c。直接拿路径拼会得到 src.a.b.c，`-m` 一跑就是
 * ModuleNotFoundError，而报错指向 Python，看不出是这一格的问题。
 *
 * `src` 本身是包（src/__init__.py 存在）的工程不能剥这一层：调用方用
 *   opts.srcIsPackage 把它排除掉，那时 src 就是包名的一部分。
 *
 * @param {string} file
 * @param {{srcIsPackage?: boolean}} [opts]
 * @returns {{module: string|null, srcRoot: string|null}}
 */
function moduleWithRoot (file, opts = {}) {
  const p = String(file || '').replace(/\\/g, '/').replace(/^\.?\//, '')
  const parts = p.split('/').filter(Boolean)
  if (parts[0] === 'src' && parts.length > 2 && opts.srcIsPackage !== true) {
    return { module: moduleOf(parts.slice(1).join('/')), srcRoot: 'src' }
  }
  return { module: moduleOf(p), srcRoot: null }
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
 * 把一份「作者点名过的模块 / 文件」清单，与扫描结果求交集。
 *
 * 两种匹配，优先逐字：
 *   ① 声明里的模块名 → moduleToFiles 展开（含 src 布局那一组），与扫描文件逐字相等；
 *   ② 声明里的路径 → 逐字相等；不一致时退到「路径后缀唯一命中」。
 *      作者常站在子目录里写用法（`cd cli && python x.py` 或只写 `python x.py`），
 *      而扫描出来的路径是相对引擎根的。后缀命中只在候选唯一时采用：
 *      两个文件都叫 x.py 时交给人挑，不替使用者猜。
 *
 * 命中项记下声明里的模块名：它是作者写的、安装后能 import 的名字，
 *   比按扫描路径反推更准（src 布局反推会多出一个 src. 前缀）。
 *
 * @param {Array} scored scoreFile 的结果表
 * @param {{modules?:string[], files?:string[]}|null} spec 清单
 * @returns {{entry: object, module: string|null}[]}
 */
function collectHits (scored, spec) {
  const hits = []
  if (!spec) return hits
  const take = (hit, module) => {
    if (!hit) return
    const at = hits.findIndex((h) => h.entry === hit)
    if (at < 0) hits.push({ entry: hit, module: module || null })
    else if (!hits[at].module && module) hits[at].module = module
  }

  for (const mod of (spec.modules || [])) {
    for (const f of moduleToFiles(mod)) {
      const hit = scored.find((s) => s.file === f)
      if (hit) { take(hit, mod); break }
    }
  }
  for (const f of (spec.files || [])) {
    const rel = String(f || '').replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!rel) continue
    const exact = scored.find((s) => s.file === rel)
    if (exact) { take(exact, null); continue }
    const byTail = scored.filter((s) => s.file === rel || s.file.endsWith('/' + rel))
    if (byTail.length === 1) take(byTail[0], null)
  }
  return hits
}

/**
 * 排出一张候选表。第一项是推荐入口，其后是同分候选（供界面在证据不足时让人点选）。
 *
 * @param {Array} params /wizard/discover 的参数表，每项带 name / source_file / required / group
 * @param {object} [opts]
 * @param {{modules:string[], files:string[]}} [opts.fromEntryPoints] 打包声明里的入口。
 *   写的是「装好之后敲哪条命令」，由打包工具读取，比文档里的用法更稳。
 * @param {{modules:string[], files:string[]}} [opts.fromReadme] README 里提取出的命令。
 *   作者自己写的用法比任何静态推断都硬：命中就直接用，不再比分数。
 * @param {boolean} [opts.srcIsPackage] src/ 本身是包（src/__init__.py 存在）时为真，
 *   那时不能把 src 当作布局层剥掉。
 * @returns {{file, module, srcRoot, subcommand, score, ambiguous, confidence, source, candidates}}
 *   source 说明这个结论从哪来：entry-points（声明）/ readme（文档）/ score（按参数打分）。
 *   srcRoot 是「模块要从哪个目录起算」：src 布局时为 'src'，调用方据此设 cwd。
 *   ambiguous 为真表示证据分不出高下：这时不替使用者挑，
 *   界面应当把这几个摆出来让人点。confidence 是同一件事的文字形式，供不在界面上时留痕。
 */
function pickEntry (params, opts = {}) {
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

  // 声明的入口优先。两级证据都是作者自己给的，比静态打分硬：
  //   打包声明写的是「装好之后敲哪条命令」，由打包工具读取，写错了装不上；
  //   README 里的示例命令是给人看的用法，写法随人而异。
  //   两级都只认「点了名、扫描也确实见过这个文件」的交集：声明里同样有训练、
  //   导出、批量工具的入口，光看名字分不出哪个是推理。
  const declaredHits = collectHits(scored, opts.fromEntryPoints)
  const readmeHits = collectHits(scored, opts.fromReadme)
  // 声明里同时给了多个入口时（老版本 CLI 与新版并存），先给更完整的那个：
  //   子命令多的说明它是项目的主命令行，只带一两个子命令的多是旧版或单项工具。
  //   这类先后只是默认值，ambiguous 会标出来，界面应当让人确认。
  if (declaredHits.length > 1) {
    declaredHits.sort((a, b) =>
      b.entry.groups.length - a.entry.groups.length || b.entry.flags - a.entry.flags ||
      String(a.entry.file).localeCompare(String(b.entry.file)))
  }

  // 四类齐全优先；没有满分的退到三类（有的引擎把模型或参考音频写在配置文件里，
  //   命令行上看不到），再退到两类。两类以下不给建议：证据不足时宁可不推荐，
  //   也不替使用者按文件名顺序挑一个。
  const rank = (a, b) =>
    b.score - a.score ||
    Number(b.exactText) - Number(a.exactText) ||
    Number(b.requiredText) - Number(a.requiredText) ||
    a.flags - b.flags ||
    String(a.file).localeCompare(String(b.file))
  // 声明与 README 命中时不再比分数：作者自己给的入口就是最强证据。
  //   都没有才回到四类打分，四类不足再退三类。
  const best = scored.filter((s) => s.score >= 3).sort(rank)
  const byScore = best.length ? best : scored.filter((s) => s.score >= 2).sort(rank)
  const pool = declaredHits.length
    ? declaredHits
    : (readmeHits.length
      ? readmeHits
      : byScore.map((s) => ({ entry: s, module: null })))

  // 前两名在「分数、文本同名、文本必填、参数个数」上完全一致时，证据分不出高下。
  //   此刻的先后只由上面那条字典序决定，那是排序的确定性，不是证据。
  const tie = (a, b) => !!a && !!b &&
    a.score === b.score && a.exactText === b.exactText &&
    a.requiredText === b.requiredText && a.flags === b.flags
  // 声明里有多个入口时同样要标出来：老版本与新版本并存的项目会声明两条，
  //   上面那条排序只是默认值，选错就是跑起另一套命令行。
  const ambiguous = pool.length > 1 &&
    (tie(pool[0].entry, pool[1].entry) || declaredHits.length > 1)

  const candidates = pool.map(({ entry: s, module }) => {
    const withRoot = moduleWithRoot(s.file, opts)
    return {
      file: s.file,
      // 声明里点过名的，用作者写的模块名；否则按扫描路径反推（src 布局会剥掉 src/）。
      module: module || withRoot.module,
      srcRoot: withRoot.srcRoot,
      subcommand: s.groups.length === 1 ? s.groups[0] : null,
      score: s.score,
      flags: s.flags,
      text_names: s.textNames,
      ref_names: s.refNames,
      out_names: s.outNames,
      model_names: s.modelNames,
    }
  })
  const top = candidates[0] || null
  const confidence = !top ? 'none' : ambiguous ? 'low' : top.score === 4 ? 'high' : 'medium'
  return {
    file: top ? top.file : null,
    module: top ? top.module : null,
    srcRoot: top ? top.srcRoot : null,
    subcommand: top ? top.subcommand : null,
    score: top ? top.score : 0,
    // 结论从哪来：entry-points 是打包声明，readme 是文档里的用法，score 是按参数打分
    source: declaredHits.length ? 'entry-points' : (readmeHits.length ? 'readme' : 'score'),
    confidence,
    ambiguous,
    candidates: candidates.slice(0, 3),
  }
}

module.exports = {
  pickEntry, moduleOf, moduleWithRoot, scoreFile, collectHits,
  norm, isText, isRef, isOut, isModel,
}
