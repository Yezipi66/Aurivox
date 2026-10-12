import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Select } from '../common/Select'
import { api } from '../../lib/api'
import { FsFilePicker } from '../common/Dialogs'
import { basename, TARGET_LANG_OPTIONS } from '../../lib/format'
import { usePreviewMode } from '../../lib/previewMode'
import { useT } from '../../lib/i18n'
import { usePersistentState } from '../../usePersistentState'
import { BrokerApiNoteCard, BrokerApiNotePill } from '../common/Fields'
import { modelCountsByEngine, paramsSummaryOf } from '../../lib/modelPickers.pure.js'

// 权重文件的扩展名，不写死成 .ckpt / .pth（那是 GPT-SoVITS 的形状）。
// 一台非 GSV 引擎的权重可能是 .safetensors / .onnx / .pt / .bin，
// 过滤太窄的后果是：自定义路径那一栏的「浏览」**看不到文件**，
// 而界面上没有任何一句话解释为什么。
const WEIGHT_EXTS = ['.ckpt', '.pt', '.pth', '.bin', '.safetensors', '.onnx', '.bin']

// PC — Broker model re-bind with a two-level selector:
//   1. primary  = every voice that owns a model of this type (voices-with-models)
//   2. secondary = that voice's GPT ckpts / SoVITS pths (recipes-models/:voiceId)
// plus a "— custom path below —" escape hatch that opens the file picker.
export function RecipeModelRebind({ recipe, onSaved }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [voicesList, setVoicesList] = useState(null)   // [{voiceId, displayName, engines, models}]
  const [gpt, setGpt] = useState(recipe.gpt_ckpt || '')
  const [sovits, setSovits] = useState(recipe.sovits_pth || '')
  // 7.1: a single shared Voice ID drives both the GPT and SoVITS model lists (one row, three dropdowns).
  // Cross-voice mixing is still possible via each model slot's "custom path" escape hatch (D2).
  const [voice, setVoice] = useState(recipe.role || '')
  // 这两个下拉渲染的是「这台引擎在这个资产上有的前两个模型位」，
  //   位名由后端给出（slotNames），不写死成 'gpt' / 'sovits'。
  //   变量名 gpt*/sovits* 留着是为了不碰配方那两个字段名（gpt_ckpt /
  //   sovits_pth，格式这轮不动），但它们现在只是「第 0 位 / 第 1 位」。
  const [slotNames, setSlotNames] = useState([])
  const [gptModels, setGptModels] = useState([])
  const [sovitsModels, setSovitsModels] = useState([])
  const [gptCustom, setGptCustom] = useState(false)
  const [sovitsCustom, setSovitsCustom] = useState(false)
  const [pickGpt, setPickGpt] = useState(false)
  const [pickSovits, setPickSovits] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)
  const modelCache = useRef({})

  // 这个「换模型」小面板改的是配方顶层那两个权重字段，配方格式这轮不动
  //   （Owner 2026-08-30），所以它只装得下**两个**位。
  //
  // 2026-10-01：过去这里是 `REBIND_ENGINE = 'gpt-sovits'` 写死，位名也写死
  //   成 'gpt' / 'sovits'，连文件选择器的扩展名都是 .ckpt / .pth。后果：
  //   一台 CosyVoice 的资产在 Broker 里**连一个模型位都列不出来**，
  //   而界面上看起来只是「这个音色没模型」，没有任何一句说「因为这里写死了引擎」。
  //
  //   现在引擎和位名都问后端要：/api/recipes-models/:role 的返回体里
  //   **已经有** engines（这个资产实际有模型的引擎，lib/assets/modelLayout.js
  //   的 enginesInMeta 算出来的）和 models[<engineId>][<slot>]。
  //   前端不猜引擎有哪些位，后端给什么位就渲染什么位。
  const loadVoiceModels = async (voiceId) => {
    if (!voiceId) return { engines: [], slots: {}, bySlot: {} }
    if (modelCache.current[voiceId]) return modelCache.current[voiceId]
    const r = await api(`/api/recipes-models/${encodeURIComponent(voiceId)}`)
    // 返回体是「按引擎分组、按位分组」的三层结构。
    const engines = (r.ok && Array.isArray(r.data && r.data.engines)) ? r.data.engines : []
    const models = (r.ok && r.data && r.data.models) || {}
    const m = { engines, slots: models, bySlot: {} }
    modelCache.current[voiceId] = m
    return m
  }

  // 这个配方现在正在用哪台引擎：配方自己**没有** engine_id（配方格式这轮不动），
  //   所以身份是从它钉的那份权重反查出来的，那份权重属于谁，就是哪台引擎。
  //   找不到就 null，让调用方说人话，别默默退回第一台引擎（那等于把
  //   一台引擎的权重发给另一台）。
  const engineOfRecipe = (voiceId) => {
    const m = modelCache.current[voiceId]
    if (!m) return null
    const pinned = [recipe.gpt_ckpt, recipe.sovits_pth].map(x => (x && typeof x === 'object') ? x.path : x).filter(Boolean)
    for (const eid of m.engines) {
      const slots = m.slots[eid] || {}
      for (const list of Object.values(slots)) {
        if ((list || []).some(x => x && pinned.includes(x.path))) return eid
      }
    }
    return null
  }

  // 这台引擎在这个资产上到底有哪几个位，由后端给的列表决定，不猜。
  //   （GSV ⇒ ['gpt','sovits']；CosyVoice ⇒ ['model']；别的形状就按它的来。）
  const slotNamesOf = (m, engineId) => Object.keys((m && m.slots && m.slots[engineId]) || {})

  const load = async () => {
    if (voicesList) return
    const r = await api('/api/assets/voices-with-models')
    setVoicesList(r.ok ? (r.data.voices || []) : [])
    // Seed both slots from the recipe's own voice; if the pinned file isn't one
    // of that voice's known models, start in custom mode.
    const m = await loadVoiceModels(recipe.role)
    const eid = engineOfRecipe(recipe.role)
    const slots = slotNamesOf(m, eid)
    const slotMap = (m.slots && m.slots[eid]) || {}
    // 配方顶层只有 gpt_ckpt / sovits_pth 两个字段（格式这轮不动），所以这里
    //   取的是「这台引擎的前两个位」，按后端给的顺序，不按名字猜。
    const [s0, s1] = slots
    setSlotNames([s0, s1].filter(Boolean))
    const list0 = (s0 && slotMap[s0]) || []
    const list1 = (s1 && slotMap[s1]) || []
    setGptModels(list0); setSovitsModels(list1)
    // pinned 是 v3 的 { base, path } 还是 v2 的裸字符串，两种都吃。
    const pinned = [recipe.gpt_ckpt, recipe.sovits_pth]
      .map(x => (x && typeof x === 'object') ? x.path : x).filter(Boolean)
    setGptCustom(!pinned[0] || !list0.some(x => x.path === pinned[0]))
    setSovitsCustom(!pinned[1] || !list1.some(x => x.path === pinned[1]))
  }

  // Selecting a Voice ID refreshes both the GPT and SoVITS lists, each defaulting to its first entry
  // (kept if the current path still belongs to this voice). Leaves custom mode.
  const onVoiceChange = async (v) => {
    setVoice(v)
    const m = await loadVoiceModels(v)
    const eid = engineOfRecipe(v)
    const slots = slotNamesOf(m, eid)
    const slotMap = (m.slots && m.slots[eid]) || {}
    const [s0, s1] = slots
    setSlotNames([s0, s1].filter(Boolean))
    const list0 = (s0 && slotMap[s0]) || []
    const list1 = (s1 && slotMap[s1]) || []
    setGptModels(list0); setSovitsModels(list1)
    setGptCustom(false); setSovitsCustom(false)
    if (list0.length > 0 && !list0.some(x => x.path === gpt)) setGpt(list0[0].path)
    if (list1.length > 0 && !list1.some(x => x.path === sovits)) setSovits(list1[0].path)
  }

  // PC-3: when a picked model lives outside the project the server refuses with
  // code:"external". We surface a strong warning and require a second, explicit
  // confirmation before re-sending with allow_external_models:true.
  const [extConfirm, setExtConfirm] = useState(null) // { field } | null

  const save = async (allowExternal) => {
    setBusy(true); setError(null); setMsg(null)
    try {
      const body = { gpt_ckpt: gpt, sovits_pth: sovits }
      if (allowExternal) body.allow_external_models = true
      const r = await api(`/api/recipes/${encodeURIComponent(recipe.role)}/${encodeURIComponent(recipe.name)}`, {
        method: 'PUT', body,
      })
      if (!r.ok) {
        if (r.data && r.data.code === 'external') {
          // Pause and ask for an explicit confirmation instead of failing.
          setExtConfirm({ field: r.data.field || 'model' })
          return
        }
        throw new Error((r.data && r.data.error) || `Server error ${r.status}`)
      }
      setExtConfirm(null)
      setMsg('Models updated'); onSaved && onSaved(r.data.recipe)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  if (!open) {
    return <button className="btn btn-sm btn-ghost" onClick={() => { setOpen(true); load() }}>{t('Change models', '更换模型')}</button>
  }

  // 有任何模型的角色都可以挑，以前问的是「有没有 GPT 或有没有 SoVITS」，
  // 那两个字段已经不存在了，留着会让这个下拉永远是空的。
  const modelVoices = (voicesList || []).filter(v => Object.keys(v.models || {}).length > 0)

  return (
    <div className="rebind">
      {/* 7.1: one row, three dropdowns — Voice ID (shared) · model slot 0 · model slot 1.
          2026-10-01：两个位下拉的标签过去写死成「GPT checkpoint」「SoVITS model」，
             文件选择器的扩展名也写死成 .ckpt / .pth ⇒ 一台别的引擎的权重在界面上
             连标题都不匹配。现在标题取后端给的真实位名（slotNames），扩展名放开。
             Each model slot keeps a "custom path…" escape hatch (cross-voice /
             outside the project) (D2/D4). */}
      <div className="rebind-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: '0 1 170px', minWidth: 130 }}>
          <label className="field-label">Voice ID</label>
          <Select className="control" value={voice} onChange={e => onVoiceChange(e.target.value)}>
            {!modelVoices.some(v => v.voiceId === voice) && <option value={voice}>{voice || '— select —'}</option>}
            {modelVoices.map(v => <option key={v.voiceId} value={v.voiceId}>{v.displayName}</option>)}
          </Select>
        </div>
        <div className="field" style={{ flex: '1 1 260px', minWidth: 200 }}>
          <label className="field-label">{slotNames[0] || t('Model', '模型')}</label>
          <Select className="control"
            value={gptCustom ? '__custom__' : (gptModels.some(m => m.path === gpt) ? gpt : '')}
            title={gptCustom ? gpt : ''}
            onChange={e => { const v = e.target.value; if (v === '__custom__') { setGptCustom(true) } else { setGptCustom(false); setGpt(v) } }}>
            {!gptCustom && !gptModels.some(m => m.path === gpt) && <option value="">— select a checkpoint —</option>}
            {gptModels.map(m => <option key={m.path} value={m.path}>{m.name}{m.steps ? ` (${m.steps})` : ''}</option>)}
            <option value="__custom__">— custom path… —</option>
          </Select>
          {gptCustom && (
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <input className="control" value={gpt} onChange={e => setGpt(e.target.value)}
                placeholder="assets/<voice>/models/<engine>/<slot>/…" />
              <button className="btn btn-sm" title={t('Browse for a model file', '浏览模型文件')} onClick={() => setPickGpt(true)}>📁</button>
            </div>
          )}
        </div>
        {/* 只有一位的引擎（CosyVoice 的 model 位就是一个）**不画第二格**。
            画一个标题写着「模型」、候选永远为空的下拉，比不画更糟：用户会以为
            「这个音色真的没有第二个模型」，而真相是「这台引擎只有一个位」。
            判据跟方法下拉一样：名片/后端没给的，界面不许替它编一个。 */}
        {slotNames.length > 1 && (
        <div className="field" style={{ flex: '1 1 260px', minWidth: 200 }}>
          <label className="field-label">{slotNames[1]}</label>
          <Select className="control"
            value={sovitsCustom ? '__custom__' : (sovitsModels.some(m => m.path === sovits) ? sovits : '')}
            title={sovitsCustom ? sovits : ''}
            onChange={e => { const v = e.target.value; if (v === '__custom__') { setSovitsCustom(true) } else { setSovitsCustom(false); setSovits(v) } }}>
            {!sovitsCustom && !sovitsModels.some(m => m.path === sovits) && <option value="">— select a model —</option>}
            {sovitsModels.map(m => <option key={m.path} value={m.path}>{m.name}{m.version ? ` [${m.version}]` : ''}</option>)}
            <option value="__custom__">— custom path… —</option>
          </Select>
          {sovitsCustom && (
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <input className="control" value={sovits} onChange={e => setSovits(e.target.value)}
                placeholder="assets/<voice>/models/<engine>/<slot>/…" />
              <button className="btn btn-sm" title={t('Browse for a model file', '浏览模型文件')} onClick={() => setPickSovits(true)}>📁</button>
            </div>
          )}
        </div>
        )}
      </div>
      {error && <div className="msg msg-error">{error}</div>}
      {msg && <div className="msg msg-success">{msg}</div>}
      {extConfirm && (
        <div className="msg msg-warn">
          <strong>⚠️ {t('This model file is outside the project (not under assets/).', '该模型文件不在项目内（不在 assets/ 目录下）。')}</strong>
          <div style={{ marginTop: 6 }}>
            {t(<>It will be pinned as an <strong>absolute path</strong>. Consequences:</>,
               <>它将以<strong>绝对路径</strong>方式固定。这会带来以下后果：</>)}
            <ul style={{ margin: '4px 0 0 18px' }}>
              <li>{t(<>The original file <strong>must not be moved or renamed</strong> — otherwise every request using this recipe will fail.</>,
                     <>原始文件<strong>不能被移动或重命名</strong>：否则每个使用该 recipe 的请求都会失败。</>)}</li>
              <li>{t(<>The path is tied to <strong>this machine</strong>; the recipe is no longer self-contained.</>,
                     <>该路径与<strong>本机</strong>绑定；此 recipe 不再是自包含的。</>)}</li>
              <li>{t('To distribute it you must ship these model files to the other machine as well (just like the voice assets).',
                     '若要分发，必须把这些模型文件一并拷贝到目标机器（与音色资源一样）。')}</li>
            </ul>
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => save(true)}>
              {busy ? t('Saving…', '保存中…') : t('I understand — pin absolute path', '我已了解：固定为绝对路径')}
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setExtConfirm(null)}>{t('Cancel', '取消')}</button>
          </div>
        </div>
      )}
      <p className="field-hint">{t(
        <>ⓘ Saving rebinds this recipe's model. Every future API call to voice "{recipe.id}" on this endpoint will use the new checkpoint/model; requests already in flight are unaffected.</>,
        <>ⓘ 保存后将重新绑定该 recipe 的模型。此后对该 endpoint 上音色 “{recipe.id}” 的每次 API 调用都会使用新的 checkpoint/模型；已在处理中的请求不受影响。</>)}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-sm btn-primary" disabled={busy || !!extConfirm} onClick={() => save(false)}>{busy ? t('Saving…', '保存中…') : t('Save models', '保存模型')}</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => setOpen(false)}>{t('Close', '关闭')}</button>
      </div>
      <FsFilePicker open={pickGpt} exts={WEIGHT_EXTS} title={t('Select a model file', '选择模型文件')}
        onPick={(p) => setGpt(p)} onClose={() => setPickGpt(false)} />
      <FsFilePicker open={pickSovits} exts={WEIGHT_EXTS} title={t('Select a model file', '选择模型文件')}
        onPick={(p) => setSovits(p)} onClose={() => setPickSovits(false)} />
    </div>
  )
}