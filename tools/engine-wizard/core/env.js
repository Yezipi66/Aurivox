'use strict'
// ============================================================================
//  ENV —— 第 3 步：建这台引擎自己的 Python 环境
//
//  ⭐ 本文件只有一个职责：**照名片跑它给的那条命令**，不替用户决定装法。
//
//  为什么这么克制
//  ⚠ lib/engines/installPlan.js 已按 ONBOARDING_PLAN A4' 退役（B 方案）；
//    下面记的是它当初的判据，判据仍成立，只是出处已退役：
//    「建环境的命令。名片必须自己说，平台不猜 ——
//      uv / poetry / pip -r / conda 各家都不一样，
//      **猜错的表现是装了一半才炸**。」
//  ⇒ 所以这里 ⛔ 没有「如果没有 env_command 就用 uv sync」这种分支。
//    那种分支就是猜，而且是最贵的那种猜（装到一半炸，磁盘留一半）。
//
//  ⛔ 关于 torch
//  torch / torchaudio / torchvision / onnxruntime 体积大且 GPU 专属，
//  上游通常**单独装**（本项目 README:177 就是这么做的，torch 由
//  install_torch.ps1 单独 --no-deps 装）。
//  ⛔ 本文件不碰 torch —— 上游的 env_command 里写什么就跑什么。
//    如果它没有包含 torch，那是上游的选择，如实照做。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { projectRoot, engineDir } = require('./clone.js')

/** 名片里的 env_command 必须是什么形状 —— 与已退役的 installPlan.js:46-55 同一条判据 */
function readEnvCommand (manifest) {
  const inst = manifest && manifest.install
  if (inst === undefined || inst === null) {
    // ⚠ 2026-10-05 Owner 反复强调：界面文案不要用这种口吻
    // ⛔ 原文案三个毛病：
    //   ① 「这不是错 —— 契约里明确允许」—— 拿我们的契约去安慰用户，
    //      用户不关心契约，他要知道**现在该怎么办**；
    //   ② 「平台不会替你猜装法」—— 把**内部设计原则**讲出来，
    //      等于跟用户解释我们为什么这么写代码，他不需要知道；
    //   ③ 「但向导这一步就没东西可跑了」—— 说的是**我们的**实现，
    //      不是用户的目标。用户的目标是「把这台引擎装上」。
    // ✅ 现在只说：① 缺什么 ② 怎么补 ③ 补了之后会怎样。
    return {
      ok: false, code: 'NO_INSTALL_SECTION',
      whatToDo: 'Manifest 尚未声明 install.env_command，'
        + '该字段用于确定依赖安装方式。\n'
        + '可选两种处理方式：\n'
        + '  ① 暂时跳过本步骤，在第 4 步填写 Manifest 时声明 '
        + 'install.env_command，然后返回本步骤执行；\n'
        + '  ② 按上游说明在 engines/<引擎 id>/ 内自行创建环境，'
        + '平台会检测到该环境已就绪。',
      error: 'Manifest 尚未声明 install.env_command，该字段用于确定依赖安装方式。\n'
        + '可在第 4 步填写 Manifest 后返回执行；'
        + '也可按上游说明在 engines/<引擎 id>/ 内自行创建环境，'
        + '平台会检测到。',
    }
  }
  const cmd = inst.env_command
  if (cmd === undefined || cmd === null) {
    return {
      ok: false, code: 'NO_ENV_COMMAND',
      error: '名片里有 install 段，但没写 install.env_command。\n'
        + 'uv / poetry / pip -r / conda 各家不一样，平台不猜。\n'
        + '照上游的安装说明写这一行，例如：\n'
        + '  "env_command": ["uv", "sync"]\n'
        + '  "env_command": ["uv", "pip", "install", "-r", "requirements.txt"]',
    }
  }
  if (!Array.isArray(cmd) || cmd.length === 0
      || cmd.some((s) => typeof s !== 'string' || !s.trim())) {
    return {
      ok: false, code: 'BAD_ENV_COMMAND',
      error: 'install.env_command 必须是**非空的字符串数组**（argv 形式），'
        + '例如 ["uv","sync"]。\n'
        + '写成一整行命令会在含空格的路径上被错误拆分，排查困难。',
    }
  }
  return { ok: true, argv: cmd.map((s) => s.trim()) }
}

