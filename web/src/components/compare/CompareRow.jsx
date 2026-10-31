// 对比页的一行：一条参考音频配置，含目标语种、模型、参考音频、参数与结果。
// 参数格子的键名与类型取自当前引擎的 param_schema；参考音频的时长约束是平台侧的硬约束。
import { useState, useEffect, useRef } from 'react'
import { Select } from '../common/Select'
import { useT } from '../../lib/i18n'
import { API_BASE, api } from '../../lib/api'
import { LANG_LABEL, TextPrepModal, hanOverrideDirection } from '../pron/PronProofing'
import { IconFolder, IconRerun, IconTrash } from '../common/Icons'
import { Player } from '../common/Player'
import { AuxReferencePicker, CrossRefPicker, CustomRefPicker, RefAudioList } from '../common/RefPickers'
import { REF_MAX_SEC, REF_MIN_SEC, refInRange } from '../../lib/refAudio'
import { basename } from '../../lib/pathText'
import { langLabel, normalizeLangFamily } from '../../lib/langOptions'
import { fieldsForTier, isFieldVisible, initialParamValues, coerceParamValue, paramsToSend, TIERS } from '../../lib/engines'
import { slotsOf } from '../../lib/modelPickers.pure.js'
import {
  defaultPicksOf, modelItem, normalizeRowModel, ownerOfModel, referenceSlotOf, referenceVoiceOf,
  slotHeaderText, slotItemText, slotOptions,
} from './compareModelPicks.pure.js'
import { ParamField } from '../common/ParamField'
import { CMP_LANG_OPTIONS, BASE_VOICE_ID } from './compareConstants'

