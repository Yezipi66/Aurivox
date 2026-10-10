// ============================================================
//  刀 F2：引擎管理页 —— 不点合成也能起 / 停 / 看引擎
// ============================================================
//
// ⭐⭐⭐ 这个页面存在的全部理由（2026-08-31 当场量出来的）：
//   · lib/routes/engines.js 在刀 F1 之前只有 1 个路由，且是 GET
//   · supervisor.ensure()（起引擎）唯一的活调用点在**合成里**
//   · supervisor.stop(id)（停单台）活代码里 0 个调用点
//   ⇒ 界面能"看"引擎，⛔ 不能"动"引擎。**想起一台引擎，唯一的办法是点一次合成。**
//
// ⭐ 顺带接上一个一直没人用的东西：lib/engines.js 的 processBadge() 写好之后，
//   全仓库**没有一个 .jsx 在渲染它** —— 同一种坏法（做完了，没接上）。
//
// ⛔ 这个文件里不许出现任何具体引擎的名字，也不许判"内存够不够 / 名额满没满"。
//   前端只挡它自己看得见的四件事（不归平台管、没装看管人、已经在跑、正忙），
//   判断全部在 lib/engineActions.pure.js；剩下的一律发出去让后端说不行。
//   ⭐ 判据：**判据只能有一份。** 前端多一份的表现是"按钮亮着按下去被拒"，
//     或者更坏 —— "按钮灰着，其实能起"。

import { useState } from 'react'
import { startEngine, stopEngine, processBadge, occupancyBadge, engineUsageBadge } from '../../lib/engines'
import { engineControls, actionOutcome } from '../../lib/engineActions.pure.js'

const TONE_CLASS = {
  ok: 'badge-ok',
  busy: 'badge-accent',
  idle: 'badge-neutral',
  unknown: 'badge-muted',
  bad: 'badge-danger',
}

// ⭐ badge-danger 不一定在所有主题里都定义了；没有就退回 danger 边框色。
//   ⛔ 不用 badge-bad：那是 engineBadge 用的另一个类名，两套命名会漂。
function toneClass (tone) {
  return TONE_CLASS[tone] || 'badge-muted'
}

