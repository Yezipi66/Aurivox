// 五步接入流程定义：顺序、依赖、并发、风险。克隆时 engines/<id>/ 必须为空（名片第 4 步才写）。
// 判据：test/steps.node.test.js 断言本文件形状。

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

/** 某一步做完没：由真实产物判，不由「用户点过下一步」判。 */
export function stepDone (stepKey, facts = {}) {
  switch (stepKey) {
    case 'prepare':
      // 光解析出 id 不算：得真克隆了才算。
      // 这一步含解析 / 探测 / 确认 / 克隆，只解析出 id 时停在「可以clone，但还没 clone」。
      return facts.cloned === true
    case 'env':
      return facts.envBuilt === true
    case 'models':
      // ready 为 null（说不出来）时不算做完：那是需要补名片的信号，
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

/** 哪些步骤现在能走：判据只有「必填项齐了没有」。 */
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

/** 同一时刻有几条线在跑：只列还没做完的步骤。models ↔ manifest 并发，其余串行。 */
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

/** 当前该做哪一步：第一个没完成的；全做完时没有下一步 */
export function currentStep (done = {}) {
  for (const st of STEPS) if (!done[st.key]) return st.key
  return null
}

/** 节点状态：pending / running / completed / failed / skipped */
export function nodeStatus (stepKey, o = {}) {
  const done = o.done || {}
  if (o.running === stepKey) return 'running'
  if (o.failed === stepKey) return 'failed'
  if (done[stepKey]) return 'completed'
  return 'pending'
}

/** 危险动作要显示的那段话：说清后果而且具体，不劝阻、不施压。 */
export function riskNotice (stepKey, t, vars) {
  const st = STEP_BY_KEY[stepKey]
  if (!st || !st.risk) return null
  // vars 把具体名字与路径填进那句话：「会克隆到哪里」必须一眼可见。
  // 不能只说「写进 engines/」：那里已经有若干引擎，分不清是哪个。
  const fill = (str) => {
    if (!str || !vars) return str
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
      text: fill(t('This installs everything the engine needs to run. Several GB '
        + 'are downloaded and it takes a while. If it fails halfway, delete the '
        + 'engine folder and run this step again.',
        '安装该引擎运行所需的全部依赖。需下载数 GB，耗时较长。'
        + '若中途失败，请删除引擎目录后重新执行本步骤。')),
    }
  }
  return null
}

/** 这一步能不能开始，以及不能开始时差什么。 */
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