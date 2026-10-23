// 音频播放器：AudioPlayer 是紧凑进度条，Player 是可定位的完整播放器。
// 波形需要解码音频，所以只在预览模式为 waveform 且该源尚未解码时才解码，结果按源缓存。
// 解码失败时退回进度条，不显示空白画布。
import { useState, useEffect, useRef } from 'react'
import { usePreviewMode } from '../../lib/previewMode'
import { useT } from '../../lib/i18n'

// 波形解码与峰值缓存，所有播放器共用。
// 同一个 src 只解码一次，所以切换预览模式或重渲染列表都不会重复解码。
const PEAK_RES = 500
const _peaksCache = new Map()   // src -> { peaks: number[], duration: number }
const _peaksInflight = new Map() // src -> Promise
let _sharedCtx = null
function sharedAudioCtx() {
  if (!_sharedCtx) {
    const AC = window.AudioContext || window.webkitAudioContext
    _sharedCtx = AC ? new AC() : null
  }
  return _sharedCtx
}
function decodePeaks(src) {
  if (_peaksCache.has(src)) return Promise.resolve(_peaksCache.get(src))
  if (_peaksInflight.has(src)) return _peaksInflight.get(src)
  const ctx = sharedAudioCtx()
  if (!ctx) return Promise.reject(new Error('no AudioContext'))
  const p = fetch(src)
    .then(r => r.arrayBuffer())
    .then(buf => ctx.decodeAudioData(buf))
    .then(audio => {
      const ch = audio.getChannelData(0)
      const block = Math.max(1, Math.floor(ch.length / PEAK_RES))
      const peaks = new Array(PEAK_RES)
      for (let i = 0; i < PEAK_RES; i++) {
        let max = 0
        const s = i * block
        const e = Math.min(ch.length, s + block)
        for (let j = s; j < e; j++) { const v = Math.abs(ch[j]); if (v > max) max = v }
        peaks[i] = max
      }
      const result = { peaks, duration: audio.duration }
      _peaksCache.set(src, result)
      _peaksInflight.delete(src)
      return result
    })
    .catch(err => { _peaksInflight.delete(src); throw err })
  _peaksInflight.set(src, p)
  return p
}

function themeColors() {
  const cs = getComputedStyle(document.documentElement)
  const get = (k, fb) => (cs.getPropertyValue(k) || '').trim() || fb
  return {
    accent: get('--accent', '#a970ff'),
    muted: get('--muted', '#8a8a99'),
    border: get('--border', '#3a3a44'),
  }
}

// 在画布上绘制波形（已播放与未播放分色）、分段边界竖线与段间静音的底色。
function drawWaveform(canvas, peaksObj, curTime, totalDur, bounds) {
  if (!canvas || !peaksObj) return
  const w = canvas.clientWidth, h = canvas.clientHeight
  if (!w || !h) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const { accent, muted, border } = themeColors()
  const peaks = peaksObj.peaks
  const n = peaks.length
  const mid = h / 2
  const dur = totalDur || peaksObj.duration || 0
  const pct = dur ? Math.min(1, Math.max(0, curTime / dur)) : 0
  const hasBounds = Array.isArray(bounds) && bounds.length > 1 && dur > 0

  // 段间静音的底色。
  if (hasBounds) {
    ctx.save()
    ctx.globalAlpha = 0.18
    ctx.fillStyle = border
    for (let i = 1; i < bounds.length; i++) {
      const gs = bounds[i - 1].end, ge = bounds[i].start
      if (typeof gs === 'number' && typeof ge === 'number' && ge > gs) {
        const x0 = (gs / dur) * w, x1 = (ge / dur) * w
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h)
      }
    }
    ctx.restore()
  }

  // 波形柱，按播放位置分成已播放与未播放两色。
  const barW = w / n
  for (let i = 0; i < n; i++) {
    const bh = Math.max(1, peaks[i] * h * 0.92)
    const x = i * barW
    ctx.fillStyle = (i / n) <= pct ? accent : muted
    ctx.globalAlpha = (i / n) <= pct ? 0.95 : 0.5
    ctx.fillRect(x, mid - bh / 2, Math.max(1, barW * 0.75), bh)
  }
  ctx.globalAlpha = 1

  // 分段边界竖线，画在段间空隙的中点。
  if (hasBounds) {
    ctx.save()
    ctx.strokeStyle = accent
    ctx.globalAlpha = 0.7
    ctx.lineWidth = 1
    for (let i = 1; i < bounds.length; i++) {
      const gs = bounds[i - 1].end, ge = bounds[i].start
      const t = (typeof gs === 'number' && typeof ge === 'number') ? (gs + ge) / 2 : gs
      if (typeof t !== 'number') continue
      const x = Math.round((t / dur) * w) + 0.5
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
    }
    ctx.restore()
  }
}