export function EnginesTab ({ engines = [], engineErrors = [], occupancy = null, onChanged }) {
  // { [id]: 'start' | 'stop' } —— 这一台正在等后端回话。
  const [pending, setPending] = useState({})
  // { [id]: { kind, message, ... } } —— 上一次操作的结果，就地显示在那一行。
  // ⛔ 不做成全局一条 —— 五台引擎共用一条提示，看不出说的是哪一台。
  const [outcome, setOutcome] = useState({})

  // ⭐ 两个翻函数都是纯的（web/src/lib/engines.js），这里只调一次。
  const occBadge = occupancyBadge(occupancy)

  const setBusy = (id, what) => setPending(p => ({ ...p, [id]: what }))
  const clearBusy = (id) => setPending(p => { const n = { ...p }; delete n[id]; return n })

  const run = async (id, what, fn) => {
    setBusy(id, what)
    setOutcome(o => ({ ...o, [id]: null }))
    try {
      const resp = await fn()
      const res = actionOutcome(resp)
      setOutcome(o => ({ ...o, [id]: res }))
      // ⭐ 成功之后要求上层重拉一次：进程状态那个 8 秒轮询会自己追上，
      //   但等 8 秒会让人以为按钮没反应，然后再点一次。
      if (res.kind === 'ok' && typeof onChanged === 'function') onChanged()
    } catch (err) {
      // ⛔ 网络层挂了不许静默 —— 静默成功是最贵的那种坏法。
      setOutcome(o => ({ ...o, [id]: { kind: 'error', message: String((err && err.message) || err) } }))
    } finally {
      clearBusy(id)
    }
  }

  return (
    <div className="section">
      <div className="section-hdr"><h2>引擎</h2></div>
      <div className="section-body">
      <p className="msg msg-info">
        这台机器上装了哪几台引擎、各自跑没跑，以及不点合成也能把它起起来。
        <br />
        ⚠ 同时启动多台引擎会占用大量内存 —— 平台会按实测峰值拦，拦下来时这里会写明原因。
      </p>

      {/* ⭐⭐ B5 占用透明度：机器级总览。
          ⛔ null = 后端没给这一段 ⇒ **不画**（不是画「没占用」）。
          ⭐ 判据是「字段在不在」而不是「数组空不空」—— 两者都长得像 []，
            但一个是「真装了 0 台」、另一个是「平台不知道」，含义相反。 */}
      {occBadge && (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`badge ${toneClass(occBadge.tone)}`} title={occBadge.title}>
              {occBadge.label}
            </span>
            <span style={{ color: 'var(--muted)' }}>{occBadge.detail.join(' · ')}</span>
          </div>
        </div>
      )}

      {/* 名片坏掉的引擎在 errors 里，不在 engines 里。必须显示 ——
          一台引擎因为少写一个键就从列表里静默消失，是最难查的那种症状。 */}
      {engineErrors.length > 0 && (
        <div className="msg msg-danger">
          <strong>这几台引擎的名片读不出来，所以没出现在下面的列表里：</strong>
          <ul>
            {engineErrors.map(e => (
              <li key={e.id}><code>{e.id}</code>{e.code ? ` [${e.code}]` : ''} —— {e.error || e.message}</li>
            ))}
          </ul>
        </div>
      )}

      {engines.length === 0 && (
        <div className="card">这台机器上一台引擎都没装（或者列表还没拉回来）。</div>
      )}

      {engines.map(engine => {
        const ctl = engineControls(engine)
        const badge = processBadge(engine)
        const busy = pending[engine.id] || null
        const res = outcome[engine.id] || null
        return (
          <div className="card" key={engine.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <strong>{engine.label || engine.id}</strong>
              <code style={{ opacity: 0.7 }}>{engine.id}</code>
              {badge && (
                <span className={`badge ${TONE_CLASS[badge.tone] || 'badge-muted'}`} title={badge.title}>
                  {badge.label}
                </span>
              )}
              {/* ⭐ null = 这台部署不管进程，⛔ 不是"没在跑"。两者必须分开显示。 */}
              {badge === null && (
                <span className="badge badge-muted" title="这台部署不管引擎进程，或这台引擎由作者自己起。">
                  平台不管
                </span>
              )}

              {/* ⭐⭐ B5 引擎级占用。⛔ null = 后端没报这台 ⇒ **不画**。
                  ⛔ 绝不为「没量到」画一枚写着 0 的徽章 —— 那等于说
                    「它不吃内存」，而那是最危险的说法（用户会以为能多开）。
                  ⚠ tone=bad 那一枚是「上次启动没活着回来」⇒ 多半 OOM，
                    它排在最前面，因为那是唯一需要用户行动的一条。 */}
              {usage && (
                <span
                  className={`badge ${toneClass(usage.tone)}`}
                  style={usage.tone === 'bad' ? { borderColor: 'var(--danger)' } : undefined}
                  title={usage.title}
                >
                  {usage.label}
                </span>
              )}
              <div style={{ flex: 1 }} />
              <button
                className="btn"
                disabled={!ctl.start.enabled || !!busy}
                title={ctl.start.title}
                onClick={() => run(engine.id, 'start', () => startEngine(engine.id))}
              >
                {busy === 'start' ? '启动中…' : ctl.start.label}
              </button>
              <button
                className="btn"
                disabled={!ctl.stop.enabled || !!busy}
                title={ctl.stop.title}
                onClick={() => run(engine.id, 'stop', () => stopEngine(engine.id))}
              >
                {busy === 'stop' ? '关闭中…' : ctl.stop.label}
              </button>
            </div>

            {res && res.kind === 'error' && (
              <div className="msg msg-error" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                {res.message}
              </div>
            )}

            {/* ⭐⭐⭐ 唯一一个需要人来回答的分支。
                ⛔ 不许把它当普通报错红字弹出去 —— 那会让"平台还没量过这台引擎
                  要多少内存"变成一句没法推进的话，而用户其实只要点一下就行。
                §12 开放问题 ② 记的就是这个形状：一个必须有人回答的问题，
                下游那条路上没有人 —— 这个页面上有。 */}
            {res && res.kind === 'confirm' && (
              <div className="card" style={{ marginTop: 8 }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{res.message}</div>
                {res.mem && res.mem.freeMb != null && (
                  <div className="msg msg-info">当前可用内存约 {res.mem.freeMb} MB。</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() => run(engine.id, 'start', () => startEngine(engine.id, { confirmed: true }))}
                  >
                    {res.confirmLabel}
                  </button>
                  <button className="btn" onClick={() => setOutcome(o => ({ ...o, [engine.id]: null }))}>
                    取消
                  </button>
                </div>
              </div>
            )}

            {res && res.kind === 'ok' && (
              <div className="msg msg-success" style={{ marginTop: 8 }}>
                {/* action 四种各自说人话。⛔ 不压成"成功" ——
                    "本来就在跑"和"刚给你起起来"对用户不是一回事。 */}
                {res.action === 'reuse' && '它本来就在跑，直接用了。'}
                {res.action === 'start' && '起来了。'}
                {res.action === 'relaunch' && '为了换那一份模型，把它重开了一次。'}
                {res.action === 'not-ours' && '这台引擎由作者自己起，平台没有动它。'}
                {res.action == null && '好了。'}
              </div>
            )}
          </div>
        )
      })}
      </div>
    </div>
  )
}