// engineId 供行内读音校对调用 /pron/preview：该接口的 engine_id 必传，漏传时该行的读音预览不产生任何提示。
function CompareRow({ row, index, allAudioFiles, voiceFiles, onUpdate, onAddAux, onRemoveAux, onGenerate, onRemove, onSaveRecipe, recipes, onLoadRecipe, availableModels, rowModel, onModelChange, defaultParams, selectedVoice, voices, voiceLang, defaultTextLang, masterEngineBatch, engineId, engine }) {
  const { t } = useT()
  const [showPicker, setShowPicker] = useState(false)
  const [recipeId, setRecipeId] = useState('')
  const [pickerTarget, setPickerTarget] = useState('main') // 文件选择器的目标：'main'（主参考）或 'aux'（辅助参考）。
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [segments, setSegments] = useState([])  // 当前音色的切片列表，从 /api/assets/<voiceId>/segments 读。
  // 辅助参考与文本默认折叠，只有这一行已经带值时才自动展开，免得已有内容被藏起来。
  const [showAux, setShowAux] = useState(() => (row.auxRefPaths || []).length > 0)
  const [showText, setShowText] = useState(() => !!(row.text && row.text.trim()))
  // 切片改用试听列表：这一行只能从该列表里选参考音频，所以它默认展开。
  const [showSlicePreview, setShowSlicePreview] = useState(true)
  // 辅助参考的来源与自定义状态在共享的 AuxReferencePicker 里，本组件不再单独跟踪。
  // 删除本行结果音频前的二次确认状态。
  const [cmpDelConfirm, setCmpDelConfirm] = useState(false)

  // 这一行的权重位与选择。位名、位标签与个数都来自当前引擎的名片。
  const slots = slotsOf(engine)
  const rm = normalizeRowModel(rowModel, slots)
  // 参考音频、切片与语种跟随第一个能换的位，所以混搭别的位的权重时参考仍取自该位归属的角色。
  const refSlot = referenceSlotOf(slots)
  const voiceId = referenceVoiceOf(rm, slots, selectedVoice)
  // 这一行自己的模型语种。读音校对面板按这一行的模型取，不取生成页共享的音色，这样汉字方向与默认读音与实际发出去的请求一致。
  const rowVoiceLang = availableModels.find(m => m.voiceId === voiceId)?.language
    || voices.find(v => (v.id || v.voiceId) === voiceId)?.language || voiceLang || 'ja'

  // 这一行的目标语种。取行内的值，其次共享默认值；两者都空时跟随音色语种。
  const effTextLang = row.textLang || defaultTextLang || rowVoiceLang || 'ja'
  const _rowTargetFam = normalizeLangFamily(effTextLang)
  const _rowBaseFam = String(rowVoiceLang || '').replace(/^all_/, '')
  // 这一行读音校对面板使用的语系。
  const rowPronLang = _rowTargetFam || _rowBaseFam
  // 这一行逐字强制反向语言的汉字方向，没有则为 null。
  const rowHanDir = hanOverrideDirection(effTextLang, rowVoiceLang)
  const rowHanForced = row.hanForced || []
  const [showRowTextPrep, setShowRowTextPrep] = useState(false)
  // 参考来源：'slices'（本音色的切片，默认）、'cross'（别的音色）、'custom'（自备文件）。
  const refSource = row.refSource || 'slices'
  const setRefSource = (v) => onUpdate(row.id, 'refSource', v)

  // 当前主参考的时长，跨所有来源解析（本音色切片、别的音色切片、原始音频、自备上传），用于在超出 3 到 10 秒区间时提前警告。
  const [refDur, setRefDur] = useState(null)
  useEffect(() => {
    const ref = row.refAudio || ''
    setRefDur(null)
    if (!ref) return
    // 本音色的切片自带服务端测好的时长，直接取。
    const slice = segments.find(s => {
      const raw = s.audio || s.audio_path || s.audio_filename
      const fn = raw ? raw.replace(/\\/g, '/').split('/').pop() : ''
      return ref === `assets/${voiceId}/slicer_opt/${fn}`
    })
    if (slice && typeof slice.duration === 'number' && slice.duration > 0) { setRefDur(slice.duration); return }
    // 其余来源用离屏 audio 元素测量可播放的地址。测不出来的来源保持 null，避免误报警。
    let url = null
    if (/^assets\//.test(ref)) url = `/${ref}`
    else if (row.customRef && row.customRef.url) url = row.customRef.url
    if (!url) return
    let cancelled = false
    const a = new Audio()
    a.preload = 'metadata'
    const onMeta = () => { if (!cancelled && isFinite(a.duration) && a.duration > 0) setRefDur(a.duration) }
    a.addEventListener('loadedmetadata', onMeta)
    a.src = url
    return () => { cancelled = true; a.removeEventListener('loadedmetadata', onMeta); a.src = '' }
  }, [row.refAudio, segments, voiceId, row.customRef])
  const refOutOfRange = refDur != null && !refInRange(refDur)

  // 音色变化时重新加载切片。
  useEffect(() => {
    if (!voiceId) return
    api(`/api/assets/${voiceId}/segments`).then(r => {
      if (r.ok && r.data.segments) setSegments(r.data.segments.segments || [])
    }).catch(() => setSegments([]))
  }, [voiceId])

  // 切片加载完成后自动选第一条可用的切片作为默认参考。
  useEffect(() => {
    if (segments.length === 0) return
    if ((row.refSource || 'slices') !== 'slices') return  // 不覆盖用户已选的跨音色或自备参考
    if (row.refAudio) return  // 已经选过参考就不改
    const first = segments.find(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
    if (first) {
      const raw = first.audio || first.audio_path || first.audio_filename
      if (!raw) return
      const filename = raw.replace(/\\/g, '/').split('/').pop()
      onUpdate(row.id, 'refAudio', `assets/${voiceId}/slicer_opt/${filename}`)
    }
  }, [segments, voiceId])

  // 超参不手抄：键名与类型都来自当前引擎的 param_schema。改用别的引擎时，格子照样显示、填了也照样发出去，上游不认这个键且不报错。
  //
  // 两个 state 的形状与生成页一致：
  //   paramValues   这一行的格子值，从名片默认值起步
  //   touched       用户明确动过的键名，paramsToSend 只发这些
  // touched 不能省：没动过的键是界面建议，不是用户的选择，全发过去等于平台替用户决定上游默认值。
  const [paramValues, setParamValues] = useState(() => ({
    ...initialParamValues(engine),
    ...(row.params || {}),
  }))
  // row.params 里存的都是用户动过的（当初就是从 touched 存下来的），所以从配方或旧行恢复出来的值天然算 touched。
  const [touched, setTouched] = useState(() => new Set(Object.keys(row.params || {})))
  const setParam = (name, raw) => {
    const field = (engine?.param_schema || []).find(f => f && f.name === name)
    setParamValues(v => ({ ...v, [name]: field ? coerceParamValue(field, raw) : raw }))
    setTouched(prev => {
      const next = new Set(prev); next.add(name); return next
    })
  }
  // 换引擎后上一台的键名不适用于这台，重新从名片默认值起步。touched 一并清空：那些键名属于上一台引擎，跟着过来等于用户在新引擎上选过旧引擎的参数。
  useEffect(() => {
    setParamValues(initialParamValues(engine))
    setTouched(new Set())
  }, [engine?.id])

  // 存回 row：只存用户动过的那些（params 是发出去的形状，touched 是动过的键名）。
  // touched 必须是可还原的数组，不能只留在本组件的 state 里：生成请求在页签一级读 row，拿不到这一行的局部 state。
  useEffect(() => {
    const explicit = paramsToSend(engine, paramValues, touched)
    onUpdate(row.id, 'params', explicit)
    onUpdate(row.id, 'touched', Array.from(touched))
  }, [paramValues, touched, engine?.id])

  // seed 不属于任何一台引擎，不进 param_schema，是平台自己的 state。判据：换一台引擎，这一格的含义一个字都不变。
  const [seed, setSeed] = useState(row.seed ?? defaultParams?.seed ?? -1)
  useEffect(() => { onUpdate(row.id, 'seed', seed) }, [seed])

  // 不能只取 common 一层：有些引擎的 param_schema 里 common 层是空的，只画 common 时选它们一个格子都没有，而界面上看不出任何异常。
  //
  // 两档都画，档位名单取自 TIERS（唯一产地是 web/src/lib/engines.js），不另写一份。
  const [advTier, setAdvTier] = useState('common')
  const visibleFields = (tier) => fieldsForTier(engine, tier)
    .filter(f => isFieldVisible(f, paramValues))
  // 某一档一个格子都没有时不画那个档位按钮：点开是空的标签页，比不画更糟。
  // 名片没给的东西，界面不替它编。
  const tiersWithFields = TIERS.filter(t => visibleFields(t).length > 0)
  // 当前档被换引擎换空时落到第一个有格子的档，不停在空档上。
  const effTier = tiersWithFields.includes(advTier) ? advTier : (tiersWithFields[0] || 'common')

  const allFiles = [...allAudioFiles, ...voiceFiles]

  // 行状态与表头摘要，全部由行内已有状态推导，不新增 state。
  const cmpStatus = row.loading ? 'running' : row.error ? 'error' : (row.result && row.result.audio_url) ? 'done' : 'idle'
  const cmpStatusLabel = cmpStatus === 'running' ? 'Generating…' : cmpStatus === 'done' ? 'Ready' : cmpStatus === 'error' ? 'Failed' : 'Not run'
  const cmpRefName = row.refAudio ? basename(row.refAudio) : null
  // 角色名：候选清单里查得到就用它的显示名，其次音色名单，最后原样。
  const nameForVoiceId = (vid) => vid
    ? ((availableModels.find(m => m.voiceId === vid) || {}).voiceName
       || (voices || []).find(v => (v.id || v.voiceId) === vid)?.display_name
       || (voices || []).find(v => (v.id || v.voiceId) === vid)?.displayName
       || vid)
    : null
  // 表头摘要：同一角色内的组合按位拼完整标注；跨角色混搭时逐段取归属角色与该位的文字。
  const _sameVoice = rm.voiceId && slots.length > 0
    && slots.every(s => modelItem(availableModels, rm.voiceId, s.name, rm.picks[s.name]))
  const cmpModelLabel = _sameVoice
    ? `${nameForVoiceId(rm.voiceId)} / ${slots.map(s => slotItemText(modelItem(availableModels, rm.voiceId, s.name, rm.picks[s.name]))).join(' / ')}`
    : (slots.map(s => {
        const p = rm.picks[s.name]
        const owner = ownerOfModel(availableModels, s.name, p)
        if (!p || !owner) return null
        return `${nameForVoiceId(owner)} / ${slotHeaderText(modelItem(availableModels, owner, s.name, p)) || p}`
      }).filter(Boolean).join('  ×  ') || null)
  // 参考音频来自哪个角色：从 row.refAudio 的 assets/<voiceId>/ 路径推出，本音色与跨音色都适用。自备上传不在 assets/ 下，标为 Custom；没有参考时回落到模型音色。
  const _refAssetVid = (() => {
    const s = String(row.refAudio || '').replace(/\\/g, '/')
    const m = s.match(/(?:^|\/)assets\/([^/]+)\//)
    return m ? m[1] : null
  })()
  const refVoiceName = _refAssetVid
    ? nameForVoiceId(_refAssetVid)
    : (row.refAudio ? 'Custom' : nameForVoiceId(rm.voiceId || selectedVoice))
  // 生成之后编辑区折叠为只显示音频，便于并排试听；点标题重新展开。
  const [editorOpen, setEditorOpen] = useState(() => !(row.result && row.result.audio_url))
  const lastResultUrlRef = useRef(row.result && row.result.audio_url)
  useEffect(() => {
    const url = row.result && row.result.audio_url
    if (url && url !== lastResultUrlRef.current) { setEditorOpen(false) }
    lastResultUrlRef.current = url
  }, [row.result && row.result.audio_url])

  const pickFile = (filePath) => {
    if (pickerTarget === 'main') {
      onUpdate(row.id, 'refAudio', filePath)
    } else {
      onAddAux(row.id, filePath)
    }
    setShowPicker(false)
  }

  return (
    <div className={`card cmp-row cmp-${cmpStatus}`} style={{ position: 'relative' }}>
      {/* 表头：序号徽章、参考与模型摘要、状态标签。 */}
      <div className="cmp-row-hdr">
        <span className="cmp-badge">{index + 1}</span>
        <div className="cmp-summary">
          <span className="cmp-summary-ref" title={row.refAudio || ''}>
            {cmpRefName || 'No reference selected'}
          </span>
          {/* 参考音频的角色名。 */}
          {refVoiceName && (
            <span className="cmp-summary-voice" title={`Reference character: ${refVoiceName}`}
              style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>🎭 {refVoiceName}</span>
          )}
          {cmpModelLabel && (
            <span className="cmp-summary-model" title={cmpModelLabel}>{cmpModelLabel}</span>
          )}
        </div>
        <span className={`cmp-status cmp-status-${cmpStatus}`}>{cmpStatusLabel}</span>
        <div className="cmp-row-actions">
          {/* 折叠或展开编辑区。 */}
          <button className="btn btn-sm btn-ghost" onClick={() => setEditorOpen(o => !o)}
            title={editorOpen ? 'Collapse editor (keep audio only)' : 'Expand editor'}>
            {editorOpen ? '▲ Edit' : '▼ Edit'}
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => onGenerate(row)} disabled={row.loading}>
            {row.loading ? '…' : (cmpStatus === 'done' ? 'Regenerate' : 'Generate')}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => onSaveRecipe && onSaveRecipe(row)}
            disabled={!selectedVoice || !row.refAudio}
            title={!row.refAudio ? 'Pick a reference audio first' : 'Save this row as a reusable recipe'}>
            Save as recipe
          </button>
          <Select className="control" value={recipeId} onChange={e=>setRecipeId(e.target.value)} style={{width:155,height:30}}><option value="">Load recipe…</option>{(recipes||[]).map(r=><option key={r.id} value={r.id}>{r.display_name||r.id}</option>)}</Select>
          <button className="btn btn-sm btn-ghost" disabled={!recipeId} onClick={()=>onLoadRecipe?.(row,recipeId)}>Load</button>
          <button className="btn btn-sm btn-danger" onClick={() => onRemove(row.id)} title="Remove from comparison">×</button>
        </div>
      </div>

      {/* 参考时长警告：引擎把参考音频限制在 3 到 10 秒，超界的片段合成时基本会失败。放在可折叠区之外，生成后折叠成只显示音频时也仍然可见。 */}
      {refOutOfRange && (
        <div className="cmp-ref-range-warn" style={{ fontSize: 'var(--fs-11)', color: 'var(--warning)', margin: '0 0 8px' }}>
          {'\u26a0'} Reference audio is {refDur.toFixed(1)}s &mdash; outside the {REF_MIN_SEC}&ndash;{REF_MAX_SEC}s range. This row will likely error (engine hard limit); pick a {REF_MIN_SEC}&ndash;{REF_MAX_SEC}s clip.
        </div>
      )}

      {/* 编辑区：语种、模型、参考音频与高级设置，生成后默认折叠。 */}
      {editorOpen && (<>
      {/* 目标语种放在条目顶部，用窄下拉单行显示。 */}
      <div className="field cmp-target-lang" style={{ maxWidth: 240, marginBottom: 8 }}>
        <label className="field-label">Target Language</label>
        <Select
          className="control"
          value={row.textLang || ''}
          onChange={e => onUpdate(row.id, 'textLang', e.target.value)}
        >
          <option value="">Use default ({langLabel(defaultTextLang)})</option>
          {CMP_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </div>

      {/* 模型拆成「角色 + 每个权重位一个下拉」：角色决定非混搭时的候选与切片来源，
          每个下拉的标签与候选都来自名片。 */}
      {availableModels.length > 0 && slots.length > 0 && (() => {
        const voiceOpts = []
        const seenV = new Set()
        availableModels.forEach(m => { if (!seenV.has(m.voiceId)) { seenV.add(m.voiceId); voiceOpts.push({ voiceId: m.voiceId, voiceName: m.voiceName }) } })
        const groupsFor = (slotName) => voiceOpts.map(v => ({
          voiceId: v.voiceId, voiceName: v.voiceName, items: slotOptions(availableModels, slotName, v.voiceId),
        })).filter(g => g.items.length)
        // 跨角色混搭：打开后每个位的下拉列出所有角色的权重（按角色分组），关闭时只列主角色的。
        // 已经是跨角色的组合（来自配方或旧行）自动进入混搭状态，保留原有选择。
        const mix = !!rm.mix || slots.some(s => rm.owners[s.name] && rm.owners[s.name] !== rm.voiceId)
        const picksOf = (vid) => defaultPicksOf(slots, availableModels.find(m => m.voiceId === vid))
        const pickVoice = (vid) => {
          if (!vid) { onModelChange({ voiceId: '', picks: {}, owners: {}, mix }); return }
          // 换主角色会清掉已有的跨角色覆盖。
          onModelChange({ voiceId: vid, picks: picksOf(vid), owners: {}, mix })
          // 底模自己没有切片：选它时直接切到跨角色参考选择器，用户立刻就能借一条参考。
          if (vid === BASE_VOICE_ID && (row.refSource || 'slices') === 'slices') setRefSource('cross')
        }
        // 选某个位的权重：推出它归属的角色，混搭标记与参考跟随逻辑才对得上。
        const pickSlot = (slotName, path) => {
          const owner = ownerOfModel(availableModels, slotName, path)
          const owners = { ...rm.owners }
          if (owner && owner !== rm.voiceId) owners[slotName] = owner
          else delete owners[slotName]
          onModelChange({ ...rm, picks: { ...rm.picks, [slotName]: path }, owners })
          // 混搭下参考位换到没有切片的角色时，切到跨角色参考选择器。
          if (mix && slotName === refSlot && owner === BASE_VOICE_ID && (row.refSource || 'slices') === 'slices') setRefSource('cross')
        }
        const toggleMix = (on) => {
          if (on) { onModelChange({ ...rm, mix: true }); return }
          // 退出混搭模式时，组合收回到主角色上。
          onModelChange({ ...rm, mix: false, picks: picksOf(rm.voiceId), owners: {} })
        }
        const modelsMixed = slots.some(s => rm.owners[s.name] && rm.owners[s.name] !== rm.voiceId)
        const refSlotLabel = refSlot ? ((slots.find(s => s.name === refSlot) || {}).label || refSlot) : ''
        // 混搭示例用名片上的位名。
        const _ex = slots.slice(0, 2)
        const mixExampleZh = _ex.length === 2 ? `（例如 A 的 ${_ex[0].label} + B 的 ${_ex[1].label}）` : ''
        const mixExampleEn = _ex.length === 2 ? ` (e.g. A’s ${_ex[0].label} + B’s ${_ex[1].label})` : ''
        return (
          <div className="cmp-model-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '0 1 170px', minWidth: 130, marginBottom: 0 }}>
              <label className="field-label">Voice ID</label>
              <Select className="control" value={rm.voiceId || ''} onChange={e => pickVoice(e.target.value)}
                title={rm.voiceId || ''}>
                <option value="">— default —</option>
                {voiceOpts.map(v => <option key={v.voiceId} value={v.voiceId}>{v.voiceName}</option>)}
              </Select>
            </div>
            {slots.map(s => {
              const picked = rm.picks[s.name] || ''
              const cross = rm.owners[s.name] && rm.owners[s.name] !== rm.voiceId
              return (
                <div key={s.name} className="field" style={{ flex: '1 1 240px', minWidth: 180, marginBottom: 0 }}>
                  <label className="field-label">{s.label}{cross ? ' *' : ''}</label>
                  <Select className="control" value={picked} disabled={!mix && !rm.voiceId}
                    title={picked}
                    onChange={e => pickSlot(s.name, e.target.value)}>
                    {mix
                      ? groupsFor(s.name).map(g => (
                          <optgroup key={g.voiceId} label={g.voiceName}>
                            {g.items.map(it => <option key={it.path} value={it.path}>{slotItemText(it)}</option>)}
                          </optgroup>
                        ))
                      : (() => {
                          // 未选角色时没有「本角色的候选」，画空占位而不是把全部角色的权重列出来。
                          const opts = slotOptions(availableModels, s.name, rm.voiceId)
                          return opts.length === 0
                            ? <option value="">—</option>
                            : opts.map(it => <option key={it.path} value={it.path}>{slotItemText(it)}</option>)
                        })()}
                  </Select>
                </div>
              )
            })}
            <label className="cmp-mix-toggle" style={{ flexBasis: '100%', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', marginBottom: 0, cursor: 'pointer' }}
              title={t(`Mix models across assets — pick each weight slot from any voice independently${mixExampleEn}.`,
                       `跨资产混搭模型：每个权重位可分别从任意音色中独立选择${mixExampleZh}。`)}>
              <input type="checkbox" checked={mix} onChange={e => toggleMix(e.target.checked)} />
              <span>{t('Mix models across assets', '跨资产混搭模型')}</span>
            </label>
            {modelsMixed && refSlotLabel && (
              <div className="field-hint" style={{ flexBasis: '100%', color: 'var(--warning)', marginBottom: 0 }}>
                {t(`Mixed stack across assets — reference audio & language follow the ${refSlotLabel} side.`,
                   `跨资产混搭：参考音频与语言跟随 ${refSlotLabel} 侧。`)}
              </div>
            )}
          </div>
        )
      })()}

      {/* 主参考音频：来源选择器，本音色、别的音色或自备文件。 */}
      <div className="field">
        <label className="field-label">Main Reference Audio</label>
        <Select
          className="control"
          value={refSource}
          onChange={e => {
            const v = e.target.value
            setRefSource(v)
            // 换来源时清掉当前选择，避免留下上一来源的路径。
            onUpdate(row.id, 'refAudio', '')
            onUpdate(row.id, 'promptText', '')
            onUpdate(row.id, 'promptLang', '')
            if (v !== 'custom') onUpdate(row.id, 'customRef', null)
          }}
          style={{ marginBottom: 6 }}
        >
          <option value="slices">This voice's slices</option>
          <option value="cross">Another voice's reference</option>
          <option value="custom">Custom file…</option>
        </Select>
        {refSource === 'slices' && (
          <>
            {/* 试听列表是这一行唯一的切片选择器，默认展开，也提供原始音频。3 到 10 秒的越界提示放在始终可见的表头里（覆盖所有参考来源），每条试听项另带自己的标记。 */}
            <div className="collapsible" style={{ marginTop: 6 }}>
              <div className="collapsible-hdr" onClick={() => setShowSlicePreview(v => !v)}>
                <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--muted)' }}>Audition reference &mdash; Slices / Raw (click one to set it as the main reference)</span>
                <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>{showSlicePreview ? '\u25b2' : '\u25bc'}</span>
              </div>
              {showSlicePreview && (
                <div className="collapsible-body">
                  <RefAudioList
                    voiceId={voiceId}
                    selectMode="single"
                    activeRef={row.refAudio}
                    onPick={(path, text) => { onUpdate(row.id, 'refAudio', path); onUpdate(row.id, 'promptText', text || '') }}
                  />
                </div>
              )}
            </div>
          </>
        )}
        {refSource === 'cross' && (
          <CrossRefPicker
            voices={voices}
            currentVoiceId={voiceId}
            activeRef={row.refAudio}
            onPick={(path, text) => { onUpdate(row.id, 'refAudio', path); onUpdate(row.id, 'promptText', text || '') }}
          />
        )}
        {refSource === 'custom' && (
          <CustomRefPicker
            custom={row.customRef || null}
            onPick={(path, text, plang, obj) => {
              if (obj) onUpdate(row.id, 'customRef', obj)
              onUpdate(row.id, 'refAudio', path)
              onUpdate(row.id, 'promptText', text || '')
              onUpdate(row.id, 'promptLang', plang || '')
            }}
            onClear={() => { onUpdate(row.id, 'customRef', null); onUpdate(row.id, 'refAudio', ''); onUpdate(row.id, 'promptText', ''); onUpdate(row.id, 'promptLang', '') }}
          />
        )}
      </div>

      {/* 辅助参考音频：可折叠，来源为本音色、别的音色或自备上传。选中的条目不提供试听。 */}
      <div className="field">
        <div className="collapsible-hdr" style={{ padding: 0 }} onClick={() => setShowAux(v => !v)}>
          <label className="field-label" style={{ margin: 0, cursor: 'pointer' }}>
            Auxiliary References
            <span style={{ fontWeight: 400, fontSize: 'var(--fs-11)', color: 'var(--muted)', marginLeft: 6 }}>
              (optional{row.auxRefPaths.length > 0 ? ` · ${row.auxRefPaths.length} selected` : ''})
            </span>
          </label>
          <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>{showAux ? '▲' : '▼'}</span>
        </div>
        {showAux && (
          <AuxReferencePicker
            voiceId={voiceId}
            voices={voices}
            value={row.auxRefPaths}
            mainRef={row.refAudio}
            onAdd={(path) => onAddAux(row.id, path)}
            onRemove={(idx) => onRemoveAux(row.id, idx)}
          />
        )}
      </div>

      {/* 这一行自己的文本：可折叠，默认空。 */}
      <div className="field">
        <div className="collapsible-hdr" style={{ padding: 0 }} onClick={() => setShowText(v => !v)}>
          <label className="field-label" style={{ margin: 0, cursor: 'pointer' }}>
            Text
            <span style={{ fontWeight: 400, fontSize: 'var(--fs-11)', color: 'var(--muted)', marginLeft: 6 }}>
              {row.text && row.text.trim() ? '(custom)' : '(leave empty for default)'}
            </span>
          </label>
          <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>{showText ? '▲' : '▼'}</span>
        </div>
        {showText && (
          <>
            <input
              className="control"
              style={{ marginTop: 4 }}
              value={row.text}
              onChange={e => onUpdate(row.id, 'text', e.target.value)}
              placeholder="Enter test text (empty = this voice's default)…"
            />
            {/* 这一行的读音校对与逐字汉语言种：覆盖只作用于本行，存为配方时一并钉住。在共享的文本准备弹窗里设置。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={() => setShowRowTextPrep(true)}>
                Proof &amp; language{'\u2026'}
              </button>
              {rowHanDir && rowHanForced.length > 0 && (
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--accent)' }}>{rowHanForced.length} forced {LANG_LABEL[rowHanDir.reverse]}</span>
              )}
              {Object.keys(row.pronOverrides || {}).length > 0 && (
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--accent)' }}>{Object.keys(row.pronOverrides).length} reading override(s)</span>
              )}
              <span style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>this row only</span>
            </div>
            {showRowTextPrep && (
              <TextPrepModal
                onClose={() => setShowRowTextPrep(false)}
                text={row.text} setText={v => onUpdate(row.id, 'text', v)} panelLang={rowPronLang}
                pronOverrides={row.pronOverrides || {}} setPronOverrides={o => onUpdate(row.id, 'pronOverrides', o)}
                hanDirection={rowHanDir} hanForced={rowHanForced} setHanForced={f => onUpdate(row.id, 'hanForced', f)}
                hanReadings={row.hanReadings || {}} setHanReadings={r => onUpdate(row.id, 'hanReadings', r)}
                engineId={engineId}
              />
            )}
          </>
        )}
      </div>

      {/* 高级设置。 */}
      <div className="collapsible" style={{ margin: '6px 0' }}>
        <div className="collapsible-hdr" onClick={() => setShowAdvanced(!showAdvanced)}>
          <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--muted)' }}>Advanced Settings</span>
          <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>{showAdvanced ? '▲' : '▼'}</span>
        </div>
        {showAdvanced && (
          <div className="collapsible-body">
            <div className="form-grid">
              {/* 按 engine.param_schema 循环，与生成页共用同一个 ParamField，这里不再分叉出按类型写死的输入框：那样换一台引擎会让格子照样显示、填了发出去上游不认且不报错。两档都画（跟着 TIERS），因为有些引擎的 common 层是空的，只画 common 时选它们一个格子都没有。不传 options：ParamField 只在 select 加 source 时用它（候选项要扫盘），写死 choices 的格子自取 field.choices。这一页不扫权重、音色与音频，那是生成页的职责。 */}
              {/* 档位按钮取自 TIERS。写死两档就是第二份「有几档」的事实。 */}
              {tiersWithFields.length > 1 && (
                <div style={{ display: 'flex', gap: 6, gridColumn: '1 / -1' }}>
                  {tiersWithFields.map(tier => (
                    <button key={tier} type="button" className="btn btn-sm"
                      onClick={() => setAdvTier(tier)}
                      style={{ background: effTier === tier ? 'var(--accent)' : 'var(--surface)',
                               color: effTier === tier ? '#fff' : 'var(--muted)' }}>
                      {tier}
                    </button>
                  ))}
                </div>
              )}

              {visibleFields(effTier).map(f => (
                <ParamField key={f.name}
                  field={f}
                  values={paramValues}
                  onChange={setParam}
                  lang={voiceLang}
                  t={t} />
              ))}

              {/* seed 不在 param_schema 里：它不是任何一台引擎的参数，是平台自己的开关。判据：换一台引擎，这一格的含义一个字都不变。 */}
              <div>
                <label className="field-label">Seed (-1 = random)</label>
                <input type="number" className="control" value={seed} onChange={e => setSeed(parseInt(e.target.value) || -1)} />
              </div>
              <div title={t('Engine batch for THIS row. Inherit = follow the master switch above. On = whole text in one parallel-batched engine call (single audio, no per-segment files). Off = keep the sequential per-segment path.', '本行的引擎批量。继承=跟随上方总开关；开=整段一次性并行批量合成（单个音频、无分段文件）；关=保持逐段串行。')}>
                <label className="field-label">{t('Engine Batch (parallel)', '引擎批量并行')}</label>
                <Select className="control" value={row.engine_batch || 'inherit'} onChange={e => onUpdate(row.id, 'engine_batch', e.target.value)}>
                  <option value="inherit">{t(`Inherit (${masterEngineBatch ? 'On' : 'Off'})`, `继承（${masterEngineBatch ? '开' : '关'}）`)}</option>
                  <option value="on">{t('On', '开')}</option>
                  <option value="off">{t('Off', '关')}</option>
                </Select>
              </div>
              {/* 这一行走哪个推理入口。名片没声明多个方法时不画这个下拉：只有一个选项的下拉只是噪声，而名片没说的东西界面不替它编。 */}
              {Array.isArray(engine?.methods) && engine.methods.length > 0 && (
                <div title={t('Which inference entrypoint THIS row uses. Only engines whose manifest declares call.methods offer more than one.', '此行使用哪个推理入口。仅当引擎的清单声明了 call.methods 时才提供多个选项。')}>
                  <label className="field-label">{t('Method', '推理方法')}</label>
                  <Select className="control" value={row.method || engine.default_method || engine.methods[0]} onChange={e => onUpdate(row.id, 'method', e.target.value)}>
                    {engine.methods.map(m => <option key={m} value={m}>{m}</option>)}
                  </Select>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      </>)}

      {/* 文件选择器。 */}
      {showPicker && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-soft)',
          maxHeight: 240, overflow: 'auto', marginBottom: 4,
        }}>
          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>
            Select {pickerTarget === 'main' ? 'main reference' : 'auxiliary'} audio ({allFiles.length} files)
          </div>
          {allFiles.map(f => (
            <div
              key={f.path}
              onClick={() => pickFile(f.path)}
              style={{
                padding: '6px 10px', fontSize: 'var(--fs-12)', cursor: 'pointer',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: '1px solid var(--border)',
              }}
              onMouseEnter={e => e.target.style.background = 'var(--accent-soft)'}
              onMouseLeave={e => e.target.style.background = 'transparent'}
            >
              <span>{f.name}</span>
              <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-11)' }}>{f.duration.toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}

      {/* 结果区与输出管理按钮，与生成页一致。合成接口返回真实的 outputs/generate/<id>/，所以定位目录与删除可以复用。重跑按本行当前设置重新生成。 */}
      {row.result && row.result.audio_url && (
        <div className="cmp-result">
          <div className="cmp-result-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Result{refVoiceName ? ` · 🎭 ${refVoiceName}` : ''}</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {row.result.id && (
                <button className="icon-btn" title="Show in file explorer"
                  onClick={async () => { const r = await api('/api/outputs/reveal', { method: 'POST', body: { id: row.result.id, source: 'comparerefs' } }); if (!r.ok) onUpdate(row.id, 'error', (r.data && r.data.error) || 'Could not open the file location') }}>
                  <IconFolder size={15} /></button>
              )}
              <button className="icon-btn" title="Rerun with this row's current settings"
                disabled={row.loading} onClick={() => onGenerate(row)}>
                <IconRerun size={15} /></button>
              {row.result.id && (
                cmpDelConfirm
                  ? (
                    <>
                      <button className="icon-btn icon-btn-danger" title="Confirm delete"
                        onClick={async () => { const r = await api(`/api/outputs/${encodeURIComponent(row.result.id)}?source=comparerefs`, { method: 'DELETE' }); setCmpDelConfirm(false); if (!r.ok) { onUpdate(row.id, 'error', (r.data && r.data.error) || 'Failed to delete audio'); return } onUpdate(row.id, 'result', null) }}>✓</button>
                      <button className="icon-btn" title="Cancel" onClick={() => setCmpDelConfirm(false)}>✕</button>
                    </>
                  )
                  : (
                    <button className="icon-btn icon-btn-danger" title="Delete this audio from disk"
                      onClick={() => setCmpDelConfirm(true)}><IconTrash size={15} /></button>
                  )
              )}
            </div>
          </div>
          <Player src={`${API_BASE}${row.result.audio_url}`} size="sm" bounds={row.result.segment_bounds} duration={row.result.duration} />
          <div className="cmp-result-meta">
            <a href={`${API_BASE}${row.result.audio_url}`} download style={{ color: 'var(--accent)', fontSize: 'var(--fs-12)' }}>Download</a>
            {row.result.segments && <span style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>{row.result.segments.length} segments</span>}
          </div>
        </div>
      )}

      {row.error && (
        <div className="msg msg-error" style={{ marginTop: 6 }}>{row.error}</div>
      )}
    </div>
  )
}

export { CompareRow }
