'use strict'
// 第 2 步「选依赖版本」的后端判据：把上游清单里某几行换成指定的版本。
// 改版本不能靠 uv 的排除（--excludes / --no-install-package）：排除的语义是「这个包连同
//   依赖它的其它包一起不装」，会把依赖它的包一起弄掉 ⇒ 环境装不完整。改版本要改清单本身。
// 上游文件保持原样，改写结果写进平台自己的清单副本。
// 改写保留原约束形式（einops>=0.8.1 选 0.7.0 ⇒ einops>=0.7.0；原本没钉版本的钉住）；
//   换不出一个合法 spec 就如实报出来，不闷头改。

const fs = require('node:fs')
const path = require('node:path')

// 平台自己的清单副本文件名。放在引擎目录里，与上游文件并列。
const LOCAL_MANIFEST = '.wizard-requirements.local.txt'

/** 归一化包名：大小写、-_. 视作同一个。 */
function normName (name) {
  return String(name || '').trim().toLowerCase().replace(/[-_.]+/g, '-')
}

/** 从一条 spec 里取出包名。 */
function specName (spec) {
  return normName(String(spec).split(/[<>=!~;@\s]/)[0])
}

/**
 * 把一条 spec 里的版本换掉，保留原有的约束形式。
 *
 * @param {string} spec 原 spec，例如 einops>=0.8.1
 * @param {string} version 目标版本，例如 0.7.0
 * @returns {string|null} 换好的 spec；换不了时返回 null
 */
function replaceVersion (spec, version) {
  const raw = String(spec || '').trim()
  const ver = String(version || '').trim()
  if (!raw || !ver) return null
  // 拆出「包名 + 约束 + 其它」三段。其它段是 extras、environment marker 等。
  const m = raw.match(/^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*((?:[<>=!~].*)?)$/)
  if (!m) return null
  const name = m[1]
  const extras = m[2] || ''
  const constraint = (m[3] || '').trim()
  // 约束形式：取第一个运算符。没有约束就是「没钉版本」。
  const opMatch = constraint.match(/^(===|==|!=|<=|>=|~=|<|>)/)
  if (!opMatch) return `${name}${extras}==${ver}`
  const op = opMatch[1]
  // ~= 与 === 只在特定形式下能换；其余运算符按原样保留。
  return `${name}${extras}${op}${ver}`
}

/**
 * 在清单文本里把指定包的版本换掉。
 *
 * @param {string} text 清单原文
 * @param {object} overrides 包名⇒版本（包名用原样，函数内部归一化）
 * @returns {{text:string, changed:string[], missing:string[]}}
 *   changed：实际改掉的包名（归一化后）；missing：清单里找不到的包名
 */
function rewriteManifest (text, overrides) {
  const src = String(text || '')
  const wanted = new Map()
  for (const [name, ver] of Object.entries(overrides || {})) {
    const k = normName(name)
    if (k && ver) wanted.set(k, String(ver).trim())
  }
  const changed = []
  const missing = []
  if (!wanted.size) return { text: src, changed, missing }

  const lines = src.split(/\r?\n/)
  const out = lines.map((line) => {
    // 注释行、选项行、链接行不动。
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('-')) return line
    if (/^(?:git\+|https?:|file:|\.{1,2}[\\/])/i.test(t)) return line
    const name = specName(t)
    if (!wanted.has(name)) return line
    const ver = wanted.get(name)
    const replaced = replaceVersion(t, ver)
    if (!replaced) {
      if (!missing.includes(name)) missing.push(name)
      return line
    }
    if (!changed.includes(name)) changed.push(name)
    // 保留原来的行首缩进与行尾注释。
    const indent = line.match(/^\s*/)[0]
    const tail = line.match(/(#.*)$/)
    return indent + replaced + (tail ? ' ' + tail[1] : '')
  })

  // 清单里根本没有的包：如实报出来。
  for (const name of wanted.keys()) {
    if (!changed.includes(name)) missing.push(name)
  }
  return { text: out.join('\n'), changed, missing }
}

/**
 * 写出改过的清单副本。
 *
 * @param {string} dir 引擎目录
 * @param {string} from 上游清单相对路径（相对 dir）
 * @param {object} overrides 包名⇒版本
 * @returns {{ok:true, file:string, changed:string[], missing:string[]}
 *          |{ok:false, code:string, error:string, errorZh:string}}
 */
function writeLocalManifest (dir, from, overrides) {
  const srcPath = path.join(dir, from)
  let text = ''
  try {
    text = fs.readFileSync(srcPath, 'utf8')
  } catch (e) {
    return {
      ok: false,
      code: 'MANIFEST_UNREADABLE',
      error: `Cannot read the dependency manifest (${from}): ${e && e.message ? e.message : e}`,
      errorZh: `读不到依赖清单（${from}）：${e && e.message ? e.message : e}`,
    }
  }
  const r = rewriteManifest(text, overrides)
  if (!r.changed.length) {
    return {
      ok: false,
      code: 'NO_VERSION_OVERRIDE_APPLIED',
      error: `None of the chosen versions match a package in ${from}: `
        + `${r.missing.join(', ')}`,
      errorZh: `所选版本没有一项对得上 ${from} 里的包：${r.missing.join('、')}`,
    }
  }
  const outPath = path.join(dir, LOCAL_MANIFEST)
  fs.writeFileSync(outPath, r.text, 'utf8')
  return { ok: true, file: LOCAL_MANIFEST, changed: r.changed, missing: r.missing }
}

/**
 * 在 pyproject.toml 的依赖数组里把指定包的版本换掉。
 *
 * 依赖数组的每一项形如 "einops==0.8.1" 或 "einops>=0.8.1"，
 * 也可能带 extras（"foo[bar]>=1.0"）与 marker（"foo==1.0; python_version<'3.12'"）。
 *
 * @param {string} text pyproject.toml 原文
 * @param {object} overrides 包名⇒版本
 * @returns {{text:string, changed:string[], missing:string[]}}
 */
function rewritePyproject (text, overrides) {
  const src = String(text || '')
  const wanted = new Map()
  for (const [name, ver] of Object.entries(overrides || {})) {
    const k = normName(name)
    if (k && ver) wanted.set(k, String(ver).trim())
  }
  const changed = []
  const missing = []
  if (!wanted.size) return { text: src, changed, missing }

  const lines = src.split(/\r?\n/)
  const out = lines.map((line) => {
    const m = line.match(/^(\s*)"([^"]+)"(,?)(\s*#.*)?$/)
    if (!m) return line
    const indent = m[1]
    const entry = m[2]
    const comma = m[3]
    const comment = m[4] || ''
    // marker（; 之后的部分）要留着。
    const semi = entry.indexOf(';')
    const spec = (semi >= 0 ? entry.slice(0, semi) : entry).trim()
    const marker = semi >= 0 ? entry.slice(semi) : ''
    const name = specName(spec)
    if (!wanted.has(name)) return line
    const ver = wanted.get(name)
    const replaced = replaceVersion(spec, ver)
    if (!replaced) {
      if (!missing.includes(name)) missing.push(name)
      return line
    }
    if (!changed.includes(name)) changed.push(name)
    return `${indent}"${replaced}${marker}"${comma}${comment}`
  })

  for (const name of wanted.keys()) {
    if (!changed.includes(name)) missing.push(name)
  }
  return { text: out.join('\n'), changed, missing }
}

