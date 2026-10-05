// ---------------------------------------------------------------------------
//  五步接入流程的**唯一定义** —— 顺序、依赖、并发、风险、判据。
//
//  这个文件为什么存在：App.jsx / Pipeline.jsx / StepVerify.jsx 都按它渲染，
//  ⛔ 不许在那些文件里另写一份步骤表 —— 两份会漂移，而漂移的症状是
//  「流程条显示五步、校验列四道、中间某个步骤永远点不到」。
//  判据：test/steps.node.test.js断言本文件的形状。
//
//  交互照 web/src/components/train/TrainingTab.jsx 的 selectedNode：
//    · 轨道 = 进度条（连接线在前一步完成时变绿，不另做进度条组件）
//    · 点哪一步才展开哪一步 —— 不预铺全部参数
//    · 危险动作说清后果，⛔ 但不加「我了解风险」复选框（仪式，不是保护）
//
//  ⛔ 顺序是硬约束：**克隆时 engines/<id>/ 必须是空的**，因为名片第 4 步才写。
//    反过来做的症状是 git 报 not empty，不是可恢复的错误。
//    ⛔ 任何改动顺序的提交都必须同时更新下面 requiresEmptyDir 那条断言。
//
//  ⛔ i18n：产品术语保持英文（Manifest / Checkpoint / Model / Generate），
//    依据 web/src/lib/i18n.jsx:5-7 ⇒ 中文位里不写「模型位」「音色」。
//
//  ⛔ 本文件不许出现任何具体引擎名。
// ---------------------------------------------------------------------------

export const STEPS = [
  {
    // 链接 → 探测 → 克隆都由同一个 repo URL 驱动，所以合成一步。
    // 内部顺序：只读探测 → 使用者确认 → 才clone。⛔ 探测不能省，
    // 省掉就失去「clone 前告知将发生什么」这一层。
    key: 'prepare',
    n: 1,
    // ⛔ 五步名称全部中文，且直接说这一步要做的动作 —— 界面不出现半截英文。
    label: ['1 下载源码', '1 下载源码'],
    does: ['粘贴 GitHub 仓库地址，系统读取项目信息并准备克隆命令，随后即可安装依赖。',
        '粘贴 GitHub 仓库地址，系统读取项目信息并准备克隆命令，随后即可安装依赖。'],
    needs: ['url'],
    // ⛔ 克隆时目录必须为空（名片第4 步才写）⇒ 这条不能删，
    //   删了就没有任何地方声明这个前提，症状是 git 报 not empty。
    requiresEmptyDir: true,
    // 会写盘（clone）⇒ 界面上要显式解锁
    risk: 'network-write',
    // 三小步各自的状态在界面上分开显示
    phases: ['resolve', 'probe', 'clone'],
  },
  {
    key: 'env',
    n: 2,
    // 这一步做的是列出要装的包，并把与 GPU 相关的单独标出来
    label: ['2 装依赖', '2 装依赖'],
    does: ['按上游声明的依赖清单安装依赖包，与 GPU 相关的包单独列出。安装完成后可检查能否启动。',
        '按上游声明的依赖清单安装依赖包，与 GPU 相关的包单独列出。安装完成后可检查能否启动。'],
    // ⛔ env_command 必须由名片给出 —— 平台不猜（判据来自已退役的 installPlan.js:44）
    requiresManifestField: 'install.env_command',
    risk: 'network-heavy',
  },
  {
    key: 'models',
    n: 3,
    // 这一步展示上游自带的下载方式（自带脚本或 README 里的命令），
    // ⛔ 平台不另造一套 —— 各项目的下载方式本来就各不相同。
    label: ['3 下载模型', '3 下载模型'],
    does: ['显示上游项目自带的下载方式与存放位置，由使用者手动执行。',
        '显示上游项目自带的下载方式与存放位置，由使用者手动执行。'],
    parallelWith: 'manifest',
    // ⛔ 平台只展示命令，不代为下载 ⇒ 副标题必须写明由使用者执行，
    //   否则步骤名像在承诺平台会下载。
    readOnly: true,
  },
  {
    key: 'manifest',
    n: 4,
    // 用户在这一步做的事是填一张表。⛔ 界面上不叫它 manifest —— 那是文件名
    label: ['4 填写名片', '4 填写名片'],
    does: ['填写引擎名片：名称、参数与启动方式。',
        '填写引擎名片：名称、参数与启动方式。'],
    parallelWith: 'models',
  },
  {
    key: 'verify',
    n: 5,
    // 四道校验：是否已安装 / 能否启动 / 权重是否完整 / 能否合成
    label: ['5 检查', '5 检查'],
    does: ['检查安装结果：是否已安装、能否启动、权重是否完整、能否合成。四项分别显示，互不作为前置条件。',
        '检查安装结果：是否已安装、能否启动、权重是否完整、能否合成。四项分别显示，互不作为前置条件。'],
    needs: ['id'],
  },
]

