// ============================================================
//  刀 F2：引擎管理页那两个按钮**能不能按**（纯函数）
// ============================================================
//
// ⭐⭐⭐ 这一刀之前，界面能"看"引擎、⛔ 不能"动"引擎：
//   `lib/routes/engines.js` 只有一个 GET，`supervisor.ensure()` 唯一的活调用点
//   在合成里 ⇒ **想起一台引擎，唯一的办法是点一次合成。**
//   刀 F1 补上了两个 POST，这个文件是它在界面这一侧的判断。
//
// ⚠ 为什么判断写在这儿而不是写在 JSX 里：
//   仓库里那 26 条前端守卫全是**文本守卫**（grep 源码里有没有那个词）。
//   `npm run build` 绿 ≠ 接线对：React 的 prop 传漏了不是错误，是 undefined。
//   ⇒ 凡是"什么情况下按钮该灰掉"这种判断，全部挪进纯函数，才有可能写出
//     真的会红的测试。JSX 里只剩「把这个对象画出来」。
//
// ⛔ 这里不许出现任何具体引擎的名字。判断只看名片解析出来的字段
//   （managed / process / online），装一台谁都没见过的引擎，这里一个字不用改。
//
// ⛔ 这里也不许自己判"内存够不够、名额满没满"。那是 residency.js 的活，
//   而它已经被测穷了。前端多一份判据 = 两份判据，迟早分叉，
//   而分叉的表现是"按钮是亮的，按下去被拒"或者更糟"按钮灰着，其实能起"。
//   ⇒ 前端只挡**它自己看得见的**四件事：不归平台管、没装看管人、
//     已经在跑、正忙。剩下的一律放行，让后端说不行。

/** 一台引擎此刻在进程这一侧处于什么状态。⛔ 与"探活通不通"（online）不是一回事。 */
export function processPhase (engine) {
  if (!engine) return 'unknown'
  // 名片没写 runtime 段 = 这台引擎由作者自己起。⭐ 这是**合法状态**，不是错误。
  if (engine.managed === false) return 'not-ours'
  const p = engine.process
  // ⭐ null / undefined = 这台部署「不管进程」，⛔ 不是「没在跑」。
  if (p === null || p === undefined) return 'unmanaged'
  // ⭐⭐ phase 要先于 running 判：status() 在"正在起"的那几十秒里
  //   吐的是 { running: false, phase: 'launching' } —— 按 running 判会
  //   把它显示成"待命"，然后用户对着一个要等几分钟的启动再点一次。
  if (p.phase && p.phase !== 'ready') return 'starting'
  if (p.running !== true) {
    // 引擎在跑但不是我们起的（开发机上最常见）。停不了它 —— 我们没有它的进程。
    if (engine.online === true) return 'external'
    return 'idle'
  }
  return p.busy === true ? 'busy' : 'running'
}

const REASON = {
  'not-ours': {
    zh: '这台引擎的名片没写 runtime 段 —— 它由作者自己起，平台起不了也停不了它。',
    en: 'This engine has no runtime section in its manifest; it is started by its author, not by this app.',
  },
  unmanaged: {
    zh: '这台部署不管引擎进程（没装看管人）。',
    en: 'This deployment does not manage engine processes.',
  },
  external: {
    zh: '这台引擎正在跑，但不是本平台起的（多半是你自己在另一个窗口开着）。\n⇒ 平台不会去停它。',
    en: 'The engine is up but was not started by this app, so it cannot be stopped here.',
  },
  starting: {
    zh: '正在把模型装进内存，这一下可能要等几十秒到几分钟。\n⛔ 不用再点 —— 再点只会排在后面。',
    en: 'Loading the model into memory; this can take a while. No need to click again.',
  },
  running: {
    zh: '它已经在跑了。',
    en: 'Already running.',
  },
  busy: {
    zh: '正在给一次合成干活。现在关掉它，那次合成会拿到半截音频 —— ⛔ 不是一句报错。\n请等它跑完。',
    en: 'Busy synthesising. Stopping now would truncate that job. Wait for it to finish.',
  },
  idle: {
    zh: '现在没在跑。',
    en: 'Not running.',
  },
}

function reason (phase, lang) {
  const r = REASON[phase]
  if (!r) return ''
  return lang === 'en' ? r.en : r.zh
}

/**
 * 那两个按钮各自：能不能按、写什么、悬停时说什么。
 *
 * ⭐ 每一个 enabled:false 都**必须**带 title 说明为什么。
 *   ⛔ 一个灰着的按钮不说理由，等于告诉用户"这儿坏了"。
 */
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
            ? '把这台引擎起起来。\n⭐ 不用先点合成 —— 这正是这个页面存在的理由。\n⚠ 起的那一下要把模型装进内存，可能要等几十秒到几分钟。'
            : 'Start this engine now, without having to run a synthesis first.')
        : reason(phase, lang),
    },
    stop: {
      // ⛔ external 不许给停：那个进程不是我们的，我们没有它的句柄。
      //   给一个按下去什么也不会发生的按钮，比没有按钮更坏。
      enabled: phase === 'running',
      label: stopLabel,
      title: phase === 'running'
        ? (zh
            ? '放掉这台引擎，把它占的内存还给系统。\n⚠ 下一次用到它时会重新起，又要等一次装载。'
            : 'Release this engine and give its memory back. It will start again on next use.')
        : reason(phase, lang),
    },
  }
}

/**
 * 后端拒绝之后，界面该怎么办。
 *
 * ⭐⭐⭐ 只有 ENGINE_NEEDS_CONFIRM 这一个码要**问用户**，其余全是"说给用户听"。
 *   §12「开放问题 ②」记着这件事的形状：那是**一个必须有人回答的问题**，
 *   而下游 OpenAI 兼容口那条路上没有人 —— 这个页面上有人，所以这里能问。
 * ⛔ 不许把它当普通报错弹出去：那样"平台还没量过这台引擎要多少内存"
 *   会变成一句无法推进的红字，而用户其实只要点一下"知道了，起"。
 */
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
      // mem 原样带上来 —— 那句文案里**故意没有**"预计要多少"（我们不知道），
      // 弹框要显示"现在还剩多少"就只能靠这个。
      mem: data.mem || null,
      message: data.error || (zh ? '平台还没量过这台引擎要占多少内存。' : 'Memory footprint unknown.'),
      confirmLabel: zh ? '知道风险，仍然启动' : 'Start anyway',
    }
  }
  return {
    kind: 'error',
    code,
    message: data.error || (zh ? `启动失败（HTTP ${resp && resp.status}）` : `Failed (HTTP ${resp && resp.status})`),
  }
}
