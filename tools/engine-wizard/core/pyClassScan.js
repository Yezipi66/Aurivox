'use strict'

// Python 形态的推理入口：静态找出「哪个类、哪个方法」是拿来做推理的。
//
// 为什么需要这一份：反射（reflect_params.py）要先有名片里的 call.module + call.class
//   才能 import，读不到类就读不到参数。名片还没写、客户端的 CLI 又找不到时（纯库形态的
//   引擎），入口那一格只能靠人背模块名。这里把候选摊开，只做静态文本扫描，不 import 任何东西。
//
// 判据与命令行那条线同一套：一个方法同时收文本、参考音频、输出落点、模型时，它像推理入口。
//   只收文本而不收落点的，按工具函数处理，不列入候选。
// 平台不按类名或项目名挑：排序只按证据分与常见方法名的先后，结论由人来定。

const fs = require('node:fs')
const path = require('node:path')

const { findPyFiles, isNotEntryFile } = require('./pyFiles')
const { moduleWithRoot, scoreFile } = require('./entryPick')

// 超过这个大小的文件不读：模型仓库里几百 KB 的生成文件不是入口，
//   读它只消耗时间，还会把参数名列表撑得很大。
const MAX_FILE_BYTES = 512 * 1024

const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/
const DEF_RE = /^(\s*)def\s+([A-Za-z_]\w*)\s*\(/
// 常见的方法名：只参与排序，不作硬性过滤。不同引擎叫 synthesize / infer / generate / tts。
const METHOD_HINT_RE = /(synthes|infer|generat|tts|speak|render|call)/i

function parenDelta (s) {
  let d = 0
  for (const ch of String(s)) {
    if (ch === '(') d++
    else if (ch === ')') d--
  }
  return d
}

/** 括号里的形参表 → 名字数组。去掉 self / cls / *args / **kwargs，剥掉注解与默认值。 */
function paramNames (src) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of String(src)) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
    .map((s) => String(s).split('=')[0].split(':')[0].trim())
    .filter((s) => /^[A-Za-z_]\w*$/.test(s))
    .filter((s) => s !== 'self' && s !== 'cls')
}

/**
 * 从一个 Python 源文件的文本里找类与方法。只认单行 class 声明与 def 声明；
 * 方法签名跨行时按括号配平一直读到闭合。
 *
 * @param {string} text
 * @returns {Array<{name:string, methods:Array<{name:string, params:string[]}>}>}
 */
function scanClasses (text) {
  const lines = String(text || '').split(/\r?\n/)
  const classes = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const cm = line.match(CLASS_RE)
    if (cm) {
      cur = { name: cm[2], indent: cm[1].length, methods: [] }
      classes.push(cur)
      continue
    }
    if (!cur) continue
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const indent = line.length - line.trimStart().length
      // 回到类声明同级的缩进 = 这个类的正文结束。顶格的下一个类或函数不该算进来。
      if (indent <= cur.indent) { cur = null; continue }
    }
    const dm = line.match(DEF_RE)
    if (!dm) continue
    // dm[0] 已经吃掉左括号，所以从 1 层开始配平；签名跨行时一直读到闭合。
    let sig = line.slice(dm[0].length)
    let depth = 1 + parenDelta(sig)
    let j = i
    while (depth > 0 && j + 1 < lines.length) {
      j++
      sig += ' ' + lines[j].trim()
      depth += parenDelta(lines[j])
    }
    i = j
    const inner = sig.slice(0, sig.lastIndexOf(')') >= 0 ? sig.lastIndexOf(')') : sig.length)
    const params = paramNames(inner)
    if (params.length) cur.methods.push({ name: dm[2], params })
  }
  return classes
}

/**
 * 扫一台引擎，列出像推理入口的「类 + 方法」。
 *
 * @param {string} dir 引擎源码根目录
 * @param {{limit?: number}} [opts]
 * @returns {Array<{file, module, srcRoot, className, method, score, flags,
 *   params:{text:string[], ref:string[], out:string[], model:string[]}}>}
 */
function scanPythonEntries (dir, opts = {}) {
  if (!dir || !fs.existsSync(dir)) return []
  const limit = Number.isFinite(opts.limit) ? opts.limit : 8
  const srcIsPackage = fs.existsSync(path.join(dir, 'src', '__init__.py'))
  const out = []

  for (const file of findPyFiles(dir)) {
    if (isNotEntryFile(file.split('/').pop())) continue
    const abs = path.join(dir, ...file.split('/'))
    let text = ''
    try {
      const st = fs.statSync(abs)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      text = fs.readFileSync(abs, 'utf8')
    } catch { continue }
    const { module, srcRoot } = moduleWithRoot(file, { srcIsPackage })
    if (!module) continue

    for (const cls of scanClasses(text)) {
      for (const m of cls.methods) {
        const pseudo = m.params.map((name) => ({ name }))
        const scored = scoreFile(file, pseudo)
        // 收文本是必要条件：不收文本的方法不可能是合成入口。
        if (!scored.hasText || scored.score < 2) continue
        out.push({
          file,
          module,
          srcRoot,
          className: cls.name,
          method: m.name,
          score: scored.score + (METHOD_HINT_RE.test(m.name) ? 0.5 : 0),
          flags: scored.flags,
          params: {
            text: scored.textNames,
            ref: scored.refNames,
            out: scored.outNames,
            model: scored.modelNames,
          },
        })
      }
    }
  }

  // 同分时先看文件深浅：仓库根附近的推理脚本通常是主入口，
  //   藏在 vendors/ 或模块子目录深处的类多是第三方实现或某个部件。
  //   这一条只影响先后，不删候选。
  out.sort((a, b) =>
    b.score - a.score ||
    a.file.split('/').length - b.file.split('/').length ||
    a.className.localeCompare(b.className) ||
    String(a.method).localeCompare(String(b.method)))
  return out.slice(0, limit)
}

module.exports = { scanClasses, scanPythonEntries, paramNames }