/**
 * 紧凑进度条播放器：播放键、进度条与时长显示，不可定位。
 * @param src 音频地址。
 * @param onDuration 可选回调，收到解码出的时长（秒）。时长量不出来时不调用。
 */
function AudioPlayer({ src, onDuration }) {
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const audioRef = useRef(null)
  const barRef = useRef(null)
  const rafRef = useRef(0)

  const toggle = () => {
    if (!audioRef.current) return
    if (playing) {
      audioRef.current.pause()
      cancelAnimationFrame(rafRef.current)
      setPlaying(false)
    } else {
      audioRef.current.play().catch(() => {})
      setPlaying(true)
      tick()
    }
  }

  const tick = () => {
    const a = audioRef.current
    if (a && a.duration && barRef.current) {
      barRef.current.style.width = (a.currentTime / a.duration * 100) + '%'
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  const onLoaded = () => {
    if (audioRef.current) {
      const d = audioRef.current.duration
      setDuration(d)
      // 把解码出的时长报给调用方，让它能按格式做区间检查：
      // 服务端只能读 WAV 头，量不出 mp3/flac 等格式的长度。
      if (onDuration && isFinite(d) && d > 0) onDuration(d)
    }
  }

  const onEnded = () => {
    cancelAnimationFrame(rafRef.current)
    setPlaying(false)
    if (barRef.current) barRef.current.style.width = '0%'
  }

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const durStr = duration ? duration.toFixed(1) + 's' : ''

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={toggle}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 2,
          color: playing ? 'var(--accent)' : 'var(--muted)', display: 'flex',
          flexShrink: 0,
        }}
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1"/>
            <rect x="14" y="5" width="4" height="14" rx="1"/>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        )}
      </button>
      <div style={{
        flex: 1, height: 3, background: 'var(--border)', borderRadius: 2,
        overflow: 'hidden', position: 'relative', flexShrink: 0,
      }}>
        <div ref={barRef} style={{
          width: '0%', height: '100%',
          background: 'var(--accent)', borderRadius: 2,
        }}/>
      </div>
      <span style={{ fontSize: 11, color: 'var(--muted)', width: 28, textAlign: 'right', flexShrink: 0 }}>
        {durStr}
      </span>
      <audio
        ref={audioRef}
        src={src}
        onLoadedMetadata={onLoaded}
        onEnded={onEnded}
        preload="metadata"
      />
    </div>
  )
}

/**
 * 与界面配色一致的可定位播放器，取代浏览器原生的 audio 控件（原生控件是浅色样式）。
 * @param src 音频地址。
 * @param size 尺寸档位，决定 class 名里的尺寸后缀。
 * @param bounds 可选：合并时间轴上各段的 [{start,end}] 偏移（秒），波形模式下据此画
 *   分段竖线与段间静音底色。
 * @param duration 可选：服务端给出的合并时长，在音频元数据或解码结果出来之前先用它兜底。
 */
