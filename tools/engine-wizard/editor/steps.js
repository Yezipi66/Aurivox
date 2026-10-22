// 接入向导的五步定义：每一步的顺序、必填项、并发关系与风险等级。
// 克隆时 engines/<id>/ 必须是空目录：名片在第 4 步才写，写早了克隆就失败。
// 纯数据与纯函数，不发请求也不读盘；形状由 test/steps.node.test.js 断言。

export const STEPS = [
  {
    key: 'prepare',
    n: 1,
    label: ['Clone repository', '克隆仓库'],
    does: ['粘贴 GitHub 仓库地址，系统读取项目信息并准备克隆命令，随后即可安装依赖。',
        '粘贴 GitHub 仓库地址，系统读取项目信息并准备克隆命令，随后即可安装依赖。'],
    needs: ['url'],
    requiresEmptyDir: true,
    risk: 'network-write',
    phases: ['resolve', 'probe', 'clone'],
  },
  {
    key: 'env',
    n: 2,
    label: ['Install dependencies', '安装依赖'],
    does: ['按上游声明的依赖清单安装依赖包，与 GPU 相关的包单独列出。安装完成后可检查能否启动。',
        '按上游声明的依赖清单安装依赖包，与 GPU 相关的包单独列出。安装完成后可检查能否启动。'],
    needs: ['id'],
    risk: 'network-heavy',
  },
  {
    key: 'models',
    n: 3,
    label: ['Download models', '下载模型'],
    does: ['列出上游项目自带的下载方式与存放位置，勾选后点「下载」即可。下载在后台进行，可随时进入下一步。',
        '列出上游项目自带的下载方式与存放位置，勾选后点「下载」即可。下载在后台进行，可随时进入下一步。'],
    parallelWith: 'manifest',
  },
  {
    key: 'manifest',
    n: 4,
    label: ['Write manifest', '填写名片'],
    does: ['填写引擎名片：名称、参数与启动方式。',
        '填写引擎名片：名称、参数与启动方式。'],
    parallelWith: 'models',
  },
  {
    key: 'verify',
    n: 5,
    label: ['Verify', '检查'],
    does: ['检查安装结果：是否已安装、能否启动、权重是否完整、能否合成。四项分别显示，互不作为前置条件。',
        '检查安装结果：是否已安装、能否启动、权重是否完整、能否合成。四项分别显示，互不作为前置条件。'],
    needs: ['id'],
  },
]

/**
 * 某一步做完没有。判据是真实产物，不是「用户点过下一步」。
 * facts 是各步的产物状态（见下面各 case 用到的字段），没做完返回 false。
 */
export function stepDone (stepKey, facts = {}) {
  switch (stepKey) {
    case 'prepare':
      // 只解析出 id 不算做完，得真克隆了才算。
      // 这一步含解析 / 探测 / 确认 / 克隆，只解析出 id 时停在「可以 clone，但还没 clone」。
      return facts.cloned === true
    case 'env':
      return facts.envBuilt === true
    case 'models':
      // ready 为 null（说不出来）时不算做完：那是需要补名片的信号，
      // 不是一条可以放过的结论。
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
 * 哪些步骤现在能走。判据只有「必填项齐了没有」。
 * s 是当前状态（仓库地址、目录名等）；每一步返回 { step, n, ok, missing }，
 * missing 列还缺的必填项。
 */
export function stepStatus (s = {}) {
  return STEPS.map((st) => {
    const missing = (st.needs || []).filter((k) => !s[k])
    let ok = missing.length === 0

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
 * 同一时刻有几条线在执行。只列还没做完的步骤：models 与 manifest 并发，合成一格，
 * 其余步骤各自一格。返回的每条线是一串步骤标识，并发的那对写作 'models+manifest'。
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

/** 当前该做哪一步：第一个没做完的；全做完时返回 null（没有下一步）。 */
export function currentStep (done = {}) {
  for (const st of STEPS) if (!done[st.key]) return st.key
  return null
}

/**
 * 步骤在流程条上的状态：pending / running / completed / failed。
 * o 是 { done, running, failed } 三个步骤键；skipped 不由这里产生。
 */
export function nodeStatus (stepKey, o = {}) {
  const done = o.done || {}
  if (o.running === stepKey) return 'running'
  if (o.failed === stepKey) return 'failed'
  if (done[stepKey]) return 'completed'
  return 'pending'
}

/**
 * 危险动作要显示的那段话：说清后果而且具体，不劝阻、不施压。
 * 等级按配色语义分三档：
 *   info   陈述：客观说明这一步会发生什么，不含风险判断。
 *   warn   警告：低风险但要注意（耗时、量大、填错不报错）。
 *   danger 危险：不可撤回，或会终止一个已经开始的操作。
 * t 是双语取词函数 t(英文, 中文)；vars 填进文案模板，如 {name}、{path}。
 */
export function riskNotice (stepKey, t, vars) {
  const st = STEP_BY_KEY[stepKey]
  if (!st || !st.risk) return null
  // vars 把具体名字与路径填进那句话：「会克隆到哪里」必须一眼可见，
  // 不能只说「写进 engines/」：那里已经有若干引擎，分不清是哪个。
  const fill = (str) => {
    if (!str || !vars) return str
    return Object.keys(vars).reduce((a, k) => a
      .split('{' + k + '}').join(vars[k] == null ? '' : vars[k]), str)
  }
  if (st.risk === 'network-write') {
    // 目录里已经有内容 ⇒ 这一步是复用，不克隆：
    // 说「会克隆到哪」就与实际做的事不符了。
    if (vars && vars.reuse) {
      return {
        level: 'info',
        text: fill(t(
          'This step reuses what is already in "{path}". '
          + 'Nothing is downloaded and nothing is deleted.',
          '本步骤将复用“{path}”里已有的内容。'
          + '既不下载，也不删除任何东西。')),
      }
    }
    // 克隆是陈述：说清会写到哪里，不含风险判断。
    return {
      level: 'info',
      text: fill(t(
        'This will clone the "{name}" project into "{path}" on this machine.',
        '本操作会将“{name}”项目克隆到本地的“{path}”')),
    }
  }
  if (st.risk === 'network-heavy') {
    // 下载数 GB、耗时较长：低风险但值得提醒，黄色。
    return {
      level: 'warn',
      text: fill(t('This installs everything the engine needs to run. Several GB '
        + 'are downloaded and it takes a while. If it fails halfway, delete the '
        + 'engine folder and run this step again.',
        '安装该引擎运行所需的全部依赖。需下载数 GB，耗时较长。'
        + '若中途失败，请删除引擎目录后重新执行本步骤。')),
    }
  }
  return null
}

/**
 * 这一步能不能开始，以及不能开始时差什么。
 * 不能开始时 reason 说明缺什么或为什么；s 是当前状态（仓库地址、目录名等）。
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