/**
 * 改写清单里的 torch 系几行：把上游钉的版本换成本机后端上可用的版本。
 *
 * 为什么需要这一步：改任何一个包的版本都会重写整份清单副本，
 *   而上游钉的 torch 版本可能低于本机后端的版本下界。
 *   若原样保留那几行，选一个普通包的版本就会把 torch 静默降级成装不上的那一版。
 *
 * @param {string} text 清单原文
 * @param {object} overrides 包名⇒版本（使用者显式选的，照它来）
 * @param {object} opts
 *   torchVersion 本机后端上可用的 torch 版本（空串表示给不出）
 *   torchNames torch 系的包名（torch / torchaudio / torchvision）
 * @returns {{text:string, changed:string[], missing:string[], torchRewritten:string[]}}
 */
function rewriteTorchFamily (text, overrides, opts) {
  const src = String(text || '')
  const wanted = new Map()
  for (const [name, ver] of Object.entries(overrides || {})) {
    const k = normName(name)
    if (k && ver) wanted.set(k, String(ver).trim())
  }
  const changed = []
  const missing = []
  const torchRewritten = []
  const target = String((opts && opts.torchVersion) || '').trim()
  const torchNames = new Set(((opts && opts.torchNames) || []).map(normName))
  if (!wanted.size && !target) return { text: src, changed, missing, torchRewritten }

  const lines = src.split(/\r?\n/)
  const out = lines.map((line) => {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('-')) return line
    if (/^(?:git\+|https?:|file:|\.{1,2}[\\/])/i.test(t)) return line
    const name = specName(t)
    // 使用者显式选了这个包 ⇒ 照他选的来。
    if (wanted.has(name)) {
      const replaced = replaceVersion(t, wanted.get(name))
      if (!replaced) {
        if (!missing.includes(name)) missing.push(name)
        return line
      }
      if (!changed.includes(name)) changed.push(name)
      const indent = line.match(/^\s*/)[0]
      const tail = line.match(/(#.*)$/)
      return indent + replaced + (tail ? ' ' + tail[1] : '')
    }
    // torch 系里没被显式选的那几行 ⇒ 按本机后端上可用的版本改。
    if (!target || !torchNames.has(name)) return line
    const replaced = replaceVersion(t, target)
    if (!replaced) return line
    if (!torchRewritten.includes(name)) torchRewritten.push(name)
    const indent = line.match(/^\s*/)[0]
    const tail = line.match(/(#.*)$/)
    return indent + replaced + (tail ? ' ' + tail[1] : '')
  })

  for (const name of wanted.keys()) {
    if (!changed.includes(name)) missing.push(name)
  }
  return { text: out.join('\n'), changed, missing, torchRewritten }
}

module.exports = {
  normName, specName, replaceVersion, rewriteManifest, rewritePyproject,
  rewriteTorchFamily, writeLocalManifest, LOCAL_MANIFEST,
}
