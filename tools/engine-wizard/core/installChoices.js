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
  // versionOverrides：使用者为某个包选定的版本（包名⇒版本号）。
  //   改版本要改清单本身：uv 的排除语义是「这个包连同依赖它的其它包一起不装」，
  //   所以不能靠排除来实现改版本（依赖它的那些包会一起装不上）。
  const versionOverrides = {}
  for (const [name, ver] of Object.entries(input.versionOverrides || {})) {
    const k = normName(name)
    const v = String(ver == null ? '' : ver).trim()
    if (k && v) versionOverrides[k] = v
  }
  return { exclude, backend, upgradeTorch, torchSuggestion, versionOverrides }
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
 * 「选依赖版本」这条路线：使用者为某些包选了别的版本。
 *
 * 产出两件事：
 *   ① 主安装步指向改写过的清单副本（上游文件保持原样）；
 *   ② torch 被改版本时，主安装步跳过 torch 系，追加一步从该后端的官方
 *      index 装所选版本（index 是命令级参数，不能靠清单表达）。
 *
 * 为什么不用排除来实现改版本：uv 的排除语义是「这个包连同依赖它的其它包
 *   一起不装」，排除 einops 会把 fugashi 这些依赖它的包也弄掉。
 *
 * @param {string} dir 引擎目录
 * @param {object} guess suggestEnvCommand 的结果
 * @param {object} ch readChoices 的结果
 * @param {string} recommended 本机推荐的后端 key
 * @param {string} route 装法路线
 * @param {boolean} write 是否写清单副本（执行期才写）
 * @returns {{guess:object}|{ok:false, code:string, error:string, errorZh:string}}
 */
function versionOverrideRoute (dir, guess, ch, recommended, route, write, pythonVersion) {
  const vo = require('./versionOverrides')
  const overrides = ch.versionOverrides || {}
  const names = Object.keys(overrides)
  if (!names.length) return { guess }

  // 锁文件路线不做：版本已经锁死，改它等于改 lock 的内容，平台不替上游改。
  if (route === 'lock') {
    return {
      ok: false,
      code: 'VERSION_OVERRIDE_ON_LOCK',
      error: 'The upstream provides a lock file, so the versions are already pinned. '
        + 'The platform cannot change a pinned version without editing the lock file.',
      errorZh: '上游提供了锁文件，版本已经定死。'
        + '平台无法在不改动锁文件的前提下更改已锁定的版本。',
    }
  }

  const from = guess.from
  const isPyproject = route === 'pyproject'
  const upstreamPath = path.join(dir, from || '')

  // 先在内存里改一遍：计划阶段（execute 不带）不能写盘。
  let text = ''
  try { text = fs.readFileSync(upstreamPath, 'utf8') } catch (e) { text = '' }
  if (!text) {
    return {
      ok: false,
      code: 'MANIFEST_UNREADABLE',
      error: `Cannot read the dependency manifest (${from}).`,
      errorZh: `读不到依赖清单（${from}）。`,
    }
  }
  const r = isPyproject
    ? vo.rewritePyproject(text, overrides)
    : vo.rewriteManifest(text, overrides)
  if (!r.changed.length) {
    return {
      ok: false,
      code: 'NO_VERSION_OVERRIDE_APPLIED',
      error: `None of the chosen versions match a package in ${from}: ${r.missing.join(', ')}`,
      errorZh: `所选版本没有一项对得上 ${from} 里的包：${r.missing.join('、')}`,
    }
  }

  // torch 系那几行：上游钉的版本在本机后端上可能装不上。
  //   改写清单时它们也要一起改，否则选一个普通包的版本就会把 torch
  //   静默降级成装不上的那一版。
  //   使用者显式选了 torch 就照他选的来；没选就取本机后端上可用的版本。
  const target = ch.backend || recommended
  let torchTarget = ''
  const torchPicked = names.filter((n) => TORCH_TRIO.includes(normName(n)))
  if (!torchPicked.length && pythonVersion) {
    try {
      const { judgeTorchVersion } = require('./torchVersionProbe')
      const j = judgeTorchVersion({ dir, backend: target, pythonVersion })
      // 只有在「上游那版装不上」时才换：装得上就照上游的版本。
      if (j && j.ok === false && j.suggested) torchTarget = j.suggested
    } catch (e) { /* 判不出来 ⇒ 照上游的版本装，不闷头换 */ }
  }
  let finalText = r.text
  let torchRewritten = []
  if (torchTarget && !isPyproject) {
    const tr = vo.rewriteTorchFamily(text, overrides, {
      torchVersion: torchTarget,
      torchNames: TORCH_TRIO,
    })
    if (tr.changed.length || tr.torchRewritten.length) {
      finalText = tr.text
      torchRewritten = tr.torchRewritten
    }
  }
  // 改写之后每个包的最终 spec：界面照这份显示，
  //   就不必自己拿「上游原文 + 手写版本」拼一条出来（那份会和这里分叉）。
  const finalSpecs = specsFromManifestText(finalText)

  // 清单副本：执行期才写盘。计划阶段也写（它是平台自己的辅助文件，
  //   与 .wizard-excludes.txt 同一性质），这样计划里显示的命令就是真命令。
  const localName = vo.LOCAL_MANIFEST
  if (write) {
    fs.writeFileSync(path.join(dir, guess.cwd || '.', localName), finalText, 'utf8')
  }

  let argv = [...(guess.argv || [])]
  let alt = null
  // torch 系里被改过的：使用者显式选的，或按本机后端自动改的。
  const torchChanged = [...new Set([
    ...names.filter((n) => TORCH_TRIO.includes(normName(n))),
    ...torchRewritten,
  ])]
  // 自动改写时用的是本机后端上可用的那个版本。
  const torchVersions = {}
  for (const n of torchChanged) {
    const k = normName(n)
    torchVersions[k] = overrides[n] || overrides[k] || torchTarget
  }

  if (isPyproject) {
    // uv pip install -e . 读的是 pyproject 本身，改副本没用。
    // 所以拆成两步：先按副本装依赖，再装项目本体（-e 不带依赖）。
    const rel = argv[argv.indexOf('-e') + 1]
    const base = ['uv', 'pip', 'install', '-r', localName]
    const project = ['uv', 'pip', 'install', '-e', rel, '--no-deps']
    argv = base
    alt = { then: project, needs: [] }
  } else {
    // requirements 路线：把 -r 指到副本。
    const i = argv.indexOf('-r')
    if (i >= 0) argv[i + 1] = localName
    else argv = [...argv, '-r', localName]
  }

  if (torchChanged.length) {
    // torch 换版本 ⇒ index 也要跟着换（index 是命令级参数）。
    const target = ch.backend || recommended
    const opt = backendOption(target)
    if (!opt || !opt.index) {
      const err = noIndexError(target)
      return { ok: false, code: err.code, error: err.error, errorZh: err.errorZh }
    }
    // 主命令跳过 torch 系（清单里改过的那几行装不了：index 不同）。
    const skipNames = [...new Set([...ch.exclude, ...torchChanged.map(normName)])]
    const skipFile = EXCLUDES_FILE
    if (write) {
      fs.writeFileSync(path.join(dir, guess.cwd || '.', skipFile),
        skipNames.join('\n') + '\n')
    }
    if (argv.includes('-r')) argv = [...argv, '--excludes', skipFile]
    else argv = [...argv, ...skipNames.flatMap((n) => ['--no-install-package', n])]
    // 追加一步：按所选版本从该后端的官方 index 装。
    const specs = torchChanged.map((n) => `${normName(n)}==${torchVersions[normName(n)]}`)
    const names2 = torchChanged.map(normName)
    const ta = torchAlt(specs, names2, target)
    if (ta.error) return ta.error
    alt = ta.alt
  }

  return { guess: { ...guess, argv, alternative: alt }, specs: finalSpecs }
}

