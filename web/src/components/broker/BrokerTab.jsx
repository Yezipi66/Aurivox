// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
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

// 权重文件的扩展名 —— ⛔ 不写死成 .ckpt / .pth（那是 GPT-SoVITS 的形状）。
// 一台非 GSV 引擎的权重可能是 .safetensors / .onnx / .pt / .bin，
// 过滤太窄的后果是：自定义路径那一栏的「浏览」**看不到文件**，
// 而界面上没有任何一句话解释为什么。
const WEIGHT_EXTS = ['.ckpt', '.pt', '.pth', '.bin', '.safetensors', '.onnx', '.bin']

// PC — Broker model re-bind with a two-level selector:
//   1. primary  = every voice that owns a model of this type (voices-with-models)
//   2. secondary = that voice's GPT ckpts / SoVITS pths (recipes-models/:voiceId)
// plus a "— custom path below —" escape hatch that opens the file picker.
function RecipeModelRebind({ recipe, onSaved }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [voicesList, setVoicesList] = useState(null)   // [{voiceId, displayName, engines, models}]
  const [gpt, setGpt] = useState(recipe.gpt_ckpt || '')
  const [sovits, setSovits] = useState(recipe.sovits_pth || '')
  // 7.1: a single shared Voice ID drives both the GPT and SoVITS model lists (one row, three dropdowns).
  // Cross-voice mixing is still possible via each model slot's "custom path" escape hatch (D2).
  const [voice, setVoice] = useState(recipe.role || '')
  // ⭐ 这两个下拉渲染的是「这台引擎在这个资产上有的前两个模型位」，
  //   位名由后端给出（slotNames），不写死成 'gpt' / 'sovits'。
  //   变量名 gpt*/sovits* 留着是为了不碰配方那两个字段名（gpt_ckpt /
  //   sovits_pth，格式这轮不动），⛔ 但它们现在只是「第 0 位 / 第 1 位」。
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

  // ⚠ 这个「换模型」小面板改的是配方顶层那两个权重字段 —— 配方格式这轮不动
  //   （Owner 2026-08-30），所以它只装得下**两个**位。
  //
  // ⭐⭐ 2026-10-01：过去这里是 `REBIND_ENGINE = 'gpt-sovits'` 写死，位名也写死
  //   成 'gpt' / 'sovits'，连文件选择器的扩展名都是 .ckpt / .pth。后果：
  //   一台 CosyVoice 的资产在 Broker 里**连一个模型位都列不出来**，
  //   而界面上看起来只是「这个音色没模型」，没有任何一句说「因为这里写死了引擎」。
  //
  //   现在引擎和位名都问后端要：/api/recipes-models/:role 的返回体里
  //   **已经有** engines（这个资产实际有模型的引擎，lib/assets/modelLayout.js
  //   的 enginesInMeta 算出来的）和 models[<engineId>][<slot>]。
  //   ⛔ 前端不猜引擎有哪些位 —— 后端给什么位就渲染什么位。
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
  //   所以身份是从它钉的那份权重反查出来的 —— 那份权重属于谁，就是哪台引擎。
  //   ⛔ 找不到就 null，让调用方说人话，别默默退回第一台引擎（那等于把
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

  // 这台引擎在这个资产上到底有哪几个位，⛔ 由后端给的列表决定，不猜。
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

  // 有任何模型的角色都可以挑 —— ⛔ 以前问的是「有没有 GPT 或有没有 SoVITS」，
  // 那两个字段已经不存在了，留着会让这个下拉永远是空的。
  const modelVoices = (voicesList || []).filter(v => Object.keys(v.models || {}).length > 0)

  return (
    <div className="rebind">
      {/* 7.1: one row, three dropdowns — Voice ID (shared) · model slot 0 · model slot 1.
          ⭐ 2026-10-01：两个位下拉的标签过去写死成「GPT checkpoint」「SoVITS model」，
             文件选择器的扩展名也写死成 .ckpt / .pth ⇒ 一台别的引擎的权重在界面上
             连标题都对不上。现在标题取后端给的真实位名（slotNames），扩展名放开。
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
        {/* ⛔ 只有一位的引擎（CosyVoice 的 model 位就是一个）**不画第二格**。
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
                     <>原始文件<strong>不能被移动或重命名</strong>——否则每个使用该 recipe 的请求都会失败。</>)}</li>
              <li>{t(<>The path is tied to <strong>this machine</strong>; the recipe is no longer self-contained.</>,
                     <>该路径与<strong>本机</strong>绑定；此 recipe 不再是自包含的。</>)}</li>
              <li>{t('To distribute it you must ship these model files to the other machine as well (just like the voice assets).',
                     '若要分发，必须把这些模型文件一并拷贝到目标机器（与音色资源一样）。')}</li>
            </ul>
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => save(true)}>
              {busy ? t('Saving…', '保存中…') : t('I understand — pin absolute path', '我已了解——固定为绝对路径')}
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

function RecipeCard({ recipe, endpoint, onChanged }) {
  const { t } = useT()
  // ⭐ 参数摘要：按**这个配方自己带的键**渲染，键的顺序尽量按当前引擎的
  //   param_schema 走（paramsSummaryOf）。过去这里是写死的
  //   `top_k / temperature / speed` 三个 GPT-SoVITS 键。
  //   ⚠️ 配方没有 engine_id（配方格式不动），所以**不按引擎身份过滤** ——
  //   参数就在配方里，显示配方里有的，不编配方里没有的。这比「猜它是哪台
  //   引擎然后只显示那几个键」更不容易错。
  const { short: paramSummary, full: paramSummaryFull } =
    useMemo(() => paramsSummaryOf(recipe.params, null), [recipe.params])
  const [copied, setCopied] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  // 7.3: Example call is collapsed and single-line by default. Windows PS/CMD handle `\` line
  // continuations poorly, so a single line (no continuations) is easiest to copy; expand for full multi-line.
  const [cmdOpen, setCmdOpen] = useState(false)
  // Whole recipe card is collapsed by default; header toggles it open.
  const [open, setOpen] = useState(false)
  // i18n-neutral sample line (follows the UI language) instead of a hardcoded Japanese greeting.
  const sampleInput = t('Hello! This is a sample line.', '你好，这是一段示例文本。')
  // Optional `language` (Aurivox extension) shown reflecting THIS recipe's own
  // pinned language (or "auto" when it pins none) so the copied command is
  // explicit and reproducible. It's optional — drop it to let the server resolve
  // from the recipe. Priority: request language > recipe.language > asset > auto.
  const reqLang = recipe.language || 'auto'
  const cmd = `curl -X POST ${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $API_KEY" \\
  -d '{"model":"tts-1","voice":"${recipe.id}","input":"${sampleInput}","language":"${reqLang}"}' \\
  --output out.wav`
  const cmdOneLine = cmd.replace(/\\\s*\n\s*/g, ' ')

  const copy = () => {
    // Copy the currently displayed form: single line when collapsed (Windows-friendly), full multi-line when expanded.
    try { navigator.clipboard.writeText(cmdOpen ? cmd : cmdOneLine); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch (_) {}
  }
  const del = async () => {
    setBusy(true)
    try {
      const r = await api(`/api/recipes/${encodeURIComponent(recipe.role)}/${encodeURIComponent(recipe.name)}`, { method: 'DELETE' })
      if (r.ok) onChanged && onChanged()
    } finally { setBusy(false); setConfirmDel(false) }
  }

  // Inline edit of the recipe's pinned target-text language (decides how shared
  // Han characters are read). Blank = "follow the asset" (then auto at replay).
  const [langBusy, setLangBusy] = useState(false)
  const [langMsg, setLangMsg] = useState(null)
  const saveLang = async (v) => {
    setLangBusy(true); setLangMsg(null)
    try {
      const r = await api(`/api/recipes/${encodeURIComponent(recipe.role)}/${encodeURIComponent(recipe.name)}`,
        { method: 'PUT', body: { language: v } })
      if (r.ok) { setLangMsg(t('Saved', '已保存')); onChanged && onChanged() }
      else setLangMsg((r.data && r.data.error) || t('Save failed', '保存失败'))
    } catch (e) { setLangMsg(e.message) } finally {
      setLangBusy(false); setTimeout(() => setLangMsg(null), 1500)
    }
  }

  return (
    <div className="recipe-card">
      <div className="rc-hdr">
        <div className="rc-title" onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer', userSelect: 'none' }}
          title={open ? t('Collapse', '收起') : t('Expand', '展开')}>
          <span style={{ marginRight: 6, fontSize: 11, color: 'var(--muted)' }}>{open ? '▼' : '▶'}</span>
          <span className="rc-display">{recipe.display_name}</span>
          <code className="rc-id">{recipe.id}</code>
        </div>
        <div className="rc-actions">
          {/* Deleting from a collapsed card opens it so the confirm prompt (inside the body) is visible. */}
          <button className="btn btn-sm btn-danger" onClick={() => { setOpen(true); setConfirmDel(true) }} disabled={busy}>Delete</button>
        </div>
      </div>
      {open && (
      <div className="rc-body">
        <div className="rc-grid">
          <div><span className="rc-k">{t('Reference', '参考音频')}</span><span className="rc-v" title={recipe.reference_audio}>{basename(recipe.reference_audio)}</span></div>
          <div>
            <span className="rc-k">{t('Language', '语言')}</span>
            <span className="rc-v" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Select className="control" style={{ height: 30, fontSize: 12, minWidth: 220 }}
                value={recipe.language || ''} disabled={langBusy}
                onChange={e => saveLang(e.target.value)}>
                <option value="">{t('(follow asset \u2192 auto)', '（跟随资产 \u2192 自动）')}</option>
                {TARGET_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              {langMsg && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{langMsg}</span>}
            </span>
          </div>
          <div><span className="rc-k">{t('Model slot 1', '模型位 1')}</span><span className="rc-v" title={recipe.gpt_ckpt}>{recipe.gpt_ckpt ? basename(recipe.gpt_ckpt) : t('(none)', '（无）')}</span></div>
          <div><span className="rc-k">{t('Model slot 2', '模型位 2')}</span><span className="rc-v" title={recipe.sovits_pth}>{recipe.sovits_pth ? basename(recipe.sovits_pth) : t('(none)', '（无）')}</span></div>
          {/* ⭐⭐ 2026-10-01：过去这里是写死的三个 GPT-SoVITS 键
              （`top_k {…} · temp {…} · speed {…}`）。一台 CosyVoice 的配方在
              Broker 里显示的是「top_k undefined · temp undefined · speed undefined」，
              而这个配方明明带着 prompt_text / spk_id —— 参数**就在那儿**，
              只是这一页不认识它们的键名。

              现在按**当前引擎名片上的 param_schema** 渲染：有什么显示什么，
              一个都没有就老实说「没有参数」。
              ⛔ 前端不猜哪几个参数值得显示（那又是一个写死的清单）。 */}
          <div><span className="rc-k">{t('Params', '参数')}</span><span className="rc-v" title={paramSummaryFull}>
            {paramSummary || t('(none)', '（无）')}
          </span></div>
          <div><span className="rc-k">{t('Source', '来源')}</span><span className="rc-v">{recipe.meta?.source || '—'}{recipe.meta?.notes ? ` · ${recipe.meta.notes}` : ''}</span></div>
        </div>
        <div className="rc-cmd">
          <div className="rc-cmd-hdr">
            <span onClick={() => setCmdOpen(o => !o)} style={{ cursor: 'pointer', userSelect: 'none' }}
              title={cmdOpen ? t('Collapse', '收起') : t('Expand full multi-line command', '展开完整的多行命令')}>
              <span style={{ marginRight: 6, fontSize: 11, color: 'var(--muted)' }}>{cmdOpen ? '▼' : '▶'}</span>
              {t('Example call (OpenAI-compatible)', '调用示例（兼容 OpenAI）')}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={copy}>{copied ? t('Copied', '已复制') : t('Copy command', '复制命令')}</button>
          </div>
          {cmdOpen
            ? <pre className="rc-cmd-body">{cmd}</pre>
            : <pre className="rc-cmd-body" title="Click the title to expand" style={{ whiteSpace: 'pre', overflowX: 'auto' }}>{cmdOneLine}</pre>}
        </div>
        <RecipeModelRebind recipe={recipe} onSaved={() => onChanged && onChanged()} />
        {confirmDel && (
          <div className="msg msg-warn">
            {t(<>Delete recipe <strong>{recipe.id}</strong>? This cannot be undone.</>,
               <>确定删除 recipe <strong>{recipe.id}</strong>？此操作无法撤销。</>)}
            <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={del}>{t('Delete', '删除')}</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => setConfirmDel(false)}>{t('Cancel', '取消')}</button>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  )
}

function BrokerTab() {
  const { t, lang } = useT()
  const [recipes, setRecipes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [apiNoteAcked, setApiNoteAcked] = usePersistentState('broker.apiNoteAck', false)
  const [apiNoteOpen, setApiNoteOpen] = useState(false)
  const endpoint = (typeof window !== 'undefined' ? window.location.origin : '') + '/v1/audio/speech'
  const apiNoteExpanded = !apiNoteAcked || apiNoteOpen

  const load = useCallback(() => {
    setLoading(true)
    api('/api/recipes').then(r => {
      if (r.ok && Array.isArray(r.data.recipes)) { setRecipes(r.data.recipes); setError(null) }
      else setError((r.data && r.data.error) || `Server error ${r.status}`)
    }).catch(e => setError(e.message)).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  // Group recipes by role for display.
  const groups = {}
  for (const rec of recipes) { (groups[rec.role] = groups[rec.role] || []).push(rec) }
  const roleKeys = Object.keys(groups).sort()

  return (
    <div>
      <div className="section" style={{ marginBottom: 12 }}>
        <div className="section-hdr"><span>Broker — Distribution</span>
          <button className="btn btn-sm" onClick={load}>{t('Refresh', '刷新')}</button>
        </div>
        <div className="section-body">
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            {t(
              <>Recipes are exposed through the OpenAI-compatible speech endpoint. Set the
              request's <code>voice</code> field to a recipe id (<code>role/name</code>) to synthesize with that
              recipe's pinned models, reference and parameters. Standard OpenAI clients work unchanged.</>,
              <>Recipe 通过兼容 OpenAI 的语音 endpoint 对外暴露。将请求的 <code>voice</code> 字段设为某个 recipe id（<code>role/name</code>），即可使用该 recipe 固定的模型、参考音频与参数进行合成。标准 OpenAI 客户端无需改动即可使用。</>)}
          </p>
          <div className="broker-endpoint">
            <span className="be-k">Endpoint</span>
            <code className="be-url">POST {endpoint}</code>
            {!apiNoteExpanded && <BrokerApiNotePill className="nn-in-bar" onOpen={() => setApiNoteOpen(true)} />}
          </div>
          {apiNoteExpanded && (
            <div style={{ marginTop: 10 }}>
              <BrokerApiNoteCard
                endpoint={endpoint}
                acked={apiNoteAcked}
                onAck={() => { setApiNoteAcked(true); setApiNoteOpen(false) }}
                onCollapse={() => setApiNoteOpen(false)}
              />
            </div>
          )}
        </div>
      </div>

      {loading && <div className="empty-state" style={{ padding: 16 }}><div className="es-sub">{t('Loading recipes…', '正在加载 recipe…')}</div></div>}
      {error && <div className="msg msg-error">{error}</div>}

      {!loading && !error && recipes.length === 0 && (
        <div className="empty-state" style={{ padding: 20 }}>
          <div className="es-title">{t('No recipes yet', '暂无 recipe')}</div>
          <div className="es-sub">{t(<>Create one with <strong>Save as recipe</strong> on the Generate or Compare Refs page.</>,
                                     <>可在 Generate 或 Compare Refs 页面点击 <strong>Save as recipe</strong> 创建。</>)}</div>
        </div>
      )}

      {roleKeys.map(role => (
        <div className="section" key={role} style={{ marginBottom: 12 }}>
          <div className="section-hdr"><span>{role.toUpperCase()}</span>
            <span className="cmp-count">{groups[role].length} recipe{lang === 'zh' ? '' : (groups[role].length > 1 ? 's' : '')}</span>
          </div>
          <div className="section-body">
            <div className="recipe-list">
              {groups[role].map(rec => (
                <RecipeCard key={rec.id} recipe={rec} endpoint={endpoint} onChanged={load} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ============================
// Compact workbench context / status row (Phase 1, Part 1.1)
// Frontend-only: derives from existing /api/assets, /api/health and the
// active training task. Missing data degrades to graceful placeholders.
function ContextRow({ voices, selectedVoice, health, activeTaskId, activity }) {
  const [previewMode, setPreviewMode] = usePreviewMode()
  const [meta, setMeta] = useState(null)
  const [taskStatus, setTaskStatus] = useState(null)
  // Any in-place "Generate reference text" (Fill missing) job, from anywhere. These
  // run server-side independently of the Assets page, so the global Task slot must
  // reflect them too — not only training/inference. Backend is the source of truth
  // (GET /api/transcribe-jobs), so this lights up regardless of the current page.
  const [restoring, setRestoring] = useState(null) // null | { id }
  // Any running training-pipeline task, from anywhere — NOT only the formal Training
  // tab's task (activeTaskId). A dependency-driven Rebuild/Restore (slice/asr/preprocess/
  // train/finalize/publish) creates its own pipeline task whose id lives outside
  // activeTaskId, so without this the global Task slot would stay "None" while a rebuild
  // is clearly running on the Assets page. Backend /api/train/tasks lists them all.
  const [runningTask, setRunningTask] = useState(null) // null | { id, voiceId, currentStep }

  const voice = voices.find(v => v.id === selectedVoice)

  useEffect(() => {
    let dead = false
    const poll = () => {
      api('/api/transcribe-jobs').then(r => {
        if (dead || !r.ok) return
        const jobs = r.data?.jobs || {}
        const runningId = Object.keys(jobs).find(id => jobs[id].status === 'running')
        setRestoring(runningId ? { id: runningId } : null)
      }).catch(() => {})
      api('/api/train/tasks').then(r => {
        if (dead || !r.ok) return
        const tasks = r.data?.tasks || []
        const run = tasks.find(t => t && t.status === 'running')
        setRunningTask(run ? { id: run.id, voiceId: run.voiceId, currentStep: run.currentStep } : null)
      }).catch(() => {})
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { dead = true; clearInterval(t) }
  }, [])

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

  // 这个角色手上有哪几台引擎的模型、各几个。
  //
  // ⭐ 以前这里是写死的两格（GPT / SoVITS）——只有第一台引擎能填进去，
  //   别的引擎的模型在这条状态栏上一个字都看不到。现在**有几台引擎就几格**。
  const modelCounts = modelCountsByEngine(meta)

  const item = (k, v, placeholder) => (
    <span className="ctx-item">
      <span className="ctx-k">{k}</span>
      <span className={`ctx-v${placeholder ? ' placeholder' : ''}`}>{v}</span>
    </span>
  )

  // Task slot reflects, in priority order: the formal Training-tab task while running >
  // any OTHER running pipeline task (a dependency-driven Rebuild/Restore) > an in-place
  // reference-text restore (Fill missing / Generate reference text) > a live inference
  // (generation) activity > the last known training result > idle. Anything that
  // actually runs the training pipeline or an in-place ASR now lights this slot,
  // regardless of which page it was launched from.
  let taskLabel = 'None', taskPlaceholder = true, taskBusy = false
  const trainRunning = activeTaskId && taskStatus?.status === 'running'
  // A running pipeline task that is NOT the formal Training-tab task → a rebuild/repair.
  const rebuildRunning = runningTask && runningTask.id !== activeTaskId
  if (trainRunning) {
    taskLabel = `Tuning · ${taskStatus?.currentStep || '…'}`; taskPlaceholder = false; taskBusy = true
  } else if (rebuildRunning) {
    taskLabel = `Rebuilding · ${runningTask.voiceId || runningTask.currentStep || '…'}`; taskPlaceholder = false; taskBusy = true
  } else if (restoring) {
    taskLabel = `Restoring · ${restoring.id}`; taskPlaceholder = false; taskBusy = true
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
      {modelCounts.length === 0
        ? item('Models', 'none', true)
        : modelCounts.map(c => (
            <span key={c.engineId} style={{ display: 'contents' }}>
              {item(c.engineId, String(c.count), false)}
              <span className="ctx-sep" />
            </span>
          ))}
      {modelCounts.length === 0 && <span className="ctx-sep" />}
      {/* ⭐⭐⭐ 2026-08-30 刀 4：这里原本是 Connected / Unreachable ——
          最后一枚读 `health.engine_online`（往端口探活）的灯，已删。
          理由与 engines.js:engineBadge 那一处同一条：端口是第六项，
          引擎是用完即走的进程，"它现在在不在线"是一个不存在的问题；
          对命令行引擎这枚灯永远红，而红灯常亮 = 所有红灯失效。
          ⛔ 不许以任何形式重新加回来（包括改叫 "Ready" / "Idle"）。
          这一行的状态由「Task」那一格说 —— 它说的是**这一次操作**。 */}
      <span className="ctx-item">
        <span className="ctx-k">Task</span>
        <span className={`badge ${taskPlaceholder ? 'badge-neutral' : taskStatus?.status === 'failed' ? 'badge-danger' : taskBusy ? 'badge-accent' : 'badge-info'}`}>{taskLabel}</span>
      </span>
      {/* Global audio-preview mode — applies to every result player app-wide. */}
      <span className="ctx-pvmode" title="Audio preview style for generated results">
        <button type="button"
          className={`ctx-pvmode-btn ${previewMode === 'bar' ? 'active' : ''}`}
          onClick={() => setPreviewMode('bar')} title="Compact bar (fastest)" aria-label="Compact bar preview">
          <svg width="15" height="12" viewBox="0 0 15 12" fill="none" aria-hidden="true">
            <rect x="1" y="5" width="13" height="2" rx="1" fill="currentColor" />
            <circle cx="5" cy="6" r="2" fill="currentColor" />
          </svg>
        </button>
        <button type="button"
          className={`ctx-pvmode-btn ${previewMode === 'waveform' ? 'active' : ''}`}
          onClick={() => setPreviewMode('waveform')} title="Waveform + segment dividers" aria-label="Waveform preview">
          <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor" aria-hidden="true">
            <rect x="1" y="4" width="1.6" height="4" rx="0.8" />
            <rect x="4" y="2" width="1.6" height="8" rx="0.8" />
            <rect x="7" y="0.5" width="1.6" height="11" rx="0.8" />
            <rect x="10" y="3" width="1.6" height="6" rx="0.8" />
            <rect x="13" y="4.5" width="1.6" height="3" rx="0.8" />
          </svg>
        </button>
      </span>
    </div>
  )
}

export {
  BrokerTab,
  ContextRow,
}
