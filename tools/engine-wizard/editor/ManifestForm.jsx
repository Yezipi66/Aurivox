import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { RuntimeSection, CallSection, ModelsSection } from './NestedSections'
import { useInstalled } from './useInstalled'

// ============================================================================
//  MANIFEST FORM —— ⭐ 名片填表（不是 JSON 编辑器）
//
//  ⛔⛔ 这个组件存在的理由
//  上一版左侧是个 <textarea> 装 JSON —— 那是**代码编辑器**，不是填表。
//  它要求用户：会写 JSON + 记得住几十个键的语义 + 知道哪些填错不报错。
//  ⇒ 只有技术用户能用，而且技术用户也懒得填。
//
//  ⭐ 这一版：按**分组**分区（项目现成的 .section 三件套）
//    · 每个字段：键名 + 一句话说明 + 填错的后果
//    · 高危字段（静默失效那一类）当场挂 .badge-warn
//    · 参数区是**可增删的行**，不是一坨 JSON
//    · ⛔ 表单由 /wizard/spec 长出来（fieldmeta 是唯一权威），不手写清单
//
//  ⛔⛔ 全部用项目类：.section / .field / .field-label / .field-hint /
//    .control / .param-grid / .plan-warn / .rc-cmd / .expert-block /
//    .expert-summary / .badge / .msg —— ⛔⛔ 一个自造的 mf-*/pr-* 都不留。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

// ---------------------------------------------------------------------------
// 分组标题 —— ⭐ 用**平台的词汇**，不自己造中文名
// ⚠ 为什么不是「怎么起进程」这种说法：平台自己的界面从不这么叫它。
//   造一套「更friendly」的说法 = 造第二套词汇，用户学的是我的词、
//   填的是平台的键，两边对不上。⇒ 显示键名，说明放在 fieldmeta 的 howto 里。
// ---------------------------------------------------------------------------
const GROUP_LABELS = {
  basics: { en: 'Basics', zh: '基本信息' },
  source: { en: 'Source', zh: '源码与许可' },
  models: { en: 'Models', zh: '模型权重' },
  runtime: { en: 'runtime', zh: 'runtime（启动引擎进程）' },
  call: { en: 'call', zh: 'call（调用引擎接口）' },
  parameters: { en: 'parameters', zh: 'parameters（界面参数）' },
  capabilities: { en: 'capabilities', zh: 'capabilities（能力声明）' },
  install: { en: 'install', zh: 'install（怎么装）' },
  output: { en: 'output', zh: 'output（输出格式）' },
}

const GROUP_ORDER = [
  'basics', 'source', 'models', 'runtime', 'call',
  'capabilities', 'install', 'output',
]

// ⛔ 这三段是**嵌套结构**，有专门的编辑器（NestedSections.jsx），
//    不能「一个键一个 input」—— 那样只显示说明、填不了值。
const NESTED_GROUPS = ['runtime', 'call', 'models']

// 顶层哪些键是「简单值」⇒ 直接给个输入框；哪些是对象/数组 ⇒ 展开写
const SIMPLE_KEYS = {
  id: 'text', label: 'text', local_changes: 'text',
  max_chars: 'number', max_chars_source: 'text',
  timeout_ms: 'number', timeout_ms_source: 'text',
  base_url_env: 'text', contract_version: 'number',
}