/**
 * 某一步**做完没** —— 由真实产物判，不由「用户点过下一步」判。
 *
 * ⛔ 判据必须是产物：点过下一步不等于做完，实际可能压根没解析成功。
 *
 * @param {string} stepKey
 * @param {object} facts 各步骤的真实产物（由 App 从端点收集）
 * @returns {boolean}
 */
export function stepDone (stepKey, facts = {}) {
  switch (stepKey) {
    case 'prepare':
      // ⛔ 光解析出 id 不算 —— 得真克隆了才算。
      // 这一步含解析 / 探测 / 确认 / 克隆，只解析出 id 时停在「可以clone，但还没 clone」。
      return facts.cloned === true
    case 'env':
      return facts.envBuilt === true
    case 'models':
      // ready 为 null（说不出来）时**不算做完** —— 那是需要补名片的信号，
      // 而非一个可以放过的结论。
      return facts.weightsReady === true || facts.weightsReady === false
    case 'manifest':
      return facts.manifestSaved === true
    case 'verify':
      return facts.verified === true
    default:
      return false
  }
}

export const STEP_BY_KEY = Object.fromEntries(STEPS.map((s) => [s.key, s]))

/**
 * ⭐ 哪些步骤现在能走 —— 判据只有「必填项齐了没有」。
 *
 * @param {{url?:string, id?:string, cloneUrl?:string, manifest?:object}} s
 * @returns {{step:string, ok:boolean, missing:string[]}[]}
 */
export function stepStatus (s = {}) {
  return STEPS.map((st) => {
    const missing = (st.needs || []).filter((k) => !s[k])
    let ok = missing.length === 0

    // ⭐ env 那一步：名片里必须真的写了 env_command
    if (st.requiresManifestField && ok) {
      const m = s.manifest
      const parts = st.requiresManifestField.split('.')
      let v = m
      for (const p of parts) v = v && v[p]
      if (!v) ok = false
    }
    return { step: st.key, n: st.n, ok, missing }
  })
}

/**
 * 同一时刻有几条线在跑 —— 只列**还没做完的**步骤。
 *
 * ⛔ 只有 models ↔ manifest 这一对并发。其余一律串行：第 1 步的
 *   「目录必须为空」要求克隆先落地，而并行并不能绕过它。
 * ⛔ 全部做完时返回一条空线，不返回 null —— 调用方按数组渲染。
 *
 * @param {Record<string,boolean>} done 已完成的步骤
 * @returns {string[][]} 每个元素是一条独立的线
 */
export function lanes (done = {}) {
  const pending = STEPS.filter((s) => !done[s.key]).map((s) => s.key)
  const iM = pending.indexOf('models')
  const iF = pending.indexOf('manifest')
  if (iM >= 0 && iF >= 0) {
    const merged = pending.filter((k) => k !== 'models' && k !== 'manifest')
    merged.splice(Math.min(iM, iF), 0, 'models+manifest')
    return [merged]
  }
  return [pending]
}

