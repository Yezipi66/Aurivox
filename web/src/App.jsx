import { useState, useEffect, useCallback } from 'react'
import './styles.css'
import { usePersistentState } from './usePersistentState'
import { api } from './lib/api'
import { AssetsTab } from './components/assets/AssetsTab'
import { BrokerTab, ContextRow } from './components/broker/BrokerTab'
import { ReferenceCompareTab } from './components/compare/ReferenceCompareTab'
import { GenerateTab } from './components/generate/GenerateTab'
import { TrainingTab } from './components/train/TrainingTab'
import { LangProvider, LangToggle } from './lib/i18n'

export default function App() {
  return (
    <LangProvider>
      <AppShell />
    </LangProvider>
  )
}

function AppShell() {
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
        const diskList = Object.entries(r.data.assets || {}).map(([id, meta]) => ({
          id,
          display_name: meta?.display_name || id,
          language: meta?.language || meta?.text_lang || 'ja',
        }))
        // Built-in Base model voice (zero-shot inference on the pretrained weights):
        // prepended so it appears first / default in the Generate voice dropdown. It
        // has no folder on disk, so it never shows in the Assets management page
        // (which reads /api/assets directly). Checkpoints load lazily via
        // GET /api/assets/__base__.
        const list = [{ id: '__base__', display_name: 'Base model', language: 'auto', builtin: true }, ...diskList]
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
      // 2) 没有 activeTaskId：优先接管运行中的，其次等待人工校对的，最后中断的。
      // awaiting_review 必须被接管，否则 Refine 里勾了「ASR 后暂停」的任务会卡在后端
      // 无处校对（校对面板只在 Train 页对 activeTaskId 渲染）。
      const pick = tasks.find(t => t.status === 'running')
                || tasks.find(t => t.status === 'awaiting_review')
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
        <button className={`nav-btn ${page === 'broker' ? 'active' : ''}`} onClick={() => setPage('broker')}>Broker</button>
        <div style={{ flex: 1 }} />
        <LangToggle />
        {health?.ffmpeg_available && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 8, background: 'rgba(76,175,80,0.15)', color: 'var(--success)', border: '1px solid rgba(76,175,80,0.3)', alignSelf: 'center' }}>ffmpeg</span>}
        {health && (() => {
          const c = health.cuda;
          // Three states: probing (neutral) → CUDA ready (green) / CPU (red).
          const probing = !c || c.ready === false;
          const ok = !!c?.available;
          const bg = probing ? 'rgba(158,158,158,0.15)' : ok ? 'rgba(76,175,80,0.15)' : 'rgba(207,102,121,0.15)';
          const fg = probing ? 'var(--muted)' : ok ? 'var(--success)' : 'var(--danger)';
          const bd = probing ? 'rgba(158,158,158,0.3)' : ok ? 'rgba(76,175,80,0.3)' : 'rgba(207,102,121,0.3)';
          const label = probing ? 'GPU: detecting…' : ok ? `CUDA${c.vram_gb ? ` ${c.vram_gb}GB` : ''}` : 'CPU only';
          const title = probing ? 'Detecting CUDA…'
            : ok ? `CUDA ready — ${c.device_name || 'NVIDIA GPU'}${c.vram_gb ? ` · ${c.vram_gb}GB` : ''}`
            : 'No NVIDIA GPU detected. Inference runs on CPU (slower); fine-tuning is not recommended.';
          return (
            <span title={title} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 8, background: bg, color: fg, border: `1px solid ${bd}`, alignSelf: 'center' }}>{label}</span>
          );
        })()}
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
            <ReferenceCompareTab voices={voices} selectedVoice={selectedVoice} onActivity={setGenActivity} />
          )}
          {page === 'assets' && (
            <AssetsTab voices={voices} selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} setPage={setPage} loadVoices={loadVoices} setTrainPrefill={setTrainPrefill}
              setActiveTaskId={setActiveTaskId}
              rebuildTask={rebuildTask} setRebuildTask={setRebuildTask} />
          )}
          {page === 'train' && (
            <TrainingTab voices={voices} loadVoices={loadVoices}
              activeTaskId={activeTaskId} setActiveTaskId={setActiveTaskId}
              trainPrefill={trainPrefill} setTrainPrefill={setTrainPrefill} health={health} />
          )}
          {page === 'broker' && (
            <BrokerTab />
          )}
        </div>
      </main>
    </div>
  )
}
