// 训练页与资产页共用的面板组件：流水线图、重建进度、实时日志、试听与置信度标注。
// 组件只负责显示与交互，训练任务的真实状态由后端接口给出。
// 置信度着色只作辅助，颜色之外另用符号冗余编码，不依赖红绿分辨也能读。
import { useState, useEffect, useRef } from 'react'
import { useT } from '../../lib/i18n'
import { TRAIN_STEPS } from './trainConstants'

// 流水线图。既是导航（点节点去配置那一步），也是状态（节点反映任务当前的状态）。
function PipelineMap({ statusSteps, enabledMap, selectedNode, onSelect, readOnly }) {
  const { t, lang } = useT()
  return (
    <div className={`pipe-map ${readOnly ? 'readonly' : ''}`} role="list">
      {TRAIN_STEPS.map((s, i) => {
        let st
        const off = enabledMap && enabledMap[s.key] === false
        if (statusSteps && statusSteps[s.key]) st = statusSteps[s.key].status || 'pending'
        else st = off ? 'skipped' : 'pending'
        const glyph = st === 'completed' ? '\u2713' : st === 'running' ? '\u25CF' : st === 'failed' ? '\u2717' : st === 'skipped' ? '\u2013' : i + 1
        const isSel = selectedNode === s.key
        // 节点左侧的连接段在上一步完成后转绿，整条轨道因此读起来像进度条。
        const prevDone = i > 0 && statusSteps && statusSteps[TRAIN_STEPS[i - 1].key] &&
          statusSteps[TRAIN_STEPS[i - 1].key].status === 'completed'
        return (
          <button
            type="button"
            role="listitem"
            className={`pipe-step ${isSel ? 'selected' : ''} ${off ? 'disabled-step' : ''} ${readOnly ? 'readonly' : ''}`}
            key={s.key}
            onClick={readOnly ? undefined : () => onSelect(isSel ? null : s.key)}
            title={readOnly ? (lang === 'zh' ? s.labelZh : s.label) : t('Click to configure this step', '点击以配置此步骤')}
          >
            {i > 0 && <span className={`pipe-seg ${prevDone ? 'done' : ''}`} aria-hidden="true" />}
            <span className={`pipe-dot ${st}`}>{glyph}</span>
            <span className={`pipe-label ${st === 'running' ? 'running' : ''}`}>{lang === 'zh' ? s.labelZh : s.label}</span>
          </button>
        );
      })}
    </div>
  )
}

// 资产页上正在进行的重建作业的进度面板。
// 复用同一个 PipelineMap（只读），因此修复流程与正式训练流程长得一样：
// 不相关的步骤显示为灰掉或跳过，进行中的步骤有动画，失败时给出失败的那一步与错误信息。
function RebuildProgress({ job, onDismiss }) {
  if (!job) return null
  const stepLabel = (k) => (TRAIN_STEPS.find(s => s.key === k) || {}).label || k
  const failed = job.phase === 'failed'
  const done = job.phase === 'done'
  const scanning = job.phase === 'scanning'
  let statusText, statusCls
  if (failed) { statusText = `Failed at ${stepLabel(job.failedStep)}`; statusCls = 'error' }
  else if (done) { statusText = 'Rebuild complete — assets rescanned.'; statusCls = 'success' }
  else if (scanning) { statusText = 'Rebuild finished — rescanning assets…'; statusCls = 'info' }
  else { statusText = job.currentStep ? `Running: ${stepLabel(job.currentStep)}…` : 'Starting…'; statusCls = 'info' }
  return (
    <div className={`rebuild-progress ${failed ? 'is-failed' : ''}`}>
      <div className="rp-hdr">
        <span className="rp-title">
          {failed ? '\u2717' : done ? '\u2713' : '\u25CF'} {failed ? 'Rebuild failed' : done ? 'Rebuild done' : 'Rebuilding'} · {job.id}
        </span>
        {(failed || done) && (
          <button className="btn btn-sm btn-ghost" onClick={onDismiss}>Dismiss</button>
        )}
      </div>
      <PipelineMap statusSteps={job.steps} readOnly />
      <div className={`rp-status msg-${statusCls}`}>{statusText}</div>
      {failed && job.error && (
        <pre className="rp-error">{job.error}</pre>
      )}
    </div>
  )
}

