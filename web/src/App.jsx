import { useState, useEffect, useCallback } from 'react'
import './styles.css'
import { usePersistentState } from './usePersistentState'
import { api } from './lib/api'
import { AssetsTab } from './components/assets/AssetsTab'
import { BrokerTab } from './components/broker/BrokerTab'
import { ContextRow } from './components/broker/ContextRow'
import { ReferenceCompareTab } from './components/compare/ReferenceCompareTab'
import { GenerateTab } from './components/generate/GenerateTab'
import { TrainingTab } from './components/train/TrainingTab'
import { FlowCanvasTab } from './components/flowgraph/FlowCanvasTab'
import { EnginesTab } from './components/engines/EnginesTab'
import { LangProvider, LangToggle, useT } from './lib/i18n'
import { Select } from './components/common/Select'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { fetchEngines, pickEngine, showsTrainingTab, engineBadge, mergeProcessState } from './lib/engines'

// 把操作系统报的设备名整理成一句能给人看的话。
// /api/health 的 device_name 是系统原样报上来的字符串，混着商标符号、用途后缀
// 和一段不可信的显存（WMI 的 AdapterRAM 在核显上会报出一个远小于真实共享内存的数）。
// 界面上不该出现一个我们自己都不信的数字，所以这三样一起去掉。
// 只做「去掉」，不猜、不改写：万一名里没有 GPU 这类词，就原样保留。
function prettyDevice(raw) {
  if (!raw) return '未知设备';
  return String(raw)
    .replace(/\((?:R|TM)\)/g, '')           // (R) (TM) 商标符号
    .replace(/[®™]/g, '')
    .replace(/\s*\(\s*\d+(?:\.\d+)?\s*GB\s*\)/gi, '')   // 不可信的显存
    .replace(/\s*\bGPU\b\s*$/i, '')             // 结尾的用途后缀
    .replace(/\s{2,}/g, ' ')
    .trim() || String(raw);
}

export default function App() {
  return (
    <LangProvider>
      <AppShell />
    </LangProvider>
  )
}