function Field ({ sec, value, onChange }) {
  const { t } = useT()
  const kind = SIMPLE_KEYS[sec.key] || 'text'
  return (
    <div className="field">
      {/* ⭐ 键名 + 「填错不报错」徽标同一行（内联 flex，照 TrainingTab 的写法）*/}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <label className="field-label" style={{ margin: 0 }} title={sec.howto}>
          <code>{sec.key}</code>
        </label>
        {sec.danger === 'silent' && (
          <span className="badge badge-warn">
            {t('no error if wrong', '填错不报错')}
          </span>
        )}
      </div>
      <div className="field-hint">{sec.howto}</div>
      {kind === 'number'
        ? (
          <input className="control" type="number" value={value ?? ''}
            onChange={(e) => onChange(e.target.value === ''
              ? undefined
              : Number(e.target.value))} />
          )
        : (
          <input className="control" type="text" value={value ?? ''}
            onChange={(e) => onChange(e.target.value === undefined
              ? ''
              : e.target.value)} />
          )}
      {sec.warn && <div className="plan-warn">⚠ {sec.warn}</div>}
      {sec.structure && (
        <div className="rc-cmd">
          <pre className="rc-cmd-body">{sec.structure}</pre>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 参数区：可增删的行
// ---------------------------------------------------------------------------
function ParamRow ({ entry, index, spec, onChange, onDelete }) {
  const { t } = useT()
  const set = (k, v) => {
    const next = { ...entry }
    if (v === undefined || v === '') delete next[k]
    else next[k] = v
    onChange(index, next)
  }
  const type = entry.type || 'text'
  void spec

  return (
    <div className="card">
      <div className="form-grid">
        <div className="field">
          <label className="field-label">
            {t('Parameter name', '参数名')}
          </label>
          <input className="control" value={entry.name || ''}
            onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label">type</label>
          <select className="control" value={type}
            onChange={(e) => set('type', e.target.value)}>
            {['text', 'number', 'select', 'boolean', 'file'].map((x) => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ⭐ .param-grid —— 项目给「一堆小字段」准备的（2 列，gap 10px，
          而且 .param-grid label 自带 11px muted 的标签样式）*/}
      <div className="param-grid">
        <label><span>label</span>
          <input className="control" value={entry.label?.zh || entry.label || ''}
            placeholder={t('shown in the UI', '界面上显示的名字')}
            onChange={(e) => set('label', e.target.value)} /></label>

        <label><span>tier</span>
          <select className="control" value={entry.tier || ''}
            onChange={(e) => set('tier', e.target.value || undefined)}>
            <option value="">{t('(unset → advanced)', '（不写 → advanced）')}</option>
            <option value="common">common</option>
            <option value="advanced">advanced</option>
          </select></label>

        <label><span>phase</span>
          <select className="control" value={entry.phase || ''}
            onChange={(e) => set('phase', e.target.value || undefined)}>
            <option value="">{t('(unset → call)', '（不写 → call）')}</option>
            <option value="call">call</option>
            <option value="load">load</option>
          </select></label>

        <label><span>default</span>
          <input className="control" value={entry.suggested_value ?? ''}
            onChange={(e) => set('suggested_value',
              e.target.value === ''
                ? undefined
                : (type === 'number' || type === 'boolean')
                  ? (type === 'boolean' ? e.target.value === 'true' : Number(e.target.value))
                  : e.target.value)} /></label>

        {type === 'number' && (
          <label><span>min / max</span>
            <span className="form-grid">
              <input className="control" type="number" value={entry.min ?? ''}
                onChange={(e) => set('min',
                  e.target.value === '' ? undefined : Number(e.target.value))} />
              <input className="control" type="number" value={entry.max ?? ''}
                onChange={(e) => set('max',
                  e.target.value === '' ? undefined : Number(e.target.value))} />
            </span></label>
        )}

        {type === 'select' && (
          <label><span>choices</span>
            <input className="control"
              value={Array.isArray(entry.choices) ? entry.choices.join(',') : ''}
              placeholder="voices / weights / audio"
              onChange={(e) => set('choices', e.target.value
                ? e.target.value.split(',').map((s) => s.trim())
                : undefined)} /></label>
        )}

        <label><span>applies_to</span>
          <input className="control"
            value={Array.isArray(entry.applies_to) ? entry.applies_to.join(',') : ''}
            placeholder={t('comma separated', '逗号分隔')}
            onChange={(e) => set('applies_to', e.target.value
              ? e.target.value.split(',').map((s) => s.trim())
              : undefined)} /></label>
      </div>

      {/* ⭐ 折叠用**项目的** .expert-block + .expert-summary
          （⛔⛔ 不再用裸 <details> —— 那个没有边框/间距，
            跟整页所有其它折叠长得不一样）*/}
      <details className="expert-block" style={{ marginTop: 8 }}>
        <summary className="expert-summary">
          {t('More (rarely needed)', '更多（多数用不到）')}
        </summary>
        <div className="param-grid" style={{ marginTop: 8 }}>
          <label><span>repeat</span>
            <input className="control" type="number" value={entry.repeat ?? ''}
              onChange={(e) => set('repeat',
                e.target.value === '' ? undefined : Number(e.target.value))} /></label>
          <label><span>group</span>
            <input className="control" value={entry.group || ''}
              onChange={(e) => set('group', e.target.value)} /></label>
          <label><span>order</span>
            <input className="control" type="number" value={entry.order ?? ''}
              onChange={(e) => set('order',
                e.target.value === '' ? undefined : Number(e.target.value))} /></label>
          <label><span>source</span>
            <select className="control" value={entry.source || ''}
              onChange={(e) => set('source', e.target.value || undefined)}>
              <option value="">{t('(unset)', '（不写）')}</option>
              <option value="voices">voices</option>
              <option value="weights">weights</option>
              <option value="audio">audio</option>
            </select></label>
        </div>
        <p className="plan-warn">
          {t('repeat unset or 1 means a single value (scalar). Only 2 or more makes an array. '
            + 'Those are two different things to the engine, and neither is reported '
            + 'as an error.',
            'repeat 未填或填 1 表示单个值（标量），仅当大于等于 2 时才为数组。'
            + '这两种对引擎是两件事，而且都不会报错。')}
        </p>
      </details>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="btn btn-sm btn-danger" type="button"
          onClick={() => onDelete(index)}>
          {t('Delete this parameter', '删掉这个参数')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ⭐ CliGenPanel —— 走命令行（cli 形态）的「扫描 → 自动填 → 手编」
//
// 操作流（Owner 2026-10-10 定，⛔ 照这个来）：
//   进来 → [读取名片]（改已有引擎）或 [新建名片]（默认新建）
//   新建后 → [扫描参数] → 列出上游命令行的 flag 表（官方说明 / 必填选填 / 类型）
//   → 平台**自动填**一批进名片（bind 三槽位 + args，⛔ 不要求用户逐个勾）
//   → 用户手动编辑补改 → 最下面 [保存]
//
// ⭐ 这条路扫上游命令行 --flag，flag 即参数，官方 help 直接挂它上面
//   ⇒ 不用读函数签名、不用猜 flag↔参数对应。
//
// ⛔ 纪律：只填表单不落盘（落盘是 SaveBar 的事）；help 原样递出不改写。
//    布局借鉴项目现有 .workspace-left/.workspace-right（左操作 + 右实时 JSON）。
// ---------------------------------------------------------------------------
function CliGenPanel ({ manifest, onChange }) {
  const { t } = useT()
  const { installed, loadOne } = useInstalled()
  const [allDirs, setAllDirs] = React.useState([])   // engines/ 下所有文件夹（含没名片）
  const [mode, setMode] = React.useState(manifest.id ? 'scan' : 'idle')
  const [engineId, setEngineId] = React.useState(manifest.id || '')
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const [scan, setScan] = React.useState(null)
  const [subcmd, setSubcmd] = React.useState('')
  const [readPick, setReadPick] = React.useState('')   // 「读取」入口选中的引擎
  const [newPick, setNewPick] = React.useState('')      // 「新建」入口选中的文件夹

  // ⭐ 拉 engines/ 下所有文件夹（含还没名片的）——「新建名片」入口靠它列出
  //   第 1 步克隆来、还没写名片的引擎。⛔ 与 installed（只有名片的）是两份数据。
  React.useEffect(() => {
    fetch('/wizard/installed?all=1').then((r) => r.json())
      .then((j) => setAllDirs(j.engines || []))
      .catch(() => {})
  }, [])

  React.useEffect(() => { if (!engineId && manifest.id) setEngineId(engineId || manifest.id) }, [manifest.id])

  // ⭐ 读取：选一台**已有名片**的引擎 → 先把磁盘名片原文灌进表单，再进编辑态。
  //   ⛔ 绝对不许只进扫描空壳：那样表单里只剩 cli 扫描结果，
  //      原有的 models / runtime / install / call 全被冲掉，点保存就是毁数据。
  //   读取和新建是两条不同的路：读出来的是什么就是什么，⛔ 不自动清空已有字段。
  const startRead = async (id) => {
    if (!id) return
    setBusy(true); setErr(null); setScan(null); setSubcmd('')
    try {
      const r = await loadOne(id)
      if (!r.ok) { setErr(r.error || t('Failed to read the manifest', '读取名片失败')); return }
      let parsed
      try { parsed = JSON.parse(r.text) } catch (e) {
        setErr(t('The manifest on disk is not valid JSON', '磁盘上的名片不是合法 JSON')); return
      }
      // 灌进表单：以磁盘原文为准（唯一真相），⛔ 不在这里补默认值、不清字段。
      onChange(parsed)
      setEngineId(id)
      setReadPick(id)
      // 进了编辑态（不是扫描）：用户想再扫可以自己点「扫描参数」。
      setMode('read')
    } finally { setBusy(false) }
  }
  // 新建：选一台 engines/ 下的文件夹（含还没名片的），进扫描
  const startNew = (id) => { if (!id) return; setEngineId(id); setMode('scan'); setScan(null); setErr(null); setSubcmd('') }

  // 扫描 + 自动填：一步到位 —— 扫出参数表，同时把能对应的填进名片 call 段
  const doScan = async () => {
    if (!engineId) return
    setBusy(true); setErr(null); setScan(null)
    try {
      const r = await fetch('/wizard/cli-args', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: engineId, subcommand: subcmd || undefined }),
      })
      const j = await r.json()
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return }
      setScan(j)
      const inferSubs = (j.subcommands || []).filter(s => /synth|infer|tts|generate/i.test(s))
      const pickedSub = subcmd || inferSubs[0] || (j.subcommands || [])[0] || ''
      setSubcmd(pickedSub)
      autoFill(j, pickedSub)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // ⭐ 自动填：把推理参数直接写进名片的 call 段（cli 形态），⛔ 不用用户勾
  //   平台能认出来的（text/ref_audio/output_path 三槽位 + 其余 args）全填，
  //   认不出的留给用户手编。
  const autoFill = (j, sub) => {
    const args = (j.args || []).filter(a => (sub === '(root)' ? !a.subcommand : a.subcommand === sub))
    if (!args.length) return
    const call = { ...(manifest.call || {}), kind: 'cli' }
    // ⛔ argv 骨架每次从固定前缀重建（不累加旧子命令，否则切子命令会堆
    //   infer/synth 多个）。_MODULE_ 待用户补或来自 suggested_call。
    const prefix = (call.argv || []).slice(0, (call.argv || []).indexOf('_MODULE_') >= 0 ? (call.argv || []).indexOf('_MODULE_') + 1 : 3)
    call.argv = (prefix.length ? prefix : ['{engine_python}', '-m', '_MODULE_']).concat(sub && sub !== '(root)' ? [sub] : [])
    // 三槽位：按官方 flag 名认（text→--text/--prompt-text，ref→--voice/--ref-audio…）
    const byName = Object.fromEntries(args.map(a => [a.name, a]))
    const findFlag = (...names) => { for (const n of names) if (byName[n]) return byName[n].flag; return null }
    call.bind = call.bind || {}
    if (!call.bind.text) { const f = findFlag('text', 'tts_text', 'prompt_text', 'gen_text'); if (f) call.bind.text = f }
    if (!call.bind.ref_audio) { const f = findFlag('voice', 'ref_audio', 'prompt_wav', 'ref_wav', 'spk', 'speaker', 'reference_audio'); if (f) call.bind.ref_audio = f }
    if (!call.bind.output_path) { const f = findFlag('output', 'output_path', 'out', 'save_path'); if (f) call.bind.output_path = f }
    // 其余 flag 全进 args
    call.args = call.args || {}
    for (const a of args) if (!call.args[a.name]) call.args[a.name] = { flag: a.flag, style: a.style }
    // ⭐ 基本信息自动填（⛔ 不覆盖用户已填的）：
    //   id = 引擎 id（= 目录名，第 1 步定的）；label 默认 = id（用户想改再改）；
    //   contract_version = 平台当前契约版本（2）。
    //   ⇒ 这三项平台都能自动填，不该摆在用户脸上 ⇒ 挪进第三块折叠区。
    const next = { ...manifest, call }
    if (!next.id && engineId) next.id = engineId
    if (!next.label && (next.id || engineId)) next.label = next.id || engineId
    if (next.contract_version === undefined) next.contract_version = 2
    onChange(next)
  }

  const args = (scan && scan.args || []).filter(a => !subcmd || a.subcommand === subcmd || (subcmd === '(root)' && !a.subcommand))

  return (
    <div className="section">
      <div className="section-hdr"><h2>{t('Generate manifest from CLI', '从命令行生成名片')}</h2></div>
      <div className="section-body">
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('Scan the engine’s command-line tool. Flags are listed with their official descriptions, and recognized ones are filled into the manifest automatically.',
            '扫描引擎的命令行工具。列出每个参数和官方说明，能认出来的自动填进名片。')}
        </p>

        {/* ① 两个入口：读取（改已有）/ 新建（接新引擎）—— 各自选自己的引擎，不共用下拉 */}
        {mode === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* 读取名片：改一台已有名片的引擎 */}
            <div className="field">
              <label className="field-label">{t('Read manifest (edit an engine that already has one)', '读取名片（改一台已经有名片的引擎）')}</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select className="control" value={readPick}
                  onChange={(e) => setReadPick(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                  <option value="">{t('— pick an engine —', '— 选一台引擎 —')}</option>
                  {(installed || []).map(e => <option key={e.id} value={e.id}>{e.id}</option>)}
                </select>
                <button className="btn btn-sm" type="button" disabled={!readPick}
                  style={{ flexShrink: 0 }}
                  onClick={() => startRead(readPick)}>{t('Read', '读取')}</button>
              </div>
            </div>
            {/* 新建名片：接一台新引擎（engines/ 下还没名片的文件夹）*/}
            <div className="field">
              <label className="field-label">{t('New manifest (build one for an engine cloned in step 1)', '新建名片（给第 1 步克隆来的引擎建一张名片）')}</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select className="control" value={newPick}
                  onChange={(e) => setNewPick(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                  <option value="">{t('— pick a folder under engines/ —', '— 选 engines/ 下的一个文件夹 —')}</option>
                  {allDirs.map(e => <option key={e.id} value={e.id}>
                    {e.id}{e.manifestPresent ? '' : `（${t('no manifest yet', '还没名片')}）`}
                  </option>)}
                </select>
                <button className="btn btn-sm btn-primary" type="button" disabled={!newPick}
                  style={{ flexShrink: 0 }}
                  onClick={() => startNew(newPick)}>{t('New', '新建')}</button>
              </div>
            </div>
          </div>
        )}

        {/* ② 扫描参数（自动填）—— 只走「新建」这条路 */}
        {mode === 'scan' && (
          <>
            <div className="form-grid" style={{ alignItems: 'center' }}>
              <div className="field">
                <label className="field-label">{t('Engine id', '引擎 id')}</label>
                <input className="control" value={engineId} onChange={(e) => setEngineId(e.target.value)} />
              </div>
              {scan && (
                <div className="field">
                  <label className="field-label">{t('Subcommand', '子命令')}</label>
                  <select className="control" value={subcmd} onChange={(e) => { setSubcmd(e.target.value); autoFill(scan, e.target.value) }}>
                    {(scan.subcommands || []).map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
              <button className="btn btn-sm btn-primary" type="button" disabled={busy || !engineId} onClick={doScan}>
                {busy ? t('Scanning…', '扫描中…') : (scan ? t('Rescan', '重新扫描') : t('Scan parameters', '扫描参数'))}
              </button>
            </div>
            {err && <div className="msg msg-danger">{err}</div>}
          </>
        )}

        {/* ②′ 读取名片后：确认表单里是磁盘原文，需要的话也可以再扫一次 */}
        {mode === 'read' && (
          <>
            <div className="form-grid" style={{ alignItems: 'center' }}>
              <div className="field">
                <label className="field-label">{t('Engine id', '引擎 id')}</label>
                <input className="control" value={engineId} onChange={(e) => setEngineId(e.target.value)} />
              </div>
              <button className="btn btn-sm" type="button" onClick={() => setMode('idle')}>
                {t('Pick another engine', '换一台引擎')}
              </button>
              <button className="btn btn-sm btn-primary" type="button" disabled={busy || !engineId} onClick={doScan}>
                {busy ? t('Scanning…', '扫描中…') : t('Scan parameters', '扫描参数')}
              </button>
            </div>
            <p className="field-hint" style={{ marginTop: 6 }}>
              {t('The manifest on disk is already loaded into the form below. Nothing was cleared. '
                + 'Editing and saving keeps everything already there.',
                '磁盘上的名片原文已灌进下面的表单，原有字段一个都没动。直接改、再保存即可。')}
            </p>
            {err && <div className="msg msg-danger">{err}</div>}
          </>
        )}

        {/* ③ 参数表（扫出来给用户看，已自动填的标出来）*/}
        {scan && scan.ok && args.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <strong className="field-label">{t(`Parameters (${args.length})`, `参数（${args.length} 个）`)}</strong>
            <table className="control" style={{ width: '100%', marginTop: 6, borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted-foreground)' }}>
                  <th style={{ padding: '4px 6px' }}>{t('Flag', '参数')}</th>
                  <th style={{ padding: '4px 6px' }}>{t('Type', '类型')}</th>
                  <th style={{ padding: '4px 6px' }}>{t('Req', '必填')}</th>
                  <th style={{ padding: '4px 6px' }}>{t('Official description', '官方说明')}</th>
                </tr>
              </thead>
              <tbody>
                {args.map(a => (
                  <tr key={a.name} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '4px 6px' }}><code>{a.flag}</code>{a.is_tool && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>{t('tool', '工具')}</span>}</td>
                    <td style={{ padding: '4px 6px' }}>{a.style}</td>
                    <td style={{ padding: '4px 6px' }}>{a.required ? '✓' : ''}</td>
                    <td style={{ padding: '4px 6px', color: 'var(--muted-foreground)' }}>{a.help || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="field-hint" style={{ marginTop: 6 }}>
              {t('Recognized flags are already filled into the call section below. Edit anything the scan missed, then Save.',
                '能认出来的参数已自动填进下面的 call 段。扫描没覆盖的手动补，然后保存。')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ⭐ 从源码反射生成 parameters[] 草稿 + 映射候选（第 4 步）
//
// ⛔⛔ 三条纪律（硬约束，违反即返工）：
//   1. 只填**表单**，⛔ 绝不直接写 manifest.json —— 落盘是用户按「保存」的事
//   2. 映射候选只给候选，**人点选之后**才写 maps，⛔ 绝不自动落盘
//   3. 不新增任何平台侧校验逻辑 —— 界面只展示「反射说了什么」

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ⭐ 主组件 —— 「生成优先」版（2026-10-10 重写，.bak 是旧的字段优先版）
//
// 操作流（Owner 定的）：
//   ① 顶部：从 CLI 扫描生成（新建/读取名片 → 扫描参数 → 参数表 → 自动填）
//   ② 中部：手工编辑（导入已有 / 核心字段 runtime+call+models / 反射生成）
//   ③ 折叠：高级设置（source/capabilities/install/output）+ 参数区 parameters
//
// ⛔ 纪律：只填表单不落盘（落盘是 SaveBar 的事）；活代码不许出现引擎名。
// ---------------------------------------------------------------------------
export default function ManifestForm ({ manifest, onChange, spec }) {
  const { t } = useT()
  const { installed } = useInstalled()

  if (!spec) {
    return <p className="field-hint" style={{ margin: 0 }}>
      {t('Loading field spec…', '正在读字段规格…')}
    </p>
  }

  const set = (k, v) => {
    const next = { ...manifest }
    if (v === undefined || v === '') delete next[k]
    else next[k] = v
    onChange(next)
  }

  const setParam = (i, v) => {
    const list = [...(manifest.parameters || [])]
    list[i] = v
    set('parameters', list)
  }
  const addParam = () => set('parameters', [...(manifest.parameters || []),
    { name: '', type: 'text', tier: 'common' }])
  const delParam = (i) => {
    const list = [...(manifest.parameters || [])]
    list.splice(i, 1)
    set('parameters', list.length ? list : undefined)
  }

  const byGroup = {}
  for (const s of spec.sections) {
    if (s.group === 'parameters') continue
    if (NESTED_GROUPS.includes(s.group)) continue
    ;(byGroup[s.group] = byGroup[s.group] || []).push(s)
  }

  const gLabel = (g) => {
    const L = GROUP_LABELS[g]
    return L ? t(L.en, L.zh) : g
  }

  const CORE_GROUPS = ['runtime', 'call']
  const ADVANCED_GROUPS = ['basics', 'source', 'models', 'capabilities', 'install', 'output']
  const coreSections = GROUP_ORDER.filter((g) => CORE_GROUPS.includes(g) && byGroup[g])
  const advancedSections = GROUP_ORDER.filter((g) => ADVANCED_GROUPS.includes(g) && byGroup[g])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ⭐⭐ ① 生成区 —— 页面主体，放最顶：新建/读取名片 → 扫描 → 参数表 → 自动填 */}
      <CliGenPanel manifest={manifest} onChange={onChange} />

      {/* 反射生成（第二条生成路，读函数签名）*/}

      {/* 核心字段：runtime + call（扫描没覆盖的在这里补）*/}
          {coreSections.map((g) => (
            <div className="section" key={g}>
              <div className="section-hdr"><h2>{gLabel(g)}</h2></div>
              <div className="section-body">
                {byGroup[g].map((s) => (
                  <Field key={s.key} sec={s} value={manifest[s.key]} onChange={(v) => set(s.key, v)} />
                ))}
              </div>
            </div>
          ))}

          {/* models / runtime / call 三段（嵌套编辑器）*/}
          <div className="section">
            <div className="section-hdr"><h2>{gLabel('models')}</h2></div>
            <div className="section-body">
              <ModelsSection value={manifest.models} onChange={(x) => set('models', x)} t={t} />
            </div>
          </div>
          <div className="section">
            <div className="section-hdr"><h2>{gLabel('runtime')}</h2></div>
            <div className="section-body">
              <RuntimeSection value={manifest.runtime} onChange={(x) => set('runtime', x)} t={t} />
            </div>
          </div>
          <div className="section">
            <div className="section-hdr"><h2>{gLabel('call')}</h2></div>
            <div className="section-body">
              <CallSection value={manifest.call} onChange={(x) => set('call', x)} t={t} />
            </div>
          </div>

      {/* ③ 高级设置 + 参数区（折叠）*/}
      {advancedSections.length > 0 && (
        <details className="expert-block">
          <summary className="expert-summary">{t('Advanced settings (optional)', '高级设置（可选）')}</summary>
          <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {advancedSections.map((g) => (
              <div className="section" key={g}>
                <div className="section-hdr"><h2>{gLabel(g)}</h2></div>
                <div className="section-body">
                  {byGroup[g].map((s) => (
                    <Field key={s.key} sec={s} value={manifest[s.key]} onChange={(v) => set(s.key, v)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      <details className="expert-block">
        <summary className="expert-summary">{t('parameters (interface parameters)', 'parameters（界面参数）')}</summary>
        <div style={{ paddingTop: 8 }}>
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t('⚠ These fields all live inside Advanced Settings (collapsed by default); none appear in the main area.',
              '以上参数全部位于 Advanced Settings（默认折叠）内，主区域不会显示。')}
          </p>
          {(manifest.parameters || []).map((p, i) => (
            <ParamRow key={i} entry={p || {}} index={i} spec={spec}
              onChange={setParam} onDelete={delParam} />
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button className="btn btn-sm" type="button" onClick={addParam}>
              + {t('Add a parameter', '添加一个参数')}
            </button>
          </div>
        </div>
      </details>
    </div>
  )
}
