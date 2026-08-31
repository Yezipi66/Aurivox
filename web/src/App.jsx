import { useState, useEffect, useCallback } from 'react'
import './styles.css'
import { usePersistentState } from './usePersistentState'
import { api } from './lib/api'
import { AssetsTab } from './components/assets/AssetsTab'
import { BrokerTab, ContextRow } from './components/broker/BrokerTab'
import { ReferenceCompareTab } from './components/compare/ReferenceCompareTab'
import { GenerateTab } from './components/generate/GenerateTab'
import { TrainingTab } from './components/train/TrainingTab'
import { FlowCanvasTab } from './components/flowgraph/FlowCanvasTab'
import { EnginesTab } from './components/engines/EnginesTab'
import { LangProvider, LangToggle, useT } from './lib/i18n'
import { Select } from './components/common/Select'
import { fetchEngines, pickEngine, showsTrainingTab, engineBadge, mergeProcessState } from './lib/engines'

export default function App() {
  return (
    <LangProvider>
      <AppShell />
    </LangProvider>
  )
}

function AppShell() {
  // 只有底模徽章用得着 —— 它要在中英之间说人话。AppShell 就在 LangProvider
  // 里面，所以这个 hook 在这里是合法的。
  const { lang } = useT()
  const [page, setPage] = usePersistentState('ui.page', 'generate')
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = usePersistentState('ui.selectedVoice', '')
  const [selectedRefAudio, setSelectedRefAudio] = useState('')
  const [selectedRefText, setSelectedRefText] = useState('')
  // Optional prompt_lang override carried by a cross-voice / custom reference pick.
  // Empty string = follow the current voice's language (default, zero regression).
  const [selectedPromptLang, setSelectedPromptLang] = useState('')
  const [health, setHealth] = useState(null)
  // The canvas is an opt-in extra (FLOWGRAPH_ENABLED on the server). Asking once
  // whether it is there keeps a dead tab off the nav bar on installs that never
  // switched it on, instead of offering a button that can only disappoint.
  const [flowReady, setFlowReady] = useState(false)
  // 装了哪几台引擎，以及现在用的是哪一台。
  // ⛔ 初值是空列表 + null，不是「先假设有一台叫某某的」：在列表回来之前，
  //    界面对「有哪些引擎」这件事应当一无所知。凡是需要引擎信息才能决定的
  //    东西（参数面板、训练页显隐），这段时间就先不显示。
  const [engines, setEngines] = useState([])
  const [engineErrors, setEngineErrors] = useState([])
  const [selectedEngineId, setSelectedEngineId] = usePersistentState('ui.selectedEngine', '')
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

  // ⭐⭐⭐ 2026-08-30 刀 4：这个轮询过去的名义是「让徽章实时反映 GPT-SoVITS
  //   引擎（端口 9880）」—— 那是第六项：端口不是推理需要的东西，是我给引擎
  //   套的 HTTP 外壳产生的。engine_online 现在**前端一处都不读了**
  //   （engines.js:engineBadge 与 BrokerTab 那两枚灯已删）。
  //
  // ⭐ 留下来的是它另一半用途：ffmpeg 装没装、有没有 CUDA —— 那是**这台机器**
  //   的事实，不是某台引擎的事实，对所有引擎一视同仁 ⇒ 它不是第六项。
  //   ⇒ 轮询降到 30s（机器装没装 ffmpeg 不会在 8 秒里变）。
  // ⛔ 不许再拿这里的结果去画任何一枚"引擎在不在线"的灯。
  useEffect(() => {
    let dead = false
    const check = () => api('/api/health')
      .then(r => { if (!dead) setHealth(r.data || { ok: false }) })
      .catch(() => { if (!dead) setHealth({ ok: false }) })
    check()
    const t = setInterval(check, 30000)
    return () => { dead = true; clearInterval(t) }
  }, [])

  // 引擎列表。probe=0：这里只要「装了哪几台、各自长什么样」，不探活 ——
  // 探活要挨个打网络，一台超时就拖住整张列表，而挑引擎、长面板都不需要
  // 知道它此刻活没活。在线状态由下面那个健康轮询单独负责。
  useEffect(() => {
    let dead = false
    fetchEngines({ probe: false }).then(r => {
      if (dead) return
      setEngines(r.engines)
      // 名片坏掉的引擎不在 r.engines 里，在 r.errors 里。必须显示出来 ——
      // 一台引擎因为少写一个键就从列表里静默消失，是最难查的那种症状。
      setEngineErrors(r.errors || [])
    }).catch(() => {})
    return () => { dead = true }
  }, [])

  // 刀 F2：起 / 停之后立刻重拉一次，⛔ 不等那个 8 秒轮询。
  // ⭐ 等 8 秒的表现是"按钮点了没反应"，然后用户再点一次 —— 而第二次点的是
  //   一台正在启动的引擎（要等几十秒到几分钟），只会排得更久。
  const refreshEngines = useCallback(() => {
    return fetchEngines({ probe: false })
      .then(r => {
        setEngines(prev => mergeProcessState(prev, r.engines))
        // ⭐ 名片坏掉的那几台也一起刷新 —— 用户在引擎页看到"读不出来"，
        //   去改完 manifest.json 再回来点一下，就该少一条。
        setEngineErrors(r.errors || [])
      })
      .catch(() => {}) // ⛔ 拉不到就保持原样，不许把徽章翻成"停着"
  }, [])

  // 引擎进程状态的轮询（契约 §12 第 5 步）。
  // ⭐⭐⭐ 上面那次是**一次性**的 —— 名片和参数表只有装卸引擎时才变。
  //   但「这台引擎现在跑没跑、在装模型没有」是每几秒都在变的东西。
  //   不轮询的话，那个进程徽章会永远停在开页面那一刻：换模型时它照样写着
  //   "待命"，而人正对着一个要等几分钟的重启在猜是不是卡死了 ——
  //   那个徽章存在的唯一理由就没了。
  // ⭐ 合并只动 process 一个字段，且没变化时原样还回旧数组，
  //   否则每一轮都产出新数组 ⇒ 下面那些 useEffect([engines]) 每 8 秒重跑。
  useEffect(() => {
    let dead = false
    const tick = () => fetchEngines({ probe: false })
      .then(r => { if (!dead) setEngines(prev => mergeProcessState(prev, r.engines)) })
      .catch(() => {}) // ⛔ 拉不到就保持原样，不许把徽章翻成"停着"
    const t = setInterval(tick, 8000)
    return () => { dead = true; clearInterval(t) }
  }, [])

  // 上次选的那台还在就还用它，不在了（比如卸了）退到第一台。
  // ⛔ 这里不点名任何引擎作为兜底默认值。
  useEffect(() => {
    if (engines.length === 0) return
    const picked = pickEngine(engines, selectedEngineId)
    if (picked && picked.id !== selectedEngineId) setSelectedEngineId(picked.id)
  }, [engines])

  const engine = pickEngine(engines, selectedEngineId)

  useEffect(() => {
    api('/api/flowgraph/status')
      .then(r => setFlowReady(!!(r.ok && r.data && r.data.ok)))
      .catch(() => setFlowReady(false))
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
        {/* 契约 §11 判据 11：训练页只对 supports_finetune: true 的引擎显示。
            照抄下面 flowReady 那个形状。showsTrainingTab 是 fail-closed 的：
            列表还没回来（engine 是 null）、或者名片没写这一格，都不显示 ——
            少显示一个页签刷新一下就有了；多显示会让人对一台根本不能微调的
            引擎填完一整张表，最后才发现白填。 */}
        {showsTrainingTab(engine) && (
          <button className={`nav-btn ${page === 'train' ? 'active' : ''}`} onClick={() => setPage('train')}>Tune</button>
        )}
        {/* 刀 F2：引擎管理页。⛔ 不做成"装了两台以上才显示" ——
            装一台的时候一样要能起停它，而"起不来"恰恰是只装了一台时最要紧的事。 */}
        <button className={`nav-btn ${page === 'engines' ? 'active' : ''}`} onClick={() => setPage('engines')}>Engines</button>
        <button className={`nav-btn ${page === 'broker' ? 'active' : ''}`} onClick={() => setPage('broker')}>Broker</button>
        {flowReady && (
          <button className={`nav-btn ${page === 'flow' ? 'active' : ''}`} onClick={() => setPage('flow')}>Flow</button>
        )}
        <div style={{ flex: 1 }} />
        {/* 引擎选择器。只有装了两台以上才出现 —— 一台的时候它是个只有一个
            选项的下拉框，占地方还让人以为自己漏装了什么。 */}
        {/* ⛔ 这里原来是全 App 唯一一个裸 <select>，而且挂的 class
            `.nav-select` 在 styles.css 里根本不存在 ⇒ 浏览器默认样式，
            一个白底方框戳在深色导航条中间。别的地方（RefPickers、
            ParamField…）用的都是 components/common/Select.jsx。
            ⇒ 换成同一个组件，样式和菜单行为就跟全站一致了。
            Select 的 onChange 也发 { target: { value } }，调用方一个字不用改。 */}
        {engines.length > 1 && (
          <Select className="control nav-select" value={engine?.id || ''} onChange={e => setSelectedEngineId(e.target.value)}
            title="切换引擎：参数面板和页签会跟着这台引擎的 manifest.json 变">
            {engines.map(en => (
              <option key={en.id} value={en.id}>{en.label || en.id}</option>
            ))}
          </Select>
        )}
        {/* 名片坏掉的引擎不在列表里。不说的话，它就是「凭空少了一台」。 */}
        {engineErrors.length > 0 && (
          <span title={engineErrors.map(e => `${e.id}: ${e.error || e.message}`).join('\n')}
            style={{ fontSize: 11, padding: '3px 8px', borderRadius: 8, background: 'rgba(207,102,121,0.15)', color: 'var(--danger)', border: '1px solid rgba(207,102,121,0.3)', alignSelf: 'center' }}>
            {engineErrors.length} 张 manifest.json 读不了
          </span>
        )}
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
        {/* ⭐⭐⭐ 关于「当前这台引擎」，顶栏只留这一枚灯。
            2026-08-30 之前这里是**三枚**：底模齐 / 进程状态 / Connected。
            Owner：「你现在右上角的指示灯越来越多了，是非常不好的兆头…
                    你再加是想变成飞机仪表盘嘛」。

            ⭐ 并掉的实质理由不是省地方，是那三枚里有两枚已经在说错话：
              引擎改成「用到才起」之后，「Unreachable」变成了**常态**，
              而一枚正常状态下常亮红灯的指示灯只会训练人忽略所有红灯。
            ⭐ 「底模齐」也不再占格子 —— 永远绿的灯不携带信息，降级进悬停；
              但「底模缺」留在灯面上，那是唯一一种看不见就会被卡住一小时的坏。

            ⛔ 这里一个 if 都不许加：谁上台、悬停里怎么排，engineBadge 决定；
              跑没跑、齐没齐，服务端早算完了。 */}
        {(() => {
          const b = engineBadge(engine, health, lang);
          if (!b) return null;
          const tone = b.tone === 'ok'
            ? { bg: 'rgba(76,175,80,0.15)', fg: 'var(--success)', bd: 'rgba(76,175,80,0.3)' }
            : b.tone === 'busy'
              ? { bg: 'rgba(255,183,77,0.15)', fg: 'var(--warning, #ffb74d)', bd: 'rgba(255,183,77,0.35)' }
              : b.tone === 'bad'
                ? { bg: 'rgba(207,102,121,0.15)', fg: 'var(--danger)', bd: 'rgba(207,102,121,0.3)' }
                : { bg: 'rgba(158,158,158,0.15)', fg: 'var(--muted)', bd: 'rgba(158,158,158,0.3)' };
          return (
            <span title={b.title} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 8, background: tone.bg, color: tone.fg, border: `1px solid ${tone.bd}`, alignSelf: 'center', whiteSpace: 'nowrap' }}>{b.label}</span>
          );
        })()}
      </nav>

      {(page === 'generate' || page === 'compare') && (
        <ContextRow voices={voices} selectedVoice={selectedVoice} health={health} activeTaskId={activeTaskId} activity={genActivity} />
      )}

      <main style={{ flex: 1 }}>
        {/* The canvas is a workbench, not a document: it gets the whole window
            instead of the centred 1400px column the reading pages use. */}
        <div className={page === 'flow' ? 'workspace-container workspace-container--full' : 'workspace-container'}>
          {page === 'generate' && (
            <GenerateTab engine={engine} voices={voices} selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice}
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
            <ReferenceCompareTab engine={engine} voices={voices} selectedVoice={selectedVoice} onActivity={setGenActivity} />
          )}
          {page === 'assets' && (
            /* ⭐ 刀 A1（2026-08-31）：`engine` 传下去，是给参考文本校对里的
               读音预览用的 —— /api/pron/preview 现在 engine_id 必传，
               ⛔ 平台不替你挑一台（换一台预览出来的读音和实际合成不是一回事）。 */
            <AssetsTab engine={engine} voices={voices} selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} setPage={setPage} loadVoices={loadVoices} setTrainPrefill={setTrainPrefill}
              setActiveTaskId={setActiveTaskId}
              rebuildTask={rebuildTask} setRebuildTask={setRebuildTask} />
          )}
          {/* 判据 11 的另一半：页签藏了，页面本身也得关上 —— 否则上次停在
              Tune 页的人刷新后照样进得来。同 flow 页的做法：说清为什么没有，
              不要给一个空白面板。⚠ engine 为 null 时说的是「还在读」，跟
              「这台不支持」是两回事，不能合成一句话。 */}
          {page === 'train' && (showsTrainingTab(engine)
            ? <TrainingTab engine={engine} voices={voices} loadVoices={loadVoices}
                activeTaskId={activeTaskId} setActiveTaskId={setActiveTaskId}
                trainPrefill={trainPrefill} setTrainPrefill={setTrainPrefill} health={health} />
            : <div style={{ padding: 24, color: 'var(--muted)' }}>
                {engine === null
                  ? '正在读引擎列表…'
                  : `${engine.label || engine.id} 这台引擎不支持微调（它的 manifest.json 里 capabilities.supports_finetune 不是 true）。换一台引擎，或者去改那张 manifest.json。`}
              </div>
          )}
          {page === 'engines' && (
            <EnginesTab engines={engines} engineErrors={engineErrors} onChanged={refreshEngines} />
          )}
          {page === 'broker' && (
            <BrokerTab />
          )}
          {page === 'flow' && (flowReady
            ? <FlowCanvasTab />
            // A stored page choice can outlive the switch being turned off, so
            // say why the canvas is missing instead of showing a blank pane.
            : <div style={{ padding: 24, color: 'var(--muted)' }}>
                这台服务器上没有开画布。启动时加上 FLOWGRAPH_ENABLED=1 再刷新这一页。
              </div>
          )}
        </div>
      </main>
    </div>
  )
}
