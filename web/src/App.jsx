import { useState, useEffect, useCallback, useRef } from 'react'
import './styles.css'
import { usePersistentState } from './usePersistentState'

const API_BASE = ''

// ---- Language detection ----
function detectLang(text) {
  const s = text.replace(/\s/g, '')
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length
  const en = (s.match(/[a-zA-Z]/g) || []).length
  if (cjk > en) {
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return 'ja'
    if (/[\uac00-\ud7af]/.test(s)) return 'ko'
    return 'zh'
  }
  return 'en'
}

function api(path, opts = {}) {
  const url = `${API_BASE}${path}`
  const { method = 'GET', body, contentType, isRaw } = opts
  const headers = contentType ? {} : { 'Content-Type': 'application/json' }
  const fetchOpts = { method, headers }
  if (body) fetchOpts.body = contentType ? body : JSON.stringify(body)
  return fetch(url, fetchOpts).then(async r => {
    if (isRaw || r.headers.get('content-type')?.includes('audio/')) {
      const buf = await r.arrayBuffer()
      return { ok: r.ok, status: r.status, data: new Uint8Array(buf), contentType: r.headers.get('content-type') || '' }
    }
    if (r.headers.get('content-type')?.includes('application/json')) {
      const data = await r.json()
      return { ok: r.ok, status: r.status, data }
    }
    return { ok: r.ok, status: r.status, data: await r.text() }
  })
}

function checkIcon(v) {
  return v ? <span style={{ color: 'var(--success)', fontWeight: 700 }}>✓</span> : <span style={{ color: 'var(--danger)', fontWeight: 700 }}>✗</span>
}

function basename(p) {
  if (!p || typeof p !== 'string') return '(none)'
  const a = p.replace(/\\/g, '/').split('/')
  return a[a.length - 1]
}

