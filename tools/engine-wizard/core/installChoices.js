'use strict'
// 第 2 步「装哪些包」的选择：用户可以跳过任意包，也可以换 torch 后端，
// 还可以接受「升级 torch 到本机后端上可用版本」的建议。
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
  // upgradeTorch：使用者接受「把 torch 升到本机后端上可用版本」这条建议。
  //   true = 接受，false/null = 不接受（保持上游钉的版本）。
  //   建议本身由探测层给出（core/torchVersionProbe.js），这里只消费结果。
  const upgradeTorch = input.upgradeTorch === true
  // torchSuggestion：探测层给出的建议（{declared, suggested, pythonVersion, ...}）。
  //   没有建议时是 null；接受升级却没有建议 ⇒ 如实报出来，不闷头改版本。
  const torchSuggestion = input.torchSuggestion || null
  return { exclude, backend, upgradeTorch, torchSuggestion }
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

/**
 * 上游声明里有哪些 torch 系包（用哪个版本）。
 *
 * 升级时整族一起升：torch 与 torchaudio 的版本必须配对，
 *   只升一个会留下版本不配对的那一个（症状是 import 时找不到依赖库）。
 *   上游没声明的兄弟包不凭空加。
 *
 * @returns {{name:string, spec:string}[]}
 */
function declaredTorchFamily (dir, guess, route) {
  const out = []
  for (const s of declaredSpecs(dir, guess, route)) {
    const n = specName(s)
    if (!TORCH_TRIO.includes(n)) continue
    if (out.some((x) => x.name === n)) continue
    out.push({ name: n, spec: s.replace(/\+[\w.]+/, '') })
  }
  return out
}

/**
 * 「接受升级建议」这条路线：上游钉的 torch 版本在本机后端上不可用，
 *   使用者接受改成那个后端上可用的版本。
 *
 * 产出两件事：
 *   ① 主安装步跳过 torch 系（上游钉的版本装不上，硬装必然失败）；
 *   ② 追加一步：从本机后端的官方 index 装建议版本的 torch 整族。
 *
 * @param {string} dir 引擎目录
 * @param {object} guess suggestEnvCommand 的结果
 * @param {object} ch readChoices 的结果
 * @param {string} recommended 本机推荐的后端 key
 * @param {string} route 装法路线
 * @param {boolean} write 是否写排除清单文件（执行期才写）
 * @returns {{guess:object}|{ok:false, code:string}}
 */
function upgradeTorchRoute (dir, guess, ch, recommended, route, write) {
  const target = ch.backend || recommended
  const opt = backendOption(target)
  if (!opt || !opt.index) return noIndexError(target)
  const suggestion = ch.torchSuggestion
  if (!suggestion || !suggestion.suggested) {
    return {
      ok: false, code: 'NO_TORCH_SUGGESTION',
      error: 'No Torch version was proposed for this backend, so the upgrade cannot be applied.',
      errorZh: '没有为该后端提出可用的 Torch 版本，无法执行这次升级。',
    }
  }
  const version = suggestion.suggested
  // 整族：上游声明了哪些就升哪些，没声明的不加。
  const family = declaredTorchFamily(dir, guess, route)
  const specs = family.length
    ? family.map((p) => `${p.name}==${version}`)
    : [`torch==${version}`]
  const names = family.length ? family.map((p) => p.name) : ['torch']

  const r = torchAlt(specs, names, target)
  if (r.error) return r.error
  const alt = {
    ...r.alt,
    why: `The upstream pins Torch ${suggestion.declared}, which has no wheel for `
      + `Python ${suggestion.pythonVersion} on the ${opt.label} backend. `
      + `Installing version ${version} from the official ${opt.label} index instead.`,
    whyZh: `上游把 Torch 钉在 ${suggestion.declared}，而该版本在 ${opt.label} 后端上`
      + `没有适配 Python ${suggestion.pythonVersion} 的轮子。`
      + `改为从 ${opt.label} 官方 index 安装版本 ${version}。`,
  }

  // 主安装步：跳过 torch 系（被排除的包连同依赖它的其它包一起不装）。
  const skipNames = [...new Set([...ch.exclude, ...names])]
  if (route === 'lock') {
    return {
      guess: {
        ...guess,
        argv: ['uv', 'sync', ...skipNames.flatMap((n) => ['--no-install-package', n])],
        alternative: alt,
      },
    }
  }
  if (write) {
    fs.writeFileSync(path.join(dir, guess.cwd || '.', EXCLUDES_FILE),
      skipNames.join('\n') + '\n')
  }
  return {
    guess: { ...guess, argv: [...guess.argv, '--excludes', EXCLUDES_FILE], alternative: alt },
  }
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
 *          upgradeTorch?:boolean, torchSuggestion?:object,
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
    backend: ch.backend, excluded: [...ch.exclude],
    upgradeTorch: ch.upgradeTorch }
  const recommended = input.recommendedBackend || (ch.backend ? detectRecommended() : null)
  // 接受升级建议 ⇒ 走升级路线（它自带「跳过 torch 系 + 追加装建议版本」两步）。
  //   它排在换后端那条路线前面：升级是使用者明确表达的一次选择，
  //   换后端只是「选了哪个 index」。
  if (ch.upgradeTorch) {
    if (!summary.supported) {
      return {
        ok: false, code: 'BACKEND_NO_INDEX',
        error: 'The install method is declared by the Manifest, so the platform '
          + 'cannot change the Torch version.',
        errorZh: '安装方式由 Manifest 指定，平台无法改动 Torch 版本。',
      }
    }
    const r = upgradeTorchRoute(dir, guess, ch, recommended, route, input.execute === true)
    if (!r.guess) return r
    return { guess: r.guess, choices: { ...summary, applied: true } }
  }
  const changed = ch.exclude.size > 0 || reroutesTorch(ch, recommended)
  if (!summary.supported || !changed) return { guess, choices: { ...summary, applied: false } }

  const r = route === 'lock' ? lockRoute(dir, guess, ch, recommended)
    : pipRoute(dir, guess, ch, recommended, route, input.execute === true)
  if (!r.guess) return r
  return { guess: r.guess, choices: { ...summary, applied: true } }
}

module.exports = {
  applyInstallChoices, normName, specName, EXCLUDES_FILE,
  declaredTorchFamily,
}
