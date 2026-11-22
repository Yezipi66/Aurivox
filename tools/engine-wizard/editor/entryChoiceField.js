// 第 4 步「推理入口」那一格的读写。纯函数，单独可测。
//
// 名片里没有专门的入口键：命令行形态写在 call.argv 的 -m 目标或脚本路径上，
// Python 类形态写在 call.module。这一格只把这三种写法摊成「一个可选可填的值」。
// 选中的是候选里的文件时，写进去的仍是模块名，工作目录按 src 布局一并定下；
// 直接输入的值按原样写，平台不替使用者改写他自己写的模块名。

const MODULE_TOKENS = ['_MODULE_', '__MODULE__']

function argvEntry (argv) {
  const mIdx = argv.indexOf('-m')
  if (mIdx >= 0 && mIdx + 1 < argv.length) {
    return { kind: 'module', index: mIdx + 1, value: String(argv[mIdx + 1]) }
  }
  const sIdx = argv.findIndex((w, i) => i > 0 && typeof w === 'string' && w.endsWith('.py'))
  if (sIdx > 0) return { kind: 'script', index: sIdx, value: String(argv[sIdx]) }
  return null
}

/**
 * @returns {{target:'argv'|'module', kind:'module'|'script', value:string}}
 */
export function readEntry (manifest) {
  const call = (manifest && manifest.call) || {}
  const argv = Array.isArray(call.argv) ? call.argv : []
  const hit = argvEntry(argv)
  if (hit) return { target: 'argv', ...hit }
  if (call.kind === 'python' || typeof call.module === 'string') {
    return { target: 'module', kind: 'module', value: typeof call.module === 'string' ? call.module : '' }
  }
  return { target: 'argv', kind: 'module', value: '' }
}

/** 输入框里显示的值：名片里写的那个入口，占位符不算填过。 */
export function entryText (manifest) {
  const cur = readEntry(manifest)
  if (!cur.value || MODULE_TOKENS.includes(cur.value)) return ''
  return cur.value
}

/** 输入框里显示的值：能对应到候选文件就显示文件，便于核对选的是哪一个。 */
export function displayEntry (manifest, candidates = []) {
  const cur = entryText(manifest)
  if (!cur) return ''
  const hit = (Array.isArray(candidates) ? candidates : [])
    .find((c) => c && (c.file === cur || c.module === cur))
  return hit && hit.file ? hit.file : cur
}

/**
 * 推理入口对应的文件路径，供参数池收窄使用。
 * 候选里能按当前值反查到就用候选的 file；手输的 .py 原样返回；
 * 只有模块名而候选里没有对应文件时返回空（收窄拿不到依据，调用方按全量处理）。
 *
 * @param {object} manifest
 * @param {Array} candidates discover 回传的 entry_candidates
 * @returns {string}
 */
export function entryFileOf (manifest, candidates = []) {
  const shown = displayEntry(manifest, candidates)
  if (!shown) return ''
  const hit = (Array.isArray(candidates) ? candidates : [])
    .find((c) => c && (c.file === shown || c.module === shown))
  if (hit && hit.file) return hit.file
  return /\.py$/i.test(shown) ? shown : ''
}

/**
 * 把选中的 python 入口写回名片：模块、类、方法三件一起写。
 * 原对象不动。argv / args 是命令行形态的键，切到 python 后必须摘掉，
 * 否则名片校验会以「kind=python 下不认得这个键」拒收。
 *
 * @param {object} manifest
 * @param {{module?:string, className?:string, method?:string, srcRoot?:string}} picked
 * @param {string} engineId
 * @returns {object}
 */
export function writePythonEntry (manifest, picked, engineId = '') {
  const m = { ...(manifest || {}) }
  const call = { ...(m.call || {}) }
  if (!picked) { m.call = call; return m }
  call.kind = 'python'
  if (picked.module) call.module = picked.module
  if (picked.className) call.class = picked.className
  if (picked.method) call.method = picked.method
  delete call.argv
  delete call.args
  if (engineId) call.cwd = 'engines/' + engineId + (picked.srcRoot ? '/' + picked.srcRoot : '')
  m.call = call
  return m
}

// ---- 调用形态 ----

