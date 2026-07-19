// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef } from 'react'
import { usePreviewMode } from '../../lib/previewMode'
import { useT } from '../../lib/i18n'

// ---- Waveform decode + peaks cache (shared across every Player) ----
// Decoding is done once per src and memoised, so flipping preview mode or
// re-rendering a list never re-decodes the same audio.
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

// Draw the waveform (played/unplayed split) plus segment-boundary dividers and
// inter-segment silence shading onto a canvas.
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

  // Inter-segment silence shading.
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

  // Waveform bars, split at the playback position.
  const barW = w / n
  for (let i = 0; i < n; i++) {
    const bh = Math.max(1, peaks[i] * h * 0.92)
    const x = i * barW
    ctx.fillStyle = (i / n) <= pct ? accent : muted
    ctx.globalAlpha = (i / n) <= pct ? 0.95 : 0.5
    ctx.fillRect(x, mid - bh / 2, Math.max(1, barW * 0.75), bh)
  }
  ctx.globalAlpha = 1

  // Segment-boundary dividers (mid-gap).
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
      // Report the decoded duration up so callers can range-check any format
      // (WAV header parsing on the server can't measure mp3/flac/etc).
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

// Full dark-themed, seekable audio player that matches the app UI.
// Replaces the native <audio controls> chrome (which renders as a light
// pill that clashes with the dark/purple theme).
// `bounds` (optional): per-segment [{start,end}] offsets (seconds) in the combined
// timeline — when present in waveform mode, segment dividers + silence shading are
// drawn. `duration` (optional): server-reported combined duration used as a fallback
// before the audio metadata / decode resolves it.
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
  // Some engine-direct WAVs (e.g. 32-bit float / WAVE_FORMAT_EXTENSIBLE, produced
  // when ffmpeg is unavailable) can't be decoded by the browser's decodeAudioData.
  // In that case fall back to the bar track instead of rendering a blank canvas.
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

  // Lazy decode: only when the waveform mode is active and we don't have peaks yet.
  useEffect(() => {
    if (!waveform || !src || peaks) return
    let cancelled = false
    decodePeaks(src).then(p => { if (!cancelled) setPeaks(p) }).catch(() => { if (!cancelled) setWaveErr(true) })
    return () => { cancelled = true }
  }, [waveform, src, peaks])

  // Redraw the waveform whenever peaks / progress / duration / bounds change.
  const effDur = dur || duration || (peaks && peaks.duration) || 0
  useEffect(() => {
    if (!waveform || !peaks) return
    drawWaveform(canvasRef.current, peaks, cur, effDur, bounds)
  }, [waveform, peaks, cur, effDur, bounds])

  // Redraw on container resize (canvas is sized from its clientWidth).
  useEffect(() => {
    if (!waveform) return
    const el = canvasRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (peaks) drawWaveform(el, peaks, cur, effDur, bounds) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [waveform, peaks, cur, effDur, bounds])

  const pct = dur ? (cur / dur * 100) : 0

  // Segment-boundary dividers for the compact bar track (mid-gap of each inter-
  // segment silence), mirroring the waveform-mode dividers.
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

// Acknowledge-able naming/metadata notice for the Assets tab.
//
// Split into two pieces so the collapsed hint lives OUTSIDE the content flow
// (in the summary-bar's free space, right of the stat pills) and takes zero
// density from the asset list:
//   - <NamingNotePill/>  the one-line pill (shown when acked & collapsed)
//   - <NamingNoteCard/>  the full card (first visit, or re-opened)
// Ack/open state is lifted into AssetsTab so both pieces stay in sync.

export {
  AudioPlayer,
  Player,
}
