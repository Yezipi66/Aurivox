import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processPhase, engineControls, actionOutcome } from './engineActions.pure.js'

// ---------------------------------------------------------------------------
//  刀 F2：引擎管理页那两个按钮
// ---------------------------------------------------------------------------
//
// ⭐⭐⭐ 这不是文本守卫。仓库里那 26 条前端守卫守的是"这个词出现在这个位置"，
//   而这个文件真的把判断函数调起来看它返回什么 —— 判断本身被刻意挪出了 JSX，
//   就是为了这件事（`npm run build` 绿 ≠ 接线对）。
//
// 每条测试问的都是同一类问题：**某种状态下按钮该不该按，理由说没说。**

test('⭐⭐⭐ 名片没写 runtime 段（managed:false）⇒ 两个按钮都不许亮', () => {
  // 这是**合法状态**，不是错误：这台引擎由作者自己起。
  // ⛔ 给一个按下去什么也不会发生的按钮，比没有按钮更坏。
  const c = engineControls({ id: 'x', managed: false, process: null })
  assert.equal(c.phase, 'not-ours')
  assert.equal(c.start.enabled, false)
  assert.equal(c.stop.enabled, false)
  assert.match(c.start.title, /自己起/)
})

test('⭐⭐ process 是 null ⇒ "这台部署不管进程"，⛔ 不是"没在跑"', () => {
  const c = engineControls({ id: 'x', managed: true, process: null })
  assert.equal(c.phase, 'unmanaged')
  assert.equal(c.start.enabled, false, '不管进程的部署上把启动按钮点亮，等于承诺一件做不到的事')
  assert.ok(c.start.title.length > 0, '灰着的按钮必须说为什么')
})

test('⭐ 没在跑 ⇒ 能启动、不能关闭', () => {
  const c = engineControls({ id: 'x', managed: true, process: { running: false } })
  assert.equal(c.phase, 'idle')
  assert.equal(c.start.enabled, true)
  assert.equal(c.stop.enabled, false)
})

test('⭐⭐⭐ 正在启动（running:false 但有 phase）⇒ 启动按钮必须灰掉', () => {
  // ⚠ 这是整套东西里唯一会让人以为卡死的时刻：模型正在装进内存，几十秒到几分钟。
  //   按 running 判会把它显示成"待命"，于是用户再点一次 —— 只会排得更久。
  const c = engineControls({ id: 'x', managed: true, process: { running: false, phase: 'launching' } })
  assert.equal(c.phase, 'starting')
  assert.equal(c.start.enabled, false)
  assert.match(c.start.label, /启动中/)
})

test('⭐⭐⭐ 正在合成（busy）⇒ 关闭按钮必须灰掉，理由是"半截音频"', () => {
  const c = engineControls({ id: 'x', managed: true, process: { running: true, busy: true } })
  assert.equal(c.phase, 'busy')
  assert.equal(c.stop.enabled, false)
  assert.match(c.stop.title, /半截音频/, '这里必须说清后果 —— 关掉它不是"操作失败"，是那次合成被腰斩')
})

test('在跑且不忙 ⇒ 能关，不能重复启动', () => {
  const c = engineControls({ id: 'x', managed: true, process: { running: true, busy: false } })
  assert.equal(c.phase, 'running')
  assert.equal(c.stop.enabled, true)
  assert.equal(c.start.enabled, false)
})

test('⭐⭐ 引擎在跑但不是平台起的（external）⇒ 关闭必须灰掉', () => {
  // 开发机上最常见的一种状态：用户自己在另一个窗口开着。
  // 我们没有那个进程的句柄，点了不会有任何事发生。
  const c = engineControls({ id: 'x', managed: true, online: true, process: { running: false } })
  assert.equal(c.phase, 'external')
  assert.equal(c.stop.enabled, false)
  assert.match(c.stop.title, /不是本平台起的/)
})

test('⛔ 每一个灰掉的按钮都必须带理由 —— 不说理由等于告诉用户"这儿坏了"', () => {
  const cases = [
    { id: 'a', managed: false, process: null },
    { id: 'b', managed: true, process: null },
    { id: 'c', managed: true, process: { running: false } },
    { id: 'd', managed: true, process: { running: false, phase: 'launching' } },
    { id: 'e', managed: true, process: { running: true, busy: true } },
    { id: 'f', managed: true, process: { running: true, busy: false } },
    { id: 'g', managed: true, online: true, process: { running: false } },
    null,
  ]
  for (const e of cases) {
    const c = engineControls(e)
    for (const which of ['start', 'stop']) {
      if (!c[which].enabled) {
        assert.ok(c[which].title && c[which].title.length > 0,
          `${e ? e.id : 'null'} 的 ${which} 按钮灰着却没有理由`)
      }
    }
  }
})

test('⛔ 前端不许自己判"内存够不够" —— 那条判据只有后端有一份', () => {
  // 一台没在跑、平台管得着的引擎，无论内存多紧，按钮都必须是亮的：
  // 拦不拦由 residency.js 说了算。前端多一份判据的表现是
  // "按钮灰着，其实能起" —— 而那不报错。
  const c = engineControls({ id: 'x', managed: true, process: { running: false }, mem_hint_free_mb: 1 })
  assert.equal(c.start.enabled, true)
})

// ---------------------------------------------------------------------------
//  后端拒绝之后，界面该怎么办
// ---------------------------------------------------------------------------

test('⭐⭐⭐ ENGINE_NEEDS_CONFIRM 是"要问人"，⛔ 不是报错', () => {
  const r = actionOutcome({
    ok: false, status: 409,
    data: { code: 'ENGINE_NEEDS_CONFIRM', error: '平台还没量过引擎 x 要占多少内存', mem: { freeMb: 6030 } },
  })
  assert.equal(r.kind, 'confirm', '当成普通报错弹出去，用户就只能看着一句没法推进的红字')
  assert.equal(r.mem.freeMb, 6030, 'mem 必须带上 —— 那句文案里故意没有"预计要多少"，弹框除了 mem 没有别的来源')
  assert.ok(r.confirmLabel)
})

test('内存不够 / 忙 是"说给用户听"，不是问句', () => {
  for (const code of ['ENGINE_NO_MEMORY', 'ENGINE_BUSY_OTHER_WEIGHT', 'ENGINE_BUSY']) {
    const r = actionOutcome({ ok: false, status: 409, data: { code, error: 'nope' } })
    assert.equal(r.kind, 'error', `${code} 不该被做成一个可以点"仍然启动"的问句`)
    assert.equal(r.code, code)
  }
})

test('⭐ 成功时 action 必须留着：reuse / start / not-ours 对用户不是一回事', () => {
  for (const action of ['start', 'reuse', 'relaunch', 'not-ours']) {
    const r = actionOutcome({ ok: true, status: 200, data: { ok: true, action } })
    assert.equal(r.kind, 'ok')
    assert.equal(r.action, action)
  }
})

test('后端没吐 JSON（500 空 body）也要给一句人能看的话', () => {
  const r = actionOutcome({ ok: false, status: 500, data: null })
  assert.equal(r.kind, 'error')
  assert.ok(r.message.length > 0)
})