function Player({ src, size = 'md', bounds = null, duration = null }) {
  const audioRef = useRef(null)
  const trackRef = useRef(null)
  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [muted, setMuted] = useState(false)
  const [peaks, setPeaks] = useState(null)
  const [waveErr, setWaveErr] = useState(false)
  const [previewMode] = usePreviewMode()
  const { t } = useT()
  const waveform = previewMode === 'waveform'
  // 引擎直接产出的部分 WAV（例如没有 ffmpeg 时的 32 位浮点或 WAVE_FORMAT_EXTENSIBLE）
  // 浏览器 decodeAudioData 解不出来，这种情况下退回进度条，不显示空白画布。
  const showWave = waveform && !waveErr

  const fmt = (t) => {
    if (!isFinite(t) || t < 0) return '0:00'
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${s < 10 ? '0' : ''}${s}`
  }

  const tick = () => {
    const a = audioRef.current
    if (a) setCur(a.currentTime)
    rafRef.current = requestAnimationFrame(tick)
  }

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }

  const onPlay = () => { setPlaying(true); cancelAnimationFrame(rafRef.current); tick() }
  const onPause = () => { setPlaying(false); cancelAnimationFrame(rafRef.current) }
  const onEnded = () => { setPlaying(false); cancelAnimationFrame(rafRef.current); setCur(0) }
  const onLoaded = () => { const a = audioRef.current; if (a) setDur(a.duration || 0) }

  const seekTo = (clientX) => {
    const a = audioRef.current
    const el = trackRef.current
    if (!a || !el || !isFinite(a.duration) || !a.duration) return
    const r = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    a.currentTime = ratio * a.duration
    setCur(a.currentTime)
  }

  const onTrackDown = (e) => {
    seekTo(e.clientX)
    const move = (ev) => seekTo(ev.clientX)
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const toggleMute = () => {
    const a = audioRef.current
    if (!a) return
    a.muted = !a.muted
    setMuted(a.muted)
  }

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])
  useEffect(() => { setPlaying(false); setCur(0); setDur(0); setPeaks(null); setWaveErr(false) }, [src])

  // 按需解码：只在波形模式生效且该源还没有峰值时进行。
  useEffect(() => {
    if (!waveform || !src || peaks) return
    let cancelled = false
    decodePeaks(src).then(p => { if (!cancelled) setPeaks(p) }).catch(() => { if (!cancelled) setWaveErr(true) })
    return () => { cancelled = true }
  }, [waveform, src, peaks])

  // 峰值、播放进度、时长或分段边界变化时重绘波形。
  const effDur = dur || duration || (peaks && peaks.duration) || 0
  useEffect(() => {
    if (!waveform || !peaks) return
    drawWaveform(canvasRef.current, peaks, cur, effDur, bounds)
  }, [waveform, peaks, cur, effDur, bounds])

  // 容器尺寸变化时重绘：画布尺寸取自 clientWidth。
  useEffect(() => {
    if (!waveform) return
    const el = canvasRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (peaks) drawWaveform(el, peaks, cur, effDur, bounds) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [waveform, peaks, cur, effDur, bounds])

  const pct = dur ? (cur / dur * 100) : 0

  // 紧凑进度条上的分段竖线，取每段空隙的中点，与波形模式的竖线一致。
  const barDividers = (!showWave && Array.isArray(bounds) && bounds.length > 1 && effDur > 0)
    ? bounds.slice(1).map((b, i) => {
        const mid = (bounds[i].end + b.start) / 2
        return Math.min(100, Math.max(0, (mid / effDur) * 100))
      })
    : []

  return (
    <div className={`aplayer aplayer-${size}`}>
      <button className="ap-btn ap-play" onClick={toggle} title={playing ? 'Pause' : 'Play'} type="button">
        {playing ? (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <span className="ap-time">{fmt(cur)}</span>
      {showWave ? (
        <div className={`ap-wave ap-wave-${size}`} ref={trackRef} onMouseDown={onTrackDown} role="slider" aria-label="Seek">
          <canvas className="ap-wave-canvas" ref={canvasRef} />
        </div>
      ) : (
        <div
          className={`ap-track${waveErr ? ' ap-track-nowave' : ''}`}
          ref={trackRef}
          onMouseDown={onTrackDown}
          role="slider"
          aria-label="Seek"
          title={waveErr ? t('This audio format can\u2019t be rendered as a waveform; showing the progress bar instead.', '此音频格式无法生成波形，已回退为进度条') : undefined}
        >
          <div className="ap-fill" style={{ width: pct + '%' }}>
            <span className="ap-thumb" />
          </div>
          {barDividers.map((left, i) => (
            <span key={i} className="ap-seg-div" style={{ left: left + '%' }} />
          ))}
        </div>
      )}
      <span className="ap-time ap-dur">{fmt(dur)}</span>
      <button className="ap-btn ap-vol" onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'} type="button">
        {muted ? (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 9v6h4l5 5V4L8 9H4z" />
            <path d="M16 8l5 8M21 8l-5 8" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 9v6h4l5 5V4L8 9H4z" />
            <path d="M16 8.5a4 4 0 010 7" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          </svg>
        )}
      </button>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={onLoaded}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
      />
    </div>
  )
}

export {
  AudioPlayer,
  Player,
}
