import { useState, useEffect, useCallback, useRef } from 'react'
import './styles.css'
import { usePersistentState } from './usePersistentState'

const API_BASE = ''

// GPT-SoVITS engine hard constraint: reference audio must be 3~10s, else /tts 400.
const REF_MIN_SEC = 3
const REF_MAX_SEC = 10
const refInRange = (dur) => typeof dur === 'number' && dur >= REF_MIN_SEC && dur <= REF_MAX_SEC
// Prefer an in-range slice as the auto-default so generation doesn't fail on a too-short first slice.
const pickDefaultRef = (segs) => {
  const usable = (segs || []).filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
  return usable.find(s => refInRange(s.duration)) || usable[0] || null
}

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

// Build a helpful error for /api/outputs/* calls. A 404 here almost always means
// the backend is running an older build without these routes; surface the HTTP
// status so the fix (apply the server patch, then restart the backend) is obvious.
function outputsError(r, fallback) {
  if (r && r.data && typeof r.data === 'object' && r.data.error) return r.data.error
  const status = r ? r.status : 0
  if (status === 404) return 'HTTP 404 - the /api/outputs endpoints are missing. The backend is running an older build; restart it after applying the server patch.'
  return `${fallback} (HTTP ${status || '?'})`
}

// Status badge for a boolean backend check (e.g. /api/voices/:id/validate)
function statusBadge(ok, okLabel = 'Selected', missLabel = 'Missing') {
  return <span className={`badge ${ok ? 'badge-ok' : 'badge-danger'}`}>{ok ? okLabel : missLabel}</span>
}

function basename(p) {
  if (!p || typeof p !== 'string') return '(none)'
  const a = p.replace(/\\/g, '/').split('/')
  return a[a.length - 1]
}