/** 上游的依赖清单在哪 —— 只**报**，不替用户选装法 */
/**
 * ⭐⭐ 从**上游自己的依赖清单**推出装法（2026-10-05）
 *
 * ⚠ 为什么加这个（Owner 抓到的一个死结）：
 *   原来第 2 步只认「名片写好的 install.env_command」，
 *   ⛔ 而名片是**第 4 步**才写的 ⇒ 用户从第 1 步一路走过来，
 *      到第 2 步必然卡住：「名片里没有 install 段」。
 *   ⛔ 那等于向导逼着用户**先跳回去填名片**才能装环境。
 *
 * ✅ 依据：第 1 步的探测**已经读到了上游的清单文件名**
 *   （pyproject.toml / uv.lock / requirements.txt / environment.yml），
 *   ⭐ 而且这些文件名本身就决定了装法 ——
 *   有 uv.lock ⇒ 版本已定，照它装；只有 requirements.txt ⇒ uv pip -r。
 *   ⛔ 但**只根据文件存在与否**，⛔ 不猜包名、不猜版本。
 *
 * ⚠ 名片的 install.env_command **仍然优先** ——
 *   名片作者知道这台引擎的特殊装法（要编译、要特定源…），
 *   探测推出的只是「常规装法」，⛔ 不能盖过名片。
 *
 */

/**
 * ⭐⭐ 锁文件装不了本机后端时，给出**第二条**命令（两条都给，平台不拍板）。
 *
 * 问题的实况（实测某台已装引擎的 uv.lock）：lock 里写的是
 *   torch 2.8.0+cu128  source = download.pytorch.org/whl/cu128
 *   另带 38 个 nvidia-*-cu12
 * ⇒ `uv sync` 会照装一整套 CUDA。而 lock 锁的是**版本号**，⛔ 不是后端：
 *   同一个 2.8.0 在 xpu / cpu / rocm 线上各有 wheel
 *   （实测 torch-2.8.0+xpu-cp311-cp311-win_amd64.whl 存在）。
 *   ⇒ 想换后端**不必放弃锁文件**：记下版本号，只重建 torch。
 *
 * ⛔ 本函数**只产出一条建议**，不执行、不判断哪条对 ——
 *   平台只验不建 ⇒ 用哪条由使用者决定。
 *
 * @param {string} dir 清单所在目录
 * @param {string} lockRel lock 相对路径（可能带一层子目录）
 * @returns {{argv:string[], why:string, needs:string[]}|null}
 *   null = 读不出 torch 版本 / 锁的后端与推荐一致 / 推荐后端没有官方 index
 */
function suggestBackendAlternative (dir, lockRel) {
  let hw
  try {
    hw = require('./hardware.js')
  } catch (e) { return null }
  if (!hw || typeof hw.readTorchPin !== 'function') return null

  let text
  try { text = fs.readFileSync(path.join(dir, lockRel), 'utf8') } catch (e) { return null }

  const pin = hw.readTorchPin(text)
  if (!pin || !pin.plain) return null

  let rec
  try { rec = hw.recommendBackend(hw.detectGpus()) } catch (e) { return null }
  if (!rec || !rec.recommended) return null

  // ⛔ 一致时不给第二条：没有需要解决的问题，多给一条只是噪音
  if (pin.backend && pin.backend === rec.recommended) return null

  const opt = (hw.BACKEND_PREFERENCE || []).find((b) => b.key === rec.recommended)
  if (!opt || !opt.index) return null   // ⛔ 没有官方 index ⇒ 平台给不出命令

  // 只重建 torch；锁文件里的其余包照旧（那才是锁文件的价值）
  return {
    argv: ['uv', 'pip', 'install', `torch==${pin.plain}`, '--index-url', opt.index],
    why: `锁文件指定的是 CUDA 版（${pin.version}），与本机推荐的后端（${opt.label}）不一致。`
      + `可保留锁定的版本号 ${pin.plain}，改从 ${opt.label} 的官方 index 安装 torch；`
      + '锁文件中的其余依赖保持不变。',
    needs: ['torch'],
  }
}

/**
 * 按上游的依赖清单推导安装方式。
 * @param {string} dir 引擎目录
 * @returns {{argv:string[]|null, from:string|null, why:string}}
 */