// ===========================
//  GENERATE TAB
// ===========================
function GenerateTab({ voices, selectedVoice, setSelectedVoice, onEditVoice, onSwitchToCompare, onVoiceUpdate, selectedRefAudio, selectedRefText, onSelectRef }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [validation, setValidation] = useState(null)

  const [splitEnabled, setSplitEnabled] = useState(true)
  const [maxChars, setMaxChars] = useState(30)
  const [concatEnabled, setConcatEnabled] = useState(true)
  const [silenceMs, setSilenceMs] = useState(300)

  const selected = voices.find(v => v.id === selectedVoice)

  // Advanced settings — loaded from /api/advanced-params (global, not per-voice)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [temperature, setTemperature] = useState(1.0)
  const [topK, setTopK] = useState(15)
  const [topP, setTopP] = useState(1.0)
  const [repPenalty, setRepPenalty] = useState(1.35)
  const [splitMethod, setSplitMethod] = useState('cut5')
  const [speedFactor, setSpeedFactor] = useState(1.0)
  const [seed, setSeed] = useState(-1)

  // Load advanced params from backend on mount
  useEffect(() => {
    api('/api/advanced-params').then(r => {
      if (r.ok && r.data) {
        const p = r.data
        if (p.temperature !== undefined) setTemperature(p.temperature)
        if (p.top_k !== undefined) setTopK(p.top_k)
        if (p.top_p !== undefined) setTopP(p.top_p)
        if (p.repetition_penalty !== undefined) setRepPenalty(p.repetition_penalty)
        if (p.text_split_method !== undefined) setSplitMethod(p.text_split_method)
        if (p.speed_factor !== undefined) setSpeedFactor(p.speed_factor)
        if (p.seed !== undefined) setSeed(p.seed)
      }
    }).catch(() => {})
  }, [])

  // Model selection
  const [checkpoints, setCheckpoints] = useState({ gpt: [], sovits: [] })
  const [selGpt, setSelGpt] = useState('')
  const [selSovits, setSelSovits] = useState('')
  const [lang, setLang] = useState(selected?.language || 'ja')
  const [auxRefs, setAuxRefs] = useState([])  // selected aux reference audio paths
  const [segments, setSegments] = useState([])  // loaded from API for aux ref picker

  // Load checkpoints + segments when voice changes
  useEffect(() => {
    if (!selectedVoice) return
    api(`/api/assets/${selectedVoice}`).then(r => {
      if (r.ok && r.data.ok && r.data.meta?.assets?.checkpoints) {
        const c = r.data.meta.assets.checkpoints
        setCheckpoints({ gpt: c.gpt || [], sovits: c.sovits || [] })
        if (!selGpt) setSelGpt(r.data.meta.assets.checkpoints.gpt?.[0]?.path || '')
        if (!selSovits) setSelSovits(r.data.meta.assets.checkpoints.sovits?.[0]?.path || '')
      }
    }).catch(() => {})
    api(`/api/assets/${selectedVoice}/segments`).then(r => {
      if (r.ok && r.data.segments) setSegments(r.data.segments.segments || [])
    }).catch(() => setSegments([]))
  }, [selectedVoice])

  // Set language from voice config
  useEffect(() => {
    const v = voices.find(x => x.id === selectedVoice)
    if (v?.language) setLang(v.language)
  }, [selectedVoice, voices])

  // Advanced params are global (from /api/advanced-params), not per-voice — no sync needed on voice change

  useEffect(() => {
    if (!selectedVoice) return
    api(`/api/voices/${selectedVoice}/validate`).then(r => {
      if (r.ok && r.data.ok) setValidation(r.data.checks)
    }).catch(() => setValidation(null))
  }, [selectedVoice, voices])

  // Use user-selected ref (from VoiceSidebar) or fallback to first matched segment
  const defaultRef = segments.length > 0
    ? (segments.find(s => s.matched && (s.audio || s.audio_path || s.audio_filename)) || segments[0])
    : null
  const currentRefAudio = selectedRefAudio || (defaultRef ? (defaultRef.audio || defaultRef.audio_path || defaultRef.audio_filename) : '')
  const currentRefText = selectedRefText || (defaultRef ? (defaultRef.text || '') : '')

  const handleGenerate = async () => {
    if (!selectedVoice) { setError('Select a voice first'); return }
    if (!text.trim()) { setError('Enter text to synthesize'); return }
    setLoading(true); setError(null); setResult(null)
    try {
      const r = await api('/api/generate', {
        method: 'POST',
        body: {
          voice: selectedVoice, text: text.trim(), format: 'wav',
          ref_audio: currentRefAudio || undefined,
          reference_text: currentRefText || undefined,
          split: splitEnabled, max_chars: maxChars,
          concat: concatEnabled, silence_ms: silenceMs,
          temperature, top_k: topK, top_p: topP,
          repetition_penalty: repPenalty, text_split_method: splitMethod,
          speed_factor: speedFactor, seed,
          batch_size: batchSize, batch_threshold: batchThreshold,
          split_bucket: splitBucket, fragment_interval: fragmentInterval,
          parallel_infer: parallelInfer,
          sample_steps: sampleSteps, if_sr: superSampling,
          media_type: mediaType, streaming_mode: streamingMode,
          overlap_length: overlapLength, min_chunk_length: minChunkLength,
          gpt_model: selGpt, sovits_model: selSovits,
          text_lang: lang, prompt_lang: lang,
          aux_ref_audio_paths: auxRefs.length > 0 ? auxRefs : undefined,
        }
      })
      if (!r.ok) throw new Error(r.data.error || `Server error ${r.status}`)
      setResult(r.data)
      // Auto-save advanced params after successful generation
      api('/api/advanced-params', {
        method: 'POST',
        body: {
          temperature, top_k: topK, top_p: topP,
          repetition_penalty: repPenalty, text_split_method: splitMethod,
          speed_factor: speedFactor, seed,
          batch_size: batchSize, batch_threshold: batchThreshold,
          split_bucket: splitBucket, fragment_interval: fragmentInterval,
          parallel_infer: parallelInfer,
          sample_steps: sampleSteps, if_sr: superSampling,
          media_type: mediaType, streaming_mode: streamingMode,
          overlap_length: overlapLength, min_chunk_length: minChunkLength,
        },
      }).catch(() => {})
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <div className="workspace-grid">
      <div className="workspace-left">
        <div className="section">
          <div className="section-hdr"><span>Generate</span></div>
          <div className="section-body">
            <div className="field">
              <label className="field-label">Voice</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select className="control" style={{ flex: 1 }} value={selectedVoice} onChange={e => setSelectedVoice(e.target.value)}>
                  {voices.map(v => <option key={v.id} value={v.id}>{v.display_name} ({v.id}) [{v.language}]</option>)}
                  {voices.length === 0 && <option value="">No voices available</option>}
                </select>
                {selected && <button className="btn btn-sm" onClick={() => onEditVoice(selected.id)}>Edit</button>}
                <button className="btn btn-sm" onClick={onSwitchToCompare}>Compare Refs</button>
              </div>
            </div>

            {/* Model selection row */}
            {checkpoints.gpt.length > 0 && (
              <div className="field">
                <label className="field-label">GPT Model</label>
                <select className="control" value={selGpt} onChange={e => setSelGpt(e.target.value)}>
                  {checkpoints.gpt.map(c => (
                    <option key={c.path} value={c.path}>{c.name} (step {c.steps})</option>
                  ))}
                </select>
              </div>
            )}
            {checkpoints.sovits.length > 0 && (
              <div className="field">
                <label className="field-label">SoVITS Model</label>
                <select className="control" value={selSovits} onChange={e => setSelSovits(e.target.value)}>
                  {checkpoints.sovits.map(c => (
                    <option key={c.path} value={c.path}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label className="field-label">Text</label>
              <textarea
                className="control" rows={5} placeholder="Enter text to synthesize..."
                value={text} onChange={e => { setText(e.target.value); }}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                Language: <span style={{ color: 'var(--accent)', textTransform: 'uppercase' }}>{lang}</span>
              </div>
            </div>

            <div className="section" style={{ margin: '6px 0' }}>
              <div className="section-hdr"><span>Long-Text Splitting</span></div>
              <div className="section-body">
                <div className="form-grid">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={splitEnabled} onChange={e => setSplitEnabled(e.target.checked)} />
                    Split long text
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>Max chars:</span>
                    <input type="number" className="control" style={{ width: 60, height: 26, padding: '0 6px', fontSize: 12 }} value={maxChars} min={10} max={200} onChange={e => setMaxChars(parseInt(e.target.value) || 30)} />
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={concatEnabled} onChange={e => setConcatEnabled(e.target.checked)} disabled={!splitEnabled} />
                    Concatenate
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>Silence (ms):</span>
                    <input type="number" className="control" style={{ width: 60, height: 26, padding: '0 6px', fontSize: 12 }} value={silenceMs} min={0} max={2000} step={50} onChange={e => setSilenceMs(parseInt(e.target.value) || 300)} />
                  </div>
                </div>
                {splitEnabled && text.length > maxChars && (
                  <div className="field-hint" style={{ marginTop: 6, color: 'var(--warning)' }}>
                    Text ({text.length} chars) will be split into segments of ~{maxChars} chars each.
                  </div>
                )}
              </div>
            </div>

            {/* Advanced Settings */}
            <div className="collapsible" style={{ margin: '6px 0' }}>
              <div className="collapsible-hdr" onClick={() => setShowAdvanced(!showAdvanced)}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Advanced Settings</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showAdvanced ? '▲' : '▼'}</span>
              </div>
              {showAdvanced && (
                <div className="collapsible-body">
                  {/* Tier tabs */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                    <button type="button" className="btn btn-sm" onClick={() => setAdvTier('common')} style={{ background: advTier === 'common' ? 'var(--accent)' : 'var(--surface)', color: advTier === 'common' ? '#fff' : 'var(--muted)' }}>Common</button>
                    <button type="button" className="btn btn-sm" onClick={() => setAdvTier('advanced')} style={{ background: advTier === 'advanced' ? 'var(--accent)' : 'var(--surface)', color: advTier === 'advanced' ? '#fff' : 'var(--muted)' }}>Advanced</button>
                  </div>

                  {advTier === 'common' && (
                    <div className="form-grid">
                      <div>
                        <label className="field-label">Temperature</label>
                        <input type="number" className="control" step="0.05" min="0" max="2" value={temperature} onChange={e => setTemperature(parseFloat(e.target.value) || 1.0)} />
                      </div>
                      <div>
                        <label className="field-label">Top K</label>
                        <input type="number" className="control" step="1" min="1" max="100" value={topK} onChange={e => setTopK(parseInt(e.target.value) || 15)} />
                      </div>
                      <div>
                        <label className="field-label">Top P</label>
                        <input type="number" className="control" step="0.05" min="0" max="1" value={topP} onChange={e => setTopP(parseFloat(e.target.value) || 1.0)} />
                      </div>
                      <div>
                        <label className="field-label">Repetition Penalty</label>
                        <input type="number" className="control" step="0.05" min="0.5" max="2" value={repPenalty} onChange={e => setRepPenalty(parseFloat(e.target.value) || 1.35)} />
                      </div>
                      <div>
                        <label className="field-label">Split Method</label>
                        <select className="control" value={splitMethod} onChange={e => setSplitMethod(e.target.value)}>
                          <option value="cut0">cut0 (no split)</option>
                          <option value="cut1">cut1 (punctuation)</option>
                          <option value="cut2">cut2 (sentence)</option>
                          <option value="cut3">cut3 (paragraph)</option>
                          <option value="cut4">cut4 (length)</option>
                          <option value="cut5">cut5 (default)</option>
                        </select>
                      </div>
                      <div>
                        <label className="field-label">Speed Factor</label>
                        <input type="number" className="control" step="0.1" min="0.5" max="2" value={speedFactor} onChange={e => setSpeedFactor(parseFloat(e.target.value) || 1.0)} />
                      </div>
                      <div>
                        <label className="field-label">Seed (-1 = random)</label>
                        <input type="number" className="control" value={seed} onChange={e => setSeed(parseInt(e.target.value) || -1)} />
                      </div>
                    </div>
                  )}

                  {advTier === 'advanced' && (
                    <div className="form-grid">
                      <div>
                        <label className="field-label">Batch Size</label>
                        <input type="number" className="control" step="1" min="1" max="8" value={batchSize} onChange={e => setBatchSize(parseInt(e.target.value) || 1)} />
                      </div>
                      <div>
                        <label className="field-label">Batch Threshold</label>
                        <input type="number" className="control" step="0.05" min="0" max="1" value={batchThreshold} onChange={e => setBatchThreshold(parseFloat(e.target.value) || 0.75)} />
                      </div>
                      <div>
                        <label className="field-label">Split Bucket</label>
                        <input type="checkbox" checked={splitBucket} onChange={e => setSplitBucket(e.target.checked)} />
                      </div>
                      <div>
                        <label className="field-label">Fragment Interval (s)</label>
                        <input type="number" className="control" step="0.05" min="0" max="2" value={fragmentInterval} onChange={e => setFragmentInterval(parseFloat(e.target.value) || 0.3)} />
                      </div>
                      <div>
                        <label className="field-label">Parallel Infer</label>
                        <input type="checkbox" checked={parallelInfer} onChange={e => setParallelInfer(e.target.checked)} />
                      </div>
                      <div>
                        <label className="field-label">Sample Steps (v3)</label>
                        <input type="number" className="control" step="4" min="4" max="64" value={sampleSteps} onChange={e => setSampleSteps(parseInt(e.target.value) || 32)} />
                      </div>
                      <div>
                        <label className="field-label">Super Sampling (v3)</label>
                        <input type="checkbox" checked={superSampling} onChange={e => setSuperSampling(e.target.checked)} />
                      </div>
                      <div>
                        <label className="field-label">Media Type</label>
                        <select className="control" value={mediaType} onChange={e => setMediaType(e.target.value)}>
                          <option value="wav">WAV</option>
                          <option value="ogg">OGG</option>
                          <option value="aac">AAC</option>
                          <option value="raw">RAW</option>
                        </select>
                      </div>
                      <div>
                        <label className="field-label">Streaming Mode</label>
                        <select className="control" value={streamingMode ? 1 : 0} onChange={e => setStreamingMode(!!parseInt(e.target.value))}>
                          <option value={0}>Disabled</option>
                          <option value={1}>Enabled (best quality)</option>
                        </select>
                      </div>
                      <div>
                        <label className="field-label">Overlap Length</label>
                        <input type="number" className="control" step="1" min="0" max="10" value={overlapLength} onChange={e => setOverlapLength(parseInt(e.target.value) || 2)} />
                      </div>
                      <div>
                        <label className="field-label">Min Chunk Length</label>
                        <input type="number" className="control" step="4" min="4" max="64" value={minChunkLength} onChange={e => setMinChunkLength(parseInt(e.target.value) || 16)} />
                      </div>
                    </div>
                  )}

                  {/* Engine-level params - planned for future release */}
                  {/*
                  <details style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <summary style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', cursor: 'pointer' }}>
                      Engine Settings (require restart)
                    </summary>
                    <div className="form-grid" style={{ marginTop: 6 }}>
                      <div>
                        <label className="field-label">Model Version</label>
                        <select className="control" value={modelVersion || 'v2Pro'} onChange={e => setModelVersion(e.target.value)}>
                          <option value="v2Pro">v2Pro (recommended)</option>
                          <option value="v2ProPlus">v2ProPlus</option>
                          <option value="v2">v2</option>
                          <option value="v3">v3</option>
                          <option value="v4">v4</option>
                        </select>
                      </div>
                      <div>
                        <label className="field-label">Half Precision</label>
                        <input type="checkbox" checked={isHalf !== false} onChange={e => setIsHalf(e.target.checked)} />
                      </div>
                      <div>
                        <label className="field-label">Device</label>
                        <select className="control" value={inferDevice || 'cuda'} onChange={e => setInferDevice(e.target.value)}>
                          <option value="cuda">CUDA (GPU)</option>
                          <option value="cpu">CPU</option>
                        </select>
                      </div>
                    </div>
                    <p style={{ fontSize: 10, color: 'var(--warning)', marginTop: 6 }}>
                      Changing these requires restarting the GPT-SoVITS engine (port 9880) to take effect.
                    </p>
                  </details>
                  */}

                  <div className="field-hint" style={{ marginTop: 6 }}>
                    These parameters are sent to GPT-SoVITS for this generation only. They do not change the voice config.
                  </div>

                  {/* Auxiliary Reference Audio */}
                  <div style={{ marginTop: 10 }}>
                    <label className="field-label">
                      Auxiliary References
                      <span style={{ fontWeight: 400, fontSize: 10, color: 'var(--muted)', marginLeft: 6 }}>(optional, multi-select)</span>
                    </label>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        const allPaths = (segments || []).filter(s => s.matched).map(seg => {
                          const raw = seg.audio || seg.audio_path || seg.audio_filename
                          const fn = raw ? raw.replace(/\\/g, '/').split('/').pop() : ''
                          return `assets/${selectedVoice}/slicer_opt/${fn}`
                        }).filter(p => p !== currentRefAudio)
                        const allSelected = allPaths.every(p => auxRefs.includes(p))
                        setAuxRefs(allSelected ? [] : allPaths)
                      }}
                    >
                      {auxRefs.length > 0 ? 'Clear All' : 'Select All'}
                    </button>
                    {(segments || []).length > 0 && (
                      <div style={{ maxHeight: 120, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', marginTop: 4 }}>
                        {(segments || []).filter(s => s.matched).map((seg, i) => {
                          const raw = seg.audio || seg.audio_path || seg.audio_filename
                          const fn = raw ? raw.replace(/\\/g, '/').split('/').pop() : ''
                          const fullPath = `assets/${selectedVoice}/slicer_opt/${fn}`
                          const refPath = currentRefAudio || ''
                          const isMain = refPath ? refPath.replace(/\\/g, '/').split('/').pop() === fn : false
                          const isSelected = auxRefs.includes(fullPath)
                          return (
                            <div
                              key={i}
                              onClick={() => {
                                if (isMain) return
                                setAuxRefs(prev =>
                                  isSelected ? prev.filter(p => p !== fullPath) : [...prev, fullPath]
                                )
                              }}
                              style={{
                                padding: '3px 8px', fontSize: 11, cursor: isMain ? 'default' : 'pointer',
                                background: isSelected ? 'var(--accent-soft)' : 'transparent',
                                borderBottom: '1px solid var(--border)',
                                display: 'flex', alignItems: 'center', gap: 6,
                                opacity: isMain ? 0.4 : 1,
                              }}
                            >
                              <input type="checkbox" checked={isSelected} disabled={isMain}
                                readOnly style={{ accentColor: 'var(--accent)', width: 11, height: 11 }}/>
                              <span style={{ flex: 1 }}>
                                {seg.scene} #{seg.index}
                                {isMain && <span style={{ color: 'var(--muted)', fontSize: 10, marginLeft: 4 }}>(main)</span>}
                              </span>
                              <span style={{ fontSize: 10, color: 'var(--muted)' }}>{(seg.duration || 0).toFixed(1)}s</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {auxRefs.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        {auxRefs.map((p, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, marginBottom: 2 }}>
                            <span style={{ color: 'var(--muted)', minWidth: 14 }}>{i+1}.</span>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p.split('/').pop()}
                            </span>
                            <button
                              onClick={() => setAuxRefs(prev => prev.filter(x => x !== p))}
                              style={{
                                background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer',
                                fontSize: 14, padding: '0 2px', lineHeight: 1,
                              }}
                            >×</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <button className="btn btn-primary" onClick={handleGenerate} disabled={loading}>
              {loading ? 'Generating...' : 'Generate'}
            </button>

            {error && <div className="msg msg-error"><strong>Error:</strong> {error}</div>}
          </div>
        </div>

        {/* Result */}
        {result && result.audio_url && (
          <div className="section">
            <div className="section-hdr">
              <span>{result.split ? (result.concat ? `Combined (${result.segments?.length} segments)` : `Segments (${result.segments?.length})`) : 'Result'}</span>
              {result.silence_ms !== undefined && <span style={{ fontSize: 10, color: 'var(--muted)' }}>silence: {result.silence_ms}ms | {result.concat_method || ''}</span>}
            </div>
            <div className="section-body">
              <audio controls src={`${API_BASE}${result.audio_url}`} style={{ width: '100%' }} />
              <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
                <a href={`${API_BASE}${result.audio_url}`} download style={{ color: 'var(--accent)', fontSize: 13 }}>Download WAV</a>
              </div>
              {result.warning && <div className="msg msg-warning" style={{ marginTop: 8 }}>{result.warning}</div>}
            </div>
          </div>
        )}

        {/* Segments */}
        {result && result.segments && result.segments.length > 1 && (
          <CollapsibleSegments segments={result.segments} />
        )}
      </div>

      {/* Right sidebar: voice info */}
      <div className="workspace-right">
        {selected && <VoiceSidebar voice={selected} validation={validation} onVoiceUpdate={onVoiceUpdate} selectedRefAudio={selectedRefAudio} selectedRefText={selectedRefText} onSelectRef={onSelectRef} />}
      </div>
    </div>
  )
}

function AudioPlayer({ src }) {
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
    if (audioRef.current) setDuration(audioRef.current.duration)
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
      <span style={{ fontSize: 10, color: 'var(--muted)', width: 28, textAlign: 'right', flexShrink: 0 }}>
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

// ===========================
//  TRAINING TAB
// ===========================

function NumField({ label, value, onChange, min, max, step = 1 }) {
  return (
    <div>
      <label style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</label>
      <input className="control" type="number" value={value} min={min} max={max} step={step}
             onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    </div>
  );
}

function TextField({ label, value, onChange }) {
  return (
    <div>
      <label style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</label>
      <input className="control" value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

const LANGUAGES = [
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese (Mandarin)' },
  { code: 'yue', label: 'Cantonese' },
  { code: 'en', label: 'English' },
  { code: 'ko', label: 'Korean' },
]

function TrainingTab({ voices, loadVoices, activeTaskId, setActiveTaskId }) {
  const [form, setForm] = usePersistentState('train.form', {
    inputDir: '', language: 'ja', voiceName: '',
    denoise: false, slice: true, asr: true, copyRaw: true,
    // Advanced params
    gptEpochs: 20, sovitsEpochs: 20, batchSize: 'auto', learningRate: 'default',
    sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5,
    asrEngine: 'auto', denoiseModel: 'mdx-net',
    asrModelSize: 'large-v3-turbo', asrPrecision: 'float16',
    modelVersion: 'v2Pro', isHalf: true, inferDevice: 'cuda',
    // S1 advanced
    s1Seed: 1234, s1SaveEvery: 1, s1Precision: '16-mixed', s1GradClip: 1.0,
    s1Lr: 0.01, s1LrInit: 0.00001, s1LrEnd: 0.0001, s1Warmup: 2000, s1Decay: 40000,
    s1MaxSec: 54, s1NumWorkers: 4, s1MaxEval: 8,
    // S2 advanced
    s2Seed: 1234, s2LogInterval: 100, s2EvalInterval: 500, s2Fp16: true,
    s2LrDecay: 0.999875, s2SegmentSize: 20480, s2CMel: 45, s2CKl: 1.0,
    s2TextLowLr: 0.4, s2GradCkpt: false,
  });
  const [localTaskId, setLocalTaskId] = useState(null);
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advTier, setAdvTier] = useState('common'); // 'common' | 'advanced'
  // Advanced - Common
  // (existing: temperature, topK, topP, repPenalty, splitMethod, speedFactor, seed)
  // Advanced - Advanced
  const [batchSize, setBatchSize] = useState(1);
  const [batchThreshold, setBatchThreshold] = useState(0.75);
  const [splitBucket, setSplitBucket] = useState(true);
  const [fragmentInterval, setFragmentInterval] = useState(0.3);
  const [parallelInfer, setParallelInfer] = useState(true);
  const [sampleSteps, setSampleSteps] = useState(32);
  const [superSampling, setSuperSampling] = useState(false);
  const [mediaType, setMediaType] = useState('wav');
  const [streamingMode, setStreamingMode] = useState(false);
  const [overlapLength, setOverlapLength] = useState(2);
  const [minChunkLength, setMinChunkLength] = useState(16);
  const pollRef = useRef(null);
  const failCountRef = useRef(0);

  // 用 props 中的 activeTaskId，但在 handleStart 后也写一份本地（启动时用）
  const taskId = activeTaskId || localTaskId;
  const isRunning = status?.status === 'running';
  const isFinished = status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status);
  const isInterrupted = status?.status === 'interrupted';

  // 便捷 form setter
  const setField = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  // 轮询训练状态 —— 有 taskId 就轮询，不依赖本地 training 布尔
  useEffect(() => {
    if (!taskId) return;
    let dead = false; // 标记任务已彻底消失，停止轮询
    const MAX_FAIL = 3;
    const poll = () => {
      if (dead) return;
      api(`/api/train/status/${taskId}`).then(r => {
        if (r.ok) {
          failCountRef.current = 0;
          setStatus(r.data);
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(r.data.status)) {
            if (r.data.status === 'completed') loadVoices();
          }
        } else if (r.status === 404) {
          // 任务已被清理（磁盘 journal 也删了），自愈回到表单
          dead = true;
          failCountRef.current = 0;
          setActiveTaskId(null);
          setLocalTaskId(null);
          setStatus(null);
          setLogs([]);
        } else {
          // 其他错误（5xx 等）计入失败计数
          failCountRef.current++;
          if (failCountRef.current >= MAX_FAIL) {
            dead = true;
            failCountRef.current = 0;
            setActiveTaskId(null);
            setLocalTaskId(null);
            setStatus(null);
            setLogs([]);
          }
        }
      }).catch(() => {
        // 网络错误也计入失败计数
        failCountRef.current++;
        if (failCountRef.current >= MAX_FAIL) {
          dead = true;
          failCountRef.current = 0;
          setActiveTaskId(null);
          setLocalTaskId(null);
          setStatus(null);
          setLogs([]);
        }
      });
      api(`/api/train/logs/${taskId}`).then(r => {
        if (r.ok) setLogs(r.data.logs || []);
      }).catch(() => {});
    };
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [taskId]);

  // "Restoring training state…" 超时兜底：10s 后仍无 status 则回退表单
  const restoreTimeoutRef = useRef(null);
  useEffect(() => {
    if (taskId && !status) {
      restoreTimeoutRef.current = setTimeout(() => {
        setActiveTaskId(null);
        setLocalTaskId(null);
        setStatus(null);
        setLogs([]);
      }, 10000);
    }
    return () => {
      if (restoreTimeoutRef.current) {
        clearTimeout(restoreTimeoutRef.current);
        restoreTimeoutRef.current = null;
      }
    };
  }, [taskId, status]);

  const handleStart = async () => {
    if (!form.inputDir.trim()) { setError('Please select an audio folder'); return }
    if (!form.voiceName.trim()) { setError('Please enter a voice name'); return }
    setError(null);
    setStatus(null);
    setLogs([]);
    try {
      let cleanDir = form.inputDir.trim();
      if ((cleanDir.startsWith('"') && cleanDir.endsWith('"')) ||
          (cleanDir.startsWith("'") && cleanDir.endsWith("'"))) {
        cleanDir = cleanDir.slice(1, -1);
      }
      const r = await api('/api/train/start', {
        method: 'POST',
        body: {
          voiceId: form.voiceName.trim(),
          language: form.language,
          inputDir: cleanDir,
          steps: { denoise: form.denoise, slice: form.slice, asr: form.asr, copyRaw: form.copyRaw },
          customParams: {
            training: {
              gpt_epochs: Number(form.gptEpochs) || 20,
              sovits_epochs: Number(form.sovitsEpochs) || 20,
              batch_size: form.batchSize === 'auto' ? 'auto' : (Number(form.batchSize) || 'auto'),
              learning_rate: form.learningRate === 'default' ? 'default' : (Number(form.learningRate) || 'default'),
              // S1 advanced
              seed: form.s1Seed ?? 1234,
              save_every_n_epoch: form.s1SaveEvery ?? 4,
              precision: form.s1Precision || '16-mixed',
              gradient_clip: form.s1GradClip ?? 1.0,
              lr: form.s1Lr ?? 0.01,
              lr_init: form.s1LrInit ?? 0.00001,
              lr_end: form.s1LrEnd ?? 0.0001,
              warmup_steps: form.s1Warmup ?? 2000,
              decay_steps: form.s1Decay ?? 40000,
              max_sec: form.s1MaxSec ?? 54,
              num_workers: form.s1NumWorkers ?? 4,
              max_eval_sample: form.s1MaxEval ?? 8,
              // S2 advanced
              s2_seed: form.s2Seed ?? 1234,
              log_interval: form.s2LogInterval ?? 100,
              eval_interval: form.s2EvalInterval ?? 500,
              fp16_run: form.s2Fp16 !== false,
              lr_decay: form.s2LrDecay ?? 0.999875,
              segment_size: form.s2SegmentSize ?? 20480,
              c_mel: form.s2CMel ?? 45,
              c_kl: form.s2CKl ?? 1.0,
              text_low_lr_rate: form.s2TextLowLr ?? 0.4,
              grad_ckpt: !!form.s2GradCkpt,
            },
            steps: {
              slice: { params: {
                min_duration_sec: Number(form.sliceMinSec) || 3,
                max_duration_sec: Number(form.sliceMaxSec) || 15,
                silence_threshold_db: Number(form.sliceSilenceDb) || -40,
                min_silence_sec: Number(form.sliceMinSilenceSec) || 0.5,
              }},
              asr: { params: { engine: form.asrEngine, model_size: form.asrModelSize, precision: form.asrPrecision } },
              denoise: { params: { model: form.denoiseModel } },
            },
          },
        },
      });
      if (!r.ok) throw new Error(r.data?.error || 'Failed to start training');
      setLocalTaskId(r.data.taskId);
      setActiveTaskId(r.data.taskId); // 写入持久化 + 触发 App 层重连
    } catch (err) {
      setError(err.message);
    }
  }

  const handleCancel = async () => {
    if (!taskId) return;
    await api(`/api/train/cancel/${taskId}`, { method: 'POST' });
  };

  const handleReset = () => {
    setActiveTaskId(null);
    setLocalTaskId(null);
    setStatus(null);
    setLogs([]);
    setError(null);
  };

  const stepDefs = [
    { key: 'denoise', label: 'Vocal Removal', checked: form.denoise, set: (v) => setField('denoise', v) },
    { key: 'slice', label: 'Slicing', checked: form.slice, set: (v) => setField('slice', v) },
    { key: 'asr', label: 'Transcription (ASR)', checked: form.asr, set: (v) => setField('asr', v) },
    { key: 'copyRaw', label: 'Copy source to raw/', checked: form.copyRaw, set: (v) => setField('copyRaw', v) },
  ];

  return (
    <div className="section">
      <div className="section-hdr"><h2>Train New Voice</h2></div>
      <div className="section-body">
        {!taskId && (
          <>
            <div className="field">
              <label className="field-label">Voice Name *</label>
              <input className="control" value={form.voiceName} onChange={e => setField('voiceName', e.target.value)} placeholder="e.g. MyVoice" />
            </div>
            <div className="field">
              <label className="field-label">Audio Folder Path *</label>
              <input className="control" value={form.inputDir} onChange={e => setField('inputDir', e.target.value)} placeholder="e.g. D:\raw_audio\MyVoice" />
            </div>
            <div className="field">
              <label className="field-label">Language *</label>
              <select className="control" value={form.language} onChange={e => setField('language', e.target.value)}>
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>

            {/* Advanced Settings toggle */}
            <div className="field">
              <button type="button" className="btn btn-sm" onClick={() => setShowAdvanced(v => !v)} style={{ marginTop: 4 }}>
                {showAdvanced ? '\u25BE Advanced Settings' : '\u25B8 Advanced Settings'}
              </button>
            </div>

            {showAdvanced && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12, marginTop: 4 }}>
                <div className="field">
                  <label className="field-label">Preprocessing Steps</label>
                  {stepDefs.map(s => (
                    <label key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginTop: 4, cursor: 'pointer' }}>
                      <input type="checkbox" checked={s.checked} onChange={e => s.set(e.target.checked)} />
                      {s.label}
                    </label>
                  ))}
                </div>

                <div className="field">
                  <label className="field-label">Training</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <NumField label="GPT Epochs" value={form.gptEpochs} onChange={v => setField('gptEpochs', v)} min={1} max={100} />
                    <NumField label="SoVITS Epochs" value={form.sovitsEpochs} onChange={v => setField('sovitsEpochs', v)} min={1} max={100} />
                    <TextField label="Batch Size (auto / number)" value={form.batchSize} onChange={v => setField('batchSize', v)} />
                    <TextField label="Learning Rate (SoVITS, default / number)" value={form.learningRate} onChange={v => setField('learningRate', v)} />
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    8GB VRAM (RTX 3070): keep batch size &le; 4, or use &quot;auto&quot;.
                  </p>
                </div>

                {form.slice && (
                  <div className="field">
                    <label className="field-label">Slicing</label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <NumField label="Min Duration (s)" value={form.sliceMinSec} onChange={v => setField('sliceMinSec', v)} min={1} max={30} />
                      <NumField label="Max Duration (s)" value={form.sliceMaxSec} onChange={v => setField('sliceMaxSec', v)} min={1} max={60} />
                      <NumField label="Silence Threshold (dB)" value={form.sliceSilenceDb} onChange={v => setField('sliceSilenceDb', v)} min={-60} max={0} />
                      <NumField label="Min Silence (s)" value={form.sliceMinSilenceSec} onChange={v => setField('sliceMinSilenceSec', v)} step={0.1} min={0.1} max={5} />
                    </div>
                  </div>
                )}

                {form.asr && (
                  <div className="field">
                    <label className="field-label">ASR Engine</label>
                    <select className="control" value={form.asrEngine} onChange={e => setField('asrEngine', e.target.value)}>
                      <option value="auto">Auto (by language)</option>
                      <option value="faster-whisper">Faster Whisper</option>
                      <option value="funasr">FunASR (zh/yue)</option>
                    </select>
                  </div>
                )}
                {form.asr && form.asrEngine !== 'funasr' && (
                  <div className="field">
                    <label className="field-label">ASR Model Size</label>
                    <select className="control" value={form.asrModelSize || 'large-v3-turbo'} onChange={e => setField('asrModelSize', e.target.value)}>
                      <option value="large-v3-turbo">large-v3-turbo (fast, recommended)</option>
                      <option value="large-v3">large-v3 (best quality)</option>
                      <option value="large">large</option>
                      <option value="medium">medium</option>
                      <option value="small">small</option>
                      <option value="tiny">tiny</option>
                      <option value="distil-large-v3">distil-large-v3 (fast)</option>
                    </select>
                  </div>
                )}
                {form.asr && form.asrEngine !== 'funasr' && (
                  <div className="field">
                    <label className="field-label">ASR Precision</label>
                    <select className="control" value={form.asrPrecision || 'float16'} onChange={e => setField('asrPrecision', e.target.value)}>
                      <option value="float16">float16 (fast, recommended)</option>
                      <option value="float32">float32 (best quality, slow)</option>
                      <option value="int8">int8 (lowest VRAM)</option>
                    </select>
                  </div>
                )}

                {/* Advanced Training Settings - S1/S2 */}
                <details style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <summary style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', cursor: 'pointer' }}>
                    Advanced Training Settings (S1/S2)
                  </summary>

                  {/* S1 Advanced */}
                  <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>S1 (GPT) Training</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4 }}>
                    <NumField label="Seed" value={form.s1Seed ?? 1234} onChange={v => setField('s1Seed', v)} min={0} max={999999} />
                    <NumField label="Save Every N Epochs (S1+S2)" value={form.s1SaveEvery ?? 4} onChange={v => setField('s1SaveEvery', v)} min={1} max={50} />
                    <TextField label="Precision" value={form.s1Precision || '16-mixed'} onChange={v => setField('s1Precision', v)} />
                    <NumField label="Gradient Clip" value={form.s1GradClip ?? 1.0} onChange={v => setField('s1GradClip', v)} min={0.1} max={10} step={0.1} />
                    <NumField label="Peak LR" value={form.s1Lr ?? 0.01} onChange={v => setField('s1Lr', v)} min={0.0001} max={1} step={0.001} />
                    <NumField label="LR Init" value={form.s1LrInit ?? 0.00001} onChange={v => setField('s1LrInit', v)} min={0.0000001} max={0.1} step={0.00001} />
                    <NumField label="LR End" value={form.s1LrEnd ?? 0.0001} onChange={v => setField('s1LrEnd', v)} min={0.0000001} max={0.1} step={0.00001} />
                    <NumField label="Warmup Steps" value={form.s1Warmup ?? 2000} onChange={v => setField('s1Warmup', v)} min={0} max={100000} />
                    <NumField label="Decay Steps" value={form.s1Decay ?? 40000} onChange={v => setField('s1Decay', v)} min={1000} max={200000} />
                    <NumField label="Max Audio Sec" value={form.s1MaxSec ?? 54} onChange={v => setField('s1MaxSec', v)} min={1} max={300} />
                    <NumField label="Num Workers" value={form.s1NumWorkers ?? 4} onChange={v => setField('s1NumWorkers', v)} min={1} max={16} />
                    <NumField label="Max Eval Sample" value={form.s1MaxEval ?? 8} onChange={v => setField('s1MaxEval', v)} min={1} max={100} />
                  </div>

                  {/* S2 Advanced */}
                  <div style={{ marginTop: 12, fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>S2 (SoVITS) Training</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4 }}>
                    <NumField label="Seed" value={form.s2Seed ?? 1234} onChange={v => setField('s2Seed', v)} min={0} max={999999} />
                    <NumField label="Log Interval" value={form.s2LogInterval ?? 100} onChange={v => setField('s2LogInterval', v)} min={1} max={10000} />
                    <NumField label="Eval Interval" value={form.s2EvalInterval ?? 500} onChange={v => setField('s2EvalInterval', v)} min={10} max={10000} />
                    <div>
                      <label style={{ fontSize: 12, color: 'var(--muted)' }}>FP16 Training</label>
                      <input type="checkbox" checked={form.s2Fp16 !== false} onChange={e => setField('s2Fp16', e.target.checked)} />
                    </div>
                    <NumField label="LR Decay" value={form.s2LrDecay ?? 0.999875} onChange={v => setField('s2LrDecay', v)} min={0.9} max={1} step={0.0001} />
                    <NumField label="Segment Size" value={form.s2SegmentSize ?? 20480} onChange={v => setField('s2SegmentSize', v)} min={1024} max={65536} />
                    <NumField label="C Mel Loss" value={form.s2CMel ?? 45} onChange={v => setField('s2CMel', v)} min={1} max={100} />
                    <NumField label="C KL Loss" value={form.s2CKl ?? 1.0} onChange={v => setField('s2CKl', v)} min={0.1} max={10} step={0.1} />
                    <NumField label="Text Low LR Rate" value={form.s2TextLowLr ?? 0.4} onChange={v => setField('s2TextLowLr', v)} min={0.01} max={1} step={0.01} />
                    <div>
                      <label style={{ fontSize: 12, color: 'var(--muted)' }}>Gradient Checkpoint (save VRAM)</label>
                      <input type="checkbox" checked={!!form.s2GradCkpt} onChange={e => setField('s2GradCkpt', e.target.checked)} />
                    </div>
                  </div>

                  <p style={{ fontSize: 10, color: 'var(--warning)', marginTop: 6 }}>
                    Changing these may affect training stability. Use with caution.
                  </p>
                </details>
              </div>
            )}

            {error && <div className="msg msg-error" style={{ marginTop: 8 }}>{error}</div>}
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleStart}>Start Training</button>
          </>
        )}

        {/* 训练进度 */}
        {taskId && !status && (
          <div className="msg" style={{ marginBottom: 8 }}>Restoring training state…</div>
        )}
        {taskId && status && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {status.status === 'completed' ? 'Completed'
                   : status.status === 'failed' ? 'Failed'
                   : status.status === 'cancelled' ? 'Cancelled'
                   : status.status === 'interrupted' ? 'Interrupted'
                   : 'Training…'}
                </span>
                {isRunning && (
                  <button className="btn btn-sm btn-danger" onClick={handleCancel}>Cancel</button>
                )}
              </div>
              {isInterrupted && (
                <div className="msg msg-error" style={{ marginBottom: 8 }}>
                  Training was interrupted. Intermediate results are available; resume-from-checkpoint is on the roadmap.
                </div>
              )}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {['denoise', 'slice', 'asr', 'preprocess', 'train'].map((stepKey, i) => {
                  const step = status.steps?.[stepKey];
                  const st = step?.status || 'pending';
                  const color = st === 'completed' ? 'var(--success)' : st === 'running' ? 'var(--accent)' : st === 'failed' ? 'var(--danger)' : 'var(--border)';
                  const icons = { denoise: 'Denoise', slice: 'Slice', asr: 'ASR', preprocess: 'Preprocess', train: 'Train' };
                  return (
                    <div key={stepKey} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: color, color: '#fff', fontSize: 11, fontWeight: 700,
                      }}>
                        {st === 'completed' ? '✓' : st === 'running' ? '●' : st === 'failed' ? '✗' : i + 1}
                      </div>
                      <span style={{ fontSize: 11, color: st === 'running' ? 'var(--accent)' : 'var(--muted)' }}>{icons[stepKey]}</span>
                      {i < 4 && <span style={{ color: 'var(--muted)', fontSize: 11 }}>→</span>}
                    </div>
                  );
                })}
              </div>
            </div>
            {/* 日志面板 */}
            {logs.length > 0 && (
              <div style={{
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                padding: 8, maxHeight: 240, overflowY: 'auto', fontSize: 12, fontFamily: 'monospace',
              }}>
                {logs.map((log, i) => (
                  <div key={i} style={{ color: log.level === 'error' ? 'var(--danger)' : log.level === 'success' ? 'var(--success)' : 'var(--text)' }}>
                    [{new Date(log.time).toLocaleTimeString()}] {log.message}
                  </div>
                ))}
              </div>
            )}
            {/* 训练结束后返回 */}
            {isFinished && (
              <button className="btn btn-sm btn-primary" style={{ marginTop: 12 }} onClick={handleReset}>
                Back
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function VoiceSidebar({ voice, validation, onVoiceUpdate, selectedRefAudio, selectedRefText, onSelectRef }) {
  const [segments, setSegments] = useState(null)
  const [segLoading, setSegLoading] = useState(false)

  useEffect(() => {
    if (!voice.id) return
    setSegLoading(true)
    api(`/api/assets/${voice.id}/segments`).then(r => {
      if (r.ok && r.data.segments) setSegments(r.data.segments.segments || [])
    }).catch(() => setSegments(null))
      .finally(() => setSegLoading(false))
  }, [voice.id])

  const handlePickRef = (seg) => {
    const audioPath = seg.audio || seg.audio_path || seg.audio_filename
    if (!audioPath) return
    const filename = audioPath.replace(/\\/g, '/').split('/').pop()
    const fullPath = `assets/${voice.id}/slicer_opt/${filename}`
    onSelectRef(fullPath, seg.text || '')
  }

  // Build list of available reference audios from segments
  const availableRefs = segments && Array.isArray(segments)
    ? segments.filter(s => s.matched && (s.audio || s.audio_path || s.audio_filename))
    : []

  // Active ref: user selection (from App) > auto-first-segment
  const firstRef = availableRefs[0]
  const activeRef = selectedRefAudio || (firstRef ? (firstRef.audio || firstRef.audio_path || firstRef.audio_filename) : '')
  const activeRefText = selectedRefText || (firstRef?.text || '')
  void selectedRefText; // keep prop reference for esbuild

  return (
    <div className="section">
      <div className="section-hdr"><span>{voice.display_name}</span><span style={{ fontSize: 10, color: 'var(--muted)' }}>{voice.id}</span></div>
      <div className="section-body">
        <div className="field">
          <label className="field-label">Language</label>
          <div style={{ fontSize: 13 }}>{voice.language || '?'}</div>
        </div>

        {/* Reference Audio selector */}
        <div className="field">
          <label className="field-label">Reference Audio</label>
          {activeRef && (
            <div style={{ fontSize: 12, color: 'var(--text)', background: 'var(--bg)', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', marginBottom: 2 }}>
              {basename(activeRef)}
            </div>
          )}
          {activeRefText && (
            <div style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--bg)', padding: '4px 8px', borderRadius: 4, marginBottom: 6, fontStyle: 'italic' }}>
              "{activeRefText.length > 60 ? activeRefText.slice(0, 60) + '...' : activeRefText}"
            </div>
          )}
          {segLoading && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Loading segments...</div>}
          {!segLoading && availableRefs.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>No reference audio available</div>
          )}
          {!segLoading && availableRefs.length > 0 && (
            <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
              {availableRefs.map((seg, i) => {
                const rawPath = seg.audio || seg.audio_path || seg.audio_filename
                const segFilename = rawPath ? rawPath.replace(/\\/g, '/').split('/').pop() : ''
                const curFilename = activeRef ? activeRef.replace(/\\/g, '/').split('/').pop() : ''
                const isActive = curFilename === segFilename && !!activeRef
                const audioSrc = `/assets/${voice.id}/slicer_opt/${segFilename}`
                return (
                  <div
                    key={i}
                    style={{
                      padding: '6px 8px', fontSize: 12, cursor: 'pointer',
                      background: isActive ? 'var(--accent-soft)' : 'transparent',
                      borderBottom: '1px solid var(--border)',
                    }}
                    title={seg.text || ''}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {seg.scene} #{seg.index}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', marginLeft: 4 }}>
                        {(seg.duration || 0).toFixed(1)}s
                      </span>
                      <span style={{ marginLeft: 4, fontSize: 11, color: isActive ? 'var(--accent)' : 'var(--muted)', whiteSpace: 'nowrap' }}
                        onClick={(e) => { e.stopPropagation(); handlePickRef(seg) }}
                      >
                        {isActive ? '✓' : '→'}
                      </span>
                    </div>
                    <AudioPlayer src={audioSrc} />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {activeRefText && (
          <div className="field">
            <label className="field-label">Reference Text</label>
            <div style={{ fontSize: 12, color: 'var(--text)', background: 'var(--bg)', padding: 8, borderRadius: 4, maxHeight: 80, overflow: 'auto' }}>{activeRefText}</div>
          </div>
        )}
        {validation && (
          <table className="table" style={{ marginTop: 8 }}>
            <tbody>
              <tr><td>GPT Model</td><td>{checkIcon(validation.gpt_model_exists)}</td></tr>
              <tr><td>SoVITS Model</td><td>{checkIcon(validation.sovits_model_exists)}</td></tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function CollapsibleSegments({ segments }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="collapsible">
      <div className="collapsible-hdr" onClick={() => setOpen(!open)}>
        <span>Segments ({segments.length})</span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="collapsible-body">
          {segments.map(seg => (
            <div key={seg.index} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>Segment {seg.index}</div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>{seg.text}</div>
              <audio controls src={`${API_BASE}${seg.audio_url}`} style={{ width: '100%' }} />
              <a href={`${API_BASE}${seg.audio_url}`} download style={{ color: 'var(--accent)', fontSize: 12, display: 'inline-block', marginTop: 4 }}>Download</a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===========================
//  REFERENCE COMPARE TAB
// ===========================
function ReferenceCompareTab({ voices, selectedVoice, onBack }) {
  const [rows, setRows] = useState([])  // [{ id, refAudio, auxRefPaths, text, temperature, top_k, top_p, repetition_penalty, text_split_method, speed_factor, seed, loading, result, error }]
  const [allAudioFiles, setAllAudioFiles] = useState([])
  const [voiceFiles, setVoiceFiles] = useState([])
  const [defaultText, setDefaultText] = useState('こんにちは。これはローカルTTSテストです。今日は少し長い文章を読み上げてもらいます。途中で不自然に詰まらないか確認したいです。')
  const [availableModels, setAvailableModels] = useState([])  // [{ voiceId, voiceName, gptCheckpoint, sovitsModel, label }]
  const [rowModels, setRowModels] = useState({})  // { rowId: { voiceId, gptCheckpoint, sovitsModel } }
  const [defaultParams, setDefaultParams] = useState(null)  // loaded from /api/advanced-params
  const [segmentsCache, setSegmentsCache] = useState({})  // { voiceId: segments[] }

  const selected = voices.find(v => v.id === selectedVoice)
  const nextId = useRef(1)

  // Load default advanced params from backend
  useEffect(() => {
    api('/api/advanced-params').then(r => {
      if (r.ok && r.data) setDefaultParams(r.data)
    }).catch(() => {})
  }, [])

  // Preload segments for selected voice
  useEffect(() => {
    if (!selectedVoice || segmentsCache[selectedVoice]) return
    api(`/api/assets/${selectedVoice}/segments`).then(r => {
      if (r.ok && r.data.segments) {
        setSegmentsCache(prev => ({ ...prev, [selectedVoice]: r.data.segments.segments || [] }))
      }
    }).catch(() => {})
  }, [selectedVoice])

  useEffect(() => {
    api('/api/audio-files?dir=no_slice').then(r => { if (r.ok) setAllAudioFiles(r.data.files) })
    api('/api/audio-files?dir=voices').then(r => { if (r.ok) setVoiceFiles(r.data.files) })
    // Load models from assets/ meta.json (source of truth) instead of voices.json
    api('/api/assets').then(r => {
      if (r.ok) {
        const models = []
        Object.entries(r.data.assets || {}).forEach(([vid, meta]) => {
          const ckpts = meta?.assets?.checkpoints || {}
          const gptList = ckpts.gpt || []
          const sovitsList = ckpts.sovits || []
          if (gptList.length > 0 && sovitsList.length > 0) {
            gptList.forEach(gpt => {
              sovitsList.forEach(sovits => {
                models.push({
                  voiceId: vid,
                  voiceName: meta.display_name || vid,
                  gptCheckpoint: gpt.path,
                  sovitsModel: sovits.path,
                  gptSteps: gpt.steps || '',
                  sovitsSteps: sovits.steps || '',
                  label: `${meta.display_name || vid} / ${gpt.name}${gpt.steps ? ` (${gpt.steps})` : ''} / ${sovits.name}${sovits.steps ? ` (${sovits.steps})` : ''}`,
                })
              })
            })
          }
        })
        setAvailableModels(models)
      }
    }).catch(() => {})
  }, [])

  const addRow = () => {
    const rowId = nextId.current++
    // Default model: first available model for the selected voice, or first overall
    const defaultModel = availableModels.find(m => m.voiceId === selectedVoice) || availableModels[0]
    const modelForRow = defaultModel ? { voiceId: defaultModel.voiceId, gptCheckpoint: defaultModel.gptCheckpoint, sovitsModel: defaultModel.sovitsModel } : { voiceId: '', gptCheckpoint: '', sovitsModel: '' }
    setRowModels(prev => ({ ...prev, [rowId]: modelForRow }))
    // Use first matched segment from selected voice as default ref
    const firstSeg = segmentsCache[selectedVoice]?.find(s => s.matched && (s.audio || s.audio_path || s.audio_filename))
    const defaultRef = firstSeg ? (() => {
      const raw = firstSeg.audio || firstSeg.audio_path || firstSeg.audio_filename
      const fn = raw ? raw.replace(/\\/g, '/').split('/').pop() : ''
      return fn ? `assets/${selectedVoice}/slicer_opt/${fn}` : ''
    })() : ''
    const dp = defaultParams || {}
    setRows(prev => [...prev, {
      id: rowId,
      refAudio: defaultRef,
      auxRefPaths: [],
      text: defaultText,
      temperature: dp.temperature ?? 1.0,
      top_k: dp.top_k ?? 15,
      top_p: dp.top_p ?? 1.0,
      repetition_penalty: dp.repetition_penalty ?? 1.35,
      text_split_method: dp.text_split_method ?? 'cut5',
      speed_factor: dp.speed_factor ?? 1.0,
      seed: dp.seed ?? -1,
      loading: false,
      result: null,
      error: null,
    }])
  }

  const removeRow = (id) => {
    setRows(prev => prev.filter(r => r.id !== id))
  }

  const updateRow = (id, key, val) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, [key]: val } : r))
  }

  const addAuxToRow = (id, filePath) => {
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r
      if (r.auxRefPaths.includes(filePath)) return r
      return { ...r, auxRefPaths: [...r.auxRefPaths, filePath] }
    }))
  }

  const removeAuxFromRow = (id, idx) => {
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r
      const aux = [...r.auxRefPaths]
      aux.splice(idx, 1)
      return { ...r, auxRefPaths: aux }
    }))
  }

  const generateRow = async (row) => {
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, loading: true, result: null, error: null } : r))
    const rowModel = rowModels[row.id] || {}
    try {
      const body = {
        voice: selectedVoice,
        text: row.text.trim() || defaultText,
        format: 'wav',
        split: true,
        concat: true,
        ref_audio: row.refAudio || undefined,
        aux_ref_audio_paths: row.auxRefPaths.length > 0 ? row.auxRefPaths : undefined,
        temperature: row.temperature,
        top_k: row.top_k,
        top_p: row.top_p,
        repetition_penalty: row.repetition_penalty,
        text_split_method: row.text_split_method,
        speed_factor: row.speed_factor,
        seed: row.seed,
      }
      if (rowModel.gptCheckpoint) body.gpt_model = rowModel.gptCheckpoint
      if (rowModel.sovitsModel) body.sovits_model = rowModel.sovitsModel
      body.text_lang = selected?.language || 'ja'
      body.prompt_lang = selected?.language || 'ja'
      const r = await api('/api/generate', { method: 'POST', body })
      if (!r.ok) throw new Error(r.data.error || `Server error ${r.status}`)
      setRows(prev => prev.map(row2 => row2.id === row.id ? { ...row2, loading: false, result: r.data } : row2))
    } catch (err) {
      setRows(prev => prev.map(row2 => row2.id === row.id ? { ...row2, loading: false, error: err.message } : row2))
    }
  }

  const generateAll = async () => {
    for (const row of rows) {
      if (!row.loading) await generateRow(row)
    }
  }

  return (
    <div>
      <div className="section" style={{ marginBottom: 12 }}>
        <div className="section-hdr">
          <span>Reference Audio Comparison</span>
          <button className="btn btn-sm" onClick={onBack}>← Back</button>
        </div>
        <div className="section-body">
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
            Add as many rows as you like. Each row = a different reference audio configuration.
            Click <strong>Generate All</strong> to hear every combination side by side.
            The best one can be saved as the voice config.
          </p>

          <div className="field">
            <label className="field-label">Voice</label>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{selected?.display_name || '—'} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>({selectedVoice || 'none'})</span></div>
          </div>

          <div className="field">
            <label className="field-label">Default Test Text (applied to empty rows)</label>
            <textarea className="control" rows={3} value={defaultText} onChange={e => setDefaultText(e.target.value)} />
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button className="btn btn-sm btn-primary" onClick={addRow}>+ Add Row</button>
            <button className="btn btn-sm" onClick={generateAll} disabled={rows.length === 0}>Generate All ({rows.length})</button>
          </div>
        </div>
      </div>

      {/* Rows */}
      {rows.map((row, rowIdx) => (
        <CompareRow
          key={row.id}
          row={row}
          index={rowIdx}
          allAudioFiles={allAudioFiles}
          voiceFiles={voiceFiles}
          onUpdate={updateRow}
          onAddAux={addAuxToRow}
          onRemoveAux={removeAuxFromRow}
          onGenerate={generateRow}
          onRemove={removeRow}
          availableModels={availableModels}
          rowModel={rowModels[row.id] || { voiceId: '', gptCheckpoint: '', sovitsModel: '' }}
          onModelChange={(model) => setRowModels(prev => ({ ...prev, [row.id]: model }))}
          defaultParams={defaultParams || {
            temperature: 1.0,
            top_k: 15,
            top_p: 1.0,
            repetition_penalty: 1.35,
            text_split_method: 'cut5',
            speed_factor: 1.0,
            seed: -1,
          }}
          selectedVoice={selectedVoice}
        />
      ))}

      {rows.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 30 }}>
          No rows yet. Click <strong>+ Add Row</strong> to start comparing.
        </div>
      )}
    </div>
  )
}

function CompareRow({ row, index, allAudioFiles, voiceFiles, onUpdate, onAddAux, onRemoveAux, onGenerate, onRemove, availableModels, rowModel, onModelChange, defaultParams, selectedVoice }) {
  const [showPicker, setShowPicker] = useState(false)
  const [pickerTarget, setPickerTarget] = useState('main') // 'main' or 'aux'
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [segments, setSegments] = useState([])  // loaded from segments.json for current voice

  // Determine which voice this row uses
  const voiceId = rowModel.voiceId || selectedVoice

  // Load segments when voice changes
  useEffect(() => {
    if (!voiceId) return
    api(`/api/assets/${voiceId}/segments`).then(r => {
      if (r.ok && r.data.segments) setSegments(r.data.segments.segments || [])
    }).catch(() => setSegments([]))
  }, [voiceId])

  // Auto-select first matched segment as default ref when segments load
  useEffect(() => {
    if (segments.length === 0) return
    if (row.refAudio) return  // already set
    const first = segments.find(s => s.matched && (s.audio || s.audio_path || s.audio_filename))
    if (first) {
      const raw = first.audio || first.audio_path || first.audio_filename
      if (!raw) return
      const filename = raw.replace(/\\/g, '/').split('/').pop()
      onUpdate(row.id, 'refAudio', `assets/${voiceId}/slicer_opt/${filename}`)
    }
  }, [segments, voiceId])

  // Advanced params (initialized from row or defaults)
  const [temperature, setTemperature] = useState(row.temperature ?? defaultParams?.temperature ?? 1.0)
  const [topK, setTopK] = useState(row.top_k ?? defaultParams?.top_k ?? 15)
  const [topP, setTopP] = useState(row.top_p ?? defaultParams?.top_p ?? 1.0)
  const [repPenalty, setRepPenalty] = useState(row.repetition_penalty ?? defaultParams?.repetition_penalty ?? 1.35)
  const [splitMethod, setSplitMethod] = useState(row.text_split_method ?? defaultParams?.text_split_method ?? 'cut5')
  const [speedFactor, setSpeedFactor] = useState(row.speed_factor ?? defaultParams?.speed_factor ?? 1.0)
  const [seed, setSeed] = useState(row.seed ?? defaultParams?.seed ?? -1)

  // Store advanced params back to row on change
  useEffect(() => { onUpdate(row.id, 'temperature', temperature) }, [temperature])
  useEffect(() => { onUpdate(row.id, 'top_k', topK) }, [topK])
  useEffect(() => { onUpdate(row.id, 'top_p', topP) }, [topP])
  useEffect(() => { onUpdate(row.id, 'repetition_penalty', repPenalty) }, [repPenalty])
  useEffect(() => { onUpdate(row.id, 'text_split_method', splitMethod) }, [splitMethod])
  useEffect(() => { onUpdate(row.id, 'speed_factor', speedFactor) }, [speedFactor])
  useEffect(() => { onUpdate(row.id, 'seed', seed) }, [seed])

  const allFiles = [...allAudioFiles, ...voiceFiles]

  const pickFile = (filePath) => {
    if (pickerTarget === 'main') {
      onUpdate(row.id, 'refAudio', filePath)
    } else {
      onAddAux(row.id, filePath)
    }
    setShowPicker(false)
  }

  return (
    <div className="card" style={{ marginBottom: 8, position: 'relative' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Row #{index + 1}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn-sm" onClick={() => onGenerate(row)} disabled={row.loading}>
            {row.loading ? '...' : 'Generate'}
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => onRemove(row.id)}>×</button>
        </div>
      </div>

      {/* Model selector */}
      {availableModels.length > 0 && (
        <div className="field">
          <label className="field-label">Model</label>
          <select
            className="control"
            value={rowModel.gptCheckpoint ? `${rowModel.voiceId}::${rowModel.gptCheckpoint}::${rowModel.sovitsModel}` : ''}
            onChange={e => {
              const val = e.target.value
              if (!val) { onModelChange({ voiceId: '', gptCheckpoint: '', sovitsModel: '' }); return }
              const [vid, gpt, sov] = val.split('::')
              onModelChange({ voiceId: vid, gptCheckpoint: gpt, sovitsModel: sov })
            }}
          >
            <option value="">— default —</option>
            {availableModels.map((m, i) => (
              <option key={i} value={`${m.voiceId}::${m.gptCheckpoint}::${m.sovitsModel}`}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Main reference audio — from segments.json */}
      <div className="field">
        <label className="field-label">Main Reference Audio</label>
        {segments.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>No segments available for this voice</div>
        ) : (
          <select
            className="control"
            value={row.refAudio}
            onChange={e => onUpdate(row.id, 'refAudio', e.target.value)}
          >
            <option value="">— none —</option>
            {segments.map((seg, i) => {
              const raw = seg.audio || seg.audio_path || seg.audio_filename
              const fn = raw ? raw.replace(/\\/g, '/').split('/').pop() : ''
              const path = raw || ''
              return (
                <option key={i} value={path}>
                  {seg.scene} #{seg.index} — "{seg.text.slice(0, 30)}{seg.text.length > 30 ? '...' : ''}" ({(seg.duration || 0).toFixed(1)}s{seg.matched ? '' : ', no audio'})
                </option>
              )
            })}
          </select>
        )}
      </div>

      {/* Aux reference audio — multi-select from segments */}
      <div className="field">
        <label className="field-label">
          Auxiliary References
          <span style={{ fontWeight: 400, fontSize: 10, color: 'var(--muted)', marginLeft: 6 }}>(optional, multi-select from segments)</span>
        </label>
        {segments.length > 0 && (
          <div style={{ maxHeight: 120, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', marginTop: 4 }}>
            {segments.filter(s => s.matched && (s.audio || s.audio_path || s.audio_filename)).map((seg, i) => {
              const raw = seg.audio || seg.audio_path || seg.audio_filename
              const path = raw || ''
              const isSelected = row.auxRefPaths.includes(path)
              return (
                <div
                  key={i}
                  onClick={() => {
                    if (isSelected) {
                      const idx = row.auxRefPaths.indexOf(path)
                      if (idx >= 0) onRemoveAux(row.id, idx)
                    } else {
                      onAddAux(row.id, path)
                    }
                  }}
                  style={{
                    padding: '3px 8px', fontSize: 11, cursor: 'pointer',
                    background: isSelected ? 'var(--accent-soft)' : 'transparent',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <input type="checkbox" checked={isSelected} readOnly style={{ accentColor: 'var(--accent)', width: 11, height: 11 }} />
                  <span style={{ flex: 1 }}>
                    {seg.scene} #{seg.index} — "{seg.text.slice(0, 20)}{seg.text.length > 20 ? '...' : ''}"
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>{(seg.duration || 0).toFixed(1)}s</span>
                </div>
              )
            })}
          </div>
        )}
        {row.auxRefPaths.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {row.auxRefPaths.map((p, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, marginBottom: 2 }}>
                <span style={{ color: 'var(--muted)', minWidth: 14 }}>{i+1}.</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {basename(p)}
                </span>
                <button
                  onClick={() => onRemoveAux(row.id, i)}
                  style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
                >×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-row text override */}
      <div className="field">
        <label className="field-label">
          Text
          <span style={{ fontWeight: 400, fontSize: 10, color: 'var(--muted)', marginLeft: 6 }}>(leave empty for default)</span>
        </label>
        <input
          className="control"
          value={row.text}
          onChange={e => onUpdate(row.id, 'text', e.target.value)}
          placeholder="Enter test text..."
        />
      </div>

      {/* Advanced Settings */}
      <div className="collapsible" style={{ margin: '6px 0' }}>
        <div className="collapsible-hdr" onClick={() => setShowAdvanced(!showAdvanced)}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Advanced Settings</span>
          <span style={{ color: 'var(--muted)', fontSize: 11 }}>{showAdvanced ? '▲' : '▼'}</span>
        </div>
        {showAdvanced && (
          <div className="collapsible-body">
            <div className="form-grid">
              <div>
                <label className="field-label">Temperature</label>
                <input type="number" className="control" step="0.05" min="0" max="2" value={temperature} onChange={e => setTemperature(parseFloat(e.target.value) || 1.0)} />
              </div>
              <div>
                <label className="field-label">Top K</label>
                <input type="number" className="control" step="1" min="1" max="100" value={topK} onChange={e => setTopK(parseInt(e.target.value) || 15)} />
              </div>
              <div>
                <label className="field-label">Top P</label>
                <input type="number" className="control" step="0.05" min="0" max="1" value={topP} onChange={e => setTopP(parseFloat(e.target.value) || 1.0)} />
              </div>
              <div>
                <label className="field-label">Repetition Penalty</label>
                <input type="number" className="control" step="0.05" min="0.5" max="2" value={repPenalty} onChange={e => setRepPenalty(parseFloat(e.target.value) || 1.35)} />
              </div>
              <div>
                <label className="field-label">Split Method</label>
                <select className="control" value={splitMethod} onChange={e => setSplitMethod(e.target.value)}>
                  <option value="cut0">cut0 (no split)</option>
                  <option value="cut1">cut1 (punctuation)</option>
                  <option value="cut2">cut2 (sentence)</option>
                  <option value="cut3">cut3 (paragraph)</option>
                  <option value="cut4">cut4 (length)</option>
                  <option value="cut5">cut5 (default)</option>
                </select>
              </div>
              <div>
                <label className="field-label">Speed Factor</label>
                <input type="number" className="control" step="0.1" min="0.5" max="2" value={speedFactor} onChange={e => setSpeedFactor(parseFloat(e.target.value) || 1.0)} />
              </div>
              <div>
                <label className="field-label">Seed (-1 = random)</label>
                <input type="number" className="control" value={seed} onChange={e => setSeed(parseInt(e.target.value) || -1)} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* File picker dropdown */}
      {showPicker && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-soft)',
          maxHeight: 240, overflow: 'auto', marginBottom: 4,
        }}>
          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
            Select {pickerTarget === 'main' ? 'main reference' : 'auxiliary'} audio ({allFiles.length} files)
          </div>
          {allFiles.map(f => (
            <div
              key={f.path}
              onClick={() => pickFile(f.path)}
              style={{
                padding: '6px 10px', fontSize: 12, cursor: 'pointer',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: '1px solid var(--border)',
              }}
              onMouseEnter={e => e.target.style.background = 'var(--accent-soft)'}
              onMouseLeave={e => e.target.style.background = 'transparent'}
            >
              <span>{f.name}</span>
              <span style={{ color: 'var(--muted)', fontSize: 11 }}>{f.duration.toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}

      {/* Result */}
      {row.result && row.result.audio_url && (
        <div style={{ marginTop: 8, background: 'var(--bg)', borderRadius: 'var(--radius-sm)', padding: 8 }}>
          <audio controls src={`${API_BASE}${row.result.audio_url}`} style={{ width: '100%' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <a href={`${API_BASE}${row.result.audio_url}`} download style={{ color: 'var(--accent)', fontSize: 12 }}>Download</a>
            {row.result.segments && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{row.result.segments.length} segments</span>}
          </div>
        </div>
      )}

      {row.error && (
        <div className="msg msg-error" style={{ marginTop: 6 }}>{row.error}</div>
      )}
    </div>
  )
}

// ============================
//  SVG ICONS
// ============================
function IconFolderSearch({ size = 16, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <circle cx="14.5" cy="15.5" r="2.5" />
      <path d="M16 17l2 2" />
    </svg>
  )
}

function IconTrash({ size = 16, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}

// ============================
//  ASSETS TAB
// ============================
function AssetsTab({ voices, setSelectedVoice, setPage, loadVoices }) {
  const [assets, setAssets] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [segments, setSegments] = useState({})
  const [segmentsLoading, setSegmentsLoading] = useState({})
  const [deleteConfirm, setDeleteConfirm] = useState(null) // { id, displayName }
  const [deleting, setDeleting] = useState(false)

  const loadAssets = useCallback(() => {
    api('/api/assets').then(r => {
      if (r.ok) setAssets(r.data.assets || {})
    }).catch(() => {})
  }, [])

  useEffect(() => { loadAssets() }, [loadAssets])

  const handleScan = async () => {
    setScanning(true); setScanMsg(null)
    try {
      const r = await api('/api/assets/scan', { method: 'POST' })
      if (r.ok) {
        setAssets(r.data.assets || {})
        setScanMsg({ type: 'success', text: `Scan complete - ${r.data.scanned || 0} voice(s) found` })
        if (loadVoices) loadVoices()
      } else {
        setScanMsg({ type: 'error', text: r.data?.error || 'Scan failed' })
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message })
    } finally {
      setScanning(false)
      setTimeout(() => setScanMsg(null), 4000)
    }
  }

  const handleScanOne = async (id) => {
    setScanMsg(null)
    try {
      const r = await api(`/api/assets/${id}/scan`, { method: 'POST' })
      if (r.ok) {
        loadAssets()
        setScanMsg({ type: 'success', text: `Scan complete for ${id}` })
        if (loadVoices) loadVoices()
      } else {
        setScanMsg({ type: 'error', text: r.data?.error || 'Scan failed' })
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message })
    } finally {
      setTimeout(() => setScanMsg(null), 4000)
    }
  }

  const handleOpenExplorer = async (id) => {
    try {
      await api(`/api/assets/${id}/open`, { method: 'POST' })
    } catch (e) {
      setScanMsg({ type: 'error', text: `Failed to open folder: ${e.message}` })
      setTimeout(() => setScanMsg(null), 3000)
    }
  }

  const handleDeleteRequest = (id, displayName) => {
    setDeleteConfirm({ id, displayName })
  }

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    const { id } = deleteConfirm
    setDeleting(true)
    setDeleteConfirm(null)
    try {
      await api(`/api/assets/${id}`, { method: 'DELETE' })
      setScanMsg({ type: 'success', text: `Deleted ${id}. Re-scanning...` })
      // Auto re-scan after delete
      setTimeout(async () => {
        try {
          const r = await api('/api/assets/scan', { method: 'POST' })
          if (r.ok) {
            setAssets(r.data.assets || {})
            setScanMsg({ type: 'success', text: `Deleted ${id}. Scan complete - ${r.data.scanned || 0} voice(s) found` })
          }
        } catch (_) {}
        setTimeout(() => setScanMsg(null), 4000)
      }, 500)
    } catch (e) {
      setScanMsg({ type: 'error', text: `Delete failed: ${e.message}` })
      setTimeout(() => setScanMsg(null), 3000)
    } finally {
      setDeleting(false)
    }
  }

  const handleBrowse = async (id) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    if (segments[id]) return
    setSegmentsLoading(s => ({ ...s, [id]: true }))
    try {
      const r = await api(`/api/assets/${id}/segments`)
      if (r.ok) setSegments(s => ({ ...s, [id]: r.data.segments }))
    } catch (e) {
      setSegments(s => ({ ...s, [id]: { error: e.message } }))
    } finally {
      setSegmentsLoading(s => ({ ...s, [id]: false }))
    }
  }

  const handleSetAsVoice = (assetId) => {
    // Scan all already syncs voices.json, so the voice should already be in the list.
    setSelectedVoice(assetId)
    setPage('generate')
  }

  const handleUseAsReference = (audioPath, text) => {
    // Switch to the expanded asset's voice and go to Generate page.
    // Reference audio + text are auto-loaded from segments.json.
    if (expandedId) setSelectedVoice(expandedId)
    setPage('generate')
  }

  if (!assets) {
    return (
      <div className="section">
        <div className="section-hdr"><h2>Assets</h2></div>
        <div className="section-body"><div className="msg">Loading assets...</div></div>
      </div>
    )
  }

  const assetEntries = Object.entries(assets).sort((a, b) => (a[1].display_name || a[0]).localeCompare(b[1].display_name || b[0]))

  return (
    <div className="section">
      <div className="section-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Voice Assets</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={loadAssets} disabled={scanning}>Refresh</button>
          <button className="btn btn-sm btn-primary" onClick={handleScan} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Scan All'}
          </button>
        </div>
      </div>
      <div className="section-body">
        {scanMsg && <div className={`msg msg-${scanMsg.type}`} style={{ marginBottom: 10 }}>{scanMsg.text}</div>}
        {assetEntries.length === 0 && <div className="msg">No voice assets found. Click "Scan All" to scan.</div>}
        {assetEntries.map(([id, asset]) => {
          const a = asset.assets || {}
          const raw = a.raw || {}
          const slices = a.slices || {}
          const ckpts = a.checkpoints || {}
          const gptCount = (ckpts.gpt || []).length
          const sovitsCount = (ckpts.sovits || []).length
          const segCount = asset.segment_total || 0
          const isExpanded = expandedId === id
          const segData = segments[id]
          const isLoadingSegs = segmentsLoading[id]

          return (
            <div key={id} className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{asset.display_name || id}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    Mode: {asset.mode || 'N/A'} &middot; ID: {id}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <button className="btn btn-sm" onClick={() => handleOpenExplorer(id)} title="Open in Explorer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}>
                    <IconFolderSearch size={14} color="var(--muted)" />
                  </button>
                  <button className="btn btn-sm" onClick={() => handleDeleteRequest(id, asset.display_name || id)} title="Delete Asset" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}>
                    <IconTrash size={14} color="var(--danger)" />
                  </button>
                  <button className="btn btn-sm" onClick={() => handleBrowse(id)}>
                    {isExpanded ? 'Collapse' : 'Browse'}
                  </button>
                  <button className="btn btn-sm" onClick={() => handleScanOne(id)} disabled={scanning}>
                    Scan
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => handleSetAsVoice(id)}>
                    Set as Voice
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--text)' }}>
                <span>Raw: {raw.file_count || 0} files ({(raw.total_duration || 0).toFixed(1)}s)</span>
                <span>Slices: {slices.file_count || 0}</span>
                <span>Checkpoints: GPT {gptCount} / SoVITS {sovitsCount}</span>
                <span>Segments: {segCount}</span>
              </div>

              {isExpanded && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  {isLoadingSegs && <div className="msg">Loading segments...</div>}
                  {segData && segData.error && <div className="msg msg-error">{segData.error}</div>}
                  {segData && segData.segments && segData.segments.length === 0 && <div className="msg">No segments found.</div>}
                  {segData && segData.segments && segData.segments.length > 0 && (
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                      <table className="table" style={{ width: '100%', fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Scene</th>
                            <th style={{ textAlign: 'left', padding: '4px 6px' }}>Text</th>
                            <th style={{ textAlign: 'right', padding: '4px 6px' }}>Duration</th>
                            <th style={{ textAlign: 'center', padding: '4px 6px' }}>Ref</th>
                          </tr>
                        </thead>
                        <tbody>
                          {segData.segments.map((seg, i) => (
                            <tr key={i}>
                              <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{seg.scene} #{seg.index}</td>
                              <td style={{ padding: '4px 6px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seg.text}</td>
                              <td style={{ padding: '4px 6px', textAlign: 'right' }}>{(seg.duration || 0).toFixed(1)}s</td>
                              <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                                <button className="btn btn-sm" onClick={() => handleUseAsReference(seg.audio_path, seg.text)} title={seg.audio_path}>
                                  Use as Ref
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                        Showing {segData.matched || segData.segments.length} of {segData.total} segments
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setDeleteConfirm(null)}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 320, maxWidth: 420,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <IconTrash size={20} color="var(--danger)" />
              <span style={{ fontWeight: 600, fontSize: 15 }}>Delete Asset</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
              Are you sure you want to delete <strong>{deleteConfirm.displayName}</strong>?
            </p>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
              This will permanently delete the asset folder and its voice configuration.
              This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setDeleteConfirm(null)} disabled={deleting}>Cancel</button>
              <button className="btn btn-sm btn-danger" onClick={handleDeleteConfirm} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================
export default function App() {
  const [page, setPage] = usePersistentState('ui.page', 'generate')
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = usePersistentState('ui.selectedVoice', '')
  const [selectedRefAudio, setSelectedRefAudio] = useState('')
  const [selectedRefText, setSelectedRefText] = useState('')
  const [health, setHealth] = useState(null)
  const [activeTaskId, setActiveTaskId] = usePersistentState('train.activeTaskId', null)

  const loadVoices = useCallback(() => {
    api('/api/assets').then(r => {
      if (r.ok) {
        const list = Object.entries(r.data.assets || {}).map(([id, meta]) => ({
          id,
          display_name: meta?.display_name || id,
          language: meta?.language || meta?.text_lang || 'ja',
        }))
        setVoices(list)
        if (!selectedVoice && list.length > 0) setSelectedVoice(list[0].id)
        if (selectedVoice && !list.find(v => v.id === selectedVoice)) setSelectedVoice(list[0]?.id || '')
      }
    }).catch(() => {})
  }, [selectedVoice])

  // Clear ref selection when voice changes
  useEffect(() => { setSelectedRefAudio(''); setSelectedRefText('') }, [selectedVoice])

  const handleSelectRef = useCallback((audio, text) => {
    setSelectedRefAudio(audio || '')
    setSelectedRefText(text || '')
  }, [])

  useEffect(() => {
    api('/api/health').then(r => setHealth(r.data)).catch(() => setHealth({ ok: false }))
    loadVoices()
  }, [])

  // 自动重连：刷新/关页后恢复正在运行/中断的任务
  useEffect(() => {
    api('/api/train/tasks').then(r => {
      if (!r.ok) return;
      const tasks = r.data.tasks || [];
      // 1) 持久化里有 activeTaskId：校验它是否仍存在于后端，不存在则清掉，避免卡空白
      if (activeTaskId) {
        const stillThere = tasks.find(t => t.id === activeTaskId);
        if (!stillThere) setActiveTaskId(null);
        return;
      }
      // 2) 没有 activeTaskId：优先接管运行中的，其次接管中断的
      const pick = tasks.find(t => t.status === 'running')
                || tasks.find(t => t.status === 'interrupted');
      if (pick) setActiveTaskId(pick.id);
    }).catch(() => {});
  }, []);

  const handleDelete = async (id) => {
    const r = await api(`/api/assets/${id}`, { method: 'DELETE' })
    if (r.ok) loadVoices()
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav className="nav">
        <button className={`nav-btn ${page === 'generate' ? 'active' : ''}`} onClick={() => setPage('generate')}>Generate</button>
        <button className={`nav-btn ${page === 'compare' ? 'active' : ''}`} onClick={() => setPage('compare')}>Compare Refs</button>
        <button className={`nav-btn ${page === 'assets' ? 'active' : ''}`} onClick={() => setPage('assets')}>Assets</button>
        <button className={`nav-btn ${page === 'train' ? 'active' : ''}`} onClick={() => setPage('train')}>Train</button>
        <div style={{ flex: 1 }} />
        {health?.ffmpeg_available && <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 8, background: 'rgba(76,175,80,0.15)', color: 'var(--success)', border: '1px solid rgba(76,175,80,0.3)', alignSelf: 'center' }}>ffmpeg</span>}
        <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 8, background: health?.ok ? 'rgba(76,175,80,0.15)' : 'rgba(207,102,121,0.15)', color: health?.ok ? 'var(--success)' : 'var(--danger)', border: `1px solid ${health?.ok ? 'rgba(76,175,80,0.3)' : 'rgba(207,102,121,0.3)'}`, alignSelf: 'center' }}>
          {health === null ? '...' : health.ok ? 'GPT-SoVITS Connected' : 'GPT-SoVITS Unreachable'}
        </span>
      </nav>

      <main style={{ flex: 1 }}>
        <div className="workspace-container">
          {page === 'generate' && (
            <GenerateTab voices={voices} selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice}
              onEditVoice={() => {}}
              onSwitchToCompare={() => setPage('compare')}
              onVoiceUpdate={loadVoices}
              selectedRefAudio={selectedRefAudio}
              selectedRefText={selectedRefText}
              onSelectRef={handleSelectRef} />
          )}
          {page === 'compare' && (
            <ReferenceCompareTab voices={voices} selectedVoice={selectedVoice} onBack={() => setPage('generate')} />
          )}
          {page === 'assets' && (
            <AssetsTab voices={voices} setSelectedVoice={setSelectedVoice} setPage={setPage} loadVoices={loadVoices} />
          )}
          {page === 'train' && (
            <TrainingTab voices={voices} loadVoices={loadVoices}
              activeTaskId={activeTaskId} setActiveTaskId={setActiveTaskId} />
          )}
        </div>
      </main>
    </div>
  )
}
