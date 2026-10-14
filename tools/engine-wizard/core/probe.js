'use strict'
const TOML_LINE = {
  name: /^\s*name\s*=\s*["']([^"']+)["']/,
  scripts: /^\s*([\w-]+)\s*=\s*["']([\w.]+):(\w+)["']\s*$/,
  where: /^\s*where\s*=\s*\[\s*["']([^"']+)["']/,
  requiresPython: /requires-python\s*=\s*["']([^"']+)["']/,
  license: /^\s*license\s*=\s*["']([^"']+)["']/,
  deps: /^\s*["']([\w.\-]+)\s*(?:[<>=!~][^"']*)?["']\s*,?\s*$/,
}

function probePyproject (text) {
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
      // 只取「包名 + 版本约束」这一行（"torch>=2.5.0", 这行 TOML 惯例是裸字符串）
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

function parseRequirements (text) {
  const out = { found: false, dependencies: [], specs: [], skipped: 0 }
  if (typeof text !== 'string' || !text) return out
  out.found = true

  const seen = new Set()
  let continued = false

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()

    // 续行：上一行以 `\` 结尾 ⇒ 这一行是它的延续，不是独立依赖
    if (continued) {
      if (line.endsWith('\\')) continue
      continued = false
      if (!line) continue
      // 续行落在新行之后：只有当它自己是一整条依赖时才收（`-r` 这类选项行不算）
    }

    if (!line || line.startsWith('#')) continue

    // 行尾注释要剥掉：`包名==1.0  # 说明` ⇒ `包名==1.0`
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash).trim()
    if (!line) continue

    // 行尾续行标记：本行不是一条完整依赖，下一行才是它的延续
    if (line.endsWith('\\')) { continued = true; continue }

    // 选项行：-r / -e / -c / --index-url / --hash / --find-links
    if (line.startsWith('-')) { out.skipped++; continue }

    // 环境标记 `;` 之后是条件，只取分号前的依赖声明
    const semi = line.indexOf(';')
    if (semi >= 0) line = line.slice(0, semi).trim()
    if (!line) { out.skipped++; continue }

    // 直连来源：git+https / http(s) / file / 本地路径 ⇒ 不是普通依赖
    if (/^(?:git\+|https?:|file:|\.{1,2}[\\/])/i.test(line)) { out.skipped++; continue }
    // PEP 508 直引：`包名 @ https://…` ⇒ 同样不是普通依赖
    if (/@\s*\S/.test(line)) { out.skipped++; continue }

    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/)
    if (!m) { out.skipped++; continue }
    const name = m[1]
    const tail = m[2]
    // 名字后面只能跟两种东西（PEP 508 的形状）：
    //   ① extras：fastapi[all]
    //   ② **紧贴**的版本约束：torch>=2.5.0 / torch == 2.5.0 里第二种不合法
    //   ③ 或者什么都没有（裸包名）
    //
    //   关键：合法的比较算子**必须是两个字符或单个 < >**，
    //   **单个 `=` 不是算子**：它是赋值。
    //   这条规则同时挡住了 TOML 赋值行：
    //     name = "speechkit"        ⇒ 尾随 `= "speechkit"`，是赋值
    //     license = "Apache-2.0"    ⇒ 同上
    //     requires-python = ">=3.10" ⇒ 同上
    //   （实测：这条守卫就是被「拿 parseRequirements 解析 pyproject 文本」
    //     逼出来的：那几个 TOML 键名本来被读成了包名。）
    if (tail && !/^(?:\[[^\]]*\])?(?:===|==|!=|<=|>=|~=|<|>)/.test(tail)) {
      out.skipped++; continue
    }

    const key = name.toLowerCase().replace(/[-_.]+/g, '-')
    if (seen.has(key)) continue
    seen.add(key)
    out.dependencies.push(name)
    out.specs.push(name + tail.replace(/\s+/g, ''))
  }
  return out
}

/** 从 setup.py 文本里读 `name=`：只正则读文本，绝不 import 它 */
function parseSetupPyName (text) {
  if (typeof text !== 'string' || !text) return null
  const m = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
  return m ? m[1].trim() || null : null
}