// ===========================
//  GENERATE TAB
// ===========================
// 读音校对面板（task6）：勾选后展开的二级面板，兼作文本编辑器 + 逐字读音校对。
// 中文(zh)/粤语(yue) 走真实 g2pW 预览；其它语言为契约占位（ko 未经测试）。
function PronPanel({ text, setText, lang, overrides, setOverrides }) {
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lexicon, setLexicon] = useState({})
  // 逐词编辑缓冲（ja 假名 / en ARPABET）：保留用户正在输入的原始字符串，避免受控输入吞空格。
  const [wordEdits, setWordEdits] = useState({})
  // zh/yue：逐字选候选；ja：逐词改假名；en：逐词改音标；其它语言契约占位。
  const supported = lang === 'zh' || lang === 'yue' || lang === 'ja' || lang === 'en'
  const isCharUnit = lang === 'zh' || lang === 'yue'
  const readingLabel = lang === 'ja' ? 'kana' : lang === 'en' ? 'ARPABET (space-separated)' : 'reading'

  const loadLexicon = useCallback(() => {
    if (!supported) return
    api(`/api/pron/lexicon?lang=${encodeURIComponent(lang)}`).then(r => {
      if (r.ok && r.data?.entries) setLexicon(r.data.entries)
    }).catch(() => {})
  }, [lang, supported])

  useEffect(() => { loadLexicon() }, [loadLexicon])

  const doPreview = async () => {
    setError(null); setPreview(null); setWordEdits({})
    if (!text.trim()) { setError('Enter text above first.'); return }
    if (!supported) { setError(`Reading proofing does not support "${lang}" yet.`); return }
    setLoading(true)
    try {
      const r = await api('/api/pron/preview', { method: 'POST', body: { text, lang } })
      if (!r.ok) throw new Error(r.data?.error || `Preview failed (${r.status})`)
      setPreview(r.data)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  // Change a single character's reading -> record a word-level override.
  const changeReading = (word, charIndex, newReading) => {
    const token = (preview?.tokens || []).find(t => t.word === word)
    if (!token) return
    const readings = token.chars.map((c, i) => i === charIndex ? newReading : (overrides[word]?.[i] ?? c.reading))
    setOverrides({ ...overrides, [word]: readings })
    setPreview(pv => ({ ...pv, tokens: pv.tokens.map(t => t.word === word
      ? { ...t, chars: t.chars.map((c, i) => i === charIndex ? { ...c, reading: newReading, source: 'override' } : c) }
      : t) }))
  }

  // Word-level edit (ja kana / en ARPABET). Stores a word-level override.
  const changeWordReading = (word, str) => {
    setWordEdits(e => ({ ...e, [word]: str }))
    const arr = lang === 'en'
      ? str.trim().split(/\s+/).filter(Boolean)
      : (str.trim() ? [str.trim()] : [])
    const next = { ...overrides }
    if (arr.length) next[word] = arr; else delete next[word]
    setOverrides(next)
    setPreview(pv => ({ ...pv, tokens: pv.tokens.map(t => t.word === word
      ? (lang === 'en' ? { ...t, readings: arr, source: arr.length ? 'override' : 'g2p' }
                       : { ...t, reading: arr[0] || '', source: arr.length ? 'override' : 'g2p' })
      : t) }))
  }

  const saveToLexicon = async (word) => {
    let readings = overrides[word]
    if (!readings) {
      const tok = preview?.tokens.find(t => t.word === word)
      if (!tok) return
      if (tok.unit === 'char') readings = tok.chars.map(c => c.reading)
      else if (lang === 'en') readings = tok.readings
      else readings = [tok.reading]
    }
    if (!readings) return
    const r = await api('/api/pron/lexicon', { method: 'POST', body: { lang, word, pinyins: readings } })
    if (r.ok) { setLexicon(r.data.entries || {}) }
    else setError(r.data?.error || 'Failed to save to lexicon')
  }

  const deleteFromLexicon = async (word) => {
    const r = await api(`/api/pron/lexicon?lang=${encodeURIComponent(lang)}&word=${encodeURIComponent(word)}`, { method: 'DELETE' })
    if (r.ok) setLexicon(r.data.entries || {})
  }

  const clearOverrides = () => { setOverrides({}); if (preview) doPreview() }

  return (
    <div className="section" style={{ margin: '8px 0', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Reading proofing</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {!supported ? `Language "${lang}" is contract-only for now.`
            : isCharUnit ? 'Edit text, preview readings, fix polyphonic characters.'
            : lang === 'ja' ? 'Edit text, preview readings, fix a word\u2019s kana reading.'
            : 'Edit text, preview readings, fix a word\u2019s ARPABET phonemes.'}
        </span>
      </div>

      <textarea
        className="control" rows={3} placeholder="Edit the text to synthesize here..."
        value={text} onChange={e => setText(e.target.value)}
        style={{ marginBottom: 8 }}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-sm" onClick={doPreview} disabled={loading || !supported}>
          {loading ? 'Previewing...' : 'Preview readings'}
        </button>
        {Object.keys(overrides).length > 0 && (
          <>
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>{Object.keys(overrides).length} override(s) active this run</span>
            <button className="btn btn-sm btn-ghost" onClick={clearOverrides}>Clear overrides</button>
          </>
        )}
      </div>

      {error && <div className="field-hint" style={{ color: 'var(--danger)', marginTop: 6 }}>{error}</div>}

      {preview && supported && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(preview.tokens || []).map((tok, ti) => (
            <div key={ti} style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', background: 'var(--surface)' }}>
              {(tok.unit === 'char' || tok.chars) ? (
                // zh / yue：逐字，多音字给候选下拉
                <div style={{ display: 'flex', gap: 4 }}>
                  {tok.chars.map((c, ci) => (
                    <div key={ci} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 15, color: c.polyphonic ? 'var(--warning)' : 'var(--text)' }}>{c.char}</div>
                      {c.polyphonic && c.candidates.length > 1 ? (
                        <select
                          className="control" style={{ height: 22, fontSize: 11, padding: '0 2px', minWidth: 54 }}
                          value={c.reading}
                          onChange={e => changeReading(tok.word, ci, e.target.value)}
                        >
                          {(c.candidates.includes(c.reading) ? c.candidates : [c.reading, ...c.candidates]).map(cand => (
                            <option key={cand} value={cand}>{cand}</option>
                          ))}
                        </select>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.reading}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                // ja / en：逐词，直接改写读音（假名 / ARPABET），无候选下拉，输入框做宽
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 15, color: tok.source === 'g2p' ? 'var(--text)' : 'var(--accent)' }}>{tok.word}</div>
                  <input
                    className="control"
                    style={{ height: 24, fontSize: 12, padding: '0 6px', minWidth: lang === 'en' ? 180 : 120 }}
                    value={wordEdits[tok.word] ?? (
                      overrides[tok.word]
                        ? overrides[tok.word].join(' ')
                        : (lang === 'en' ? (tok.readings || []).join(' ') : (tok.reading || ''))
                    )}
                    placeholder={readingLabel}
                    spellCheck={false}
                    onChange={e => changeWordReading(tok.word, e.target.value)}
                  />
                </div>
              )}
              {overrides[tok.word] && (
                <button className="btn btn-sm btn-ghost" style={{ marginTop: 4, fontSize: 10 }} onClick={() => saveToLexicon(tok.word)}>
                  Save to lexicon
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {supported && Object.keys(lexicon).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Saved lexicon ({lang}):</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(lexicon).map(([w, pys]) => (
              <span key={w} style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 12, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {w}: {pys.join(' ')}
                <button className="btn btn-sm btn-ghost" style={{ padding: 0, fontSize: 12, lineHeight: 1 }} onClick={() => deleteFromLexicon(w)}>x</button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// 目标语言（text_lang）：解除「合成语言 == 微调语言」的硬绑定。任一微调音色可合成
// 五种支持语言（zh/ja/en/yue/ko）或 auto 混排。prompt_lang（参考音频文本语言）仍跟随音色。
const TARGET_LANG_OPTIONS = [
  { value: 'auto', label: 'Auto \u2014 detect per segment' },
  { value: 'all_zh', label: 'Chinese (\u4e2d\u6587)' },
  { value: 'all_ja', label: 'Japanese (\u65e5\u672c\u8a9e)' },
  { value: 'en', label: 'English' },
  { value: 'all_yue', label: 'Cantonese (\u7ca4\u8bed)' },
  { value: 'all_ko', label: 'Korean (\ud55c\uad6d\uc5b4)' },
]
const VOICE_TO_TARGET = { zh: 'all_zh', ja: 'all_ja', en: 'en', yue: 'all_yue', ko: 'all_ko' }

// 把音色语言（裸码）映射到默认 text_lang 选项（== 微调源语言，保证零回归）。
function defaultTargetLang(voiceLang) {
  const base = String(voiceLang || '').replace(/^all_/, '').replace(/^auto.*/, '')
  return VOICE_TO_TARGET[base] || 'auto'
}

// 归一 text_lang 到语言族（all_zh -> zh；auto -> null 不判定失配）。
function normalizeLangFamily(textLang) {
  if (!textLang || String(textLang).startsWith('auto')) return null
  return String(textLang).replace(/^all_/, '')
}

function GenerateTab({ voices, selectedVoice, setSelectedVoice, onEditVoice, onSwitchToCompare, onVoiceUpdate, selectedRefAudio, selectedRefText, selectedPromptLang, onSelectRef, onActivity }) {
  const [text, setText] = usePersistentState('generate.text', '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // result + recent are persisted: audio is referenced by a server URL (audio_url),
  // not a blob, so the players keep working after a reload.
  const [result, setResult] = usePersistentState('generate.result', null)
  const [validation, setValidation] = useState(null)
  // Recent Generations — server-authoritative (GET /api/outputs). Each entry is
  // a real asset folder (outputs/generate/<id>/ with meta.json), so Rerun / Show
  // in Explorer / Delete all act on the backend by id. "Clear History" only hides
  // entries locally (dismissed ids); the audio files stay on disk.
  const [recentAll, setRecentAll] = useState([])
  const [dismissed, setDismissed] = usePersistentState('generate.dismissed', [], {
    rehydrate: r => (Array.isArray(r) ? r : []),
  })
  const recent = recentAll.filter(x => !dismissed.includes(x.id))
  const [genConfirm, setGenConfirm] = useState(null)      // secondary-confirm modal payload
  const [genConfirmBusy, setGenConfirmBusy] = useState(false)

  const [splitEnabled, setSplitEnabled] = usePersistentState('generate.splitEnabled', true)
  const [maxChars, setMaxChars] = usePersistentState('generate.maxChars', 30)
  const [concatEnabled, setConcatEnabled] = usePersistentState('generate.concatEnabled', true)
  const [silenceMs, setSilenceMs] = usePersistentState('generate.silenceMs', 300)

  // 读音校对（task6）：勾选开关持久化；本次覆盖仅内存态
  const [pronEnabled, setPronEnabled] = usePersistentState('generate.pronEnabled', false)
  const [pronOverrides, setPronOverrides] = useState({})

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

  // Advanced TTS inference params (used by advanced settings panel + /tts payload)
  const [advTier, setAdvTier] = useState('common')
  const [batchSize, setBatchSize] = useState(1)
  const [batchThreshold, setBatchThreshold] = useState(0.75)
  const [splitBucket, setSplitBucket] = useState(true)
  const [fragmentInterval, setFragmentInterval] = useState(0.3)
  const [parallelInfer, setParallelInfer] = useState(true)
  const [sampleSteps, setSampleSteps] = useState(32)
  const [superSampling, setSuperSampling] = useState(false)
  const [mediaType, setMediaType] = useState('wav')
  const [streamingMode, setStreamingMode] = useState(false)
  const [overlapLength, setOverlapLength] = useState(2)
  const [minChunkLength, setMinChunkLength] = useState(16)

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
  // 目标合成语言（text_lang），独立于 prompt_lang；默认 = 微调源语言，切换音色时重置。
  const [textLang, setTextLang] = useState(() => defaultTargetLang(selected?.language || 'ja'))
  const _baseLangFam = String(lang || '').replace(/^all_/, '')
  const _targetFam = normalizeLangFamily(textLang)
  const langMismatch = !!_targetFam && _targetFam !== _baseLangFam   // 目标语言与微调语言不符
  const panelLang = _targetFam || _baseLangFam                        // 读音校对面板跟随目标语言
  const [auxRefs, setAuxRefs] = useState([])  // selected aux reference audio paths
  const [segments, setSegments] = useState([])  // loaded from API for aux ref picker

  // Load checkpoints + segments when voice changes
  useEffect(() => {
    if (!selectedVoice) return
    api(`/api/assets/${selectedVoice}`).then(r => {
      if (r.ok && r.data.ok && r.data.meta?.assets?.checkpoints) {
        const c = r.data.meta.assets.checkpoints
        const gptList = c.gpt || []
        const sovitsList = c.sovits || []
        setCheckpoints({ gpt: gptList, sovits: sovitsList })
        // checkpoint 归属校验（patch8：切换音色后重置失效的选择）——旧音色的路径若不在
        // 新音色的列表里，必须重置，否则会把上一个音色的 .pth 提交给推理后端（音色串档）。
        setSelGpt(prev => gptList.some(x => x.path === prev) ? prev : (gptList[0]?.path || ''))
        setSelSovits(prev => sovitsList.some(x => x.path === prev) ? prev : (sovitsList[0]?.path || ''))
      }
    }).catch(() => {})
    api(`/api/assets/${selectedVoice}/segments`).then(r => {
      if (r.ok && r.data.segments) setSegments(r.data.segments.segments || [])
    }).catch(() => setSegments([]))
  }, [selectedVoice])

  // Set language from voice config
  useEffect(() => {
    const v = voices.find(x => x.id === selectedVoice)
    if (v?.language) { setLang(v.language); setTextLang(defaultTargetLang(v.language)) }
  }, [selectedVoice, voices])

  // Advanced params are global (from /api/advanced-params), not per-voice — no sync needed on voice change

  // Base-model availability for the selected SoVITS model's version — warns about
  // electrical-noise risk when that version's base/SV models are missing on disk.
  const [genBaseWarn, setGenBaseWarn] = useState(null);
  useEffect(() => {
    const sel = (checkpoints.sovits || []).find(c => c.path === selSovits);
    const ver = sel && sel.version;
    if (!ver || ver === 'v1') { setGenBaseWarn(null); return; }
    let cancelled = false;
    api(`/api/models/status?version=${encodeURIComponent(ver)}`)
      .then(r => { if (!cancelled) setGenBaseWarn(r.ok && r.data && !r.data.ok ? r.data : null); })
      .catch(() => { if (!cancelled) setGenBaseWarn(null); });
    return () => { cancelled = true; };
  }, [selSovits, checkpoints]);

  // Clear any live activity indicator when leaving the Generate tab.
  useEffect(() => () => onActivity?.(null), [])

  useEffect(() => {
    if (!selectedVoice) return
    api(`/api/voices/${selectedVoice}/validate`).then(r => {
      if (r.ok && r.data.ok) setValidation(r.data.checks)
    }).catch(() => setValidation(null))
  }, [selectedVoice, voices])

  // Use user-selected ref (from VoiceSidebar) or fall back to an auto-picked slice
  // that still exists on disk (server's live `exists` check) and preferably sits in
  // the engine's 3~10s window, so default generation doesn't 400 on a too-short slice.
  const defaultRef = segments.length > 0 ? pickDefaultRef(segments) : null
  const currentRefAudio = selectedRefAudio || (defaultRef ? (defaultRef.audio || defaultRef.audio_path || defaultRef.audio_filename) : '')
  // Once the user explicitly picks a ref, honour its text verbatim — including the
  // empty string for a raw clip (which has no aligned transcript). Only fall back to
  // the auto-picked slice's text when nothing has been selected yet, otherwise a raw
  // pick would silently keep sending the stale slice transcript.
  const currentRefText = selectedRefAudio ? selectedRefText : (defaultRef ? (defaultRef.text || '') : '')

  // Load the server-authoritative Recent Generations list.
  const loadRecent = async () => {
    const r = await api('/api/outputs')
    if (r.ok && r.data && Array.isArray(r.data.items)) setRecentAll(r.data.items)
  }
  useEffect(() => { loadRecent() }, [])

  // Core generation runner shared by the Generate button and Recent → Rerun.
  // The exact request body is captured into each recent item so Rerun can
  // reproduce the audio with identical settings (not just reload the text).
  const runGenerate = async (body, meta) => {
    setLoading(true); setError(null); setResult(null)
    const t = (body.text || '').trim()
    const willSplit = !!body.split && t.length > (body.max_chars || 30)
    const estChunks = Math.max(1, Math.ceil(t.length / Math.max(1, body.max_chars || 30)))
    onActivity?.({ label: willSplit ? `Generating · ${estChunks} chunks` : 'Generating' })
    try {
      const r = await api('/api/generate', { method: 'POST', body })
      if (!r.ok) throw new Error(r.data.error || `Server error ${r.status}`)
      setResult(r.data)
      if (r.data.audio_url) { loadRecent() }
      return r.data
    } catch (err) { setError(err.message); return null }
    finally { setLoading(false); onActivity?.(null) }
  }

  const handleGenerate = async () => {
    if (!selectedVoice) { setError('Select a voice first'); return }
    if (!text.trim()) { setError('Enter text to synthesize'); return }
    const body = {
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
      text_lang: textLang, prompt_lang: selectedPromptLang || lang,
      aux_ref_audio_paths: auxRefs.length > 0 ? auxRefs : undefined,
      pron_overrides: (pronEnabled && Object.keys(pronOverrides).length > 0) ? pronOverrides : undefined,
      source: 'generate', voice_label: selected?.display_name || selectedVoice,
    }
    const data = await runGenerate(body, { voiceLabel: selected?.display_name || selectedVoice })
    if (data) {
      // Auto-save advanced params after a successful UI-driven generation.
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
    }
  }

  // Recent Generations — real management (rerun / reveal / delete + bulk).
  const handleRerun = async (item) => {
    if (loading) return
    if (!item) return
    if (!item.params) {
      // Legacy history entry saved before generation settings were captured: we
      // can only reload its text. The user then presses Generate to synthesize it
      // with the currently selected voice and settings.
      setText(item.text || '')
      setError('This entry was saved before settings capture, so only its text was loaded into the editor above. Press Generate to synthesize it with the current voice and settings. Newly generated items rerun automatically with their exact original settings.')
      return
    }
    setError(null)
    await runGenerate(item.params, { voiceLabel: item.voice })
  }

  const revealItem = async (item) => {
    const r = await api('/api/outputs/reveal', { method: 'POST', body: { id: item.id } })
    if (!r.ok) setError(outputsError(r, 'Could not open the file location'))
  }

  const askClearHistory = () => setGenConfirm({
    title: 'Clear history',
    message: 'Remove all entries from this list? Your generated audio files stay on disk — only the history shown here is cleared.',
    confirmLabel: 'Clear history',
    danger: false,
    icon: <IconRerun size={18} color="var(--accent)" />,
    onConfirm: () => { setDismissed(prev => Array.from(new Set([...prev, ...recentAll.map(x => x.id)]))); setGenConfirm(null) },
  })

  const askCleanAll = () => setGenConfirm({
    title: 'Clean all audio',
    message: 'Permanently delete EVERY generated audio file in the outputs folder and clear this list. This cannot be undone.',
    confirmLabel: 'Delete files',
    danger: true,
    icon: <IconTrash size={18} color="var(--danger)" />,
    onConfirm: async () => {
      setGenConfirmBusy(true)
      const r = await api('/api/outputs/clear-all', { method: 'POST' })
      setGenConfirmBusy(false)
      if (!r.ok) { setError(outputsError(r, 'Failed to clean output files')); setGenConfirm(null); return }
      setDismissed([]); setResult(null); setGenConfirm(null); loadRecent()
    },
  })

  const askDeleteItem = (item) => setGenConfirm({
    title: 'Delete this audio',
    message: 'Permanently delete this generated audio file from disk and remove it from the list. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
    icon: <IconTrash size={18} color="var(--danger)" />,
    onConfirm: async () => {
      setGenConfirmBusy(true)
      const r = await api(`/api/outputs/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      setGenConfirmBusy(false)
      if (!r.ok) { setError(outputsError(r, 'Failed to delete audio')); setGenConfirm(null); return }
      setGenConfirm(null); loadRecent()
    },
  })

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
                    <option key={c.path} value={c.path}>{c.name}{c.version ? ` · ${c.version}` : ''}</option>
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
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span>Characters: <span style={{ color: 'var(--text)' }}>{text.trim().length}</span></span>
                {splitEnabled && (
                  <span>Estimated chunks: <span style={{ color: 'var(--text)' }}>{Math.max(1, Math.ceil(text.trim().length / Math.max(1, maxChars)))}</span></span>
                )}
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Target language:
                  <select
                    className="control" style={{ height: 22, fontSize: 11, padding: '0 4px', width: 'auto', minWidth: 0 }}
                    value={textLang} onChange={e => setTextLang(e.target.value)}
                  >
                    {TARGET_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </span>
              </div>
              {langMismatch && (
                <div className="field-hint" style={{ color: 'var(--warning)', marginTop: 4 }}>
                  Target language differs from the fine-tuned language ({String(lang || '').toUpperCase()}). Inference quality may be affected.
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer', marginTop: 8 }}>
                <input type="checkbox" checked={pronEnabled} onChange={e => setPronEnabled(e.target.checked)} />
                Reading proofing (fix polyphonic characters before synthesis)
              </label>
              {pronEnabled && (
                <PronPanel text={text} setText={setText} lang={panelLang} overrides={pronOverrides} setOverrides={setPronOverrides} />
              )}
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
                    <p style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6 }}>
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
                      <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>(optional, multi-select)</span>
                    </label>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        const allPaths = (segments || []).filter(s => s.exists !== false && s.matched).map(seg => {
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
                        {(segments || []).filter(s => s.exists !== false && s.matched).map((seg, i) => {
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
                                {isMain && <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 4 }}>(main)</span>}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{(seg.duration || 0).toFixed(1)}s</span>
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

            {genBaseWarn && (
              <div className="msg msg-warn" style={{ marginBottom: 8 }}>
                ⚠ This voice uses a <strong>{genBaseWarn.version}</strong> model, but its base/SV models are
                missing on disk. Synthesis may produce electrical noise or low quality.
                {' '}Run: <code>python download_models.py --set {String(genBaseWarn.version).toLowerCase()}</code>
              </div>
            )}
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
              {result.silence_ms !== undefined && <span style={{ fontSize: 11, color: 'var(--muted)' }}>silence: {result.silence_ms}ms | {result.concat_method || ''}</span>}
            </div>
            <div className="section-body">
              <Player src={`${API_BASE}${result.audio_url}`} />
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

        {/* Recent Generations — persistent list with real file management */}
        <div className="section">
          <div className="section-hdr">
            <span>Recent Generations</span>
            {recent.length > 0 && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-ghost" onClick={askClearHistory}>Clear History</button>
                <button className="btn btn-sm btn-danger" onClick={askCleanAll}>Clean All</button>
              </div>
            )}
          </div>
          <div className="section-body">
            {recent.length === 0 ? (
              <div className="empty-state" style={{ padding: 16 }}>
                <div className="es-sub" style={{ marginBottom: 0 }}>Generated audio will appear here.</div>
              </div>
            ) : (
              recent.map(item => (
                <div key={item.id} className="recent-row">
                  <div className="rr-main">
                    <div className="rr-text" title={item.text}>{item.text || '(empty)'}</div>
                    <div className="rr-meta">
                      {item.voice} · <span style={{ textTransform: 'uppercase' }}>{item.lang}</span> · GPT {item.gpt} / SoVITS {item.sovits}
                      {item.segments > 1 ? ` · ${item.segments} seg` : ''} · {new Date(item.createdAt).toLocaleTimeString()}
                    </div>
                    <div style={{ marginTop: 6 }}><Player src={`${API_BASE}${item.audio_url}`} size="sm" /></div>
                  </div>
                  <div className="rr-actions">
                    <button className="icon-btn" title="Show in file explorer" onClick={() => revealItem(item)}><IconFolder size={15} /></button>
                    <button className="icon-btn" title="Rerun with the same settings" onClick={() => handleRerun(item)} disabled={loading}><IconRerun size={15} /></button>
                    <button className="icon-btn icon-btn-danger" title="Delete this audio" onClick={() => askDeleteItem(item)}><IconTrash size={15} /></button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <ConfirmDialog
          open={!!genConfirm}
          title={genConfirm?.title}
          message={genConfirm?.message}
          confirmLabel={genConfirm?.confirmLabel}
          danger={genConfirm?.danger}
          icon={genConfirm?.icon}
          busy={genConfirmBusy}
          onConfirm={genConfirm?.onConfirm}
          onCancel={() => { if (!genConfirmBusy) setGenConfirm(null) }}
        />
      </div>

      {/* Right sidebar: voice info */}
      <div className="workspace-right">
        {selected && <VoiceSidebar voice={selected} voices={voices} validation={validation} onVoiceUpdate={onVoiceUpdate} selectedRefAudio={selectedRefAudio} selectedRefText={selectedRefText} selectedPromptLang={selectedPromptLang} onSelectRef={onSelectRef} />}
      </div>
    </div>
  )
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

function NamingNotePill({ onOpen, className = '' }) {
  return (
    <button
      type="button"
      className={`naming-note-pill ${className}`}
      onClick={onOpen}
      title="Show model naming & metadata notes"
    >
      <span className="nn-i">i</span>
      Model naming &amp; metadata — how renaming works
    </button>
  )
}

function NamingNoteCard({ acked, onAck, onCollapse }) {
  return (
    <div className="naming-note-card">
      <div className="naming-note-hd">
        <span>Model naming &amp; metadata rebuild — read before renaming</span>
        {acked && (
          <button type="button" className="nn-x" title="Collapse" onClick={onCollapse}>×</button>
        )}
      </div>
      <div className="naming-note-body">
        <p>Trained models are published with the language baked into the filename:</p>
        <ul>
          <li><code>&lt;id&gt;_&lt;lang&gt;-e&lt;epoch&gt;.ckpt</code> (GPT)</li>
          <li><code>&lt;id&gt;_&lt;lang&gt;_&lt;version&gt;_e&lt;epoch&gt;_s&lt;step&gt;.pth</code> (SoVITS, e.g. <code>_v2Pro_</code>)</li>
        </ul>
        <p>
          The SoVITS filename also carries the base-model version (v2 / v2Pro / v2ProPlus). Version is
          recovered in this order: <strong>meta.json (first-truth) → filename token → weight header</strong>.
          Present metadata is never overwritten.
        </p>
        <p>
          If a voice's <code>meta.json</code> is ever deleted or a field is missing, the language is
          rebuilt from these filenames. Existing metadata is always first-truth — a present
          language is never overwritten. <strong>Rename carefully:</strong> hand-editing model
          filenames can break language recovery, and reusing an id can collide with another
          voice. Renaming here safely updates the id, folder and metadata together.
        </p>
      </div>
      <div className="naming-note-ft">
        <button type="button" className="btn btn-sm btn-primary" onClick={onAck}>Got it</button>
        {acked && <span className="nn-hint">Acknowledged — kept collapsed from now on.</span>}
      </div>
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

// ===========================================================================
//  Shared training-parameter source of truth
//  Both the Training page and the Restore/Rebuild modal render the *same*
//  parameter panels and serialise through the *same* builders, so whatever the
//  formal training flow exposes, the rebuild flow exposes identically.
// ===========================================================================

// Default values for every editable training/slice/asr field. The Training page
// keeps its own persistent form; the Restore modal seeds a fresh copy of these.
const REBUILD_PARAM_DEFAULTS = {
  expertUnlocked: false,
  // training (common)
  modelVersion: 'v2Pro',
  gptEpochs: 8, sovitsEpochs: 8, batchSize: 'auto', learningRate: 'default',
  // slice
  sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5,
  // asr
  asrEngine: 'auto', asrModelSize: 'large-v3-turbo', asrPrecision: 'float16',
  // S1 advanced/expert
  s1Seed: 1234, s1SaveEvery: 4, s1Precision: '16-mixed', s1GradClip: 1.0,
  s1Lr: 0.01, s1LrInit: 0.00001, s1LrEnd: 0.0001, s1Warmup: 2000, s1Decay: 40000,
  s1MaxSec: 54, s1NumWorkers: 4, s1MaxEval: 8,
  // S2 advanced/expert
  s2Seed: 1234, s2LogInterval: 100, s2EvalInterval: 500, s2Fp16: true,
  s2LrDecay: 0.999875, s2SegmentSize: 20480, s2CMel: 45, s2CKl: 1.0,
  s2TextLowLr: 0.4, s2GradCkpt: false,
}

const ASR_MODEL_SIZES = [
  ['large-v3-turbo', 'large-v3-turbo (fast)'], ['large-v3', 'large-v3 (best)'],
  ['large', 'large'], ['medium', 'medium'], ['small', 'small'],
  ['tiny', 'tiny'], ['distil-large-v3', 'distil-large-v3'],
]
const ASR_PRECISIONS = [
  ['float16', 'float16 (fast)'], ['float32', 'float32 (best)'], ['int8', 'int8 (low VRAM)'],
]

// --- serialisers (single source of truth for the customParams shape) ---
function buildTrainingParams(form) {
  const _vers = (Array.isArray(form.modelVersions) && form.modelVersions.length)
    ? form.modelVersions : [form.modelVersion || 'v2'];
  return {
    version: _vers[0] || 'v2',
    versions: _vers,
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
  }
}
function buildSliceParams(form) {
  return {
    min_duration_sec: Number(form.sliceMinSec) || 3,
    max_duration_sec: Number(form.sliceMaxSec) || 15,
    silence_threshold_db: Number(form.sliceSilenceDb) || -40,
    min_silence_sec: Number(form.sliceMinSilenceSec) || 0.5,
  }
}
function buildAsrParams(form) {
  return { engine: form.asrEngine, model_size: form.asrModelSize, precision: form.asrPrecision }
}

// --- shared field panels (rendered identically on both pages) ---
function SliceParamFields({ form, setField }) {
  return (
    <div className="param-grid">
      <NumField label="Min Duration (s)" value={form.sliceMinSec} onChange={v => setField('sliceMinSec', v)} min={1} max={30} />
      <NumField label="Max Duration (s)" value={form.sliceMaxSec} onChange={v => setField('sliceMaxSec', v)} min={1} max={60} />
      <NumField label="Silence Threshold (dB)" value={form.sliceSilenceDb} onChange={v => setField('sliceSilenceDb', v)} min={-60} max={0} />
      <NumField label="Min Silence (s)" value={form.sliceMinSilenceSec} onChange={v => setField('sliceMinSilenceSec', v)} step={0.1} min={0.1} max={5} />
    </div>
  )
}

function AsrParamFields({ form, setField }) {
  return (
    <>
      <div className="field">
        <label className="field-label">ASR Engine</label>
        <select className="control" value={form.asrEngine} onChange={e => setField('asrEngine', e.target.value)}>
          <option value="auto">Auto (by language)</option>
          <option value="faster-whisper">Faster Whisper</option>
        </select>
      </div>
      {form.asrEngine !== 'funasr' && (
        <div className="param-grid" style={{ marginTop: 8 }}>
          <div className="field">
            <label className="field-label">Model Size</label>
            <select className="control" value={form.asrModelSize || 'large-v3-turbo'} onChange={e => setField('asrModelSize', e.target.value)}>
              {ASR_MODEL_SIZES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label">Precision</label>
            <select className="control" value={form.asrPrecision || 'float16'} onChange={e => setField('asrPrecision', e.target.value)}>
              {ASR_PRECISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
      )}
    </>
  )
}

// --- per-model training columns (single source of truth for S1 / S2 params) ---
function S1BasicCol({ form, setField }) {
  return (
    <div>
      <div className="node-col-title">S1 · GPT</div>
      <div className="param-grid">
        <NumField label="Epochs" value={form.gptEpochs} onChange={v => setField('gptEpochs', v)} min={1} max={100} />
        <TextField label="Batch Size (auto / number)" value={form.batchSize} onChange={v => setField('batchSize', v)} />
        <NumField label="Save Every N Epochs" value={form.s1SaveEvery ?? 4} onChange={v => setField('s1SaveEvery', v)} min={1} max={50} />
        <NumField label="Peak LR" value={form.s1Lr ?? 0.01} onChange={v => setField('s1Lr', v)} min={0.0001} max={1} step={0.001} />
      </div>
    </div>
  )
}
function S2BasicCol({ form, setField }) {
  return (
    <div>
      <div className="node-col-title">S2 · SoVITS</div>
      <div className="param-grid">
        <NumField label="Epochs" value={form.sovitsEpochs} onChange={v => setField('sovitsEpochs', v)} min={1} max={100} />
        <TextField label="Learning Rate (default / number)" value={form.learningRate} onChange={v => setField('learningRate', v)} />
        <NumField label="Eval Interval" value={form.s2EvalInterval ?? 500} onChange={v => setField('s2EvalInterval', v)} min={10} max={10000} />
        <label className="toggle-row" style={{ alignSelf: 'end', paddingBottom: 6 }}>
          <input type="checkbox" checked={form.s2Fp16 !== false} onChange={e => setField('s2Fp16', e.target.checked)} /> FP16
        </label>
      </div>
    </div>
  )
}
function S1ExpertCol({ form, setField }) {
  return (
    <div>
      <div className="node-col-title">S1 · GPT</div>
      <div className="param-grid">
        <NumField label="Seed" value={form.s1Seed ?? 1234} onChange={v => setField('s1Seed', v)} min={0} max={999999} />
        <TextField label="Precision" value={form.s1Precision || '16-mixed'} onChange={v => setField('s1Precision', v)} />
        <NumField label="Gradient Clip" value={form.s1GradClip ?? 1.0} onChange={v => setField('s1GradClip', v)} min={0.1} max={10} step={0.1} />
        <NumField label="LR Init" value={form.s1LrInit ?? 0.00001} onChange={v => setField('s1LrInit', v)} min={0.0000001} max={0.1} step={0.00001} />
        <NumField label="LR End" value={form.s1LrEnd ?? 0.0001} onChange={v => setField('s1LrEnd', v)} min={0.0000001} max={0.1} step={0.00001} />
        <NumField label="Warmup Steps" value={form.s1Warmup ?? 2000} onChange={v => setField('s1Warmup', v)} min={0} max={100000} />
        <NumField label="Decay Steps" value={form.s1Decay ?? 40000} onChange={v => setField('s1Decay', v)} min={1000} max={200000} />
        <NumField label="Max Audio Sec" value={form.s1MaxSec ?? 54} onChange={v => setField('s1MaxSec', v)} min={1} max={300} />
        <NumField label="Num Workers" value={form.s1NumWorkers ?? 4} onChange={v => setField('s1NumWorkers', v)} min={1} max={16} />
        <NumField label="Max Eval Sample" value={form.s1MaxEval ?? 8} onChange={v => setField('s1MaxEval', v)} min={1} max={100} />
      </div>
    </div>
  )
}
function S2ExpertCol({ form, setField }) {
  return (
    <div>
      <div className="node-col-title">S2 · SoVITS</div>
      <div className="param-grid">
        <NumField label="Seed" value={form.s2Seed ?? 1234} onChange={v => setField('s2Seed', v)} min={0} max={999999} />
        <NumField label="Log Interval" value={form.s2LogInterval ?? 100} onChange={v => setField('s2LogInterval', v)} min={1} max={10000} />
        <NumField label="LR Decay" value={form.s2LrDecay ?? 0.999875} onChange={v => setField('s2LrDecay', v)} min={0.9} max={1} step={0.0001} />
        <NumField label="Segment Size" value={form.s2SegmentSize ?? 20480} onChange={v => setField('s2SegmentSize', v)} min={1024} max={65536} />
        <NumField label="C Mel Loss" value={form.s2CMel ?? 45} onChange={v => setField('s2CMel', v)} min={1} max={100} />
        <NumField label="C KL Loss" value={form.s2CKl ?? 1.0} onChange={v => setField('s2CKl', v)} min={0.1} max={10} step={0.1} />
        <NumField label="Text Low LR Rate" value={form.s2TextLowLr ?? 0.4} onChange={v => setField('s2TextLowLr', v)} min={0.01} max={1} step={0.01} />
        <label className="toggle-row" style={{ alignSelf: 'end', paddingBottom: 6 }}>
          <input type="checkbox" checked={!!form.s2GradCkpt} onChange={e => setField('s2GradCkpt', e.target.checked)} /> Gradient Checkpoint (save VRAM)
        </label>
      </div>
    </div>
  )
}

// part: 's1' | 's2' | 'both'. Renders the same fields whether shown on the unified
// Training page (both) or on a single-model node/restore panel (s1 / s2).
function TrainParamFields({ form, setField, part = 'both', versionMode = 'single' }) {
  const expertLocked = !form.expertUnlocked
  const showS1 = part === 's1' || part === 'both'
  const showS2 = part === 's2' || part === 'both'
  const hint = part === 's1'
    ? '8GB VRAM (RTX 3070): keep batch size ≤ 4, or use "auto". Save-Every is auto-clamped to the epoch count so a checkpoint is always produced.'
    : part === 's2'
      ? 'S2 (SoVITS) trains independently of S1 — it does not need the GPT checkpoint.'
      : '8GB VRAM (RTX 3070): keep batch size ≤ 4, or use "auto". Save-Every is auto-clamped to the epoch count so a checkpoint is always produced. S1 and S2 are independent steps.'
  return (
    <>
      <div className="layer-label">Advanced Options</div>
      {/* Base model version(s). Only shown for the SoVITS (S2) stage — GPT is version-agnostic.
          versionMode='multi' (S2 pipeline node) → checkbox group → form.modelVersions[] (read B:
          one SoVITS trained per checked version). Otherwise a single select (asset rebuild). */}
      {showS2 && (versionMode === 'multi' ? (
        <div className="train-version-row" style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>SoVITS Version(s) — one model trained per checked version</label>
          <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {[
              { v: 'v2', label: 'v2' },
              { v: 'v2Pro', label: 'v2Pro · recommended' },
              { v: 'v2ProPlus', label: 'v2ProPlus · best' },
            ].map(({ v, label }) => {
              const cur = (Array.isArray(form.modelVersions) && form.modelVersions.length)
                ? form.modelVersions : (form.modelVersion ? [form.modelVersion] : ['v2Pro']);
              const checked = cur.includes(v);
              const toggle = (on) => {
                const order = ['v2', 'v2Pro', 'v2ProPlus'];
                let next = on ? [...cur, v] : cur.filter(x => x !== v);
                next = order.filter(o => next.includes(o)); // 去重 + 规范排序
                if (!next.length) next = [v]; // 至少保留一个版本，禁止清空
                setField('modelVersions', next);
              };
              return (
                <label key={v} className="toggle-row" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={checked} onChange={e => toggle(e.target.checked)} />
                  {label}
                </label>
              );
            })}
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Each checked version trains its own SoVITS model in a single run. v2Pro / v2ProPlus need their own
            base + SV models (download_models.py); missing ones are reported below the pipeline before you start.
          </p>
        </div>
      ) : (
        <div className="train-version-row" style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>Base Model Version</label>
          <select className="control" value={form.modelVersion || 'v2'} onChange={e => setField('modelVersion', e.target.value)}>
            <option value="v2">v2 — general base (s2G2333k)</option>
            <option value="v2Pro">v2Pro — recommended · needs v2Pro base + SV model</option>
            <option value="v2ProPlus">v2ProPlus — best quality · needs v2ProPlus base + SV model</option>
          </select>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            v2Pro / v2ProPlus need their own base + SV models (download_models.py). Missing base models are
            reported below the pipeline before you start.
          </p>
        </div>
      ))}
      <div className="node-cols">
        {showS1 && <S1BasicCol form={form} setField={setField} />}
        {showS2 && <S2BasicCol form={form} setField={setField} />}
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>{hint}</p>

      <details className="expert-block" style={{ marginTop: 14 }}>
        <summary className="expert-summary">Expert Parameters — GPT-SoVITS internals</summary>
        <div className="msg msg-danger expert-warning">
          <strong>⚠ Expert Parameters.</strong> Changing these can make training unstable, waste hours of GPU time,
          or produce a worse model. Most users should never touch them. Defaults are tuned for an 8GB GPU.
        </div>
        <label className="toggle-row expert-unlock">
          <input type="checkbox" checked={!!form.expertUnlocked} onChange={e => setField('expertUnlocked', e.target.checked)} />
          I understand the risks — let me edit expert parameters
        </label>
        <fieldset disabled={expertLocked} className="expert-fields" style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
          <div className="node-cols">
            {showS1 && <S1ExpertCol form={form} setField={setField} />}
            {showS2 && <S2ExpertCol form={form} setField={setField} />}
          </div>
        </fieldset>
      </details>
    </>
  )
}

const LANGUAGES = [
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese (Mandarin)' },
  { code: 'yue', label: 'Cantonese' },
  { code: 'en', label: 'English' },
  { code: 'ko', label: 'Korean' },
]

// Training presets — frontend-only convenience. Selecting one writes a bundle of
// training-form fields; "custom" leaves whatever the user has set. No backend change:
// handleStart already serialises these same form.* fields into customParams.training.
const TRAIN_PRESETS = [
  { key: 'smoke',    label: 'Quick Smoke Test',     hint: 'Tiny run to verify the pipeline end-to-end (~2 epochs).',
    fields: { gptEpochs: 2,  sovitsEpochs: 2,  batchSize: 'auto', s1SaveEvery: 1, s2GradCkpt: false, s2Fp16: true } },
  { key: 'balanced', label: 'Balanced (Recommended)', hint: 'Sensible defaults for most voices.',
    fields: { gptEpochs: 20, sovitsEpochs: 20, batchSize: 'auto', s1SaveEvery: 4, s2GradCkpt: false, s2Fp16: true } },
  { key: 'quality',  label: 'Higher Quality',       hint: 'More epochs for a sharper model. Slower.',
    fields: { gptEpochs: 30, sovitsEpochs: 30, batchSize: 'auto', s1SaveEvery: 4, s2GradCkpt: false, s2Fp16: true } },
  { key: 'lowvram',  label: 'Low VRAM Safe',         hint: 'Batch size 1 + gradient checkpoint for 8GB GPUs.',
    fields: { gptEpochs: 20, sovitsEpochs: 20, batchSize: 1,      s1SaveEvery: 4, s2GradCkpt: true,  s2Fp16: true } },
  { key: 'custom',   label: 'Custom',               hint: 'Your own values — edit anything in the pipeline steps below.',
    fields: null },
]

// Slicing preset field values, shared by the Slicing-step preset dropdown and the
// Input Type convenience mapping.
const SLICE_PRESET_VALUES = {
  default:    { sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5 },
  aggressive: { sliceMinSec: 2, sliceMaxSec: 10, sliceSilenceDb: -34, sliceMinSilenceSec: 0.3 },
  longer:     { sliceMinSec: 5, sliceMaxSec: 25, sliceSilenceDb: -45, sliceMinSilenceSec: 0.8 },
}

// Input types — frontend-only convenience. Maps the source-audio character to the
// preprocessing toggles (denoise / slice). All map to form.* fields that already exist.
//
// BACKEND-PENDING (Phase 4): this is a preset mapping, NOT content-aware detection.
// "Standard" applies the default preprocessing; it does not inspect the audio. True
// automatic input detection (and per-input-type dedicated algorithms beyond the single
// UVR5 denoise + single slicer2 the backend ships today) require a backend preflight
// scan. Tracked in PHASE2_REPORT.md → "Phase 4 backend dependencies".
const INPUT_TYPES = [
  { key: 'auto',  label: 'Standard (default)',  hint: 'Default preprocessing: slice + transcribe.',
    fields: { denoise: false, slice: true, asr: true } },
  { key: 'clean', label: 'Clean voice clips',  hint: 'Already-clean recordings; no denoise.',
    fields: { denoise: false, slice: true, asr: true } },
  { key: 'long',  label: 'Long raw recording', hint: 'One long take; slice into clips before training.',
    fields: { denoise: false, slice: true, asr: true }, slicePreset: 'aggressive' },
  { key: 'noisy', label: 'Noisy / mixed audio', hint: 'Has music/noise; extract vocals first.',
    fields: { denoise: true, slice: true, asr: true } },
]

// Real backend pipeline steps (lib/training/pipeline.js). S1/GPT and S2/SoVITS are
// now independent steps (train_s1 / train_s2); 'promote' publishes the asset.
const TRAIN_STEPS = [
  { key: 'denoise',    label: 'Vocal Extraction' },
  { key: 'slice',      label: 'Slicing' },
  { key: 'asr',        label: 'ASR' },
  { key: 'preprocess', label: 'Preprocess' },
  { key: 'train_s1',   label: 'S1 (GPT)' },
  { key: 'train_s2',   label: 'S2 (SoVITS)' },
  { key: 'finalize',   label: 'Finalize' },
  { key: 'promote',    label: 'Publish' },
]

// Clickable pipeline map — doubles as navigation (click a node to configure it)
// and as live status (during a run the node reflects /api/train/status state).
function PipelineMap({ statusSteps, enabledMap, selectedNode, onSelect, readOnly }) {
  return (
    <div className={`pipe-map ${readOnly ? 'readonly' : ''}`} role="list">
      {TRAIN_STEPS.map((s, i) => {
        let st
        const off = enabledMap && enabledMap[s.key] === false
        if (statusSteps && statusSteps[s.key]) st = statusSteps[s.key].status || 'pending'
        else st = off ? 'skipped' : 'pending'
        const glyph = st === 'completed' ? '\u2713' : st === 'running' ? '\u25CF' : st === 'failed' ? '\u2717' : st === 'skipped' ? '\u2013' : i + 1
        const isSel = selectedNode === s.key
        // The connector segment to the LEFT of this node turns green once the
        // previous step has completed, so the rail reads as a progress bar.
        const prevDone = i > 0 && statusSteps && statusSteps[TRAIN_STEPS[i - 1].key] &&
          statusSteps[TRAIN_STEPS[i - 1].key].status === 'completed'
        return (
          <button
            type="button"
            role="listitem"
            className={`pipe-step ${isSel ? 'selected' : ''} ${off ? 'disabled-step' : ''} ${readOnly ? 'readonly' : ''}`}
            key={s.key}
            onClick={readOnly ? undefined : () => onSelect(isSel ? null : s.key)}
            title={readOnly ? s.label : 'Click to configure this step'}
          >
            {i > 0 && <span className={`pipe-seg ${prevDone ? 'done' : ''}`} aria-hidden="true" />}
            <span className={`pipe-dot ${st}`}>{glyph}</span>
            <span className={`pipe-label ${st === 'running' ? 'running' : ''}`}>{s.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// Live lightweight-pipeline panel for an in-flight Rebuild/Restore on the Assets
// page. Reuses the same PipelineMap (read-only) so the repair flow reads exactly
// like the formal training flow — irrelevant steps show greyed/skipped, the
// active step pulses, and a failure surfaces the exact step + error message.
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

// Live logs viewer with auto-scroll / pause / copy / clear (Part 2)
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

function TrainingTab({ voices, loadVoices, activeTaskId, setActiveTaskId, trainPrefill, setTrainPrefill }) {
  const [form, setForm] = usePersistentState('train.form', {
    inputDir: '', language: 'ja', voiceName: '',
    preset: 'balanced', inputType: 'auto', expertUnlocked: false,
    denoise: false, slice: true, asr: true, copyRaw: true,
    trainS1: true, trainS2: true,
    // Advanced params
    gptEpochs: 20, sovitsEpochs: 20, batchSize: 'auto', learningRate: 'default',
    sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5,
    asrEngine: 'auto', denoiseModel: 'mdx-net',
    asrModelSize: 'large-v3-turbo', asrPrecision: 'float16',
    modelVersion: 'v2Pro', modelVersions: ['v2Pro'], isHalf: true, inferDevice: 'cuda',
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
  // Base-model availability for the selected training version (drives the gate warning).
  const [baseModelStatus, setBaseModelStatus] = useState(null);
  const _selVersions = (Array.isArray(form.modelVersions) && form.modelVersions.length)
    ? form.modelVersions : [form.modelVersion || 'v2'];
  const _selVersionsKey = _selVersions.join(',');
  useEffect(() => {
    let cancelled = false;
    api(`/api/models/status?versions=${encodeURIComponent(_selVersionsKey)}`)
      .then(r => { if (!cancelled && r.ok) setBaseModelStatus(r.data); })
      .catch(() => { if (!cancelled) setBaseModelStatus(null); });
    return () => { cancelled = true; };
  }, [_selVersionsKey]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null); // pipeline-map node being configured/inspected
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
  // Overwrite confirmation when the target voice id already exists (409 guard).
  const [overwriteConfirm, setOverwriteConfirm] = useState(null); // { existingId, existingDisplay }

  // 用 props 中的 activeTaskId，但在 handleStart 后也写一份本地（启动时用）
  const taskId = activeTaskId || localTaskId;
  const isRunning = status?.status === 'running';
  const isFinished = status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status);
  const isInterrupted = status?.status === 'interrupted';

  // Fields owned by a training preset — editing any of them by hand means the
  // current values no longer match the named preset, so flip the label to "Custom".
  const PRESET_KEYS = ['gptEpochs', 'sovitsEpochs', 'batchSize', 's1SaveEvery', 's2GradCkpt', 's2Fp16'];

  // 便捷 form setter
  const setField = (key, val) => setForm(prev => {
    const next = { ...prev, [key]: val };
    if (PRESET_KEYS.includes(key) && prev.preset && prev.preset !== 'custom') {
      next.preset = 'custom';
    }
    return next;
  });

  // Consume a one-shot prefill handed over from the Assets "Rebuild" action:
  // fill in the input folder + voice name, then clear the signal so it fires once.
  useEffect(() => {
    if (!trainPrefill) return;
    setForm(prev => ({ ...prev, ...trainPrefill }));
    if (setTrainPrefill) setTrainPrefill(null);
  }, [trainPrefill]);

  // Slicing presets: convenience that fills the four slice fields (or disables slicing)
  const applySlicePreset = (name) => {
    if (name === 'none') { setField('slice', false); return; }
    const p = SLICE_PRESET_VALUES[name];
    if (p) setForm(prev => ({ ...prev, slice: true, ...p }));
  };

  // Training preset (default-view convenience): overwrite the training fields in one go.
  const applyPreset = (name) => {
    const p = TRAIN_PRESETS.find(x => x.key === name);
    if (!p) return;
    setForm(prev => ({ ...prev, preset: name, ...(p.fields || {}) }));
  };

  // Input type (default-view convenience): maps source-audio character to preprocessing toggles.
  const applyInputType = (name) => {
    const t = INPUT_TYPES.find(x => x.key === name);
    if (!t) return;
    const sliceVals = t.slicePreset ? SLICE_PRESET_VALUES[t.slicePreset] : null;
    setForm(prev => ({ ...prev, inputType: name, ...(t.fields || {}), ...(sliceVals || {}) }));
  };

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

  const submitTraining = async (overwrite) => {
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
        overwrite: !!overwrite,
        steps: { denoise: form.denoise, slice: form.slice, asr: form.asr, copyRaw: form.copyRaw, train_s1: form.trainS1 !== false, train_s2: form.trainS2 !== false },
        customParams: {
          training: buildTrainingParams(form),
          steps: {
            slice: { params: buildSliceParams(form) },
            asr: { params: buildAsrParams(form) },
            denoise: { params: { model: form.denoiseModel } },
          },
        },
      },
    });
    // Existing-voice guard: server refuses without explicit overwrite. Surface a
    // confirm showing the DISPLAY NAME the id currently belongs to.
    if (!r.ok && r.status === 409 && r.data?.code === 'VOICE_EXISTS') {
      setOverwriteConfirm({ existingId: r.data.existingId, existingDisplay: r.data.existingDisplay });
      return;
    }
    if (!r.ok) throw new Error(r.data?.error || 'Failed to start training');
    setLocalTaskId(r.data.taskId);
    setActiveTaskId(r.data.taskId); // 写入持久化 + 触发 App 层重连
  };

  const handleStart = async () => {
    if (!form.inputDir.trim()) { setError('Please select an audio folder'); return }
    if (!form.voiceName.trim()) { setError('Please enter a voice name'); return }
    setError(null);
    setStatus(null);
    setLogs([]);
    try {
      await submitTraining(false);
    } catch (err) {
      setError(err.message);
    }
  }

  const confirmOverwriteTrain = async () => {
    setOverwriteConfirm(null);
    setError(null);
    try {
      await submitTraining(true);
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

  const [clearMsg, setClearMsg] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const handleClearStaging = async () => {
    if (clearing) return;
    setCacheConfirm(false);
    setClearing(true);
    setClearMsg(null);
    try {
      const r = await api('/api/train/clear-staging', { method: 'POST' });
      if (!r.ok) throw new Error(r.data?.error || 'Failed to clean cache');
      const mb = (r.data.bytes / (1024 * 1024)).toFixed(1);
      const skipped = r.data.skipped ? `, ${r.data.skipped} running task(s) kept` : '';
      setClearMsg(`Cleaned ${r.data.removed} cache folder(s), freed ${mb} MB${skipped}`);
    } catch (err) {
      setClearMsg(`Clean failed: ${err.message}`);
    } finally {
      setClearing(false);
    }
  };

  const editable = !taskId; // inputs are editable only before a task starts

  const sanitizedVoice = form.voiceName ? form.voiceName.trim().replace(/[^a-zA-Z0-9_\-]/g, '_') : '';
  const existingVoice = sanitizedVoice ? voices.find(v => v.id === sanitizedVoice) : null;
  const voiceExists = !!existingVoice;
  const saveEvery = form.s1SaveEvery ?? 4;
  const enabledSteps = [
    form.denoise && 'Vocal extraction',
    form.copyRaw && 'Copy to raw', form.slice && 'Slice', form.asr && 'ASR',
    'Preprocess', 'S1 (GPT)', 'S2 (SoVITS)', 'Finalize', 'Publish',
  ].filter(Boolean);

  const NODE_LABELS = {
    denoise: 'Vocal Extraction', slice: 'Slicing', asr: 'ASR Transcription',
    preprocess: 'Preprocess', train_s1: 'S1 Training (GPT)', train_s2: 'S2 Training (SoVITS)',
    finalize: 'Finalize', promote: 'Publish',
  };

  const renderNodeDetail = () => {
    if (!selectedNode) return null;
    const stepSt = status?.steps?.[selectedNode]?.status;
    const stBadge = stepSt && (
      <span className={`badge ${stepSt === 'completed' ? 'badge-ok' : stepSt === 'running' ? 'badge-accent' : stepSt === 'failed' ? 'badge-danger' : 'badge-neutral'}`}>{stepSt}</span>
    );
    let body = null;
    if (selectedNode === 'denoise') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.denoise} onChange={e => setField('denoise', e.target.checked)} />
            Enable vocal extraction
          </label>
          {form.denoise && (
            <div className="field">
              <label className="field-label">Model</label>
              <select className="control" value={form.denoiseModel} onChange={e => setField('denoiseModel', e.target.value)}>
                <option value="mdx-net">MDX-Net</option>
              </select>
            </div>
          )}
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Extracts the vocal track (removes background music / instrumental) before slicing. Off by default — only needed for noisy or mixed audio.</p>
        </>
      );
    } else if (selectedNode === 'slice') {
      // Invariant #5: an asset must end up with at least one kind of reference audio.
      // slice → slicer_opt/ ; copyRaw → raw/. Both off would publish an empty asset,
      // so unchecking one auto-forces the other on.
      const toggleSlice = (checked) => {
        setForm(f => ({ ...f, slice: checked, copyRaw: checked ? f.copyRaw : true }));
      };
      const toggleCopyRaw = (checked) => {
        setForm(f => ({ ...f, copyRaw: checked, slice: checked ? f.slice : true }));
      };
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.slice} onChange={e => toggleSlice(e.target.checked)} />
            Enable slicing
          </label>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.copyRaw} onChange={e => toggleCopyRaw(e.target.checked)} />
            Copy raw audio into the asset (keep originals as reference)
          </label>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: -2, marginBottom: 8 }}>
            At least one kind of reference audio is required: slicing or copied raw.
            Turning off “Copy raw” forces slicing on, and vice versa (otherwise the asset
            would have no reference audio). When slicing is off, ASR writes <code>raw_opt.list</code>.
          </p>
          <div className="field">
            <label className="field-label">Slicing preset</label>
            <select className="control" onChange={e => applySlicePreset(e.target.value)} defaultValue="">
              <option value="" disabled>Choose a preset…</option>
              <option value="default">Default</option>
              <option value="aggressive">More aggressive split</option>
              <option value="longer">Fewer, longer clips</option>
              <option value="none">Already sliced (no slicing)</option>
            </select>
          </div>
          {form.slice && (
            <div style={{ marginTop: 4 }}>
              <SliceParamFields form={form} setField={setField} />
            </div>
          )}
        </>
      );
    } else if (selectedNode === 'asr') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.asr} onChange={e => setField('asr', e.target.checked)} />
            Enable transcription (ASR)
          </label>
          {form.asr && <AsrParamFields form={form} setField={setField} />}
        </>
      );
    } else if (selectedNode === 'train_s1') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.trainS1 !== false} onChange={e => setField('trainS1', e.target.checked)} />
            Enable S1 (GPT) fine-tuning
          </label>
          {form.trainS1 !== false
            ? <TrainParamFields form={form} setField={setField} part="s1" />
            : <p style={{ fontSize: 11, color: 'var(--muted)' }}>S1 (GPT) fine-tuning is turned off — this step will be skipped.</p>}
        </>
      );
    } else if (selectedNode === 'train_s2') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.trainS2 !== false} onChange={e => setField('trainS2', e.target.checked)} />
            Enable S2 (SoVITS) fine-tuning
          </label>
          {form.trainS2 !== false
            ? <TrainParamFields form={form} setField={setField} part="s2" versionMode="multi" />
            : <p style={{ fontSize: 11, color: 'var(--muted)' }}>S2 (SoVITS) fine-tuning is turned off — this step will be skipped.</p>}
        </>
      );
    } else if (selectedNode === 'preprocess') {
      body = <p style={{ fontSize: 12, color: 'var(--muted)' }}>Extracts text tokens and audio features required for training. No configuration needed.</p>;
    } else if (selectedNode === 'finalize') {
      body = <p style={{ fontSize: 12, color: 'var(--muted)' }}>Packages the trained checkpoints and reference audio into a voice asset. No configuration needed.</p>;
    } else if (selectedNode === 'promote') {
      body = <p style={{ fontSize: 12, color: 'var(--muted)' }}>Publishes the finished voice into <code>assets/</code> so it becomes selectable on the Generate page. No configuration needed.</p>;
    }
    return (
      <div className="node-detail">
        <div className="node-detail-hdr">
          <span className="node-detail-title">{NODE_LABELS[selectedNode]}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {stBadge}
            <button className="btn btn-sm" onClick={() => setSelectedNode(null)}>Close</button>
          </div>
        </div>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
          {body}
        </fieldset>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="section">
        <div className="section-hdr"><h2>Train New Voice</h2></div>
        <div className="section-body">
          {/* Essentials — one horizontal row so the page reads wide, not narrow */}
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
            <div className="essentials-grid">
              <div className="field">
                <label className="field-label">Voice Name *</label>
                <input className="control" value={form.voiceName} onChange={e => setField('voiceName', e.target.value)} placeholder="e.g. MyVoice" />
              </div>
              <div className="field">
                <label className="field-label">Language *</label>
                <select className="control" value={form.language} onChange={e => setField('language', e.target.value)}>
                  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="field-label">Audio Folder Path *</label>
                <input className="control" value={form.inputDir} onChange={e => setField('inputDir', e.target.value)} placeholder="e.g. D:\raw_audio\MyVoice" />
              </div>
            </div>

            {/* Preset + Input Type — high-level, user-friendly defaults (Part 2).
                Both are frontend-only: they just fill existing form.* fields. */}
            <div className="preset-grid">
              <div className="field">
                <label className="field-label">Training Preset</label>
                <select className="control" value={form.preset || 'balanced'} onChange={e => applyPreset(e.target.value)}>
                  {TRAIN_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
                <p className="field-hint">{(TRAIN_PRESETS.find(p => p.key === (form.preset || 'balanced')) || {}).hint}</p>
              </div>
              <div className="field">
                <label className="field-label">Input Type</label>
                <select className="control" value={form.inputType || 'auto'} onChange={e => applyInputType(e.target.value)}>
                  {INPUT_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
                <p className="field-hint">{(INPUT_TYPES.find(t => t.key === (form.inputType || 'auto')) || {}).hint}</p>
                <p className="field-note">ⓘ Preset mapping, not content detection — automatic input detection arrives with backend support.</p>
              </div>
            </div>
          </fieldset>

          {/* Pipeline map — click a step to configure it (or inspect its status during a run) */}
          <div className="field" style={{ marginTop: 10 }}>
            <label className="field-label">Pipeline — click any step to configure</label>
            <PipelineMap
              statusSteps={status?.steps}
              enabledMap={{ denoise: form.denoise, slice: form.slice, asr: form.asr, train_s1: form.trainS1 !== false, train_s2: form.trainS2 !== false }}
              selectedNode={selectedNode}
              onSelect={setSelectedNode}
            />
          </div>
          {renderNodeDetail()}

          {/* Pre-flight summary — reflects live form.* values (advanced params edits flow
              through here too). Shows what is NOT already visible in the dropdowns / map. */}
          <div className="preflight">
            <div className="pf-row">
              <span className="pf-key">Output</span>
              <span className="pf-val pf-path">{sanitizedVoice ? `assets/${sanitizedVoice}/` : 'assets/<voice>/'}</span>
              {voiceExists && <span className="pf-warn">⚠ will overwrite existing &ldquo;{existingVoice.display_name || sanitizedVoice}&rdquo; (id: {sanitizedVoice})</span>}
            </div>
            <div className="pf-row">
              <span className="pf-key">Fine-tune</span>
              <span className="pf-chips">
                {form.trainS1 !== false && (
                  <span className="pf-chip">GPT (S1) · {form.gptEpochs ?? 20}ep</span>
                )}
                {form.trainS2 !== false && _selVersions.map(v => (
                  <span key={v} className="pf-chip">SoVITS {v} · {form.sovitsEpochs ?? 20}ep</span>
                ))}
                {form.trainS1 === false && form.trainS2 === false && (
                  <span className="pf-chip pf-chip-off">none (safe pass)</span>
                )}
                {(form.trainS1 !== false || form.trainS2 !== false) && (
                  <span className="pf-chip pf-chip-meta">batch {form.batchSize || 'auto'} · save every {saveEvery} {saveEvery === 1 ? 'epoch' : 'epochs'}</span>
                )}
              </span>
            </div>
            <div className="pf-row">
              <span className="pf-key">Preprocess</span>
              <span className="pf-chips">
                {form.denoise && <span className="pf-chip">Vocal Extract</span>}
                {form.slice && <span className="pf-chip">Slice</span>}
                {form.asr && <span className="pf-chip">ASR</span>}
                {!form.denoise && !form.slice && !form.asr && <span className="pf-chip pf-chip-off">none</span>}
              </span>
            </div>
          </div>

          {/* Base-model gate feedback — reports EVERY selected SoVITS version (only when S2 will run).
              S1(GPT)/S2(SoVITS) enable toggles now live inside their pipeline nodes (like slice/ASR). */}
          {form.trainS2 !== false && baseModelStatus && Array.isArray(baseModelStatus.versions) &&
            baseModelStatus.versions.filter(v => !v.ok).map(v => (
              v.blocking
                ? <div key={v.version} className="msg msg-error" style={{ marginTop: 10 }}>
                    ⚠ Base models for <strong>{v.version}</strong> are missing ({(v.criticalMissing || []).join(' + ')}) — this
                    version is blocked (it would only produce electrical noise). Run:{' '}
                    <code>python download_models.py --set {String(v.version).toLowerCase()}</code>
                  </div>
                : <div key={v.version} className="msg msg-warn" style={{ marginTop: 10 }}>
                    ⚠ <strong>{v.version}</strong>: {(v.missing || []).includes('sv')
                      ? 'speaker-vector (SV) model missing — training will run but without SV enhancement'
                      : 'a preferred base model is missing; training will fall back to a lower-quality base'}. Run:{' '}
                    <code>python download_models.py --set {String(v.version).toLowerCase()}</code>
                  </div>
            ))}
          {form.trainS1 === false && form.trainS2 === false && (
            <p className="field-hint" style={{ marginTop: 10 }}>Neither S1 nor S2 is enabled (both pipeline steps off) — this run will only preprocess (slice / ASR) and publish reference audio.</p>
          )}

          {error && <div className="msg msg-error" style={{ marginTop: 8 }}>{error}</div>}

          {!taskId && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={handleStart}
                disabled={form.trainS2 !== false && !!(baseModelStatus && baseModelStatus.anyBlocking)}
                title={form.trainS2 !== false && !!(baseModelStatus && baseModelStatus.anyBlocking)
                  ? 'Some selected SoVITS versions are missing base models — run download_models.py for them first'
                  : ''}>Start Tuning</button>
              <button className="btn btn-ghost" onClick={() => setCacheConfirm(true)} disabled={clearing}
                title="Delete finished task workspaces from the .staging cache (running tasks are never touched)">
                {clearing ? 'Cleaning…' : 'Clean Cache'}
              </button>
              {clearMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{clearMsg}</span>}
            </div>
          )}

          <ConfirmDialog
            open={cacheConfirm}
            title="Clean training cache"
            message="Delete all finished task workspaces from the training cache (.staging)? Running tasks are never deleted. Your published models and assets are not affected."
            confirmLabel="Clean cache"
            danger
            busy={clearing}
            icon={<IconTrash size={18} color="var(--danger)" />}
            onConfirm={handleClearStaging}
            onCancel={() => setCacheConfirm(false)}
          />

          {taskId && !status && (
            <div className="msg" style={{ marginTop: 10 }}>Restoring training state…</div>
          )}
          {taskId && status && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {status.status === 'completed' ? 'Completed'
                   : status.status === 'failed' ? 'Failed'
                   : status.status === 'cancelled' ? 'Cancelled'
                   : status.status === 'interrupted' ? 'Interrupted'
                   : 'Tuning…'}
                </span>
                {isRunning && (
                  <button className="btn btn-sm btn-danger" onClick={handleCancel}>Cancel</button>
                )}
              </div>
              {isInterrupted && (
                <div className="msg msg-error" style={{ marginBottom: 8 }}>
                  Tuning was interrupted. Intermediate results are available; resume-from-checkpoint is on the roadmap.
                </div>
              )}
              {isFinished && (
                <button className="btn btn-sm btn-primary" style={{ marginTop: 4 }} onClick={handleReset}>Back</button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Logs only appear once a task is running/finished — keeps the idle page clean */}
      {taskId && <LiveLogs logs={logs} />}

      {/* Overwrite confirmation: target voice id already exists on disk. */}
      {overwriteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setOverwriteConfirm(null)}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 360, maxWidth: 460,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Overwrite Existing Voice?</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
              The id <strong>{overwriteConfirm.existingId}</strong> already belongs to{' '}
              <strong>&ldquo;{overwriteConfirm.existingDisplay}&rdquo;</strong>.
            </p>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
              Training will publish into <code>assets/{overwriteConfirm.existingId}/</code> and
              permanently replace the models and references of that voice. This cannot be undone.
              If you meant to keep both, cancel and give this one a different name.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setOverwriteConfirm(null)}>Cancel</button>
              <button className="btn btn-sm btn-danger" onClick={confirmOverwriteTrain}>Overwrite &amp; Train</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// prompt_lang（参考音频语言）选项，裸码，与音色 language 字段一致。
const REF_PROMPT_LANG_OPTIONS = [
  { value: 'ja', label: 'Japanese (\u65e5\u672c\u8a9e)' },
  { value: 'zh', label: 'Chinese (\u4e2d\u6587)' },
  { value: 'en', label: 'English' },
  { value: 'yue', label: 'Cantonese (\u7ca4\u8bed)' },
  { value: 'ko', label: 'Korean (\ud55c\uad6d\uc5b4)' },
]

// 跨资产参考音频选择器：列出「其他音色」并读取其全部 slices/raw，点选即用。
// 复用现有 /api/assets/<id>/segments + /raw-list。onPick(path, text)。
// 独立组件，便于后续 Compare Refs 页复用（预留接口）。
function CrossRefPicker({ voices, currentVoiceId, onPick, activeRef }) {
  const others = (voices || []).filter(v => v.id !== currentVoiceId)
  const [vid, setVid] = useState(others[0]?.id || '')
  const [segs, setSegs] = useState(null)
  const [raws, setRaws] = useState(null)
  const [loading, setLoading] = useState(false)
  const [rawDur, setRawDur] = useState({})

  useEffect(() => {
    if (others.length && !others.find(o => o.id === vid)) setVid(others[0].id)
  }, [currentVoiceId])   // eslint-disable-line

  useEffect(() => {
    if (!vid) { setSegs([]); setRaws([]); return }
    setLoading(true); setRawDur({})
    Promise.all([
      api(`/api/assets/${vid}/segments`)
        .then(r => setSegs(r.ok && r.data.segments ? (r.data.segments.segments || []) : []))
        .catch(() => setSegs([])),
      api(`/api/assets/${vid}/raw-list`)
        .then(r => setRaws(r.ok && r.data.raw ? r.data.raw : []))
        .catch(() => setRaws([])),
    ]).finally(() => setLoading(false))
  }, [vid])

  if (others.length === 0) return <div className="field-hint">No other voices available.</div>

  const availSlices = Array.isArray(segs) ? segs.filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename)) : []
  const availRaw = Array.isArray(raws) ? raws : []
  const pickSlice = (seg) => {
    const p = seg.audio || seg.audio_path || seg.audio_filename
    const fn = p ? p.replace(/\\/g, '/').split('/').pop() : ''
    if (fn) onPick(`assets/${vid}/slicer_opt/${fn}`, seg.text || '')
  }
  const pickRaw = (rf) => onPick(`assets/${vid}/raw/${rf.filename}`, rf.text || '')

  return (
    <div>
      <select className="control" value={vid} onChange={e => setVid(e.target.value)} style={{ marginBottom: 6 }}>
        {others.map(o => <option key={o.id} value={o.id}>{o.display_name} ({o.language || '?'})</option>)}
      </select>
      <div className="field-hint" style={{ color: 'var(--warning)', marginBottom: 6 }}>
        Cross-voice reference &mdash; timbre and quality may differ from this model.
      </div>
      {loading && <div className="field-hint">Loading reference audio&hellip;</div>}
      {!loading && (
        <div className="ref-list">
          {availSlices.length === 0 && availRaw.length === 0 && <div className="ref-col-empty">No reference audio in this voice</div>}
          {availSlices.map((seg, i) => {
            const p = seg.audio || seg.audio_path || seg.audio_filename
            const fn = p ? p.replace(/\\/g, '/').split('/').pop() : ''
            const rpath = `assets/${vid}/slicer_opt/${fn}`
            const isActive = activeRef === rpath
            const oor = !refInRange(seg.duration)
            return (
              <div key={`s${i}`} className={`ref-item ${isActive ? 'active' : ''}`} onClick={() => pickSlice(seg)} title={seg.text || ''}>
                <div className="ref-item-row">
                  <span className="ref-item-name">{seg.scene} #{seg.index}</span>
                  <span className={`ref-item-dur ${oor ? 'ref-dur-warn' : ''}`}>{(seg.duration || 0).toFixed(1)}s{oor ? ' \u26a0' : ''}</span>
                  <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '\u2713' : '\u2192'}</span>
                </div>
                <AudioPlayer src={`/assets/${vid}/slicer_opt/${fn}`} />
              </div>
            )
          })}
          {availRaw.map((rf, i) => {
            const rpath = `assets/${vid}/raw/${rf.filename}`
            const isActive = activeRef === rpath
            const dur = (rf.duration && rf.duration > 0) ? rf.duration : rawDur[rf.filename]
            const known = typeof dur === 'number' && dur > 0
            const oor = known && !refInRange(dur)
            return (
              <div key={`r${i}`} className={`ref-item ${isActive ? 'active' : ''}`} onClick={() => pickRaw(rf)} title={rf.text || rf.filename}>
                <div className="ref-item-row">
                  <span className="ref-item-name">{rf.filename}</span>
                  {known && <span className={`ref-item-dur ${oor ? 'ref-dur-warn' : ''}`}>{dur.toFixed(1)}s{oor ? ' \u26a0' : ''}</span>}
                  <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '\u2713' : '\u2192'}</span>
                </div>
                <AudioPlayer src={rf.url} onDuration={d => setRawDur(prev => (prev[rf.filename] ? prev : { ...prev, [rf.filename]: d }))} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 完全自选参考音频：浏览器文件选择（跨平台，非原生对话框），上传到
// voices/custom_refs 后作为任意音色的 ref_audio。可选手填参考文本 + prompt_lang。
// onPick(path, text, promptLang, customObj)；独立组件，Compare 页可复用（预留接口）。
function CustomRefPicker({ custom, onPick, onClear }) {
  const fileRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState(null)
  const [text, setText] = useState('')
  const [plang, setPlang] = useState('')
  const [dur, setDur] = useState(null)

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!f) return
    setErr(null); setUploading(true)
    try {
      const fd = new FormData(); fd.append('audio', f)
      const r = await api('/api/custom-ref-audio', { method: 'POST', body: fd, contentType: 'multipart' })
      if (!r.ok) throw new Error(r.data?.error || `Upload failed (${r.status})`)
      setText(''); setPlang(''); setDur(null)
      onPick(r.data.path, '', '', { path: r.data.path, url: r.data.url, name: r.data.name })
    } catch (e2) { setErr(e2.message) }
    finally { setUploading(false) }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.webm" style={{ display: 'none' }} onChange={onFile} />
      <button className="btn btn-sm" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading} title="Pick any audio file from your computer">
        {'\uD83D\uDCC1'} {uploading ? 'Uploading\u2026' : 'Custom file\u2026'}
      </button>
      {err && <div className="field-hint" style={{ color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
      {custom && (
        <div style={{ marginTop: 6 }}>
          <div className="field-hint" style={{ color: 'var(--warning)' }}>
            Custom reference &mdash; no aligned transcript. Add one below (optional).
          </div>
          <div style={{ fontSize: 12, wordBreak: 'break-all', margin: '4px 0' }}>{custom.name}</div>
          <AudioPlayer src={custom.url} onDuration={d => setDur(d)} />
          {typeof dur === 'number' && dur > 0 && !refInRange(dur) && (
            <div className="ref-range-warn">{'\u26a0'} {dur.toFixed(1)}s &mdash; the engine requires {REF_MIN_SEC}&ndash;{REF_MAX_SEC}s.</div>
          )}
          <input className="control" placeholder="Reference transcript (optional)" value={text}
            onChange={e => { setText(e.target.value); onPick(custom.path, e.target.value, plang, custom) }}
            style={{ marginTop: 6 }} />
          <label className="field-hint" style={{ display: 'block', marginTop: 4 }}>Reference language (prompt_lang)</label>
          <select className="control" value={plang}
            onChange={e => { setPlang(e.target.value); onPick(custom.path, text, e.target.value, custom) }}>
            <option value="">Follow current voice</option>
            {REF_PROMPT_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div><button className="btn btn-sm" style={{ marginTop: 6 }} onClick={onClear}>Remove custom reference</button></div>
        </div>
      )}
    </div>
  )
}

function VoiceSidebar({ voice, voices, validation, onVoiceUpdate, selectedRefAudio, selectedRefText, selectedPromptLang, onSelectRef }) {
  const [segments, setSegments] = useState(null)
  const [rawRefs, setRawRefs] = useState(null)
  const [segLoading, setSegLoading] = useState(false)
  const [refTab, setRefTab] = useState('slices') // 'slices' | 'raw'
  // Client-measured raw durations (filename -> seconds). Raw clips are often mp3,
  // whose length the server can't read from a WAV header, so the <audio> element
  // reports it on loadedmetadata — used for the same 3–10s guard as slices.
  const [rawDurations, setRawDurations] = useState({})
  // 跨选/自选参考音频（本次会话内有效，切换音色时重置；不写入音色配置）。
  const [crossMode, setCrossMode] = useState(false)
  const [customRef, setCustomRef] = useState(null) // { path, url, name } | null

  useEffect(() => {
    if (!voice.id) return
    setSegLoading(true)
    setRawDurations({})
    setCrossMode(false)
    setCustomRef(null)
    Promise.all([
      api(`/api/assets/${voice.id}/segments`).then(r => {
        setSegments(r.ok && r.data.segments ? (r.data.segments.segments || []) : [])
      }).catch(() => setSegments([])),
      api(`/api/assets/${voice.id}/raw-list`).then(r => {
        setRawRefs(r.ok && r.data.raw ? r.data.raw : [])
      }).catch(() => setRawRefs([])),
    ]).finally(() => setSegLoading(false))
  }, [voice.id])

  const pickSlice = (seg) => {
    const audioPath = seg.audio || seg.audio_path || seg.audio_filename
    if (!audioPath) return
    const filename = audioPath.replace(/\\/g, '/').split('/').pop()
    onSelectRef(`assets/${voice.id}/slicer_opt/${filename}`, seg.text || '')
  }
  const pickRaw = (rf) => {
    // Reference text comes from asr_opt/raw_opt.list (server-enriched rf.text);
    // may be empty if the raw list hasn't been transcribed yet.
    onSelectRef(`assets/${voice.id}/raw/${rf.filename}`, rf.text || '')
  }
  // Cross-voice pick: prompt_lang stays = current voice language (decision: do NOT
  // switch it), just warn. Custom pick: carries an optional prompt_lang override.
  const handleCrossPick = (path, text) => onSelectRef(path, text)
  const handleCustomPick = (path, text, plang, obj) => { if (obj) setCustomRef(obj); onSelectRef(path, text, plang) }
  const handleCustomClear = () => { setCustomRef(null); onSelectRef('', '', '') }
  // Effective duration for a raw clip: server WAV-header value, else client-measured.
  const rawDur = (rf) => (rf.duration && rf.duration > 0 ? rf.duration : rawDurations[rf.filename])

  // Privacy: only offer slices whose .wav still exists on disk right now
  // (server sets `exists` via a live re-check; deleted slices are excluded).
  const availableRefs = segments && Array.isArray(segments)
    ? segments.filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
    : []
  const availableRaw = Array.isArray(rawRefs) ? rawRefs : []

  // Active ref: user selection (from App) > auto-picked in-range slice
  const firstRef = pickDefaultRef(availableRefs)
  const activeRef = selectedRefAudio || (firstRef ? (firstRef.audio || firstRef.audio_path || firstRef.audio_filename) : '')
  // Explicit selection wins verbatim (empty for raw); only auto-fill from the picked
  // slice when the user hasn't chosen anything, so raw picks clear the transcript.
  const activeRefText = selectedRefAudio ? selectedRefText : (firstRef?.text || '')
  const activeFilename = activeRef ? activeRef.replace(/\\/g, '/').split('/').pop() : ''
  const activeIsRaw = /\/raw\//.test(activeRef)

  return (
    <div className="section">
      <div className="section-hdr"><span>{voice.display_name}</span><span style={{ fontSize: 11, color: 'var(--muted)' }}>{voice.id}</span></div>
      <div className="section-body">
        <div className="field">
          <label className="field-label">Language</label>
          <div style={{ fontSize: 13 }}>{voice.language || '?'}</div>
        </div>

        {/* Reference Audio selector — Slices (default) / Raw as tabs to avoid crowding */}
        <div className="field">
          <div className="ref-hdr">
            <label className="field-label" style={{ margin: 0 }}>Reference Audio</label>
            {!crossMode && (
              <div className="ref-tabs">
                <button
                  className={`ref-tab ${refTab === 'slices' ? 'active' : ''}`}
                  onClick={() => setRefTab('slices')}
                >Slices <span className="ref-tab-count">{availableRefs.length}</span></button>
                <button
                  className={`ref-tab ${refTab === 'raw' ? 'active' : ''}`}
                  onClick={() => setRefTab('raw')}
                >Raw <span className="ref-tab-count">{availableRaw.length}</span></button>
              </div>
            )}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0 6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={crossMode} onChange={e => setCrossMode(e.target.checked)} />
            Use reference from another voice
          </label>
          {activeRef && (
            <div style={{ fontSize: 12, color: 'var(--text)', background: 'var(--bg)', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', marginBottom: activeRefText ? 2 : 6 }}>
              {basename(activeRef)}
            </div>
          )}
          {(() => {
            // Out-of-range warning for the ACTIVE ref — works for both a slice and
            // a raw clip (raw duration may be client-measured, so only warn once known).
            let dur = null
            if (activeIsRaw) {
              const rf = availableRaw.find(r => r.filename === activeFilename)
              if (rf) dur = rawDur(rf)
            } else {
              const activeSeg = availableRefs.find(s => {
                const p = s.audio || s.audio_path || s.audio_filename
                return p && p.replace(/\\/g, '/').split('/').pop() === activeFilename
              })
              if (activeSeg) dur = activeSeg.duration
            }
            if (typeof dur === 'number' && dur > 0 && !refInRange(dur)) {
              return (
                <div className="ref-range-warn">
                  ⚠ Reference is {dur.toFixed(1)}s — the engine requires {REF_MIN_SEC}–{REF_MAX_SEC}s. Pick another {activeIsRaw ? 'clip' : 'slice'} or generation will fail.
                </div>
              )
            }
            return null
          })()}
          {activeRefText ? (
            <div style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--bg)', padding: '4px 8px', borderRadius: 4, marginBottom: 6, fontStyle: 'italic', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              "{activeRefText}"
            </div>
          ) : activeRef && activeIsRaw ? (
            <div style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--bg)', padding: '4px 8px', borderRadius: 4, marginBottom: 6 }}>
              Raw audio has no aligned reference text — the engine will use the audio only.
            </div>
          ) : null}
          {!crossMode && segLoading && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Loading reference audio…</div>}
          {!crossMode && !segLoading && availableRefs.length === 0 && availableRaw.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>No reference audio available</div>
          )}
          {!crossMode && !segLoading && refTab === 'slices' && (
            <div className="ref-list">
              {availableRefs.length === 0 && <div className="ref-col-empty">No slices available</div>}
              {availableRefs.map((seg, i) => {
                const rawPath = seg.audio || seg.audio_path || seg.audio_filename
                const segFilename = rawPath ? rawPath.replace(/\\/g, '/').split('/').pop() : ''
                const isActive = activeFilename === segFilename && !!activeRef
                const outOfRange = !refInRange(seg.duration)
                return (
                  <div key={i} className={`ref-item ${isActive ? 'active' : ''}`} title={outOfRange ? `${seg.text || ''}\n⚠ ${(seg.duration || 0).toFixed(1)}s is outside the engine's ${REF_MIN_SEC}–${REF_MAX_SEC}s reference window` : (seg.text || '')} onClick={() => pickSlice(seg)}>
                    <div className="ref-item-row">
                      <span className="ref-item-name">{seg.scene} #{seg.index}</span>
                      <span className={`ref-item-dur ${outOfRange ? 'ref-dur-warn' : ''}`}>{(seg.duration || 0).toFixed(1)}s{outOfRange ? ' ⚠' : ''}</span>
                      <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '✓' : '→'}</span>
                    </div>
                    <AudioPlayer src={`/assets/${voice.id}/slicer_opt/${segFilename}`} />
                  </div>
                )
              })}
            </div>
          )}
          {!crossMode && !segLoading && refTab === 'raw' && (
            <div className="ref-list">
              {availableRaw.length === 0 && <div className="ref-col-empty">No raw audio available</div>}
              {availableRaw.map((rf, i) => {
                const isActive = activeFilename === rf.filename && !!activeRef
                const dur = rawDur(rf)
                const known = typeof dur === 'number' && dur > 0
                const outOfRange = known && !refInRange(dur)
                const durTitle = known
                  ? (outOfRange ? `\n⚠ ${dur.toFixed(1)}s is outside the engine's ${REF_MIN_SEC}–${REF_MAX_SEC}s reference window` : '')
                  : ''
                return (
                  <div key={i} className={`ref-item ${isActive ? 'active' : ''}`} title={`${rf.text || rf.filename}${durTitle}`} onClick={() => pickRaw(rf)}>
                    <div className="ref-item-row">
                      <span className="ref-item-name">{rf.filename}</span>
                      {known && (
                        <span className={`ref-item-dur ${outOfRange ? 'ref-dur-warn' : ''}`}>{dur.toFixed(1)}s{outOfRange ? ' ⚠' : ''}</span>
                      )}
                      <span className="ref-item-mark" style={{ color: isActive ? 'var(--accent)' : 'var(--muted)' }}>{isActive ? '✓' : '→'}</span>
                    </div>
                    <AudioPlayer
                      src={rf.url}
                      onDuration={d => setRawDurations(prev => (prev[rf.filename] ? prev : { ...prev, [rf.filename]: d }))}
                    />
                  </div>
                )
              })}
            </div>
          )}
          {crossMode && (
            <CrossRefPicker voices={voices} currentVoiceId={voice.id} onPick={handleCrossPick} activeRef={selectedRefAudio} />
          )}
          <CustomRefPicker custom={customRef} onPick={handleCustomPick} onClear={handleCustomClear} />
        </div>

        {validation && (
          <div className="field" style={{ marginTop: 8 }}>
            <label className="field-label">Model Validity</label>
            <div className="validity-list">
              <div className="validity-row"><span>GPT Model</span>{statusBadge(validation.gpt_model_exists)}</div>
              <div className="validity-row"><span>SoVITS Model</span>{statusBadge(validation.sovits_model_exists)}</div>
              <div className="validity-row"><span>Reference Audio</span>{statusBadge(validation.reference_audio_exists)}</div>
            </div>
          </div>
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
              <Player src={`${API_BASE}${seg.audio_url}`} size="sm" />
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
  // Persisted: a Compare Refs workspace must survive reloads / app restarts.
  // Generated audio is referenced by a server URL (result.audio_url) — not a blob —
  // so persisting results keeps the players working after a reload as long as the
  // backend keeps the output file. Transient flags are reset on rehydrate, and the
  // list is capped to avoid blowing the localStorage quota.
  const [rows, setRows] = usePersistentState('compare.rows', [], {
    rehydrate: r => Array.isArray(r)
      ? r.map(x => ({ ...x, loading: false, error: null })).slice(0, 24)
      : [],
  })  // [{ id, refAudio, auxRefPaths, text, ...params, loading, result, error }]
  const [allAudioFiles, setAllAudioFiles] = useState([])
  const [voiceFiles, setVoiceFiles] = useState([])
  const [defaultText, setDefaultText] = usePersistentState('compare.defaultText', 'こんにちは。これはローカルTTSテストです。今日は少し長い文章を読み上げてもらいます。途中で不自然に詰まらないか確認したいです。')
  const [availableModels, setAvailableModels] = useState([])  // [{ voiceId, voiceName, gptCheckpoint, sovitsModel, label }]
  const [rowModels, setRowModels] = usePersistentState('compare.rowModels', {})  // { rowId: { voiceId, gptCheckpoint, sovitsModel } }
  const [defaultParams, setDefaultParams] = useState(null)  // loaded from /api/advanced-params
  const [segmentsCache, setSegmentsCache] = useState({})  // { voiceId: segments[] }

  const selected = voices.find(v => v.id === selectedVoice)
  // Seed the row-id counter past any persisted rows so reloaded rows never collide.
  const nextId = useRef(rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1)

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

  const addRow = (opts = {}) => {
    const rowId = nextId.current++
    // Default model: first available model for the selected voice, or first overall
    const defaultModel = availableModels.find(m => m.voiceId === selectedVoice) || availableModels[0]
    const modelForRow = defaultModel ? { voiceId: defaultModel.voiceId, gptCheckpoint: defaultModel.gptCheckpoint, sovitsModel: defaultModel.sovitsModel } : { voiceId: '', gptCheckpoint: '', sovitsModel: '' }
    setRowModels(prev => ({ ...prev, [rowId]: modelForRow }))
    // Use first matched segment from selected voice as default ref (unless an empty row was requested)
    const firstSeg = segmentsCache[selectedVoice]?.find(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
    const defaultRef = (!opts.empty && firstSeg) ? (() => {
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
      // Reserved override hooks (per-row) so the Generate-tab features — target
      // text_lang unlock and cross/custom reference prompt_lang/transcript — can be
      // wired into Compare rows later without touching this call site. Absent =
      // current behaviour (follow the selected voice's language).
      body.text_lang = row.textLang || selected?.language || 'ja'
      body.prompt_lang = row.promptLang || selected?.language || 'ja'
      if (row.promptText) body.reference_text = row.promptText
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
        <div className="section">
          <div className="section-hdr"><span>Get Started</span></div>
          <div className="section-body">
            <div className="starter-grid">
              <div className="starter-card">
                <div className="sc-title">Use Current Reference</div>
                <div className="sc-desc">Create a row from <strong>{selected?.display_name || selectedVoice || 'the selected voice'}</strong>'s default reference audio.</div>
                <button className="btn btn-sm btn-primary" onClick={() => addRow()} disabled={!selectedVoice}>Use Current Reference</button>
              </div>
              <div className="starter-card">
                <div className="sc-title">Add Empty Row</div>
                <div className="sc-desc">Manually configure reference audio and prompt text from scratch.</div>
                <button className="btn btn-sm" onClick={() => addRow({ empty: true })}>Add Empty Row</button>
              </div>
              <div className="starter-card">
                <div className="sc-title">Load From Assets</div>
                <div className="sc-desc">Add a row, then pick existing slices / reference samples from voice assets in the row's picker.</div>
                <button className="btn btn-sm" onClick={() => addRow()} disabled={!selectedVoice}>Load From Assets</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Comparison results area (Part 5) */}
      {rows.length > 0 && !rows.some(r => r.result) && (
        <div className="empty-state" style={{ marginTop: 4, padding: 16 }}>
          <div className="es-sub" style={{ marginBottom: 0 }}>Generated comparison results will appear here.</div>
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
    const first = segments.find(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
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
            {segments.filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename)).map((seg, i) => {
              const raw = seg.audio || seg.audio_path || seg.audio_filename
              const path = raw || ''
              return (
                <option key={i} value={path}>
                  {seg.scene} #{seg.index} — "{seg.text.slice(0, 30)}{seg.text.length > 30 ? '...' : ''}" ({(seg.duration || 0).toFixed(1)}s)
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
          <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>(optional, multi-select from segments)</span>
        </label>
        {segments.length > 0 && (
          <div style={{ maxHeight: 120, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', marginTop: 4 }}>
            {segments.filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename)).map((seg, i) => {
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
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>{(seg.duration || 0).toFixed(1)}s</span>
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
          <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>(leave empty for default)</span>
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
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Advanced Settings</span>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showAdvanced ? '▲' : '▼'}</span>
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
          <Player src={`${API_BASE}${row.result.audio_url}`} size="sm" />
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

function IconPencil({ size = 16, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  )
}

function IconFolder({ size = 16, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}

// External-link / reveal-in-explorer glyph (arrow leaving a frame).
// Circular refresh / replay glyph for Rerun.
function IconRerun({ size = 16, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6" />
      <path d="M21 13a9 9 0 1 1-3-7.7L21 8" />
    </svg>
  )
}

// Reusable secondary-confirmation modal (replaces the browser's native
// window.confirm, which is unstyled/ugly). Reuses .modal-overlay/.modal-card.
function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger = false, busy = false, icon = null, onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div className="modal-card confirm-card" onClick={e => e.stopPropagation()}>
        <div className="confirm-hdr">
          {icon}
          <span>{title}</span>
        </div>
        <div className="confirm-body">{message}</div>
        <div className="confirm-actions">
          <button className="btn btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={'btn btn-sm ' + (danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm} disabled={busy}>
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================
//  RESTORE ASSET MODAL
// ============================
// Secondary menu for dependency-driven asset repair. Instead of silently
// executing the backend's shortest path, this lets the user choose HOW to
// restore (re-slice vs. use raw as-is, transcribe or not, retrain or not) and
// tune the slice / training parameters that the chosen path will use. The
// backend planner stays authoritative: it re-plans on every option change
// (execute:false) so the live "Plan" preview always reflects what will run.
function RestoreModal({ id, displayName, onClose, onStarted }) {
  const [state, setState] = useState(null)        // { R, S, L, Seg, M }
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState(null)
  // User intent (drives the planner)
  const [sliceChoice, setSliceChoice] = useState('noslice') // 'noslice' (raw is the source) | 'real' (re-slice)
  const [doAsr, setDoAsr] = useState(true)
  // S1 (GPT) and S2 (SoVITS) are independent — the user can retrain either, both, or
  // neither. Seeded from which weights are actually missing (state.Mg / state.Ms).
  const [trainS1, setTrainS1] = useState(false)
  const [trainS2, setTrainS2] = useState(false)
  const seeded = useRef(false)
  // Parameter overrides — share the exact same field set & panels as the Training
  // page, so the rebuild flow exposes every parameter the formal flow does.
  const [showSliceParams, setShowSliceParams] = useState(false)
  const [showAsrParams, setShowAsrParams] = useState(false)
  const [showTrainParams, setShowTrainParams] = useState(false)
  const [form, setForm] = useState({ ...REBUILD_PARAM_DEFAULTS })
  const setField = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const buildOpts = () => {
    const o = {
      reslice: sliceChoice === 'real',
      skipAsr: !doAsr,
      mode: (trainS1 || trainS2) ? 'full' : 'safe',
    }
    // Only send explicit per-model flags once we know a model is missing, so the
    // safe-mode deferral path (no modal) keeps its "confirm before training" behavior.
    if (state && !state.M) { o.trainS1 = trainS1; o.trainS2 = trainS2 }
    return o
  }

  // Assemble customParams shaped for the training pipeline. Only include the
  // sections whose stage actually runs, so we never override unrelated defaults.
  const buildParams = (stages) => {
    const params = {}
    const steps = {}
    if (stages.includes('slice') && sliceChoice === 'real') {
      steps.slice = { params: buildSliceParams(form) }
    }
    if (stages.includes('asr')) {
      steps.asr = { params: buildAsrParams(form) }
    }
    if (Object.keys(steps).length) params.steps = steps
    if (stages.includes('train_s1') || stages.includes('train_s2')) {
      params.training = buildTrainingParams(form)
    }
    return params
  }

  // Re-plan (dry run) whenever the intent options change so the preview stays truthful.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(null)
    api(`/api/assets/${id}/rebuild`, { method: 'POST', body: { execute: false, ...buildOpts() } })
      .then(r => {
        if (cancelled) return
        const data = r.data || {}
        setState(data.state || null)
        setPlan(data)
        if (!r.ok) setErr(data.error || 'Failed to plan rebuild')
        // Seed choices once from the backend's default shortest path.
        if (!seeded.current && data.state) {
          seeded.current = true
          if (!data.state.S) setSliceChoice(data.slice_mode === 'slice' ? 'real' : 'noslice')
          // Missing weights → arm retrain of ONLY the missing model(s) so the plan
          // shows the shortest path (reuse existing slices/ASR, train what's absent).
          if (data.state.Mg === false) setTrainS1(true)
          if (data.state.Ms === false) setTrainS2(true)
        }
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sliceChoice, doAsr, trainS1, trainS2])

  const submit = async () => {
    setSubmitting(true); setErr(null)
    try {
      const params = buildParams(plan?.stages || [])
      const r = await api(`/api/assets/${id}/rebuild`, {
        method: 'POST',
        body: { execute: true, ...buildOpts(), params },
      })
      if (r.ok) { onStarted(id, r.data); onClose() }
      else setErr(r.data?.error || 'Rebuild failed')
    } catch (e) { setErr(e.message) }
    finally { setSubmitting(false) }
  }

  const stages = plan?.stages || []
  const asrInPlan = stages.includes('asr')
  const asrForced = asrInPlan && !doAsr // backend forced it despite the toggle (e.g. retrain)
  const trainInPlan = stages.includes('train_s1') || stages.includes('train_s2')
  const realSliceInPlan = stages.includes('slice') && sliceChoice === 'real'
  const hasWork = stages.length > 0 || plan?.needs_segments
  const isNoop = !!plan?.noop

  const planLabel = loading ? 'Computing…'
    : isNoop ? 'Already complete — nothing to rebuild.'
    : stages.length ? stages.join('  →  ')
    : plan?.needs_segments ? 'generateSegments'
    : 'No steps for the selected options.'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card restore-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">
          <div>
            <div className="modal-title">Restore Asset</div>
            <div className="modal-subtitle">{displayName || id}</div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={submitting}>✕</button>
        </div>

        <p className="modal-desc">
          Choose how to rebuild the missing artifacts. The shortest safe path is preselected;
          existing models are always kept unless you opt into retraining.
        </p>

        {/* Current asset state */}
        {state && (
          <div className="asset-state-row">
            {[['R', 'Raw'], ['S', 'Slices'], ['L', 'Transcript'], ['Seg', 'Segments'], ['Mg', 'GPT'], ['Ms', 'SoVITS']].map(([k, label]) => (
              <span key={k} className={`state-pip ${state[k] ? 'on' : 'off'}`}>
                <span className="state-pip-sym">{state[k] ? '✓' : '–'}</span>{label}
              </span>
            ))}
          </div>
        )}

        {/* Slicing choice — only meaningful when slices are missing */}
        {state && !state.S && state.R && (
          <div className="restore-group">
            <div className="restore-group-title">Slicing</div>
            <label className="radio-row">
              <input type="radio" name="slice" checked={sliceChoice === 'noslice'} onChange={() => setSliceChoice('noslice')} />
              <span>Use raw as reference audio <span className="hint">— fastest, no slicing; ASR writes raw_opt.list</span></span>
            </label>
            <label className="radio-row">
              <input type="radio" name="slice" checked={sliceChoice === 'real'} onChange={() => setSliceChoice('real')} />
              <span>Re-slice raw into clips <span className="hint">— cleaner cuts, slower; forces re-transcribe</span></span>
            </label>

            {/* Slice parameters — only when real slicing is selected */}
            {realSliceInPlan && (
              <div className="collapsible" style={{ marginTop: 10 }}>
                <div className="collapsible-hdr" onClick={() => setShowSliceParams(v => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Slice Parameters</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showSliceParams ? '▲' : '▼'}</span>
                </div>
                {showSliceParams && (
                  <div className="collapsible-body" style={{ padding: 12 }}>
                    <SliceParamFields form={form} setField={setField} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ASR choice */}
        {state && (!state.L || !state.S) && (
          <div className="restore-group">
            <div className="restore-group-title">Transcribe (ASR)</div>
            <label className="toggle-row">
              <input type="checkbox" checked={doAsr || asrForced} disabled={asrForced} onChange={e => setDoAsr(e.target.checked)} />
              <span>
                Run ASR to (re)generate the transcript &amp; segments
                {asrForced && <span className="hint"> — required for the selected options</span>}
                {!doAsr && !asrForced && <span className="hint-warn"> — skipped: reference-text-free</span>}
              </span>
            </label>

            {/* ASR parameters — only when ASR actually runs */}
            {asrInPlan && (
              <div className="collapsible" style={{ marginTop: 10 }}>
                <div className="collapsible-hdr" onClick={() => setShowAsrParams(v => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>ASR Parameters</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showAsrParams ? '▲' : '▼'}</span>
                </div>
                {showAsrParams && (
                  <div className="collapsible-body" style={{ padding: 12 }}>
                    <AsrParamFields form={form} setField={setField} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Retrain choice + training parameters — only when a weight is missing.
            S1 (GPT) and S2 (SoVITS) are independent steps, so each can be retrained
            on its own; the missing one is preselected. */}
        {state && !state.M && (
          <div className="restore-group">
            <div className="restore-group-title">Models</div>
            <label className="toggle-row">
              <input type="checkbox" checked={trainS1} onChange={e => setTrainS1(e.target.checked)} />
              <span>
                Train S1 (GPT)
                {state.Mg === false
                  ? <span className="hint-warn"> — missing</span>
                  : <span className="hint"> — already present, retrain to overwrite</span>}
              </span>
            </label>
            <label className="toggle-row">
              <input type="checkbox" checked={trainS2} onChange={e => setTrainS2(e.target.checked)} />
              <span>
                Train S2 (SoVITS)
                {state.Ms === false
                  ? <span className="hint-warn"> — missing</span>
                  : <span className="hint"> — already present, retrain to overwrite</span>}
              </span>
            </label>

            {trainInPlan && (
              <div className="collapsible" style={{ marginTop: 10 }}>
                <div className="collapsible-hdr" onClick={() => setShowTrainParams(v => !v)}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Training Parameters</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showTrainParams ? '▲' : '▼'}</span>
                </div>
                {showTrainParams && (
                  <div className="collapsible-body" style={{ padding: 12 }}>
                    <TrainParamFields form={form} setField={setField}
                      part={trainS1 && trainS2 ? 'both' : trainS1 ? 's1' : 's2'} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Plan preview */}
        <div className="plan-preview">
          <div className="plan-preview-label">PLAN</div>
          <div className={`plan-preview-body ${loading ? 'muted' : ''}`}>{planLabel}</div>
          {(plan?.warnings || []).map((w, i) => (
            <div key={i} className="plan-warn">⚠ {w}</div>
          ))}
        </div>

        {err && <div className="msg msg-error" style={{ marginBottom: 10 }}>{err}</div>}

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-sm btn-primary" onClick={submit} disabled={submitting || loading || !hasWork || isNoop}>
            {submitting ? 'Starting…' : (trainInPlan ? 'Rebuild & Train' : 'Restore')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================
//  ASSETS TAB
// ============================
function AssetsTab({ voices, selectedVoice, setSelectedVoice, setPage, loadVoices, setTrainPrefill, rebuildTask, setRebuildTask }) {
  const [assets, setAssets] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [segments, setSegments] = useState({})
  const [segmentsLoading, setSegmentsLoading] = useState({})
  const [deleteConfirm, setDeleteConfirm] = useState(null) // { id, displayName }
  const [deleting, setDeleting] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState(null) // { id, displayName }
  const rebuildPollRef = useRef(null)
  // Live lightweight-pipeline progress for an in-flight Rebuild/Restore, so the
  // user can see which step (preprocess → S1/S2 → finalize → publish) is running
  // and read a clear error if one fails — instead of just listening to the fan.
  const [rebuildJob, setRebuildJob] = useState(null) // { id, phase, currentStep, steps, error, failedStep, stages }
  // In-place ASR ("generate reference text") jobs, keyed by asset id. Advisory-only
  // recovery: transcribes the asset's own raw/ and/or slicer_opt/ in place (no promote).
  const [transcribeJobs, setTranscribeJobs] = useState({}) // id -> { status, sources, done, error }
  const [txSource, setTxSource] = useState({}) // id -> 'missing'|'raw'|'slices'|'both'
  const [txOpen, setTxOpen] = useState({}) // id -> bool: show the compact transcribe controls
  const transcribePollRef = useRef({})
  useEffect(() => () => { Object.values(transcribePollRef.current).forEach(t => clearTimeout(t)) }, [])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('All')
  // Naming-note notice: ack persists; `noteOpen` re-expands the collapsed pill.
  const [noteAcked, setNoteAcked] = usePersistentState('assets.namingNoteAck', false)
  const [noteOpen, setNoteOpen] = useState(false)
  const noteExpanded = !noteAcked || noteOpen
  // Inline rename — renames display name AND id/folder together (kept in sync to
  // prevent the display≠id overwrite trap). Guarded server-side.
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  // Rename now changes id + folder too; sync selectedVoice if it was renamed.
  // Assets-directory config (decoupling): current path + picker/migration state.
  const [assetsConfig, setAssetsConfig] = useState(null) // { assetsRoot, assetsRootSource, envOverride, platform }
  const [configBusy, setConfigBusy] = useState(false)
  const [dirInput, setDirInput] = useState('')          // editable path (manual entry)
  const [migrateTarget, setMigrateTarget] = useState(null) // path pending copy/move/switch choice
  // In-app folder browser (reliable cross-platform replacement for a native dialog,
  // which cannot be launched reliably from the headless server process).
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseData, setBrowseData] = useState(null)    // { path, parent, isDriveList, drives, dirs }
  const [browseBusy, setBrowseBusy] = useState(false)
  const [browseError, setBrowseError] = useState(null)
  // Background copy/move progress (copy → verify → delete pipeline).
  const [migrateJob, setMigrateJob] = useState(null)
  const migratePollRef = useRef(null)
  useEffect(() => () => { if (migratePollRef.current) clearInterval(migratePollRef.current) }, [])

  const loadAssets = useCallback(() => {
    api('/api/assets').then(r => {
      if (r.ok) setAssets(r.data.assets || {})
    }).catch(() => {})
  }, [])

  useEffect(() => { loadAssets() }, [loadAssets])
  useEffect(() => {
    api('/api/config').then(r => { if (r.ok) { setAssetsConfig(r.data); setDirInput(r.data.assetsRoot || '') } }).catch(() => {})
  }, [])

  const startRename = (id, current) => { setRenamingId(id); setRenameValue(current || id) }
  const cancelRename = () => { setRenamingId(null); setRenameValue('') }
  const commitRename = async (id) => {
    const name = renameValue.trim()
    if (!name) { cancelRename(); return }
    setRenameBusy(true); setScanMsg(null)
    try {
      const r = await api(`/api/assets/${id}/rename`, { method: 'PATCH', body: { display_name: name } })
      if (r.ok) {
        // id/folder may have changed — reload the full list rather than patching.
        loadAssets()
        if (loadVoices) loadVoices()
        if (r.data.idChanged && setSelectedVoice && selectedVoice === id) setSelectedVoice(r.data.id)
        setScanMsg({ type: 'success', text: r.data.idChanged ? `Renamed to "${name}" (id: ${r.data.id}).` : `Renamed to "${name}".` })
        setTimeout(() => setScanMsg(null), 4000)
        cancelRename()
      } else {
        setScanMsg({ type: 'error', text: r.data?.error || 'Rename failed' })
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message })
    } finally { setRenameBusy(false) }
  }

  // A candidate directory was chosen (via picker or manual entry). Decide whether
  // we need to ask about migrating existing data, or can switch directly.
  const requestChangeDir = (p) => {
    const next = (p || '').trim()
    if (!next) return
    if (assetsConfig && next === assetsConfig.assetsRoot) {
      setScanMsg({ type: 'info', text: 'That is already the current assets directory.' }); return
    }
    if (Object.keys(assets).length > 0) {
      setMigrateTarget(next) // non-empty → ask copy/move/switch/cancel
    } else {
      applyAssetsDir(next, 'switch')
    }
  }

  // Load a directory listing into the in-app browser. path==='' asks the server
  // for the drive list (Windows) or filesystem root (POSIX).
  const browseTo = async (p) => {
    setBrowseBusy(true); setBrowseError(null)
    try {
      const r = await api(`/api/fs/browse?path=${encodeURIComponent(p || '')}`)
      if (r.ok) setBrowseData(r.data)
      else setBrowseError(r.data?.error || 'Could not open that folder')
    } catch (e) {
      setBrowseError(e.message)
    } finally { setBrowseBusy(false) }
  }

  const pickAssetsDir = () => {
    setBrowseOpen(true)
    setBrowseError(null)
    browseTo(dirInput || assetsConfig?.assetsRoot || '')
  }

  const chooseBrowsedFolder = () => {
    const chosen = browseData?.path
    if (!chosen) return
    setBrowseOpen(false)
    setDirInput(chosen)
    requestChangeDir(chosen)
  }

  const mkdirThenOpen = async (targetPath) => {
    setBrowseBusy(true); setBrowseError(null)
    try {
      const r = await api('/api/fs/mkdir', { method: 'POST', body: { path: targetPath } })
      if (r.ok) { await browseTo(r.data.path) }
      else { setBrowseError(r.data?.error || 'Could not create folder'); setBrowseBusy(false) }
    } catch (e) {
      setBrowseError(e.message); setBrowseBusy(false)
    }
  }

  // Prompt for a name and create a sub-folder under the currently listed directory.
  const createSubfolder = () => {
    const cur = browseData?.path || ''
    if (!cur) { setBrowseError('Open a drive or folder first.'); return }
    const name = (typeof window !== 'undefined' ? window.prompt('New folder name:', 'assets') : '')
    const clean = (name || '').trim()
    if (!clean) return
    const sep = /\\/.test(cur) ? '\\' : '/'
    mkdirThenOpen(cur.replace(/[\\/]+$/, '') + sep + clean)
  }

  const applyAssetsDir = async (p, migration) => {
    setConfigBusy(true); setScanMsg(null)
    try {
      const r = await api('/api/config/assets-root', { method: 'POST', body: { path: p, migration } })
      if (!r.ok) {
        setScanMsg({ type: 'error', text: r.data?.error || 'Failed to save assets directory' })
        setConfigBusy(false); setMigrateTarget(null); return
      }
      if (r.data.async && r.data.jobId) {
        // copy/move runs in the background → show the progress pipeline and poll.
        setMigrateTarget(null)
        setMigrateJob({ jobId: r.data.jobId, migration: r.data.migration, total: r.data.total || 0,
          phase: 'copying', current: 0, currentName: '', steps: { copy: 'running', verify: 'pending', delete: 'pending' }, done: false, error: null })
        pollMigration(r.data.jobId)
      } else {
        // instant switch
        setAssetsConfig(cfg => ({ ...(cfg || {}), assetsRoot: r.data.assetsRoot, pendingRestart: true }))
        setDirInput(r.data.assetsRoot)
        setScanMsg({ type: r.data.envOverride ? 'warning' : 'success', text: r.data.note || 'Saved. Restart to apply.' })
        setMigrateTarget(null)
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message }); setMigrateTarget(null)
    } finally { setConfigBusy(false) }
  }

  const pollMigration = (jobId) => {
    if (migratePollRef.current) clearInterval(migratePollRef.current)
    migratePollRef.current = setInterval(async () => {
      try {
        const r = await api(`/api/config/migrate-status/${jobId}`)
        if (!r.ok) {
          clearInterval(migratePollRef.current); migratePollRef.current = null
          setMigrateJob(j => j ? { ...j, done: true, error: r.data?.error || 'Migration job is no longer available (server may have restarted).', phase: 'error' } : j)
          return
        }
        setMigrateJob(r.data)
        if (r.data.done) {
          clearInterval(migratePollRef.current); migratePollRef.current = null
          if (!r.data.error) {
            setAssetsConfig(cfg => ({ ...(cfg || {}), assetsRoot: r.data.assetsRoot, pendingRestart: true }))
            setDirInput(r.data.assetsRoot)
            setScanMsg({ type: r.data.envOverride ? 'warning' : 'success', text: r.data.note || 'Saved. Restart to apply.' })
          }
        }
      } catch (e) {
        clearInterval(migratePollRef.current); migratePollRef.current = null
        setMigrateJob(j => j ? { ...j, done: true, error: e.message, phase: 'error' } : j)
      }
    }, 700)
  }

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

  // In-place "generate reference text": run the shared ASR kernel over the asset's
  // own audio (raw and/or slices) and rescan — no promote, no training. Polls the
  // -status endpoint until done, then refreshes the asset so segments/text appear.
  const pollTranscribe = (id) => {
    const tick = async () => {
      try {
        const r = await api(`/api/assets/${id}/transcribe-status`)
        const job = r.data || {}
        setTranscribeJobs(prev => ({ ...prev, [id]: job }))
        if (job.status === 'running') {
          transcribePollRef.current[id] = setTimeout(tick, 2000)
        } else {
          delete transcribePollRef.current[id]
          if (job.status === 'done') {
            setScanMsg({ type: 'success', text: `Reference text generated for ${id} (${(job.done || []).join(', ')})` })
            loadAssets()
            // Invalidate the cached segments so a re-expand refetches the new text.
            setSegments(s => { const n = { ...s }; delete n[id]; return n })
            if (expandedId === id) {
              try {
                const sr = await api(`/api/assets/${id}/segments`)
                if (sr.ok) setSegments(s => ({ ...s, [id]: sr.data.segments }))
              } catch (_) {}
            }
          } else if (job.status === 'cancelled') {
            setScanMsg({ type: 'info', text: `Transcription cancelled for ${id}` })
          } else if (job.status === 'error') {
            setScanMsg({ type: 'error', text: `Transcription failed: ${job.error || 'unknown error'}` })
          }
          setTimeout(() => setScanMsg(null), 5000)
        }
      } catch (e) {
        delete transcribePollRef.current[id]
        setScanMsg({ type: 'error', text: e.message })
      }
    }
    transcribePollRef.current[id] = setTimeout(tick, 1000)
  }

  const handleTranscribe = async (id, source) => {
    setScanMsg(null)
    try {
      const r = await api(`/api/assets/${id}/transcribe`, { method: 'POST', body: { source } })
      if (r.ok && r.data?.started) {
        setTranscribeJobs(prev => ({ ...prev, [id]: { status: 'running', sources: r.data.sources || [], done: [] } }))
        setScanMsg({ type: 'info', text: `Transcribing ${id} (${(r.data.sources || []).join(', ')})…` })
        pollTranscribe(id)
      } else {
        setScanMsg({ type: 'error', text: r.data?.error || 'Could not start transcription' })
        setTimeout(() => setScanMsg(null), 5000)
      }
    } catch (e) {
      setScanMsg({ type: 'error', text: e.message })
    }
  }

  const handleCancelTranscribe = async (id) => {
    try { await api(`/api/assets/${id}/transcribe`, { method: 'DELETE' }) } catch (_) {}
  }

  // Rebuild = hand off to the Train tab with the input folder + voice name
  // prefilled (raw preferred, else the slices folder). Pure front-end: the user
  // confirms and starts training. Re-slicing / model rebuild happen in the
  // existing pipeline; no new backend endpoint is used.
  const handleRebuild = (id, asset) => {
    const a = asset.assets || {}
    const inputDir = a.raw?.dir || a.slices?.dir || ''
    if (setTrainPrefill) setTrainPrefill({ inputDir, voiceName: id })
    setPage('train')
  }

  // Poll a rebuild pipeline task to completion, then auto-rescan ALL assets so
  // the restored voice becomes usable without a manual "Scan All". The rebuild
  // pipeline (slice/asr/finalize/promote) runs server-side; we watch its status.
  const pollRebuild = (id, taskId, stages) => {
    if (rebuildPollRef.current) { clearTimeout(rebuildPollRef.current); rebuildPollRef.current = null }
    let tries = 0
    const tick = async () => {
      tries += 1
      try {
        const r = await api(`/api/train/status/${taskId}`)
        if (r.ok && r.data) {
          const st = r.data.status
          const steps = r.data.steps || {}
          setRebuildJob(prev => ({
            ...(prev || {}), id, taskId, stages,
            phase: 'running', status: st, currentStep: r.data.currentStep, steps,
          }))
          if (st === 'completed') {
            setRebuildJob(prev => ({ ...(prev || {}), id, steps, phase: 'scanning', status: st }))
            await handleScan() // full re-scan (Scan All) so the asset is immediately usable
            setRebuildJob(prev => ({ ...(prev || {}), id, steps, phase: 'done', status: st }))
            if (setRebuildTask) setRebuildTask(null) // finished — stop persisting/resuming
            setTimeout(() => setRebuildJob(cur => (cur && cur.id === id && cur.phase === 'done') ? null : cur), 6000)
            return
          }
          if (['failed', 'cancelled', 'interrupted'].includes(st)) {
            // Surface the exact failing step + its error so the user knows what broke.
            let failedStep = r.data.currentStep, error = ''
            for (const [k, v] of Object.entries(steps)) {
              if (v && v.status === 'failed') { failedStep = k; error = v.error || ''; break }
            }
            setRebuildJob(prev => ({
              ...(prev || {}), id, taskId, stages, steps, phase: 'failed', status: st, failedStep,
              error: error || `Rebuild ${st} (no error detail reported).`,
            }))
            // Keep the failure visible AND persisted across navigation until the
            // user dismisses it (so they don't miss a failed repair).
            return
          }
        } else if (!r.ok && (r.status === 404 || r.status === 400)) {
          // Task no longer known to the server (e.g. process restarted) — stop.
          setRebuildJob(prev => (prev && prev.id === id) ? { ...prev, phase: 'failed', error: 'Rebuild task is no longer available on the server (it may have been restarted). Re-run the rebuild.', failedStep: prev.currentStep } : prev)
          return
        }
      } catch (_) { /* transient — keep polling */ }
      if (tries < 1800) rebuildPollRef.current = setTimeout(tick, 2000)
    }
    rebuildPollRef.current = setTimeout(tick, 1200)
  }

  useEffect(() => () => { if (rebuildPollRef.current) clearTimeout(rebuildPollRef.current) }, [])

  // Resume an in-flight rebuild after navigating back to Assets (or a reload):
  // the pipeline keeps running server-side; we just re-attach the progress panel.
  useEffect(() => {
    if (rebuildTask && rebuildTask.taskId && !rebuildPollRef.current) {
      setRebuildJob({ id: rebuildTask.id, taskId: rebuildTask.taskId, stages: rebuildTask.stages || [], phase: 'running', status: 'pending', currentStep: null, steps: {}, error: null })
      pollRebuild(rebuildTask.id, rebuildTask.taskId, rebuildTask.stages || [])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dismiss a finished/failed rebuild panel and stop persisting it.
  const dismissRebuild = () => { setRebuildJob(null); if (setRebuildTask) setRebuildTask(null) }

  // Called when the Restore modal kicks off a rebuild. A pipeline-backed rebuild
  // returns a taskId (poll it); a lightweight segments-only rebuild is synchronous.
  const handleRebuildStarted = (id, data) => {
    if (data && data.taskId) {
      if (setRebuildTask) setRebuildTask({ id, taskId: data.taskId, stages: data.stages || [] }) // persist for resume
      setRebuildJob({ id, taskId: data.taskId, stages: data.stages || [], phase: 'running', status: 'pending', currentStep: null, steps: {}, error: null })
      pollRebuild(id, data.taskId, data.stages || [])
    } else {
      // Lightweight (segments-only) rebuild is synchronous server-side — just rescan.
      setScanMsg({ type: 'info', text: `Restored ${id} — scanning…` })
      handleScan()
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
      // Refresh the global voice registry immediately so the Generate page
      // dropdown drops the deleted voice without waiting for the re-scan.
      if (loadVoices) loadVoices()
      setScanMsg({ type: 'success', text: `Deleted ${id}. Re-scanning...` })
      // Auto re-scan after delete
      setTimeout(async () => {
        try {
          const r = await api('/api/assets/scan', { method: 'POST' })
          if (r.ok) {
            setAssets(r.data.assets || {})
            if (loadVoices) loadVoices()
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

  // Summary totals (Phase 1, Part 6) — derived entirely from existing /api/assets data
  const totals = assetEntries.reduce((acc, [, asset]) => {
    const a = asset.assets || {}
    acc.voices += 1
    acc.raw += (a.raw?.file_count || 0)
    acc.rawDur += (a.raw?.total_duration || 0)
    acc.slices += (a.slices?.file_count || 0)
    acc.gpt += (a.checkpoints?.gpt || []).length
    acc.sovits += (a.checkpoints?.sovits || []).length
    acc.segments += (asset.segment_total || 0)
    return acc
  }, { voices: 0, raw: 0, rawDur: 0, slices: 0, gpt: 0, sovits: 0, segments: 0 })

  // Derive a health badge for a voice from its available assets.
  // Color-blind friendly: every state carries a distinct shape glyph (sym),
  // so states stay distinguishable without relying on color alone.
  const voiceHealth = (asset) => {
    const a = asset.assets || {}
    const hasGpt = (a.checkpoints?.gpt || []).length > 0
    const hasSovits = (a.checkpoints?.sovits || []).length > 0
    const hasRaw = (a.raw?.file_count || 0) > 0
    const hasSlices = (a.slices?.file_count || 0) > 0
    const hasSegs = (asset.segment_total || 0) > 0
    const scanned = hasGpt || hasSovits || hasRaw || hasSlices || hasSegs
    if (!scanned) return { key: 'needscan', label: 'Needs Scan', cls: 'badge-muted', sym: '○' }
    if (!hasGpt || !hasSovits) {
      const which = (!hasGpt && !hasSovits) ? 'Models' : (!hasGpt ? 'GPT' : 'SoVITS')
      return { key: 'nomodel', label: `Missing ${which}`, cls: 'badge-danger', sym: '✕' }
    }
    if (!hasSegs) {
      if (!hasRaw && !hasSlices) {
        return { key: 'norefs', label: 'No Refs', cls: 'badge-danger2', sym: '■',
                 note: 'No raw / slices / segments — re-import audio to rebuild.' }
      }
      if (hasSlices) {
        // Slices still present → segments can be regenerated cheaply (no re-slice).
        return { key: 'noseg', label: 'No Segments', cls: 'badge-seg', sym: '▲',
                 note: 'Slices present — rebuild segments.json from them (no re-slicing, no training).' }
      }
      // Models present (passed the model check above) + raw, but slices/segments gone.
      // Still usable: raw works as reference audio. Restore text refs via ASR (no retrain).
      return { key: 'rawrefs', label: 'Raw Refs', cls: 'badge-ok2', sym: '◑',
               note: 'Usable now — raw serves as reference audio. Run ASR to restore text refs (no re-slicing, no retraining).' }
    }
    if (!hasRaw) return { key: 'ready', label: 'Ready', cls: 'badge-ok2', sym: '◐',
                          note: 'Models + segments present; raw removed (still usable).' }
    return { key: 'complete', label: 'Complete', cls: 'badge-ok', sym: '●' }
  }

  // Search + filter (Part 6) — all derived from existing /api/assets data
  const healthCounts = assetEntries.reduce((acc, [, asset]) => {
    const l = voiceHealth(asset).label
    acc[l] = (acc[l] || 0) + 1
    return acc
  }, {})
  // Text Issues is an orthogonal axis (reference-text health, not model/segment health):
  // an asset that can be transcribed but has no usable text (none) or stale/broken
  // paths (invalid). Surfaced as its own chip so warnings live in the filter row
  // instead of a resident per-card banner.
  const hasTextIssue = (asset) => {
    const canTx = (asset.raw?.file_count || 0) > 0 || (asset.slices?.file_count || 0) > 0
    const st = asset.reference_text?.state
    return canTx && (st === 'none' || st === 'invalid')
  }
  const textIssueCount = assetEntries.reduce((n, [, a]) => n + (hasTextIssue(a) ? 1 : 0), 0)
  // Keep a stable filter order; only show chips for states that actually occur
  const FILTER_ORDER = ['Complete', 'Ready', 'Raw Refs', 'No Segments', 'Missing Models', 'Missing GPT', 'Missing SoVITS', 'No Refs', 'Needs Scan']
  const filterChips = ['All', ...FILTER_ORDER.filter(l => healthCounts[l]), ...(textIssueCount ? ['Text Issues'] : [])]
  const q = search.trim().toLowerCase()
  const filteredEntries = assetEntries.filter(([id, asset]) => {
    if (filter === 'Text Issues') { if (!hasTextIssue(asset)) return false }
    else if (filter !== 'All' && voiceHealth(asset).label !== filter) return false
    if (q && !((asset.display_name || id).toLowerCase().includes(q) || id.toLowerCase().includes(q))) return false
    return true
  })

  return (
    <div className="section">
      <div className="section-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Voice Assets</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {assetsConfig && (
            <div className="assets-dir" title={`Assets directory (${assetsConfig.assetsRootSource})${assetsConfig.envOverride ? ' — set by ASSETS_ROOT env var' : ''}`}>
              <input
                className="assets-dir-input"
                value={dirInput}
                placeholder="Assets directory path…"
                disabled={configBusy || assetsConfig.envOverride}
                onChange={e => setDirInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') requestChangeDir(dirInput) }}
                title={assetsConfig.envOverride ? 'Locked by ASSETS_ROOT env var' : 'Type or paste an absolute path, then Enter / Change'}
              />
              <button
                className="btn-icon assets-dir-pick"
                title="Browse for an assets directory…"
                disabled={configBusy || assetsConfig.envOverride}
                onClick={pickAssetsDir}
              >
                <IconFolder size={15} color="var(--muted)" />
              </button>
              <button
                className="btn btn-sm"
                disabled={configBusy || assetsConfig.envOverride || !dirInput.trim() || dirInput.trim() === assetsConfig.assetsRoot}
                onClick={() => requestChangeDir(dirInput)}
              >{configBusy ? '…' : 'Change'}</button>
              {assetsConfig.pendingRestart && <span className="assets-dir-flag" title="Restart the server to apply">restart</span>}
            </div>
          )}
          <button className="btn btn-sm" onClick={loadAssets} disabled={scanning}>Refresh</button>
          <button className="btn btn-sm btn-primary" onClick={handleScan} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Scan All'}
          </button>
        </div>
      </div>
      <div className="section-body">
        {scanMsg && <div className={`msg msg-${scanMsg.type}`} style={{ marginBottom: 10 }}>{scanMsg.text}</div>}
        {noteExpanded && (
          <NamingNoteCard
            acked={noteAcked}
            onAck={() => { setNoteAcked(true); setNoteOpen(false) }}
            onCollapse={() => setNoteOpen(false)}
          />
        )}
        {/* Collapsed pill with no summary bar to tuck into (empty asset list) */}
        {!noteExpanded && assetEntries.length === 0 && (
          <NamingNotePill onOpen={() => setNoteOpen(true)} />
        )}
        <RebuildProgress job={rebuildJob} onDismiss={dismissRebuild} />
        {assetEntries.length > 0 && (
          <div className="summary-bar">
            <span className="stat-pill"><span className="sp-v">{totals.voices}</span><span className="sp-k">voices</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.raw}</span><span className="sp-k">raw files</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.rawDur.toFixed(1)}s</span><span className="sp-k">raw dur</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.slices}</span><span className="sp-k">slices</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.gpt}</span><span className="sp-k">GPT ckpts</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.sovits}</span><span className="sp-k">SoVITS ckpts</span></span>
            <span className="stat-pill"><span className="sp-v">{totals.segments}</span><span className="sp-k">segments</span></span>
            {/* Collapsed hint floats to the free space right of the stat pills */}
            {!noteExpanded && <NamingNotePill className="nn-in-bar" onOpen={() => setNoteOpen(true)} />}
          </div>
        )}
        {assetEntries.length > 0 && (
          <div className="assets-toolbar">
            <input
              className="control assets-search"
              type="text"
              placeholder="Search by voice name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <div className="filter-chips">
              {filterChips.map(f => {
                const count = f === 'Text Issues' ? textIssueCount : healthCounts[f]
                const warn = f === 'Text Issues'
                return (
                  <button
                    key={f}
                    className={`chip ${warn ? 'chip-warn' : ''} ${filter === f ? 'chip-on' : ''}`}
                    onClick={() => setFilter(f)}
                  >
                    {f}{f !== 'All' && count ? ` (${count})` : ''}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {assetEntries.length > 0 && filteredEntries.length === 0 && (
          <div className="msg" style={{ marginBottom: 10 }}>
            No voices match {q ? `“${search.trim()}”` : 'this filter'}.
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => { setSearch(''); setFilter('All') }}>Clear</button>
          </div>
        )}
        {assetEntries.length === 0 && (
          <div className="empty-state">
            <div className="es-title">No voice assets yet</div>
            <div className="es-sub">Scan your assets directory to detect voices, or fine-tune a new voice to get started.</div>
            <div className="empty-actions">
              <button className="btn btn-sm btn-primary" onClick={handleScan} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan Dataset'}</button>
              <button className="btn btn-sm" onClick={() => setPage('train')}>Start Tuning</button>
            </div>
          </div>
        )}
        {filteredEntries.map(([id, asset]) => {
          const a = asset.assets || {}
          const raw = a.raw || {}
          const slices = a.slices || {}
          const ckpts = a.checkpoints || {}
          const gptCount = (ckpts.gpt || []).length
          const sovitsCount = (ckpts.sovits || []).length
          const segCount = asset.segment_total || 0
          const h = voiceHealth(asset)
          const canRebuild = (raw.file_count || 0) > 0 || (slices.file_count || 0) > 0
          // Restore via the dependency planner (shortest path). Both "Raw Refs" and
          // "Missing Models" open the same modal: the planner reuses existing slices
          // and ASR, so e.g. a missing-model voice that still has slices+list only
          // runs preprocess+train — it never re-slices or re-transcribes.
          const showRestore = h.key === 'rawrefs' || h.key === 'nomodel'
          // No Refs is a dead end (no raw/slices); keep the Train-tab fallback so the
          // user can re-import. No Segments is fixed by Scan alone (no training).
          const showRebuild = h.key === 'norefs'
          const isExpanded = expandedId === id
          const segData = segments[id]
          const isLoadingSegs = segmentsLoading[id]

          return (
            <div key={id} className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {renamingId === id ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <input
                          className="control"
                          style={{ fontSize: 13, padding: '3px 8px', width: 200 }}
                          value={renameValue}
                          autoFocus
                          disabled={renameBusy}
                          onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') commitRename(id); if (e.key === 'Escape') cancelRename() }}
                        />
                        <button className="btn btn-sm btn-primary" disabled={renameBusy} onClick={() => commitRename(id)}>{renameBusy ? '…' : 'Save'}</button>
                        <button className="btn btn-sm btn-ghost" disabled={renameBusy} onClick={cancelRename}>Cancel</button>
                      </span>
                    ) : (
                      <>
                        {asset.display_name || id}
                        <button
                          className="btn-icon"
                          title="Rename (updates display name and id/folder)"
                          onClick={() => startRename(id, asset.display_name || id)}
                          style={{ display: 'inline-flex', alignItems: 'center' }}
                        >
                          <IconPencil size={13} color="var(--muted)" />
                        </button>
                        <span className={`badge ${h.cls}`} title={h.note || ''}>
                          <span className="badge-sym">{h.sym}</span>{h.label}
                        </span>
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    Mode: {asset.mode || 'N/A'} &middot; ID: {id}
                  </div>
                </div>
                <div className="asset-actions">
                  {/* Secondary actions */}
                  <div className="aa-group">
                    <button className="btn btn-sm btn-ghost" onClick={() => handleBrowse(id)}>
                      {isExpanded ? 'Collapse' : 'Browse'}
                    </button>
                    {showRestore ? (
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => setRestoreTarget({ id, displayName: asset.display_name || id })}
                        disabled={scanning}
                        title={h.key === 'nomodel'
                          ? 'Rebuild the missing model. Existing slices and transcripts are reused — only preprocess+train run (no re-slicing, no re-ASR).'
                          : 'Choose how to restore: use raw as reference clips or re-slice, transcribe or not — models are kept unless you opt into retraining.'}
                      >
                        {h.key === 'nomodel' ? 'Rebuild…' : 'Restore…'}
                      </button>
                    ) : (
                      <button
                        className={`btn btn-sm ${h.key === 'noseg' ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => handleScanOne(id)}
                        disabled={scanning}
                        title={h.key === 'noseg'
                          ? 'Rebuild segments.json from existing slices — no re-training'
                          : 'Re-scan this voice and refresh its assets'}
                      >
                        {h.key === 'noseg' ? 'Rebuild Segments' : 'Scan'}
                      </button>
                    )}
                    {showRebuild && (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => canRebuild && handleRebuild(id, asset)}
                        disabled={!canRebuild}
                        title={canRebuild
                          ? 'Re-train from existing raw / slices (opens Train with values prefilled)'
                          : 'No raw or slices to rebuild from — re-import audio first'}
                      >
                        Rebuild
                      </button>
                    )}
                    <button className="btn btn-sm btn-ghost" onClick={() => handleOpenExplorer(id)} title="Open in Explorer" style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px' }}>
                      <IconFolderSearch size={14} color="var(--muted)" />
                    </button>
                  </div>
                  {/* Danger action */}
                  <button className="btn btn-sm btn-ghost aa-danger" onClick={() => handleDeleteRequest(id, asset.display_name || id)} title="Delete Asset" style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px' }}>
                    <IconTrash size={14} color="var(--danger)" />
                  </button>
                  {/* Primary action */}
                  <button className="btn btn-sm btn-primary" onClick={() => handleSetAsVoice(id)}>
                    Set as Voice
                  </button>
                </div>
              </div>
              {(() => {
                // Reference-text status as a COMPACT pill in the stats row (no extra
                // full-width row → cards stay short). Clicking it reveals the in-place
                // transcribe controls on demand. Advisory-only: inference works without
                // text; a real content check (not mere file existence) drives the state.
                const rt = asset.reference_text || {}
                const hasRawAudio = (raw.file_count || 0) > 0
                const hasSliceAudio = (slices.file_count || 0) > 0
                const canTranscribe = hasRawAudio || hasSliceAudio
                const TEXT_STATE = {
                  both:    { label: 'OK',      cls: 'tp-ok',   sym: '✓' },
                  slices:  { label: 'Slices',  cls: 'tp-warn', sym: '◑' },
                  raw:     { label: 'Raw',     cls: 'tp-warn', sym: '◑' },
                  none:    { label: 'None',    cls: 'tp-none', sym: '–' },
                  invalid: { label: 'Invalid', cls: 'tp-bad',  sym: '!' },
                }
                const ts = TEXT_STATE[rt.state] || TEXT_STATE.none
                // State-derived advisory so the tooltip never lies (backend may omit it).
                const TEXT_ADVICE = {
                  both:    'Reference text present for raw and slices.',
                  slices:  'Reference text present for slices only — raw has none.',
                  raw:     'Reference text present for raw only — slices have none.',
                  none:    'No reference text yet (optional — inference works without it).',
                  invalid: 'Reference list paths are stale/broken. Re-run ASR to overwrite.',
                }
                const advice = rt.advisory || TEXT_ADVICE[rt.state] || TEXT_ADVICE.none
                const tx = transcribeJobs[id]
                const running = tx && tx.status === 'running'
                const open = !!txOpen[id]
                const sel = txSource[id] || 'missing'
                return (
                  <>
                    <div className="asset-stats">
                      <span className="stat-pill"><span className="sp-v">{raw.file_count || 0}</span><span className="sp-k">raw</span></span>
                      <span className="stat-pill"><span className="sp-v">{(raw.total_duration || 0).toFixed(1)}s</span><span className="sp-k">dur</span></span>
                      <span className="stat-pill"><span className="sp-v">{slices.file_count || 0}</span><span className="sp-k">slices</span></span>
                      <span className="stat-pill"><span className="sp-v">{gptCount}</span><span className="sp-k">GPT</span></span>
                      <span className="stat-pill"><span className="sp-v">{sovitsCount}</span><span className="sp-k">SoVITS</span></span>
                      <span className="stat-pill"><span className="sp-v">{segCount}</span><span className="sp-k">segments</span></span>
                      {canTranscribe && (
                        <button
                          type="button"
                          className={`stat-pill text-pill ${ts.cls} ${open ? 'is-open' : ''}`}
                          onClick={() => setTxOpen(s => ({ ...s, [id]: !s[id] }))}
                          title={advice}
                        >
                          <span className="tp-sym">{running ? '…' : ts.sym}</span>
                          <span className="sp-k">text</span>
                          <span className="sp-v">{running ? '…' : ts.label}</span>
                        </button>
                      )}
                    </div>

                    {canTranscribe && open && (
                      <div className="reftext-controls">
                        {rt.state === 'invalid'
                          ? <span className="rtc-msg rtc-warn">⚠ {advice}</span>
                          : <span className="rtc-msg" />}
                        <div className="rtc-actions">
                          <select
                            className="control control-sm"
                            value={sel}
                            disabled={running}
                            onChange={e => setTxSource(s => ({ ...s, [id]: e.target.value }))}
                            title="Choose which audio to transcribe"
                          >
                            <option value="missing">Fill missing</option>
                            {hasRawAudio && <option value="raw">Raw</option>}
                            {hasSliceAudio && <option value="slices">Slices</option>}
                            {hasRawAudio && hasSliceAudio && <option value="both">Both</option>}
                          </select>
                          {running ? (
                            <button className="btn btn-sm btn-ghost" onClick={() => handleCancelTranscribe(id)}>
                              Cancel{(tx.done || []).length ? ` (${tx.done.join(', ')} done)` : ''}
                            </button>
                          ) : (
                            <button
                              className="btn btn-sm btn-primary"
                              onClick={() => handleTranscribe(id, sel)}
                              title="Run ASR over this asset's own audio in place (no publish, no training)"
                            >
                              Generate reference text
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )
              })()}

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
              <span style={{ fontWeight: 600, fontSize: 14 }}>Delete Asset</span>
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

      {/* Restore Asset Modal (dependency-driven repair with user-chosen options) */}
      {restoreTarget && (
        <RestoreModal
          id={restoreTarget.id}
          displayName={restoreTarget.displayName}
          onClose={() => setRestoreTarget(null)}
          onStarted={handleRebuildStarted}
        />
      )}

      {/* Assets-directory migration: current dir is non-empty, ask what to do. */}
      {migrateTarget && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => { if (!configBusy) setMigrateTarget(null) }}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 380, maxWidth: 520,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <IconFolder size={20} color="var(--accent)" />
              <span style={{ fontWeight: 600, fontSize: 14 }}>Change Assets Directory</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
              New directory:
            </p>
            <div style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--bg)', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', marginBottom: 14 }}>
              {migrateTarget}
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
              The current assets directory contains <strong>{Object.keys(assets).length}</strong> voice{Object.keys(assets).length === 1 ? '' : 's'}.
              What should happen to that data? Changes take effect after a server restart.
            </p>
            <div className="migrate-advisory">
              <strong>Recommended:</strong> choose <em>Switch only</em>, then copy the data yourself
              in your file manager and restart. The built-in copy can stall or fail on files that are
              in use (a loaded model, an open Explorer/audio window), and such locks are hard to
              recover from. Use Copy/Move only when you're sure nothing here is open.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-primary" disabled={configBusy} onClick={() => applyAssetsDir(migrateTarget, 'switch')}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
                ➡️ Switch only (recommended) — point at the new directory, migrate the data yourself
              </button>
              <button className="btn" disabled={configBusy} onClick={() => applyAssetsDir(migrateTarget, 'copy')}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
                📋 Copy — duplicate existing voices into the new directory (keep originals)
              </button>
              <button className="btn" disabled={configBusy} onClick={() => applyAssetsDir(migrateTarget, 'move')}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
                ✂️ Move — copy, verify, then delete originals (skips locked files check → may fail)
              </button>
              <button className="btn btn-ghost" disabled={configBusy} onClick={() => setMigrateTarget(null)}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}>
                ✕ Cancel
              </button>
            </div>
            {configBusy && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>Starting…</div>}
          </div>
        </div>
      )}

      {/* Background copy/move progress — simple copy → verify → delete pipeline. */}
      {migrateJob && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => { if (migrateJob.done) setMigrateJob(null) }}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 420, maxWidth: 560,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <IconFolder size={20} color="var(--accent)" />
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                {migrateJob.migration === 'move' ? 'Moving' : 'Copying'} assets
              </span>
            </div>
            <div className="migrate-steps">
              {['copy', ...(migrateJob.migration === 'move' ? ['verify', 'delete'] : [])].map(k => {
                const label = k === 'copy' ? 'Copy' : k === 'verify' ? 'Verify integrity' : 'Delete originals'
                const st = migrateJob.steps?.[k] || 'pending'
                const mark = st === 'done' ? '✓' : st === 'running' ? '⋯' : st === 'failed' ? '✕' : '○'
                return (
                  <div key={k} className={`migrate-step migrate-step-${st}`}>
                    <span className="migrate-step-mark">{mark}</span>
                    <span className="migrate-step-label">{label}</span>
                    {st === 'running' && migrateJob.total > 0 && (
                      <span className="migrate-step-count">{migrateJob.current}/{migrateJob.total}</span>
                    )}
                  </div>
                )
              })}
            </div>
            {!migrateJob.done && migrateJob.currentName && (
              <div className="migrate-current" title={migrateJob.currentName}>
                {migrateJob.phase}: {migrateJob.currentName}
              </div>
            )}
            {migrateJob.done && migrateJob.error && (
              <div className="msg msg-error" style={{ marginTop: 12 }}>
                {migrateJob.error}
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  Nothing was deleted from your current directory. Close anything using these files
                  (loaded models, open Explorer/audio windows) and retry, or use Switch only and copy manually.
                </div>
              </div>
            )}
            {migrateJob.done && !migrateJob.error && (
              <div className="msg msg-success" style={{ marginTop: 12 }}>{migrateJob.note || 'Done. Restart to apply.'}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-sm" disabled={!migrateJob.done} onClick={() => setMigrateJob(null)}>
                {migrateJob.done ? 'Close' : 'Working…'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-app folder browser — pick an assets directory reliably on any OS. */}
      {browseOpen && (
        <div className="fs-browser-overlay" onClick={() => setBrowseOpen(false)}>
          <div className="fs-browser" onClick={e => e.stopPropagation()}>
            <div className="fs-browser-hdr">
              <IconFolder size={18} color="var(--accent)" />
              <span className="fs-browser-title">Choose assets directory</span>
              <button className="btn-icon" title="Close" onClick={() => setBrowseOpen(false)}>✕</button>
            </div>
            <div className="fs-browser-path">
              <button className="btn btn-sm"
                title={browseData?.parent === '' ? 'Back to drive list' : 'Up one level'}
                disabled={browseBusy || browseData?.isDriveList || browseData?.parent == null}
                onClick={() => browseTo(browseData?.parent ?? '')}>
                {browseData?.parent === '' ? '↑ Drives' : '↑ Up'}
              </button>
              <input className="assets-dir-input" style={{ flex: 1 }}
                value={browseData?.isDriveList ? '' : (browseData?.path || '')}
                placeholder={browseData?.isDriveList ? 'Select a drive…' : 'Path…'}
                onChange={e => setBrowseData(d => ({ ...(d || {}), path: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') browseTo(e.target.value) }}
                title="Type a path and press Enter, or double-click a folder below" />
              <button className="btn btn-sm" disabled={browseBusy}
                onClick={() => browseTo(browseData?.path || '')}>Go</button>
              <button className="btn btn-sm" title="Create a new sub-folder here"
                disabled={browseBusy || browseData?.isDriveList || !browseData?.path}
                onClick={createSubfolder}>+ New</button>
            </div>
            <div className="fs-browser-list">
              {browseBusy && <div className="fs-browser-empty">Loading…</div>}
              {!browseBusy && browseError && (
                <div className="fs-browser-error">
                  <div>{browseError}</div>
                  {browseData?.path && !browseData?.isDriveList && (
                    <button className="btn btn-sm" style={{ marginTop: 8 }}
                      onClick={() => mkdirThenOpen(browseData.path)}>
                      Create “{browseData.path}”
                    </button>
                  )}
                </div>
              )}
              {!browseBusy && !browseError && browseData?.isDriveList && browseData.drives.map(d => (
                <div key={d.path} className="fs-browser-item" onClick={() => browseTo(d.path)}>
                  <IconFolder size={14} color="var(--muted)" /> <span>{d.name}</span>
                </div>
              ))}
              {!browseBusy && !browseError && !browseData?.isDriveList && (browseData?.dirs?.length
                ? browseData.dirs.map(d => (
                    <div key={d.path} className="fs-browser-item" onClick={() => browseTo(d.path)}>
                      <IconFolder size={14} color="var(--muted)" /> <span>{d.name}</span>
                    </div>
                  ))
                : <div className="fs-browser-empty">No sub-folders here.</div>)}
            </div>
            <div className="fs-browser-ftr">
              <span className="fs-browser-current" title={browseData?.path || ''}>
                {browseData?.isDriveList ? 'Pick a drive to open' : (browseData?.path || '')}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setBrowseOpen(false)}>Cancel</button>
                <button className="btn btn-primary btn-sm"
                  disabled={browseBusy || browseData?.isDriveList || !browseData?.path}
                  onClick={chooseBrowsedFolder}>Use this folder</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================
// Compact workbench context / status row (Phase 1, Part 1.1)
// Frontend-only: derives from existing /api/assets, /api/health and the
// active training task. Missing data degrades to graceful placeholders.
function ContextRow({ voices, selectedVoice, health, activeTaskId, activity }) {
  const [meta, setMeta] = useState(null)
  const [taskStatus, setTaskStatus] = useState(null)

  const voice = voices.find(v => v.id === selectedVoice)

  useEffect(() => {
    setMeta(null)
    if (!selectedVoice) return
    let dead = false
    api(`/api/assets/${selectedVoice}`).then(r => {
      if (!dead && r.ok && r.data.ok) setMeta(r.data.meta || null)
    }).catch(() => {})
    return () => { dead = true }
  }, [selectedVoice])

  useEffect(() => {
    setTaskStatus(null)
    if (!activeTaskId) return
    let dead = false
    const poll = () => {
      api(`/api/train/status/${activeTaskId}`).then(r => {
        if (!dead && r.ok) setTaskStatus(r.data)
      }).catch(() => {})
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { dead = true; clearInterval(t) }
  }, [activeTaskId])

  // Pick the "latest" checkpoint (highest step for GPT, last for SoVITS) as
  // the model that Generate would auto-select for this voice.
  const ckpts = meta?.assets?.checkpoints || {}
  const gptList = ckpts.gpt || []
  const sovitsList = ckpts.sovits || []
  const latestGpt = gptList.length
    ? [...gptList].sort((a, b) => (Number(b.steps) || 0) - (Number(a.steps) || 0))[0]
    : null
  const latestSovits = sovitsList.length ? sovitsList[sovitsList.length - 1] : null

  const item = (k, v, placeholder) => (
    <span className="ctx-item">
      <span className="ctx-k">{k}</span>
      <span className={`ctx-v${placeholder ? ' placeholder' : ''}`}>{v}</span>
    </span>
  )

  // Task slot reflects, in priority order: a running training task > a live inference
  // (generation) activity > the last known training result > idle.
  let taskLabel = 'None', taskPlaceholder = true, taskBusy = false
  const trainRunning = activeTaskId && taskStatus?.status === 'running'
  if (trainRunning) {
    taskLabel = `Tuning · ${taskStatus?.currentStep || '…'}`; taskPlaceholder = false; taskBusy = true
  } else if (activity) {
    taskLabel = activity.label || 'Generating'; taskPlaceholder = false; taskBusy = true
  } else if (activeTaskId) {
    const s = taskStatus?.status
    if (s === 'completed') { taskLabel = 'Completed'; taskPlaceholder = false }
    else if (s === 'failed') { taskLabel = 'Failed'; taskPlaceholder = false }
    else if (s === 'interrupted') { taskLabel = 'Interrupted'; taskPlaceholder = false }
    else if (s === 'cancelled') { taskLabel = 'Cancelled'; taskPlaceholder = false }
    else { taskLabel = 'Restoring…'; taskPlaceholder = false }
  }

  return (
    <div className="ctx-row">
      {item('Voice', voice ? (voice.display_name || voice.id) : 'none selected', !voice)}
      <span className="ctx-sep" />
      {item('Lang', voice ? String(voice.language || '—').toUpperCase() : '—', !voice)}
      <span className="ctx-sep" />
      {item('GPT', latestGpt ? latestGpt.name : 'not selected', !latestGpt)}
      <span className="ctx-sep" />
      {item('SoVITS', latestSovits ? latestSovits.name : 'not selected', !latestSovits)}
      <span className="ctx-sep" />
      <span className="ctx-item">
        <span className={`badge ${health === null ? 'badge-neutral' : health?.engine_online ? 'badge-ok' : 'badge-danger'}`}>
          {health === null ? '…' : health?.engine_online ? 'Connected' : 'Unreachable'}
        </span>
      </span>
      <span className="ctx-sep" />
      <span className="ctx-item">
        <span className="ctx-k">Task</span>
        <span className={`badge ${taskPlaceholder ? 'badge-neutral' : taskStatus?.status === 'failed' ? 'badge-danger' : taskBusy ? 'badge-accent' : 'badge-info'}`}>{taskLabel}</span>
      </span>
    </div>
  )
}

export default function App() {
  const [page, setPage] = usePersistentState('ui.page', 'generate')
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = usePersistentState('ui.selectedVoice', '')
  const [selectedRefAudio, setSelectedRefAudio] = useState('')
  const [selectedRefText, setSelectedRefText] = useState('')
  // Optional prompt_lang override carried by a cross-voice / custom reference pick.
  // Empty string = follow the current voice's language (default, zero regression).
  const [selectedPromptLang, setSelectedPromptLang] = useState('')
  const [health, setHealth] = useState(null)
  const [genActivity, setGenActivity] = useState(null) // null | { label } — live inference activity for the context row
  const [activeTaskId, setActiveTaskId] = usePersistentState('train.activeTaskId', null)
  // Persisted in-flight Rebuild/Restore so its lightweight pipeline survives page
  // navigation and reloads: { id, taskId, stages }. AssetsTab resumes polling from it.
  const [rebuildTask, setRebuildTask] = usePersistentState('assets.rebuildTask', null)
  // One-shot handoff from Assets "Rebuild" → Train tab (input folder + voice name).
  const [trainPrefill, setTrainPrefill] = useState(null)

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
  useEffect(() => { setSelectedRefAudio(''); setSelectedRefText(''); setSelectedPromptLang('') }, [selectedVoice])

  const handleSelectRef = useCallback((audio, text, promptLang) => {
    setSelectedRefAudio(audio || '')
    setSelectedRefText(text || '')
    setSelectedPromptLang(promptLang || '')
  }, [])

  // Poll engine health so the badge reflects the GPT-SoVITS engine (port 9880) in
  // real time. A one-shot check would go stale if the engine dies mid-session.
  useEffect(() => {
    let dead = false
    const check = () => api('/api/health')
      .then(r => { if (!dead) setHealth(r.data || { ok: false, engine_online: false }) })
      .catch(() => { if (!dead) setHealth({ ok: false, engine_online: false }) })
    check()
    const t = setInterval(check, 8000)
    return () => { dead = true; clearInterval(t) }
  }, [])

  useEffect(() => { loadVoices() }, [])

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
        <button className={`nav-btn ${page === 'train' ? 'active' : ''}`} onClick={() => setPage('train')}>Fine-tune</button>
        <div style={{ flex: 1 }} />
        {health?.ffmpeg_available && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 8, background: 'rgba(76,175,80,0.15)', color: 'var(--success)', border: '1px solid rgba(76,175,80,0.3)', alignSelf: 'center' }}>ffmpeg</span>}
        <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 8, background: health?.engine_online ? 'rgba(76,175,80,0.15)' : 'rgba(207,102,121,0.15)', color: health?.engine_online ? 'var(--success)' : 'var(--danger)', border: `1px solid ${health?.engine_online ? 'rgba(76,175,80,0.3)' : 'rgba(207,102,121,0.3)'}`, alignSelf: 'center' }}>
          {health === null ? '...' : health.engine_online ? 'GPT-SoVITS Connected' : 'GPT-SoVITS Unreachable'}
        </span>
      </nav>

      {(page === 'generate' || page === 'compare') && (
        <ContextRow voices={voices} selectedVoice={selectedVoice} health={health} activeTaskId={activeTaskId} activity={genActivity} />
      )}

      <main style={{ flex: 1 }}>
        <div className="workspace-container">
          {page === 'generate' && (
            <GenerateTab voices={voices} selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice}
              onEditVoice={() => {}}
              onSwitchToCompare={() => setPage('compare')}
              onVoiceUpdate={loadVoices}
              selectedRefAudio={selectedRefAudio}
              selectedRefText={selectedRefText}
              selectedPromptLang={selectedPromptLang}
              onSelectRef={handleSelectRef}
              onActivity={setGenActivity} />
          )}
          {page === 'compare' && (
            <ReferenceCompareTab voices={voices} selectedVoice={selectedVoice} onBack={() => setPage('generate')} />
          )}
          {page === 'assets' && (
            <AssetsTab voices={voices} selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} setPage={setPage} loadVoices={loadVoices} setTrainPrefill={setTrainPrefill}
              rebuildTask={rebuildTask} setRebuildTask={setRebuildTask} />
          )}
          {page === 'train' && (
            <TrainingTab voices={voices} loadVoices={loadVoices}
              activeTaskId={activeTaskId} setActiveTaskId={setActiveTaskId}
              trainPrefill={trainPrefill} setTrainPrefill={setTrainPrefill} />
          )}
        </div>
      </main>
    </div>
  )
}