/** 当前形态：名片写了 kind 就认它，没写按有没有 argv 判（与 EntryChoice 同一口径）。 */
export function callKindOf (manifest) {
  const call = (manifest && manifest.call) || {}
  if (call.kind === 'cli' || call.kind === 'python') return call.kind
  return Array.isArray(call.argv) && call.argv.length ? 'cli' : 'python'
}

// cli 的开关名：tts_text → --tts-text；已经带前缀的保持原样。
function asCliFlag (raw) {
  const v = String(raw).trim()
  if (!v) return v
  if (v.startsWith('-')) return v
  return '--' + v.replace(/_/g, '-')
}

// python 的参数名：--tts_text / --tts-text → tts_text。
//   单横线的短开关（-f）不猜：它的长名无从推断，改成 f 只会在上游报 unexpected
//   keyword argument，留给人按引擎签名改。
function asPyParam (raw) {
  const v = String(raw).trim()
  if (!v || !v.startsWith('--')) return v
  return v.replace(/^-+/, '').replace(/-/g, '_')
}

/**
 * 切换调用形态（call.kind）。纯函数，原名片不动。
 *
 * 两种形态绑的不是同一类名字：cli 绑命令行开关，python 绑方法参数名。切换时按形态
 *   改写 bind，否则 `--tts_text` 会被当成关键字参数传给 Python 方法，报一个看不出
 *   是形态问题的 TypeError。改写只是默认值，界面上照常可改。
 *
 * 形态互斥的字段一并清掉：argv 是 cli 的执行命令；module / class / method /
 *   init_args 是 python 的构造与调用目标；text_via 是 cli 专有的 stdin 入口。
 *
 * @param {object} manifest
 * @param {'cli'|'python'} kind
 * @returns {object} 新名片
 */
export function withCallKind (manifest, kind) {
  const to = kind === 'cli' ? 'cli' : 'python'
  const m = { ...(manifest || {}) }
  const call = { ...(m.call || {}) }
  if (to === 'cli') {
    call.kind = 'cli'
    delete call.module
    delete call.class
    delete call.method
    delete call.init_args
    // 逐块产出是进程内的形状：命令行进程结束后只剩文件或字节流。
    //   留着 generator 会让宿主走进一个 cli 不存在的分支。
    if (call.returns === 'generator') call.returns = 'file'
    if (!Array.isArray(call.argv) || !call.argv.length) call.argv = ['{engine_python}']
  } else {
    call.kind = 'python'
    delete call.argv
    delete call.text_via
    // call.args 是命令行形态的参数形状声明（新版名片改用 parameters[]）。
    //   python 形态的加载参数走 init_args，留着 args 保存时会被拒：
    //   「call.args 在 kind="python" 下不是认得的键」。
    delete call.args
    // 「合成参数」那批行是按命令行开关扫出来的（训练、导出、工具脚本的开关也在里面），
    //   python 形态用不上它们：名字与方法参数不一致，还会被当成可调旋钮。
    //   形态换了就要按新形态重扫，不能把上一种形态的行留在表里。
    delete m.parameters
  }
  if (call.bind && typeof call.bind === 'object') {
    const next = {}
    for (const [slot, raw] of Object.entries(call.bind)) {
      next[slot] = typeof raw === 'string' && raw.trim()
        ? (to === 'cli' ? asCliFlag(raw) : asPyParam(raw))
        : raw
    }
    call.bind = next
  }
  m.call = call
  return m
}

// ---- 子命令 ----
//
// 一个入口挂多个子命令时（pkg.cli synth / infer / batch），命令行上的那个词是名片的一部分。
// 扫描不替人挑：entry.subcommand 在多于一个子命令时是 null。这里只负责读写那个词，
// 位置固定在模块名（或脚本路径）之后、第一个开关之前。

/** 模块名或脚本路径之后的位置；找不到返回 -1。 */
function subcommandSlot (argv) {
  const mIdx = argv.indexOf('-m')
  if (mIdx >= 0 && mIdx + 1 < argv.length) return mIdx + 2
  const sIdx = argv.findIndex((w, i) => i > 0 && String(w).endsWith('.py'))
  if (sIdx > 0) return sIdx + 1
  return -1
}

