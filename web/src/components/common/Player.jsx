// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef } from 'react'

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
function Player({ src, size = 'md' }) {
  const audioRef = useRef(null)
  const trackRef = useRef(null)
  const rafRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [muted, setMuted] = useState(false)

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
  useEffect(() => { setPlaying(false); setCur(0); setDur(0) }, [src])

  const pct = dur ? (cur / dur * 100) : 0

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
      <div className="ap-track" ref={trackRef} onMouseDown={onTrackDown} role="slider" aria-label="Seek">
        <div className="ap-fill" style={{ width: pct + '%' }}>
          <span className="ap-thumb" />
        </div>
      </div>
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
