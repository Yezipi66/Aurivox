'use strict'
// ============================================================================
//  PROJECT PROBE —— 从上游项目的元数据文件里**机械**提取事实
//
//  ⭐ 为什么这是「探测」而不是「猜」
//  这些值在项目自己的配置文件里写着 —— 我们只是**读**它，不推断它：
//    pyproject.toml → [project.scripts]  = 平台该起哪个命令
//                   → [project.name]    = python 包叫什么
//                   → [tool.setuptools.packages.find] where = src 布局
//    requirements.txt / environment.yml  = 依赖从哪来（决定装法）
//
//  ⛔⛔ 判据：**只提取，不推理**
//  · 提取到 → 给出值，并附上「在哪个文件哪一行」
//  · 没提取到 → 如实说没找到，⛔ 绝不用「大概率是 X」填空
//
//  ⚠ 实测依据（2026-10-03，某上游试点）：
//  我先前把 runtime.entry 和 call.module 记成「只有读过源码才知道」，
//  ⛔ 那是我判据太保守 —— 它们就在 pyproject.toml 里，机械可读。
//  这个纠正把自动填充率从 38% 提到了 53%。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const TOML_LINE = {
  name: /^\s*name\s*=\s*["']([^"']+)["']/,
  scripts: /^\s*([\w-]+)\s*=\s*["']([\w.]+):(\w+)["']\s*$/,
  where: /^\s*where\s*=\s*\[\s*["']([^"']+)["']/,
  requiresPython: /requires-python\s*=\s*["']([^"']+)["']/,
  license: /^\s*license\s*=\s*["']([^"']+)["']/,
  deps: /^\s*["']([\w.\-]+)\s*(?:[<>=!~][^"']*)?["']\s*,?\s*$/,
}

/**
 * 解析 pyproject.toml —— ⛔ 只做「行 → 值」，不做 TOML 语义分析。
 * ⛔ 拿不到就返回空结构，由调用方如实报告「没读到」。
 */
function probePyproject (text) {
  // ⭐ dependencies 要收集起来 —— Owner 2026-10-04 的第 2 步：
  //   「列出需要安装的大包，其中 torch 单独列出来」
  //   ⛔ 之前这里 `if (inDeps) continue` 把依赖**整个丢掉了**。
  const out = { found: false, scripts: {}, srcRoot: null, dependencies: [] }
  if (typeof text !== 'string') return out

  let inScripts = false
  let inProject = false
  let inDeps = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    if (/^\[project\.scripts\]$/.test(line)) { inScripts = true; continue }
    if (/^\[project\.optional-dependencies\]/.test(line)) { inScripts = false; continue }
    // ⚠⚠ 真实项目的写法是 `dependencies = [`（带 = ，在 [project] 段里），
    //   ⛔ 不是 `[project.dependencies]` 那种section —— 我原来只认后者，
    //   所以 2026-10-04 在真上游上读出 0 条依赖。
    //   两种都认：inline 数组（真项目）与 section（规范写法）。
    if (/^dependencies\s*=\s*\[/.test(line)) { inDeps = true; inProject = false; continue }
    if (/^\[project\.dependencies\]$/.test(line)) { inDeps = true; inProject = false; continue }
    if (/^optional-dependencies\s*=\s*\{/.test(line)) { inDeps = false; continue }
    if (/^\[/.test(line)) {
      // 新的 section
      inScripts = false; inDeps = false
      if (/^\[project\]$/.test(line)) inProject = true
      out.found = true
      continue
    }

    if (inScripts) {
      const m = line.match(TOML_LINE.scripts)
      if (m) out.scripts[m[1]] = { module: m[2], attr: m[3] }
      continue
    }
    if (inDeps) {
      // ⛔ 只取「包名 + 版本约束」这一行（"torch>=2.5.0", 这行 TOML 惯例是裸字符串）
      const m = line.match(TOML_LINE.deps)
      if (m) out.dependencies.push(line.replace(/,$/, '').replace(/^["']|["']$/g, ''))
      continue
    }

    if (inProject) {
      if (!out.name) {
        const m = line.match(TOML_LINE.name)
        if (m) out.name = m[1]
      }
      const m = line.match(TOML_LINE.requiresPython)
      if (m) out.requiresPython = m[1]
      const m2 = line.match(TOML_LINE.license)
      if (m2 && !out.license) out.license = m2[1]
    }
    const w = line.match(TOML_LINE.where)
    if (w) out.srcRoot = w[1]
  }
  return out
}

/** 探测一个依赖清单文件名 —— 决定我们走 uv pip 还是上游脚本 */
function detectDependencyFile (filenames) {
  // ⛔ note 是**用户可见**的（StepPrepare 的「依赖清单」那栏直接渲染它）⇒
  //   只说「识别到哪个文件」，⛔ 不说「因此用哪种装法」——
  //   那是判据，属维护者的信息。装法由 suggestEnvCommand 单独产出。
  const order = [
    { f: 'pyproject.toml', kind: 'pyproject' },
    { f: 'uv.lock', kind: 'lock' },
    { f: 'requirements.txt', kind: 'requirements' },
    { f: 'environment.yml', kind: 'conda' },
    { f: 'setup.py', kind: 'setup' },
  ]
  const hit = []
  for (const o of order) if (filenames.includes(o.f)) hit.push(o)
  if (hit.length === 0) {
    return { found: false,
    note: 'No dependency manifest found (pyproject.toml / uv.lock / requirements.txt / '
      + 'environment.yml) — follow the project README to install, or use a '
      + 'repository that ships one.',
    noteZh: '未找到依赖清单（pyproject.toml / uv.lock / requirements.txt / '
      + 'environment.yml）。请按项目 README 安装，或改用带依赖清单的仓库。' }
  }
  return {
    found: true,
    primary: hit[0],
    all: hit,
    // ⛔ 只列识别到的文件名。⛔ 不说「因此用哪种装法」——
    //   那是判据（装法由 suggestEnvCommand 单独产出），用户不需要看到。
    note: hit.map((h) => h.f).join('；'),
  }
}

/**
 * ⭐ 主入口：把探测结果变成可以直接填进名片的值。
 * @param {{pyproject?:string, filenames?:string[], pythonHint?:string}} input
 */
function probeProject (input = {}) {
  const py = probePyproject(input.pyproject)
  const files = input.filenames || []
  const deps = detectDependencyFile(files)
  const values = {}
  const sources = {}     // ⭐ 每个值都要能说清「从哪来」
  const unfilled = []

  // ---- 包名 ⇒ call.module ----
  if (py.name) {
    values['call.module'] = py.name
    sources['call.module'] = 'pyproject.toml [project.name]'
  } else if (Object.keys(py.scripts).length) {
    // 没有 [project.name]？退一步用 console 脚本的模块名（还是读出来的，不是猜的）
    const mod = Object.values(py.scripts)[0].module.split('.')[0]
    values['call.module'] = mod
    sources['call.module'] =
      `pyproject.toml [project.scripts]（${Object.keys(py.scripts)[0]} = ${Object.values(py.scripts)[0].module}）`
  } else {
    unfilled.push({
      key: 'call.module',
      why: 'Neither [project.name] nor [project.scripts] in pyproject — '
        + 'the python package name cannot be read; check the source directory.',
      whyZh: 'pyproject 里既没有 [project.name] 也没有 [project.scripts]：'
        + 'python 包名读不出来，得看源码目录',
      example: 'my_tts',
    })
  }

  // ---- console 脚本 ⇒ runtime.entry ----
  const scriptNames = Object.keys(py.scripts)
  if (scriptNames.length === 1) {
    values['runtime.entry'] = scriptNames[0]
    sources['runtime.entry'] = `pyproject.toml [project.scripts].${scriptNames[0]}`
  } else if (scriptNames.length > 1) {
    unfilled.push({
      key: 'runtime.entry',
      why: `Upstream provides ${scriptNames.length} commands (${scriptNames.join(', ')}), ` 
        + 'cannot tell which one is the inference service.',
      whyZh: `上游给了 ${scriptNames.length} 个命令（${scriptNames.join(', ')}）`
        + '，平台无法判断其中哪个是推理服务',
      example: scriptNames[0],
    })
  } else {
    unfilled.push({
      key: 'runtime.entry',
      why: 'pyproject has no [project.scripts] — upstream likely only '
        + 'provides a python API, with no ready-made service command.',
      whyZh: 'pyproject 里没有 [project.scripts] ⇒ 上游可能只提供 python API，'
        + '没有现成的服务命令',
      example: 'serve.py / api.py（要我们自己写）',
    })
  }

  // ---- src 布局 ⇒ 装法 ----
  if (py.srcRoot) {
    values.installMode = 'pyproject-src-layout'
    sources.installMode = `pyproject.toml [tool.setuptools.packages.find].where = ${py.srcRoot}`
  }

  return {
    values, sources, unfilled,
    meta: {
      packageName: py.name || null,
      consoleScripts: py.scripts,
      srcRoot: py.srcRoot,
      requiresPython: py.requiresPython || null,
      license: py.license || null,
      dependencies: deps,
    },
  }
}


/**
 * ⭐⭐ 第 2 步的核心：读依赖 → 拆出 torch 系 → 跟本机比对出绿/黄/白。
 *
 * ⭐ 判据来源：
 *   · 依赖列表 —— 上游 pyproject.toml 里写的（**不是我们猜的**）
 *   · torch 系怎么判 —— 包名（hardware.js 的 TORCH_FAMILY）
 *   · 绿/黄/白 —— 跟本机推荐后端比对（hardware.js 的 judgeTorchSpec）
 *
 * ⛔⛔ 纪律：不许出现任何具体引擎名。
 */
function planDependencies (text, opts = {}) {
  const { probePyproject: _p } = { probePyproject }
  const parsed = probePyproject(text)
  const hw = opts.hardware || null        // ⛔ 没检测就不判断（不猜）
  const deps = parsed.dependencies || []

  if (deps.length === 0) {
    return {
      ok: false,
      code: 'NO_DEPENDENCIES',
      error: 'The upstream pyproject.toml does not expose a dependency list.\n'
        + 'That does not necessarily mean it has no dependencies (they may live in uv.lock / '
        + 'requirements.txt / a subdirectory); try a repository that ships a manifest, or follow '
        + 'the upstream instructions.',
      errorZh: '上游的 pyproject.toml 里没读到依赖列表。\n'
        + '这不一定说明它没依赖（可能在 uv.lock / requirements.txt / 子目录里），'
        + '请换一份带依赖清单的仓库再来，或按上游说明自己安装。',
    }
  }

  // ⛔ 拆包：只有 torch 系需要单独处理（Owner 说的）
  const { splitTorchPackages } = require('./hardware')
  const { torchish, rest } = splitTorchPackages(deps)

  // ⭐ torch 系：每一个都判一次绿/黄/白（⛔ 不只判一个就代表全部）
  const torchGroup = torchish.map((spec) => {
    const name = spec.split(/[<>=!~\[]/)[0].trim().toLowerCase()
    const isMain = name === 'torch'
    // ⭐ 只对 torch 本体做后端判断；torchvision/torchaudio 是跟着 torch 走的
    const j = isMain && hw
      ? require('./hardware').judgeTorchSpec(spec, hw.recommended)
      : null
    return {
      spec, name,
      isMain,
      verdict: j ? j.verdict : (hw ? 'unknown' : 'unknown'),
      why: j ? j.why
        : isMain ? 'This machine was not detected — cannot tell whether this package will work.'
        // ⛔ 没锁定 torch 后端时无法判断，但 ⛔ 不给理由（那是判据）。
        //   后端由 torch 的版本决定，lock 里没写就说不出是哪个。
          : 'The backend is decided by the Torch version, which is not declared in the lock.'
      , whyZh: j ? j.whyZh
        : isMain ? '未检测本机，无法判断该包能否使用'
          : '后端由 torch 的版本决定，lock 中未声明'
    }
  })

  // ⚠ 整体结论 = torch 本体那一行的判定
  const mainRow = torchGroup.find((r) => r.isMain) || null
  const overall = mainRow ? mainRow.verdict : (hw ? 'unknown' : 'unknown')

  return {
    ok: true,
    deps: {
      total: deps.length,
      // ⭐ 其它依赖「直接同步就行」—— 原话照 Owner 的意思：
      //   「其实除了 Torch 一般没有什么风险，其他直接同步都行」
      normal: { count: rest.length, packages: rest, action: 'sync' },
      torch: { count: torchGroup.length, packages: torchGroup, action: 'choose-backend' },
    },
    // ⭐ gpus 也要带上 —— 界面上要写「检测到 Intel(R) Arc(TM) 140T」
    //   （2026-10-04 实测踩过：漏了它，界面只剩「推荐 ipex」，
    //    用户看不到凭什么推荐 ipex）
    hardware: hw ? {
      gpus: hw.gpus || [],
      recommended: hw.recommended, reason: hw.reason,
      confidence: hw.confidence, caveat: hw.caveat, options: hw.options,
    } : null,
    verdict: overall,
  }
}

module.exports = { probePyproject, probeProject, detectDependencyFile, planDependencies }