function suggestEnvCommand (dir) {
  // ⚠⚠ 2026-10-05 实测踩到：**清单常常不在根目录**。
  //   实测某台已装引擎的依赖清单在 infer/requirements.txt ——
  //   ⛔ 只看根目录就判定「没有依赖清单」⇒ 第 2 步又卡住。
  // ✅ 所以往下找一层，但：
  //   ⛔ 必须排除 .venv / site-packages —— 里面的 requirements.txt
  //      是**某个依赖自己的**依赖，不是这台引擎的（实测那里有好几份）。
  //   ⛔ 排除第三方目录（third_party / vendor / node_modules）——
  //      那是上游 vendored 的别人的项目。
  const NAMES = ['pyproject.toml', 'uv.lock', 'requirements.txt', 'environment.yml']
  const SKIP = new Set(['.venv', 'venv', 'site-packages', 'node_modules',
    'third_party', 'vendor', '.git', '__pycache__'])
  const found = []
  let rootLevelLock = null
  for (const f of NAMES) {
    // 根目录优先（锁文件 > pyproject > requirements）
    if (fs.existsSync(path.join(dir, f))) {
      found.push(f)
      if (f === 'uv.lock') rootLevelLock = f
    }
  }
  if (found.length === 0) {
    // 根目录没有 ⇒ 往下找**一层**（真实项目里清单就在一层子目录里）
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { /* 读不到就当没有 */ }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue
      const sub = path.join(dir, e.name)
      for (const f of NAMES) {
        if (fs.existsSync(path.join(sub, f))) { found.push(`${e.name}/${f}`); break }
      }
    }
  }
  if (found.length === 0) {
    return { argv: null, from: null,
      why: '这一层里没有找到依赖清单（pyproject.toml / uv.lock / '
        + 'requirements.txt / environment.yml，根目录和一层子目录都找过了）\n'
        + '请在 Manifest 中声明 install.env_command，平台将按该声明安装；'
        + '或者按上游说明自己装。' }
  }
  // ⭐ 优先级照上游文档的通行做法：锁文件 > pyproject > requirements
  const pick = (n) => found.find((f) => f === n || f.endsWith('/' + n))
  const lock = pick('uv.lock')
  const conda = pick('environment.yml')
  const pyproj = pick('pyproject.toml')
  const req = pick('requirements.txt')
  if (lock) {
    // ⛔ 只算一次：alternative 要同时用于 why 与返回值
    const alt = suggestBackendAlternative(dir, lock)
    return { argv: ['uv', 'sync'], from: lock, cwd: '.',
      // ⛔⛔ 不写「照它装最稳」—— 那只在锁的后端与本机一致时成立。
      //   锁的后端是 CUDA 而本机是 XPU 时，照装恰恰装的是**不能用的**那套
      //   （实测某台已装引擎的 lock 锁的是 +cu128，另带 38 个 nvidia-*-cu12）。
      //   ⇒ 有替代命令时，这句改成只说「照锁装」这一事实。
      why: (alt
        ? `上游有 ${lock}，其中锁定的后端与本机不一致。`
        : `上游有 ${lock} ⇒ 版本已经定死了，照它装最稳。`),
      alternative: alt }
  }
  if (conda) {
    return { argv: ['conda', 'env', 'create', '-f', conda],
      from: conda, cwd: conda.includes('/') ? conda.slice(0, conda.indexOf('/')) : '.',
      why: `上游用 conda 环境文件（${conda}）⇒ 用 conda env create。` }
  }
  if (pyproj) {
    // ⛔⛔ pyproject 单独存在时**不能**直接 uv sync ——
    //   上游没锁文件 ⇒ 装到什么版本是未定的 ⇒ 装完不可复现。
    //   ⛔ 而且很多项目的 pyproject 里依赖写不全（真见过）。
    // ✅ 诚实的做法：uv pip install -e . （只装它自己声明的依赖）
    const cwd = pyproj.includes('/') ? pyproj.slice(0, pyproj.indexOf('/')) : '.'
    const rel = pyproj.includes('/') ? pyproj.slice(pyproj.indexOf('/') + 1) : '.'
    return { argv: ['uv', 'pip', 'install', '-e', rel], from: pyproj, cwd,
      why: `上游只有 ${pyproj} ⇒ 用 uv pip install -e ${rel} 装它声明的依赖。\n`
        + '上游未提供锁文件，安装版本由上游决定，无法复现。' }
  }
  return { argv: ['uv', 'pip', 'install', '-r', req], from: req,
    cwd: req.includes('/') ? req.slice(0, req.indexOf('/')) : '.',
    why: `上游是 ${req}（老项目）⇒ uv pip install -r ${req}。` }
}