/** 探测一个依赖清单文件名：决定我们走 uv pip 还是上游脚本 */
function detectDependencyFile (filenames) {
  // note 是**用户可见**的（StepPrepare 的「依赖清单」那栏直接渲染它）⇒
  //   只说「识别到哪个文件」，不说「因此用哪种装法」，
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
    // 只列识别到的文件名。不说「因此用哪种装法」，
    //   那是判据（装法由 suggestEnvCommand 单独产出），用户不需要看到。
    note: hit.map((h) => h.f).join('；'),
  }
}

function probeProject (input = {}) {
  const py = probePyproject(input.pyproject)
  const req = parseRequirements(input.requirements)
  const files = input.filenames || []
  const deps = detectDependencyFile(files)
  const values = {}
  const sources = {}     // 每个值都要能说清「从哪来」
  const unfilled = []

  // ---- 包名 ⇒ call.module ----
  // 来源优先级：pyproject 的 [project.name] → pyproject 的 scripts 模块名
  //   → setup.py 的 name=。顺序与 detectDependencyFile 一致（pyproject 优先）。
  let packageName = py.name || null
  // 来源与值**同进同出**：没有值就没有来源。
  //   不预写一个来源再等值来填：那样会出现「值是空的，来源却写得很确定」，
  //     界面上读起来就成了「平台在 pyproject 里读到了包名」，那是假的。
  let packageNameFrom = py.name ? 'pyproject.toml [project.name]' : null
  if (!packageName && Object.keys(py.scripts).length) {
    // 没有 [project.name]？退一步用 console 脚本的模块名（还是读出来的，不是猜的）
    packageName = Object.values(py.scripts)[0].module.split('.')[0]
    const first = Object.keys(py.scripts)[0]
    packageNameFrom =
      `pyproject.toml [project.scripts]（${first} = ${Object.values(py.scripts)[0].module}）`
  }
  if (!packageName && input.setupPy) {
    const fromSetup = parseSetupPyName(input.setupPy)
    if (fromSetup) { packageName = fromSetup; packageNameFrom = 'setup.py name=' }
  }

  if (packageName) {
    values['call.module'] = packageName
    sources['call.module'] = packageNameFrom
  } else {
    unfilled.push({
      key: 'call.module',
      why: 'Neither [project.name] nor [project.scripts] in pyproject, and setup.py '
        + 'declares no name; the python package name cannot be read from these files; '
        + 'check the source directory.',
      whyZh: 'pyproject 里既没有 [project.name] 也没有 [project.scripts]，'
        + 'setup.py 里也没写 name：python 包名读不出来，得看源码目录',
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

  // ---- 许可证 ⇒ license ----
  // pyproject 写了 license 就用它（那是最精确的来源）。
  // 没写但根目录有 LICENSE / COPYING ⇒ **只报「识别到许可证文件」**。
  //   不自己判是 Apache-2.0 还是 MIT：那是读正文做判断，
  //     平台在这里只做「文件在不在」这一件事。
  //
  // 值字段只装**许可证标识**（SPDX id 或 pyproject 里写的原文），不装句子。
  //   ⚠ 这条字段是直接渲染到界面上的（StepPrepare.jsx 的 plan-kv）：
  //     一旦在这里塞「LICENSE file detected (LICENSE)」这种句子，
  //     界面上就会出现一句英文描述，而它本该是元数据。
  //   ⇒ 「只看到许可证文件、读不出是哪一种」这个事实放在 licenseEvidence，
  //     由界面翻译成人话（license + licenseFile + licenseEvidence 三者一起显示）。
  let license = py.license || null
  let licenseFrom = py.license ? 'pyproject.toml [project.license]' : null
  // 事实字段（机器读）：'file-only' = 只看到许可证文件，没读出是哪一种。
  let licenseEvidence = py.license ? 'identifier' : null
  if (!license && input.licenseFile) {
    licenseEvidence = 'file-only'
  }

  return {
    values, sources, unfilled,
    meta: {
      packageName,
      packageNameFrom,
      consoleScripts: py.scripts,
      srcRoot: py.srcRoot,
      requiresPython: py.requiresPython || null,
      license,
      licenseFrom,
      licenseEvidence,
      licenseFile: input.licenseFile || null,
      dependencies: deps,
      // 第 1 步顺手把 requirements 的包名也读出来（与第 2 步同一份解析器）
      requirementPackages: req.dependencies,
    },
  }
}


function planDependencies (text, opts = {}) {
  const pyDeps = probePyproject(text).dependencies || []
  const reqParsed = parseRequirements(opts.requirements)
  const fromPyproject = pyDeps.length > 0
  const deps = fromPyproject ? pyDeps : reqParsed.specs
  const source = fromPyproject ? 'pyproject.toml' : 'requirements.txt'

  const hw = opts.hardware || null        // 没检测就不判断（不猜）

  if (deps.length === 0) {
    // 2026-10-12：文案改了。原来那句「可能在 requirements.txt 里」
    //   是**这个函数自己写的**，而它**从来没读过 requirements.txt**
    //：代码说的和代码做的不一致。现在真的读了。
    //   两份清单都没有才说「读不到」，且只说读不到，不提换仓库。
    const hadReq = typeof opts.requirements === 'string' && opts.requirements
    return {
      ok: false,
      code: 'NO_DEPENDENCIES',
      error: (hadReq
        ? 'The upstream requirements.txt has no readable dependency line '
          + '(every line may be an option, a direct link, or a continuation).\n'
        : 'This repository has neither pyproject.toml with a dependency list '
          + 'nor a readable requirements.txt, so the dependency list cannot be read.\n')
        + 'It may live in uv.lock, a subdirectory, or a file named differently; '
        + 'follow the upstream instructions to install.',
      errorZh: (hadReq
        ? '上游的 requirements.txt 里没有读到依赖行'
          + '（每一行都是选项、直连来源或续行）。\n'
        : '这个仓库既没有带依赖列表的 pyproject.toml，也没有能读的 '
          + 'requirements.txt，读不到依赖列表。\n')
        + '它可能放在 uv.lock、子目录里，或换了别的文件名；请按上游说明自行安装。',
      dep_source: null,
    }
  }

  // 拆包：只有 torch 系需要单独处理（Owner 说的）
  const { splitTorchPackages } = require('./hardware')
  const { torchish, rest } = splitTorchPackages(deps)

  // torch 系：每一个都判一次绿/黄/白（不只判一个就代表全部）
  const torchGroup = torchish.map((spec) => {
    const name = spec.split(/[<>=!~\[]/)[0].trim().toLowerCase()
    const isMain = name === 'torch'
    // 只对 torch 本体做后端判断；torchvision/torchaudio 是跟着 torch 走的
    const j = isMain && hw
      ? require('./hardware').judgeTorchSpec(spec, hw.recommended)
      : null
    return {
      spec, name,
      isMain,
      verdict: j ? j.verdict : (hw ? 'unknown' : 'unknown'),
      why: j ? j.why
        : isMain ? 'This machine was not detected — cannot tell whether this package will work.'
        // 没锁定 torch 后端时无法判断，但 不给理由（那是判据）。
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
    // 这次依赖是从**哪个文件**读出来的：界面与维护者都要知道，
    //   不然「怎么读到的」这件事就只能靠猜。
    dep_source: source,
    dep_count: deps.length,
    deps: {
      total: deps.length,
      // 其它依赖「直接同步就行」：原话照 Owner 的意思：
      //   「除了 Torch 一般没有什么风险，其他直接同步都行」
      normal: { count: rest.length, packages: rest, action: 'sync' },
      torch: { count: torchGroup.length, packages: torchGroup, action: 'choose-backend' },
    },
    hardware: hw ? {
      gpus: hw.gpus || [],
      recommended: hw.recommended, reason: hw.reason, reasonZh: hw.reasonZh,
      confidence: hw.confidence, caveat: hw.caveat, caveatZh: hw.caveatZh,
      options: hw.options,
    } : null,
    verdict: overall,
  }
}

module.exports = {
  probePyproject, probeProject, detectDependencyFile, planDependencies,
  parseRequirements, parseSetupPyName,
}