/** 当前该做哪一步 —— 第一个没完成的；全做完时没有下一步 */
export function currentStep (done = {}) {
  for (const st of STEPS) if (!done[st.key]) return st.key
  // ⛔ 不许返回一个不存在的步骤名 —— 流程条会去找一个空的节点。
  return null
}

/**
 * 节点状态 —— 只有五种，照 PipelineMap 的 glyph。
 * pending / running / completed / failed / skipped
 * @param {string} stepKey
 * @param {{done?:object, running?:string, failed?:string}} o
 */
export function nodeStatus (stepKey, o = {}) {
  const done = o.done || {}
  if (o.running === stepKey) return 'running'
  if (o.failed === stepKey) return 'failed'
  if (done[stepKey]) return 'completed'
  return 'pending'
}

/**
 * 危险动作要显示的那段话 —— 光有按钮不够。
 *
 * 照 TrainingTab.jsx:569 的 expert-warning：说清**后果**而且说具体
 * （下载量、耗时、失败后怎么收拾），⛔ 不是「此操作有风险」。
 * ⛔ 只陈述将发生什么，不劝阻、不施压。
 *
 * @param {string} stepKey
 * @param {(en:string, zh:string)=>string} t
 * @param {{[k:string]:string}} [vars] 填进文案的具体名字与路径
 * @returns {{level:string, text:string}|null}
 */
export function riskNotice (stepKey, t, vars) {
  const st = STEP_BY_KEY[stepKey]
  if (!st || !st.risk) return null
  // vars 把具体名字与路径填进那句话：「会克隆到哪里」必须一眼可见。
  // ⛔ 不能只说「写进 engines/」—— 那里已经有若干引擎，分不清是哪个。
  const fill = (str) => {
    if (!str || !vars) return str
    // ⛔ vars 的存在性用 `!vars` 判，不可用 `.hasOwnProperty`：
    //   那是取函数引用（永远 truthy）而不是调用它 ⇒ 永远走 then 分支
    //   ⇒ vars 为 undefined 时 Object.keys(undefined) 抛 ⇒ 整页白屏。
    //   判据：RiskUnlock 在没有 vars 的步骤上必须能正常渲染。
    return Object.keys(vars).reduce((a, k) => a
      .split('{' + k + '}').join(vars[k] == null ? '' : vars[k]), str)
  }
  if (st.risk === 'network-write') {
    return {
      level: 'warn',
      text: fill(t(
        'This will clone the "{name}" project into "{path}" on this machine.',
        '本操作会将“{name}”项目克隆到本地的“{path}”')),
    }
  }
  if (st.risk === 'network-heavy') {
    return {
      level: 'warn',
      // ⛔ 这条是纯告知（无占位符），所以留在 t() 里，不改成 code + params。
      //   说清三件事：要做什么、要花多久、失败后怎么收拾。
      text: fill(t('This installs everything the engine needs to run. It downloads '
        + 'several GB and takes a while. If it fails halfway, delete the engine '
        + 'folder and run this step again.',
        '这一步会把这台引擎运行所需的一切装好。需要下载几个 GB，耗时较长。'
        + '如果中途失败，删掉引擎目录后重新执行这一步。')),
    }
  }
  return null
}

/**
 * ⭐ ⛔ 这一步**能不能开始**，以及不能开始时**差什么**。
 * @returns {{ok:boolean, reason?:string}}
 */
export function canStart (stepKey, s = {}) {
  const st = STEP_BY_KEY[stepKey]
  if (!st) return { ok: false, reason: `步骤标识无效：${stepKey}` }
  const st2 = stepStatus(s).find((x) => x.step === stepKey)
  if (!st2.ok) {
    return { ok: false,
      reason: st2.missing.length
        ? `还差：${st2.missing.join('、')}`
        : 'Manifest 里还没写 install.env_command' }
  }
  return { ok: true }
}

export default STEPS