function detectDependencyManifest (dir) {
  const candidates = [
    'pyproject.toml', 'uv.lock', 'requirements.txt',
    'environment.yml', 'setup.py',
  ]
  const found = candidates.filter((f) => fs.existsSync(path.join(dir, f)))
  // ⚠ 2026-10-05：这里原来只查根目录，与 suggestEnvCommand 的策略不一致
  //   （那边会往下找一层并排除 .venv）。
  //   ⛔ 两边策略不一致 ⇒ 同一台引擎在两处得到不同结论，界面自相矛盾。
  if (found.length === 0) {
    return {
      found: false,
      note: '这一层里没有依赖清单'
        + '（pyproject.toml / uv.lock / requirements.txt / environment.yml 都没有）。\n'
        + '可能放在子目录里，也可能这台引擎不需要额外安装。',
      found_files: [],
    }
  }
  return { found: true, found_files: found,
    note: '上游的依赖清单：' + found.join('、') }
}

/**
 * ⭐ 建计划 —— 默认只出计划，不执行。
 *
 * ⚠ 执行要等用户确认，因为这一步要联网、要下几个 GB、
 *   而且失败在「装了一半」的位置上（【台账:44】）。
 */
function buildEnvPlan (input = {}) {
  const id = input.id
  const root = input.root || projectRoot()
  if (!root) {
    return { ok: false, code: 'NO_ROOT',
      error: '找不到项目根（向上没有 server.js）' }
  }
  const dir = engineDir(id, root)

  if (!fs.existsSync(dir)) {
    return { ok: false, code: 'NO_ENGINE_DIR',
      error: `engines/${id}/ 还不存在。请先执行第 2 步的克隆，或检查路径是否写错。` }
  }
  const cmd = readEnvCommand(input.manifest)
  // ⭐⭐ 名片优先，探测兜底（2026-10-05）
  //   ⛔ 原来这里是 `if (!cmd.ok) return { ...cmd, id }` —— 只认名片，
  //      而名片第 4 步才写 ⇒ 第 2 步必然卡死（Owner 实测：「卡住了」）。
  const guess = suggestEnvCommand(dir)
  if (!cmd.ok) {
    if (!guess.argv) {
      // ⛔ 两边都没有 ⇒ 如实说清**要做什么**，⛔ 不写「平台不会替你猜装法」
      //   （那是把我们的设计原则讲给用户听，他要知道的是「现在该怎么办」）
      return { ok: false, code: cmd.code || 'NO_ENV_COMMAND', id,
        error: cmd.error, cwd: '.',
        // ⭐ 明确告诉他下一步该干什么
        whatToDo: guess.why }
    }
    // ✅ 探测能推出 ⇒ 用它，但**如实说清这是推出来的**
    // ⚠⚠ steps 必须和正常路径**同构**（2026-10-05 修）：
    //   之前这条早返回没带 steps ⇒ runEnv 执行时拿到 undefined，
    //   ⛔ 命令根本没跑，界面上却显示「成功」。
    //   ⛔ 现在补齐，且 why 与正常路径**用同一段文字**，
    //     ⛔ 不出现「有 steps 的路径」和「没 steps 的路径」两种说法。
    const cwdRel = guess.cwd || '.'
    const NOTE = 'env_command 返回 0 仅表示命令执行完毕，'
      + '不代表该引擎可以运行，仍需后续校验（import 探针或实际合成）。'
    return {
      ok: true, id, from: 'probe', from_file: guess.from,
      guessed: true,
      env_command: guess.argv,
      whatToDo: guess.why,
      // ⭐ 锁文件的后端与本机不一致时，第二条命令（只重建 torch）
      alternative: guess.alternative || null,
      note: `该安装方式依据上游依赖清单推导得出（依据：${guess.from}）。\n`
        + `  ${guess.why}\n`
        + '如该引擎需要特定安装方式，请在 Manifest 中声明 '
        + 'install.env_command，平台将优先采用该声明。',
      steps: [
        {
          kind: 'env',
          argv: guess.argv,
          // ⛔ steps[0] 只放**要执行的那条**；alternative 由界面并列展示，
          //   ⛔ 不进 steps —— 自动执行等于替使用者拍板。
          cwd: path.join('engines', id, cwdRel),
          needs_network: true,
          why: `Manifest 未声明 install.env_command，该方式依据上游依赖清单推导得出。\n`
            + `  ${guess.why}\n`
            + '  如该引擎需要特定安装方式，请在 Manifest 中声明 '
            + 'install.env_command，平台将优先采用该声明。',
        },
        { kind: 'note', why: NOTE },
      ],
    }
  }

  const deps = detectDependencyManifest(dir)
  // ⭐ 装法：名片优先，探测兜底（见上面 suggestEnvCommand）
  const usingManifest = cmd.ok
  const argv = usingManifest ? cmd.argv : guess.argv

  const steps = [
    {
      kind: 'env',
      argv,
      // ⚠ cwd = **清单所在的那个目录**：uv sync 要在有 uv.lock 的地方跑；
      //   pip -r 也要在清单旁边跑。实测某台引擎的清单在 infer/requirements.txt
      //   ⇒ cwd 必须是 engines/<id>/infer，⛔ 不是 engines/<id>（2026-10-05 修）。
      cwd: path.join('engines', id, (guess && guess.cwd) || '.'),
      needs_network: true,
      // ⭐ 理由要说清**这条装法是怎么来的** ——
      //   名片写的 vs 平台按上游清单推的，⛔ 不让用户以为是黑箱。
      why: usingManifest
        ? `按名片里写的 install.env_command 装。\n  ${guess.why}`
        : `Manifest 未声明 install.env_command，该方式依据上游依赖清单推导得出。\n`
          + `  ${guess.why}\n`
          + '  如该引擎需要特定安装方式，请在 Manifest 中声明 '
          + 'install.env_command，平台将优先采用该声明。',
    },
  ]

  steps.push({
    kind: 'note',
    why: 'env_command 返回 0 仅表示命令执行完毕，'
      + '不代表该引擎可以运行，仍需后续校验'
      + '（import 探针 / 真跑一次合成）。',
  })

  return {
    ok: true,
    id,
    dir,
    env_command: argv,
    // ⭐ 界面要能说清「这条装法从哪来的」
    from: usingManifest ? 'manifest' : 'probe',
    from_file: usingManifest ? 'manifest.json (install.env_command)' : guess.from,
    guessed: !usingManifest,
    whatToDo: guess.why,
    dependencies: deps,
    steps,
    execute: input.execute === true,
  }
}

