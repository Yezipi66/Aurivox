'use strict'
// 第 2 步「装哪些包」的选择：用户可以跳过任意包，也可以换 torch 后端。
// 只改写平台从上游清单推出的装法；名片自己写的 env_command 与 conda 不改。
// 跳过用 uv 自带的排除：锁文件走 --no-install-package，其余走 --excludes，
//   被排除的包连同「被别的包间接依赖」的情况一起不装。
// 用户什么都没改（不跳包、后端等于推荐）时原样返回，装法逐项不改动。

const fs = require('node:fs')
const path = require('node:path')

const TORCH_TRIO = ['torch', 'torchaudio', 'torchvision']
const EXCLUDES_FILE = '.wizard-excludes.txt'

function normName (name) {
  return String(name || '').trim().toLowerCase().replace(/[-_.]+/g, '-')
}

function specName (spec) {
  return normName(String(spec).split(/[<>=!~\[;@\s]/)[0])
}

function readChoices (input) {
  const exclude = new Set()
  for (const n of Array.isArray(input.exclude) ? input.exclude : []) {
    const k = normName(n)
    if (k) exclude.add(k)
  }
  const backend = typeof input.backend === 'string' && input.backend ? input.backend : null
  return { exclude, backend }
}

function backendOption (key) {
  const { BACKEND_PREFERENCE } = require('./hardware')
  return (BACKEND_PREFERENCE || []).find((b) => b.key === key) || null
}

function detectRecommended () {
  try {
    const hw = require('./hardware')
    const r = hw.recommendBackend(hw.detectGpus())
    return r && r.recommended ? r.recommended : null
  } catch (e) { return null }
}

function noIndexError (key) {
  const opt = backendOption(key)
  const label = opt ? opt.label : key
  return {
    ok: false, code: 'BACKEND_NO_INDEX',
    error: `The platform cannot build an install command for ${label}. `
      + 'Click Torch to skip it and install it yourself, or choose another backend.',
    errorZh: `平台无法生成 ${label} 的安装命令。`
      + '可点击 torch 将其设为不安装后自行安装，或改选其他后端。',
  }
}

function torchAlt (specs, names, key) {
  const opt = backendOption(key)
  if (!opt || !opt.index) return { error: noIndexError(key) }
  return {
    alt: {
      then: ['uv', 'pip', 'install', ...specs, '--index-url', opt.index],
      why: `Install ${names.join(', ')} from the official ${opt.label} index, as selected.`,
      whyZh: `按所选后端，从 ${opt.label} 官方 index 安装 ${names.join('、')}。`,
      needs: names,
    },
  }
}

function lockRoute (dir, guess, ch, recommended) {
  const hw = require('./hardware')
  let text = ''
  try { text = fs.readFileSync(path.join(dir, guess.from), 'utf8') } catch (e) { text = '' }
  const pin = text ? hw.readTorchPin(text) : null
  const family = (text && hw.readTorchFamilyPins(text)) || []
  const wanted = family.filter((p) => !ch.exclude.has(p.name))

  let skipTorch = []
  let alt = null
  const target = ch.backend || recommended
  if (ch.backend && pin && ch.backend !== recommended) {
    if (pin.backend !== ch.backend && wanted.length) {
      const r = torchAlt(wanted.map((p) => `${p.name}==${p.plain}`),
        wanted.map((p) => p.name), ch.backend)
      if (r.error) return r.error
      alt = r.alt
      skipTorch = wanted.map((p) => p.name)
    }
  } else if (guess.alternative) {
    const keep = (guess.alternative.needs || []).filter((n) => !ch.exclude.has(n))
    skipTorch = keep
    if (keep.length) {
      const pins = (guess.alternative.familyPins || []).filter((p) => keep.includes(p.name))
      const r = torchAlt(pins.map((p) => `${p.name}==${p.plain}`), keep, target)
      if (r.error) return r.error
      alt = { ...guess.alternative, then: r.alt.then, needs: keep }
    }
  }
  const skip = [...new Set([...skipTorch, ...ch.exclude])]
  return {
    guess: {
      ...guess,
      argv: ['uv', 'sync', ...skip.flatMap((n) => ['--no-install-package', n])],
      alternative: alt,
    },
  }
}

function reroutesTorch (ch, recommended) {
  return Boolean(ch.backend && recommended && ch.backend !== recommended)
}

function declaredSpecs (dir, guess, route) {
  let text = ''
  try { text = fs.readFileSync(path.join(dir, guess.from), 'utf8') } catch (e) { return [] }
  if (route === 'pyproject') return require('./probe').probePyproject(text).dependencies || []
  return text.split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').split(';')[0].trim())
    .filter((l) => l && !l.startsWith('-') && !/^(?:git\+|https?:|file:|\.{1,2}[\\/])/i.test(l))
}

function pipRoute (dir, guess, ch, recommended, route, write) {
  const torch = []
  if (reroutesTorch(ch, recommended)) {
    for (const s of declaredSpecs(dir, guess, route)) {
      const n = specName(s)
      if (TORCH_TRIO.includes(n) && !ch.exclude.has(n)) torch.push(s.replace(/\+[\w.]+/, ''))
    }
  }
  let alt = null
  if (torch.length) {
    const r = torchAlt(torch, torch.map(specName), ch.backend)
    if (r.error) return r.error
    alt = r.alt
  }
  const names = [...new Set([...ch.exclude, ...torch.map(specName)])]
  if (write) fs.writeFileSync(path.join(dir, guess.cwd || '.', EXCLUDES_FILE), names.join('\n') + '\n')
  return {
    guess: { ...guess, argv: [...guess.argv, '--excludes', EXCLUDES_FILE], alternative: alt },
  }
}

/**
 * @param {string} dir 引擎目录
 * @param {object} guess suggestEnvCommand 的结果
 * @param {{backend?:string, exclude?:string[], recommendedBackend?:string,
 *          execute?:boolean}} input
 * @returns {{guess:object, choices:object}|{ok:false, code:string}}
 */
function applyInstallChoices (dir, guess, input = {}) {
  const ch = readChoices(input)
  const argv = (guess && guess.argv) || []
  const route = argv[1] === 'sync' ? 'lock'
    : argv[0] === 'conda' ? 'conda'
      : argv.includes('-e') ? 'pyproject'
        : argv.includes('-r') ? 'requirements' : 'other'
  const summary = { supported: route !== 'conda' && route !== 'other',
    backend: ch.backend, excluded: [...ch.exclude] }
  const recommended = input.recommendedBackend || (ch.backend ? detectRecommended() : null)
  const changed = ch.exclude.size > 0 || reroutesTorch(ch, recommended)
  if (!summary.supported || !changed) return { guess, choices: { ...summary, applied: false } }

  const r = route === 'lock' ? lockRoute(dir, guess, ch, recommended)
    : pipRoute(dir, guess, ch, recommended, route, input.execute === true)
  if (!r.guess) return r
  return { guess: r.guess, choices: { ...summary, applied: true } }
}

module.exports = { applyInstallChoices, normName, specName, EXCLUDES_FILE }