function AppShell() {
  // 只有底模徽章用得着，它要在中英之间说人话。AppShell 就在 LangProvider 里面，
  // 所以这个 hook 在这里是合法的。
  const { lang } = useT()
  const [page, setPage] = usePersistentState('ui.page', 'generate')
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = usePersistentState('ui.selectedVoice', '')
  const [selectedRefAudio, setSelectedRefAudio] = useState('')
  const [selectedRefText, setSelectedRefText] = useState('')
  // 跨音色或自定义参考带来的 prompt_lang 覆盖。空串表示跟随当前音色的语言（默认，无回归）。
  const [selectedPromptLang, setSelectedPromptLang] = useState('')
  const [health, setHealth] = useState(null)
  // 画布是可选功能（服务端 FLOWGRAPH_ENABLED）。先问一次它有没有，
  // 没开过的部署就不在导航栏上摆一个点下去只会让人失望的按钮。
  const [flowReady, setFlowReady] = useState(false)
  // 装了哪几台引擎，以及现在用的是哪一台。
  // 初值是空列表 + null，不是「先假设有一台叫某某的」：在列表回来之前，
  // 界面对「有哪些引擎」这件事应当一无所知，凡是需要引擎信息才能决定的东西先不显示。
  const [engines, setEngines] = useState([])
  // 占用透明度：后端算好的那一份（lib/engines/occupancy.js）。
  // 默认 null 而不是 {}，occupancyBadge 判的是「字段在不在」，
  // {} 会让「后端没给」和「真装了 0 台」长得一样，而那两句的含义相反。
  const [occupancy, setOccupancy] = useState(null)
  const [engineErrors, setEngineErrors] = useState([])
  const [selectedEngineId, setSelectedEngineId] = usePersistentState('ui.selectedEngine', '')
  const [genActivity, setGenActivity] = useState(null)  // null | { label }：合成中的活动指示，给 ContextRow 用
  const [activeTaskId, setActiveTaskId] = usePersistentState('train.activeTaskId', null)
  // 持久化进行中的 Rebuild/Restore，让它那条轻量流水线能跨页面跳转和刷新续上：
  // { id, taskId, stages }。AssetsTab 从这里恢复轮询。
  const [rebuildTask, setRebuildTask] = usePersistentState('assets.rebuildTask', null)
  // Assets 的 Rebuild 到 Train 页的一次性交接（输入目录 + 音色名）。
  const [trainPrefill, setTrainPrefill] = useState(null)

  const loadVoices = useCallback(() => {
    api('/api/assets').then(r => {
      if (r.ok) {
        const diskList = Object.entries(r.data.assets || {}).map(([id, meta]) => ({
          id,
          display_name: meta?.display_name || id,
          language: meta?.language || meta?.text_lang || 'ja',
        }))
        // 内置的底模音色（用预训练权重做零样本推理）：排在最前，在 Generate 的
        // 音色下拉里是默认项。它在盘上没有目录，所以不出现在 Assets 管理页。
        // 检查点按需从 GET /api/assets/__base__ 加载。
        const list = [{ id: '__base__', display_name: 'Base model', language: 'auto', builtin: true }, ...diskList]
        setVoices(list)
        if (!selectedVoice && list.length > 0) setSelectedVoice(list[0].id)
        if (selectedVoice && !list.find(v => v.id === selectedVoice)) setSelectedVoice(list[0]?.id || '')
      }
    }).catch(() => {})
  }, [selectedVoice])

  // 换音色时清掉参考选择。
  useEffect(() => { setSelectedRefAudio(''); setSelectedRefText(''); setSelectedPromptLang('') }, [selectedVoice])

  const handleSelectRef = useCallback((audio, text, promptLang) => {
    setSelectedRefAudio(audio || '')
    setSelectedRefText(text || '')
    setSelectedPromptLang(promptLang || '')
  }, [])

  useEffect(() => {
    let dead = false
    const check = () => api('/api/health')
      .then(r => { if (!dead) setHealth(r.data || { ok: false }) })
      .catch(() => { if (!dead) setHealth({ ok: false }) })
    check()
    const t = setInterval(check, 30000)
    return () => { dead = true; clearInterval(t) }
  }, [])

  // 引擎列表。probe=0：这里只要「装了哪几台、各自长什么样」，不探活。
  // 探活要挨个打网络，一台超时就拖住整张列表，而挑引擎、长面板都不需要知道它此刻活没活。
  // 在线状态由下面那个健康轮询单独负责。
  useEffect(() => {
    let dead = false
    fetchEngines({ probe: false }).then(r => {
      if (dead) return
      setEngines(r.engines)
      // 拉不到就保持 null（= 不画），不许翻成「没占用」。
      setOccupancy(r.occupancy ?? null)
      // 名片坏掉的引擎不在 r.engines 里，在 r.errors 里。必须显示出来：
      // 一台引擎因为少写一个键就从列表里静默消失，是最难查的那种症状。
      setEngineErrors(r.errors || [])
    }).catch(() => {})
    return () => { dead = true }
  }, [])

  // 起 / 停之后立刻重拉一次，不等那个 8 秒轮询。
  // 等 8 秒的表现是「按钮点了没反应」，然后用户再点一次，而第二次点的是
  // 一台正在启动的引擎（要等几十秒到几分钟），只会排得更久。
  const refreshEngines = useCallback(() => {
    return fetchEngines({ probe: false })
      .then(r => {
        setEngines(prev => mergeProcessState(prev, r.engines))
        setOccupancy(r.occupancy ?? null)
        // 起 / 停之后连名片坏掉的那几台一起刷新：用户在引擎页看到「读不出来」，
        // 去改完 manifest.json 再回来点一下，就该少一条。
        setEngineErrors(r.errors || [])
      })
      .catch(() => {})  // 拉不到就保持原样，不许把徽章翻成「停着」
  }, [])

  // 引擎进程状态的轮询（契约 §12 第 5 步）。
  // 上面那次是一次性的，名片和参数表只有装卸引擎时才变，
  // 但「这台引擎现在是否在运行、在装模型没有」是每几秒都在变的东西。
  // 不轮询的话，那个进程徽章会永远停在开页面那一刻：换模型时它照样写着待命，
  // 而人正对着一个要等几分钟的重启在猜是不是卡死了，那个徽章存在的唯一理由就没了。
  // 合并只动 process 一个字段，且没变化时原样还回旧数组，
  // 否则每一轮都产出新数组 ⇒ 下面那些 useEffect([engines]) 每 8 秒重跑。
  useEffect(() => {
    let dead = false
    const tick = () => fetchEngines({ probe: false })
      .then(r => {
        if (dead) return
        setEngines(prev => mergeProcessState(prev, r.engines))
        // occupancy 每 8 秒都会变（哪些在运行、峰值），所以要跟着更新；
        // 但只在内容真的变了时才 set，否则每 8 秒一个新对象
        // ⇒ 整个引擎页重渲，而那一页有 N 个引擎的按钮和徽章。
        // 判据用 JSON 字符串：这一段只有十来个标量，代价可忽略，
        // 而换来的是「没变就真的不重渲」。
        setOccupancy(prev => (JSON.stringify(prev) === JSON.stringify(r.occupancy ?? null)
          ? prev
          : (r.occupancy ?? null)))
      })
      .catch(() => {})  // 拉不到就保持原样，不许把徽章翻成「停着」
    const t = setInterval(tick, 8000)
    return () => { dead = true; clearInterval(t) }
  }, [])

  // 上次选的那台还在就还用它，不在了（比如卸了）退到第一台。
  // 这里不点名任何引擎作为兜底默认值。
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

  // 自动重连：刷新或关页后恢复正在运行、中断的任务。
  useEffect(() => {
    api('/api/train/tasks').then(r => {
      if (!r.ok) return;
      const tasks = r.data.tasks || [];
      // 1) 持久化里有 activeTaskId：校验它是否仍存在于后端，不存在则清掉，避免卡空白。
      if (activeTaskId) {
        const stillThere = tasks.find(t => t.id === activeTaskId);
        if (!stillThere) setActiveTaskId(null);
        return;
      }
      // 2) 没有 activeTaskId：优先接管运行中的，其次等待人工校对的，最后中断的。
      // awaiting_review 必须被接管，否则勾了「ASR 后暂停」的任务会卡在后端
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
        {/* 契约 §11 判据 11：训练页只对 supports_finetune: true 的引擎显示。showsTrainingTab 是 fail-closed 的：列表还没回来（engine 是 null）或名片没写这一格都不显示。少显示一个页签刷新一下就有；多显示会让人对一台根本不能微调的引擎填完一整张表，最后才发现白填。 */}
        {showsTrainingTab(engine) && (
          <button className={`nav-btn ${page === 'train' ? 'active' : ''}`} onClick={() => setPage('train')}>Tune</button>
        )}
        {/* 引擎管理页。不做成「装了两台以上才显示」：装一台的时候一样要能起停它，而「起不来」恰恰是只装了一台时最要紧的事。 */}
        <button className={`nav-btn ${page === 'engines' ? 'active' : ''}`} onClick={() => setPage('engines')}>Engines</button>
        <button className={`nav-btn ${page === 'broker' ? 'active' : ''}`} onClick={() => setPage('broker')}>Broker</button>
        {flowReady && (
          <button className={`nav-btn ${page === 'flow' ? 'active' : ''}`} onClick={() => setPage('flow')}>Flow</button>
        )}
        <div style={{ flex: 1 }} />
        {/* 引擎选择器只在装了两台以上时出现，一台的时候它是个只有一个选项的下拉框，占地方还让人以为自己漏装了什么。 */}
        {/* 这里用 components/common/Select.jsx，与全站其余下拉一致；它的 onChange 也发 { target: { value } }，调用方一个字不用改。 */}
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
          <span className="badge badge-danger" title={engineErrors.map(e => `${e.id}: ${e.error || e.message}`).join('\n')}
            style={{ alignSelf: 'center' }}>
            {engineErrors.length} 张 manifest.json 无法读取
          </span>
        )}
        <LangToggle />
        {health?.ffmpeg_available && <span className="badge badge-ok" style={{ alignSelf: 'center' }}>ffmpeg</span>}
        {health && (() => {
          // 探测机制：问操作系统（lib/system/gpu.js），不问任何 venv 里的 torch，
          // 根 venv 瘦身之后那条路必然答「无 CUDA」，而那不是事实。
          // 标签语义一个字没动：README 定义的就是
          // 「CUDA <显存>（绿=检测到 N 卡）/ CPU only（红=未检测到 N 卡）」，
          // 而「未检测到 N 卡」是准确的，不该因为本机有别的 GPU 就去改标签的既定义。
          // 唯一补的是 tooltip：那里可以把话说完而不动标签语义。
          // 「有没有这块卡」是平台知道的，「引擎用不用得上它」是引擎层的事，
          // 而名片里没有 supported_backends ⇒ 这里不断言引擎，只陈述探测结果。
          const c = health.cuda;
          const probing = !c || c.ready === false;
          const ok = !!c?.available;
          // 非 NVIDIA 的 GPU：不看 vram_gb（WMI 的 AdapterRAM 在核显上
          // 报的数字远小于真实共享内存，那个数字不可信）
          const otherGpu = !probing && !ok && !!c?.device_name;
          const tone = probing ? 'neutral' : ok ? 'ok' : 'danger';
          const label = probing ? 'GPU: detecting…' : ok ? `CUDA${c.vram_gb ? ` ${c.vram_gb}GB` : ''}` : 'No CUDA';
          const title = probing ? '正在探测本机的计算设备…'
            : ok ? `CUDA 可用：${c.device_name || 'NVIDIA GPU'}${c.vram_gb ? ` · ${c.vram_gb}GB` : ''}`
            // 只有一行。不写「无权威显存读数」「取决于引擎后端支持」这类
            // 给排障人看的话，也不把内部取值（intel/amd）露到界面上。
            : otherGpu ? `本机 GPU：${prettyDevice(c.device_name)}。`
            : '未检测到 CUDA 设备。推理将在 CPU 上运行。';
          return (
            <span className={`badge badge-${tone}`} title={title} style={{ alignSelf: 'center' }}>{label}</span>
          );
        })()}
        {/* 顶栏引擎徽章，只显示最需要处理的一项：底模缺失（红，唯一的红色）> 启动中 > 合成中 > 运行中 > 待命（灰，按需启动下未运行是正常的）。悬停只显示底模目录和正在载入的模型。底模缺失留在灯面上，那是唯一一种看不见就会被卡住一小时的坏；「底模齐」永远绿，降级进悬停。引擎改成按需启动后 Unreachable 成了常态，常亮红灯的指示灯只会训练人忽略所有红灯。这里一个 if 都不许加：谁上台、悬停里怎么排，engineBadge 决定。 */}
        {(() => {
          const b = engineBadge(engine, health, lang);
          if (!b) return null;
          const tone = b.tone === 'ok' ? 'ok'
            : b.tone === 'busy' ? 'warn'
            : b.tone === 'bad' ? 'danger'
            : 'neutral';
          return (
            <span className={`badge badge-${tone}`} title={b.title} style={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>{b.label}</span>
          );
        })()}
      </nav>

      {(page === 'generate' || page === 'compare') && (
        <ContextRow voices={voices} selectedVoice={selectedVoice} health={health} activeTaskId={activeTaskId} activity={genActivity} />
      )}

      <main style={{ flex: 1 }}>
        {/* 画布是工作台不是文档：它占满整个窗口，不用阅读页那种居中的 1400px 栏。 */}
        <div className={page === 'flow' ? 'workspace-container workspace-container--full' : 'workspace-container'}>
          {/* 错误边界包住整个页面区：某个页面渲染出错时，顶栏和其他页面仍然可用。key={page} 让切页时重置错误状态，否则出错后切页仍会显示上一个页面的报错。 */}
          <ErrorBoundary key={page} label="页面">
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
            // engine 传下去，是给参考文本校对里的读音预览用的。/api/pron/preview
            // 现在 engine_id 必传，平台不代为选择（换一台预览出来的读音和实际合成不是一回事）。
            <AssetsTab engine={engine} voices={voices} selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} setPage={setPage} loadVoices={loadVoices} setTrainPrefill={setTrainPrefill}
              setActiveTaskId={setActiveTaskId}
              rebuildTask={rebuildTask} setRebuildTask={setRebuildTask} />
          )}
          {/* engine 传下去，是给参考文本校对里的 /api/pron/preview 用的，它现在 engine_id 必传，平台不代为选择。判据 11 的另一半：页签藏了，页面本身也得关上，否则上次停在 Tune 页的人刷新后照样进得来。同 flow 页的做法：说清为什么没有，不要给一个空白面板。engine 为 null 时说的是「还在读」，跟「这台不支持」是两回事，不能合成一句话。 */}
          {page === 'train' && (showsTrainingTab(engine)
            ? <TrainingTab engine={engine} voices={voices} loadVoices={loadVoices}
                activeTaskId={activeTaskId} setActiveTaskId={setActiveTaskId}
                trainPrefill={trainPrefill} setTrainPrefill={setTrainPrefill} health={health} />
            : <div className="empty-state">
                <div className="es-sub" style={{ marginBottom: 0 }}>
                  {engine === null
                    ? '正在读引擎列表…'
                    : `${engine.label || engine.id} 这台引擎不支持微调（它的 manifest.json 里 capabilities.supports_finetune 不是 true）。换一台引擎，或者去修改该 manifest.json。`}
                </div>
                {engine !== null && (
                  <div style={{ marginTop: 12 }}>
                    <button className="btn btn-sm" onClick={() => setPage('assets')}>返回 Assets</button>
                  </div>
                )}
              </div>
          )}
          {page === 'engines' && (
            <EnginesTab engines={engines} engineErrors={engineErrors} occupancy={occupancy} onChanged={refreshEngines} />
          )}
          {page === 'broker' && (
            <BrokerTab />
          )}
          {page === 'flow' && (flowReady
            ? <FlowCanvasTab />
            // 存下来的页签选择可能比那个开关活得久，所以要说清画布为什么不在，
            // 而不是摆一个空白面板。
            : <div className="empty-state">
                <div className="es-sub" style={{ marginBottom: 0 }}>
                  这台服务器上没有开画布。启动时加上 FLOWGRAPH_ENABLED=1 再刷新这一页。
                </div>
              </div>
          )}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  )
}