// 实时日志：自动滚动、暂停、复制、清空。
function LiveLogs({ logs }) {
  const [autoScroll, setAutoScroll] = useState(true)
  const boxRef = useRef(null)
  useEffect(() => {
    if (autoScroll && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [logs, autoScroll])
  const copy = () => {
    const txt = (logs || []).map(l => `[${new Date(l.time).toLocaleTimeString()}] ${l.message}`).join('\n')
    try { navigator.clipboard?.writeText(txt) } catch { /* ignore */ }
  }
  return (
    <div className="section">
      <div className="section-hdr">
        <span>Live Logs</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => setAutoScroll(v => !v)}>{autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}</button>
          <button className="btn btn-sm" onClick={copy} disabled={!logs || logs.length === 0}>Copy</button>
        </div>
      </div>
      <div className="section-body">
        {(!logs || logs.length === 0) ? (
          <div className="empty-state" style={{ padding: 16 }}>
            <div className="es-sub" style={{ marginBottom: 0 }}>Logs will appear here after training starts.</div>
          </div>
        ) : (
          <div className="log-view" ref={boxRef}>
            {logs.map((log, i) => (
              <div key={i} className={`log-line ${log.level || ''}`}>
                <span className="log-ts">[{new Date(log.time).toLocaleTimeString()}]</span>{log.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// 校对用的播放控件：只有播放与暂停，没有进度条，一次只播一行。
// src 指向后端的 Range 路由，preload="none" 惰性加载。
function ReviewRowAudio({ taskId, relPath }) {
  const ref = useRef(null)
  const [playing, setPlaying] = useState(false)
  if (!relPath) return null
  const src = `/api/train/review/${taskId}/audio?path=${encodeURIComponent(relPath)}`
  const toggle = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) { el.play().catch(() => {}) } else { el.pause() }
  }
  return (
    <span className="arr-audio">
      <button type="button" className="btn btn-sm btn-ghost" onClick={toggle}
              title={playing ? 'Pause' : 'Play'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '1px 8px', height: 22 }}>
        <span style={{ fontSize: 10, lineHeight: 1 }}>{playing ? '❚❚' : '▶'}</span>
        <span style={{ fontSize: 10 }}>{playing ? 'Pause' : 'Play'}</span>
      </button>
      <audio ref={ref} src={src} preload="none"
             onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
             onEnded={() => setPlaying(false)} style={{ display: 'none' }} />
    </span>
  )
}

// ASR 置信度着色。faster-whisper 的 word 与 segment 概率折算成 [0,1]，
// 映射到可信、可疑、存疑三档，辅助人工校对。
const CONF_HI = 0.85
const CONF_MID = 0.6
function confTier(c) {
  if (typeof c !== 'number') return null
  if (c >= CONF_HI) return 'hi'
  if (c >= CONF_MID) return 'mid'
  return 'lo'
}
// 三档的颜色与符号。符号是色觉冗余编码：颜色只作辅助，不依赖红绿分辨也能读。
// hi 为对勾（较为可信）/ mid 为波浪号（可疑）/ lo 为感叹号（存疑）。
// 词级另叠加下划线（见 CSS .arr-w-*）。
const CONF_COLORS = {
  hi: { fg: '#2ecc71', bg: 'rgba(46,204,113,0.16)', sym: '✓' },
  mid: { fg: '#f1c40f', bg: 'rgba(241,196,15,0.18)', sym: '~' },
  lo: { fg: '#e74c3c', bg: 'rgba(231,76,60,0.18)', sym: '!' },
}
// 三档的显示名。调用处传入 tr 做双语。
function confTierLabel(tier, tr) {
  if (tier === 'hi') return tr('Confident', '较为可信')
  if (tier === 'mid') return tr('Uncertain', '可疑')
  if (tier === 'lo') return tr('Doubtful', '存疑')
  return ''
}

// 行级置信度徽标：符号、色点与百分比。符号是色觉冗余编码。
function ConfBadge({ conf, tr }) {
  const tier = confTier(conf)
  if (!tier) return null
  const c = CONF_COLORS[tier]
  const pct = (conf * 100).toFixed(0)
  return (
    <span className="arr-conf" title={`${tr('Confidence', '置信度')} ${pct}% · ${confTierLabel(tier, tr)}`}>
      <span aria-hidden="true" style={{ fontSize: 10, fontWeight: 700, color: c.fg, lineHeight: 1 }}>{c.sym}</span>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.fg, display: 'inline-block' }} />
      <span style={{ fontSize: 10, color: c.fg }}>{pct}%</span>
    </span>
  )
}

// 词级置信度预览：逐词着色并叠加下划线。
// 只读：textarea 无法富文本，所以另起一条预览。
function WordConf({ words, tr }) {
  if (!Array.isArray(words) || words.length === 0) return null
  return (
    <div className="arr-words" title={tr('Per-word confidence (color + underline); for proofreading reference only',
                                        '逐词置信度（颜色+下划线冗余编码），仅供校对参考')}>
      {words.map((w, j) => {
        const tier = confTier(w && typeof w.p === 'number' ? w.p : null)
        const c = tier ? CONF_COLORS[tier] : null
        return (
          <span key={j} className={tier ? `arr-w arr-w-${tier}` : 'arr-w'}
                style={{ color: c ? c.fg : 'var(--muted)', background: c ? c.bg : 'transparent' }}>
            {(w && w.w != null ? String(w.w) : '').trim() || '␠'}
          </span>
        )
      })}
    </div>
  )
}

export {
  PipelineMap,
  RebuildProgress,
  LiveLogs,
  ReviewRowAudio,
  ConfBadge,
  WordConf,
  confTier,
  confTierLabel,
  CONF_HI,
  CONF_MID,
  CONF_COLORS,
}