/** 当前命令行上的子命令；没有就返回空串。占位符不算填过。 */
export function readSubcommand (manifest) {
  const call = (manifest && manifest.call) || {}
  const argv = Array.isArray(call.argv) ? call.argv : []
  const at = subcommandSlot(argv)
  if (at < 0 || at >= argv.length) return ''
  const word = String(argv[at])
  if (word.startsWith('-') || word.startsWith('{')) return ''
  return word
}

/**
 * 把选中的子命令写回命令行。传空串 = 去掉那一个词。
 * 原对象不动。
 *
 * @param {object} manifest
 * @param {string} sub
 * @returns {object}
 */
export function writeSubcommand (manifest, sub) {
  const m = { ...(manifest || {}) }
  const call = { ...(m.call || {}) }
  const argv = Array.isArray(call.argv) ? [...call.argv] : ['{engine_python}']
  const want = String(sub == null ? '' : sub).trim()
  const at = subcommandSlot(argv)
  if (at < 0) {
    // 还没有模块名或脚本路径：没有可插入子命令的位置。不在这里造一个位置出来，
    //   那种名片本来就不完整，入口那一格才是要补的地方。
    m.call = call
    return m
  }
  const has = at < argv.length && !String(argv[at]).startsWith('-') && !String(argv[at]).startsWith('{')
  if (has && want) argv[at] = want
  else if (has && !want) argv.splice(at, 1)
  else if (!has && want) argv.splice(at, 0, want)
  call.argv = argv
  m.call = call
  return m
}

/**
 * 写回名片。原对象不动。
 * 候选命中时写它声明的模块名，并按 srcRoot 设定 cwd；
 * 手输的值按原样写，cwd 保持使用者已经填过的那一份。
 *
 * @param {object} manifest
 * @param {string} shown 输入框里的值（文件路径、模块名或脚本路径）
 * @param {Array} candidates discover 回传的 entry_candidates
 * @param {string} engineId
 * @returns {object} 新名片
 */
export function writeEntry (manifest, shown, candidates = [], engineId = '') {
  const raw = String(shown == null ? '' : shown).trim()
  const hit = (Array.isArray(candidates) ? candidates : [])
    .find((c) => c && (c.file === raw || c.module === raw)) || null
  const isScript = !hit && raw.endsWith('.py')
  const target = hit ? (hit.module || hit.file) : raw

  const m = { ...(manifest || {}) }
  const call = { ...(m.call || {}) }
  const cur = readEntry(m)
  const useModule = cur.target === 'module'

  if (useModule) {
    if (target && !MODULE_TOKENS.includes(target)) call.module = target
    else delete call.module
  } else {
    const argv = Array.isArray(call.argv) ? [...call.argv] : ['{engine_python}']
    const value = target || '_MODULE_'
    const mIdx = argv.indexOf('-m')
    const sIdx = argv.findIndex((w, i) => i > 0 && String(w).endsWith('.py'))
    if (isScript) {
      if (mIdx >= 0) argv.splice(mIdx, 2)
      const again = argv.findIndex((w, i) => i > 0 && String(w).endsWith('.py'))
      if (again > 0) argv[again] = value
      else argv.splice(1, 0, value)
    } else if (mIdx >= 0) {
      argv[mIdx + 1] = value
    } else if (sIdx > 0) {
      argv.splice(sIdx, 1, '-m', value)
    } else {
      argv.splice(1, 0, '-m', value)
    }
    call.argv = argv
    // 换了入口之后，上一条命令里的子命令可能不属于新入口（synth 留给 infer 系入口
    //   就是一条非法参数，argparse 直接拒收）。只在新入口确实带着子命令表时判断：
    //   表为空表示扫描没给出分组，不能据此删掉使用者写的词。
    if (hit && Array.isArray(hit.groups) && hit.groups.length) {
      const at = subcommandSlot(argv)
      if (at > 0 && at < argv.length) {
        const word = String(argv[at])
        if (!word.startsWith('-') && !word.startsWith('{') && !hit.groups.includes(word)) {
          argv.splice(at, 1)
          call.argv = argv
        }
      }
    }
  }

  if (hit && engineId) {
    call.cwd = 'engines/' + engineId + (hit.srcRoot ? '/' + hit.srcRoot : '')
  }
  m.call = call
  return m
}