/** 执行。⛔ 只有 execute:true 才真跑。 */
function runEnv (input = {}) {
  const plan = buildEnvPlan(input)
  if (!plan.ok || !plan.execute) return plan

  const root = input.root || projectRoot()
  const step = plan.steps[0]
  const r = spawnSync(step.argv[0], step.argv.slice(1), {
    cwd: path.join(root, step.cwd),
    encoding: 'utf-8',
    timeout: input.timeoutMs || 60 * 60 * 1000,   // 装环境要很久
    windowsHide: true,
    shell: false,      // ⛔ argv 直接 spawn —— 走 shell 会被空格路径坑
  })

  if (r.error) {
    return { ...plan, ok: false, code: 'SPAWN_FAILED',
      error: `起不动「${step.argv[0]}」：${r.error.message}\n`
        + '平台无法确认是否安装成功，请检查 engines/<id>/ 目录。' }
  }
  if (r.status !== 0) {
    return {
      ...plan,
      ok: false,
      code: 'ENV_FAILED',
      status: r.status,
      // ⛔ 如实把上游的原话带出来 —— 那比我们的转述有用
      error: (r.stderr || r.stdout || '（没有输出）').trim(),
      // ⚠ 2026-10-05：原文带「（installPlan.js:44）」—— ⛔ 界面不该出现内部文件名
    //   （和之前 registry.js:83 同款毛病，Owner：「用词不能太随便」）。
    //   ⛔ 而且 installPlan.js 已按 A4' 退役，指向一个不存在的文件更没意义。
    note: '安装中断会保留不完整的环境，重新安装前需先清理该目录。'
      + '请先阅读上方错误信息，再决定重试或更换命令。',
    }
  }

  return {
    ...plan,
    ok: true,
    envStatus: r.status,
    note: 'env_command 退出码 0，仅表示命令执行完毕，'
      + '「这台引擎能不能 import」要等后面的校验。',
  }
}

module.exports = { readEnvCommand, detectDependencyManifest, buildEnvPlan, runEnv }