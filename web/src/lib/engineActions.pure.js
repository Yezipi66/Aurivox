// 引擎管理页那两个按钮能不能按（纯函数）。
// 判断写在这里而不是写在 JSX 里：React 的 prop 传漏了不是错误而是 undefined，
// npm run build 照样绿。只有把判断挪进纯函数，才写得出真的会红的测试。
// 命令由名片写明，平台只填占位符；本文件判断只看名片解析出来的字段（managed / process / online），不写具体引擎名。
// 这里也不许自己判内存够不够、名额满没满：那是 residency.js 的活，前端多一份判据迟早分叉，
// 分叉的表现是按钮亮着却被拒，或按钮灰着却实际可启动。前端只挡它自己看得见的四件事：
// 不归平台管、没装看管人、已在运行、正忙。其余一律放行，由后端判定是否可行。

/** 一台引擎此刻在进程这一侧处于什么状态。与探活通不通（online）不是一回事。 */
export function processPhase (engine) {
  if (!engine) return 'unknown'
  // 名片没写 runtime 段 = 这台引擎由作者自己起。这是合法状态，不是错误。
  if (engine.managed === false) return 'not-ours'
  const p = engine.process
  // null / undefined = 这台部署「不管进程」，不是「未运行」。
  if (p === null || p === undefined) return 'unmanaged'
  // phase 要先于 running 判：启动中的那几十秒里 status() 吐的是
  // { running: false, phase: 'launching' }，按 running 判会显示成待命，
  // 用户于是对着一个要等几分钟的启动再点一次。
  if (p.phase && p.phase !== 'ready') return 'starting'
  if (p.running !== true) {
    // 引擎在运行但不是本平台启动的（开发机上最常见）。无法停止它，因为我们没有它的进程。
    if (engine.online === true) return 'external'
    return 'idle'
  }
  return p.busy === true ? 'busy' : 'running'
}

const REASON = {
  'not-ours': {
    zh: '这台引擎的清单未声明 runtime 段：它由作者自己起，平台无法启动或停止它。',
    en: 'This engine has no runtime section in its manifest; it is started by its author, not by this app.',
  },
  unmanaged: {
    zh: '该部署不管理引擎进程（未安装进程管理器）。',
    en: 'This deployment does not manage engine processes.',
  },
  external: {
    zh: '这台引擎正在运行，但不是本平台启动的（通常是作者自己在另一个窗口打开的）。\n⇒ 平台不会停止它。',
    en: 'The engine is up but was not started by this app, so it cannot be stopped here.',
  },
  starting: {
    zh: '正在把模型装进内存，此过程可能需要数十秒至数分钟。\n不要重复点击：重复点击只会排队等待。',
    en: 'Loading the model into memory; this can take a while. No need to click again.',
  },
  running: {
    zh: '它已在运行。',
    en: 'Already running.',
  },
  busy: {
    zh: '正在执行一次合成。现在关闭它，该次合成会得到不完整的音频：并非一句报错。\n请等待其完成。',
    en: 'Busy synthesising. Stopping now would truncate that job. Wait for it to finish.',
  },
  idle: {
    zh: '当前未运行。',
    en: 'Not running.',
  },
}

function reason (phase, lang) {
  const r = REASON[phase]
  if (!r) return ''
  return lang === 'en' ? r.en : r.zh
}

// 那两个按钮各自：能不能按、写什么、悬停时说什么。
// 每一个 enabled:false 都必须带 title 说明为什么：一个灰着的按钮不说理由，等于告诉用户「这儿坏了」。
export function engineControls (engine, lang = 'zh') {
  const zh = lang !== 'en'
  const phase = processPhase(engine)

  const hard = phase === 'not-ours' || phase === 'unmanaged' || phase === 'unknown'
  const startLabel = zh ? '启动' : 'Start'
  const stopLabel = zh ? '关闭' : 'Stop'

  if (hard) {
    const why = reason(phase, lang) || (zh ? '还没拿到这台引擎的状态。' : 'Engine state not loaded yet.')
    return {
      phase,
      start: { enabled: false, label: startLabel, title: why },
      stop: { enabled: false, label: stopLabel, title: why },
    }
  }

  return {
    phase,
    start: {
      enabled: phase === 'idle',
      label: phase === 'starting' ? (zh ? '启动中…' : 'Starting…') : startLabel,
      title: phase === 'idle'
        ? (zh
            ? '启动这台引擎。\n无需先触发合成：这正是本页面的用途。\n⚠ 启动时需要将模型载入内存，可能需要数十秒至数分钟。'
            : 'Start this engine now, without having to run a synthesis first.')
        : reason(phase, lang),
    },
    stop: {
      // external 不许给停：那个进程不是我们的，我们没有它的句柄。
      // 给一个按下去什么也不会发生的按钮，比没有按钮更坏。
      enabled: phase === 'running',
      label: stopLabel,
      title: phase === 'running'
        ? (zh
            ? '释放这台引擎，将其占用的内存归还系统。\n⚠ 下一次使用时会重新启动，需再次等待装载。'
            : 'Release this engine and give its memory back. It will start again on next use.')
        : reason(phase, lang),
    },
  }
}

// 后端拒绝之后，界面该怎么办。
// 只有 ENGINE_NEEDS_CONFIRM 这一个码要问用户，其余全是说给用户听。
// 不许把它当普通报错弹出去：那样「平台尚未测量过这台引擎要多少内存」会变成一句无法推进的红字，
// 而用户只需点击一次「知道了，启动」即可。
export function actionOutcome (resp, lang = 'zh') {
  const zh = lang !== 'en'
  const data = (resp && resp.data) || {}
  if (resp && resp.ok) {
    return { kind: 'ok', action: data.action || null, message: null }
  }
  const code = data.code || null
  if (code === 'ENGINE_NEEDS_CONFIRM') {
    return {
      kind: 'confirm',
      code,
      // mem 原样带上来，那句文案里故意没有「预计要多少」（我们不知道），
      // 弹框要显示「现在还剩多少」就只能靠这个。
      mem: data.mem || null,
      message: data.error || (zh ? '平台尚未测量过该引擎的内存占用量。' : 'Memory footprint unknown.'),
      confirmLabel: zh ? '知道风险，仍然启动' : 'Start anyway',
    }
  }
  return {
    kind: 'error',
    code,
    message: data.error || (zh ? `启动失败（HTTP ${resp && resp.status}）` : `Failed (HTTP ${resp && resp.status})`),
  }
}