/**
 * 从改写后的清单文本里抽出每个包的最终 spec。
 *
 * 为什么界面要这个：pill 上显示的那条 spec 必须与真正装进去的那条一致。
 *   界面自己拿「上游原文 + 手写版本」拼一条出来，就会与后端写进清单副本的
 *   那条分叉（约束形式不同：上游写 >= 的时候拼出来的是 ==）。
 *   所以界面只渲染后端算好的这一份，不自己拼。
 *
 * @param {string} text 清单全文（改写后的）
 * @returns {string[]} 每个包的 spec，按清单里的顺序
 */
function specsFromManifestText (text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('-')) continue
    if (/^(?:git\+|https?:|file:|\.{1,2}[\\/])/i.test(t)) continue
    out.push(t)
  }
  return out
}

/**
 * @param {string} dir 引擎目录
 * @param {object} guess suggestEnvCommand 的结果
 * @param {{backend?:string, exclude?:string[], recommendedBackend?:string,
 *          upgradeTorch?:boolean, torchSuggestion?:object,
 *          versionOverrides?:object,
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
    upgradeTorch: ch.upgradeTorch,
    versionOverrides: { ...ch.versionOverrides } }
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
  // 选依赖版本 ⇒ 走改写清单那条路线（改清单，不是排除）。
  //   它排在换后端那条路线前面：选版本是使用者明确表达的一次选择。
  if (Object.keys(ch.versionOverrides).length) {
    if (!summary.supported) {
      return {
        ok: false, code: 'VERSION_OVERRIDE_UNSUPPORTED',
        error: 'The install method is declared by the Manifest, so the platform '
          + 'cannot change a dependency version.',
        errorZh: '安装方式由 Manifest 指定，平台无法改动依赖版本。',
      }
    }
    const r = versionOverrideRoute(dir, guess, ch, recommended, route, input.execute === true,
      input.pythonVersion)
    if (!r.guess) return r
    return { guess: r.guess, choices: { ...summary, applied: true }, specs: r.specs }
  }
  const changed = ch.exclude.size > 0 || reroutesTorch(ch, recommended)
  if (!summary.supported || !changed) {
    // 没有要改的版本时，界面照样要显示「最终要装的那条 spec」。
    //   这一份就是上游原文（没改过就是它），但仍由后端给，
    //   免得界面与后端各认一份、各拼一条出来。
    return { guess, choices: { ...summary, applied: false }, specs: upstreamSpecs(dir, guess) }
  }

  const r = route === 'lock' ? lockRoute(dir, guess, ch, recommended)
    : pipRoute(dir, guess, ch, recommended, route, input.execute === true)
  if (!r.guess) return r
  return { guess: r.guess, choices: { ...summary, applied: true }, specs: upstreamSpecs(dir, guess) }
}

/**
 * 读上游清单里每个包的 spec（没改过版本时的那一份）。
 *
 * @param {string} dir 引擎目录
 * @param {object} guess suggestEnvCommand 的结果
 * @returns {string[]} 每个包的 spec；读不到清单时返回 null
 */
function upstreamSpecs (dir, guess) {
  const from = guess && guess.from
  if (!from) return null
  let text = ''
  try { text = fs.readFileSync(path.join(dir, from), 'utf8') } catch (e) { return null }
  const specs = specsFromManifestText(text)
  return specs.length ? specs : null
}

module.exports = {
  applyInstallChoices, normName, specName, EXCLUDES_FILE,
  declaredTorchFamily,
  versionOverrideRoute,
  specsFromManifestText,
}
