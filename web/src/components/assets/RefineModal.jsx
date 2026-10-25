// 音色精修弹窗：从选定父音色的 checkpoint 继续训练，派生出一个新音色。
// S1（GPT）与 S2（SoVITS）各自独立，可以只精修其一或两者都精修。
// 数据有两种来源：复用父音色已冻结的数据集（切片与 ASR 结果都复用），
// 或自带新音频目录执行完整管线。两种方式都从父音色的 checkpoint 热启动。
// 自带数据的模式只使用新数据，不与父级数据集合并：上游数据由用户自己整合。
// 热启动用的 checkpoint 由用户选择，默认取最新那个。
// 派生关系（代数、根音色、父音色）显示在界面上，用户随时知道自己精修的是哪一版。
// 父音色本身不被修改，也不被覆盖。
import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { TrainParamFields, buildTrainingParams, REBUILD_PARAM_DEFAULTS, LANGUAGES } from '../train/TrainingTab'
import { ConfirmDialog } from '../common/Dialogs'
import { useT } from '../../lib/i18n'
import { modelsFromMeta } from '../../lib/modelPickers.pure.js'

const baseName = (p) => (p || '').split(/[\\/]/).pop()

export default function RefineModal({ voiceId, parentDisplayName, parentVersion, parentLanguage, onClose, onStarted }) {
  const { t } = useT()
  const parent = parentDisplayName || voiceId
  // S1 与 S2 各自独立选择。默认勾 S2：S1 在小数据集上更容易过拟合，
  // 需要重新精修的频率较低。
  const [refineS1, setRefineS1] = useState(false)
  const [refineS2, setRefineS2] = useState(true)
  const [displayName, setDisplayName] = useState('')   // 留空则由后端自动命名（带 <n> 序号）
  const [showParams, setShowParams] = useState(false)

  // 数据来源：关 = 复用父音色已冻结的数据集（退火）；开 = 用户自带新音频目录执行完整管线。
  const [useOwnData, setUseOwnData] = useState(false)
  const [inputDir, setInputDir] = useState('')
  // 新语料的语言（只有自带数据模式用得上）。空串是哨兵值，
  // 表示「未声明，继承父音色的语言」：这里绝不预填一个具体语言，
  // 否则「没声明」就被悄悄变成了「声明了」，等于替用户做决定。
  // 只有用户明确选了某一项（具体语言或 auto）才记为本分支声明的语言。
  // 每次精修本来就会派生出一个带自己血缘的新音色，所以声明一种语言
  // （哪怕与父级相同，哪怕就是 auto）也只是精修树里的一条普通分支。
  const [language, setLanguage] = useState('')
  const [ownSteps, setOwnSteps] = useState({ denoise: false, slice: true, asr: true, pauseAfterAsr: false, pauseAfterDenoise: true })
  const setOwnStep = (k, v) => setOwnSteps(prev => ({ ...prev, [k]: v }))

  // 热启动 checkpoint 的选择（默认取最新或标记为默认的那个）。
  const [ckpts, setCkpts] = useState({ gpt: [], sovits: [] })
  const [selS1, setSelS1] = useState('')   // 路径
  const [selS2, setSelS2] = useState('')   // 路径
  const [lineage, setLineage] = useState({ generation: 0, root: null, parent: null })

  const [form, setForm] = useState({
    ...REBUILD_PARAM_DEFAULTS,
    gptEpochs: 8, sovitsEpochs: 8, learningRate: 0.0001,
    modelVersion: parentVersion || REBUILD_PARAM_DEFAULTS.modelVersion,
  })
  const setField = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const [state, setState] = useState(null)   // 父音色的产物状态标记（空跑重建的结果）
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // 未开 ASR 的自带数据管线：给出警告但不拦停，并让用户填一个等待秒数。
  const [gate, setGate] = useState(null)
  const [graceSec, setGraceSec] = useState(30)

  const refinementType = refineS1 && refineS2 ? 's1+s2' : refineS1 ? 's1' : refineS2 ? 's2' : null
  const typeLabel = refinementType === 's1+s2' ? 'S1+S2' : refinementType === 's1' ? 'S1' : 'S2'
  const namePlaceholder = refinementType ? `${parent} · ${typeLabel} Refined <n>` : `${parent} · Refined <n>`

  // 取父音色的产物状态、checkpoint（热启动下拉框）与派生关系（代数 / 根 / 父）。
  // 三项都失败不致命：弹窗照常可用。
  useEffect(() => {
    let cancelled = false
    api(`/api/assets/${voiceId}/rebuild`, { method: 'POST', body: { execute: false } })
      .then(r => { if (!cancelled && r.ok && r.data) setState(r.data.state || null) })
      .catch(() => {})
    api(`/api/assets/${voiceId}`).then(r => {
      if (cancelled || !r.ok || !r.data?.ok) return
      // 精调是这条训练管线自己的事（继续训一版），它天然只认这条管线产的那两份权重，
      // 所以引擎名是这个弹窗自己的题目，不是平台写死了一台引擎。
      const gpt = modelsFromMeta(r.data.meta, 'gpt-sovits', 'gpt')
      const sovits = modelsFromMeta(r.data.meta, 'gpt-sovits', 'sovits')
      setCkpts({ gpt, sovits })
      setSelS1((gpt.find(x => x.default) || gpt[gpt.length - 1] || {}).path || '')
      setSelS2((sovits.find(x => x.default) || sovits[sovits.length - 1] || {}).path || '')
      const ref = r.data.meta?.refinement
      if (ref) setLineage({ generation: ref.generation || 0, root: ref.root_voice_id || null, parent: ref.parent_voice_id || null })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [voiceId])

  const part = refineS1 && refineS2 ? 'both' : refineS1 ? 's1' : 's2'
  const selS1Obj = ckpts.gpt.find(c => c.path === selS1)
  const selS2Obj = ckpts.sovits.find(c => c.path === selS2)

  // 复用路径的健康门：复用要在父音色已冻结的数据集上继续训练，
  // 所以那份数据得在：两份模型、参考音频（原始音频或切片任一）、
  // 参考文本（现成的分段，或后端能据以生成分段的转写清单）。
  // 「原始音频 + 参考文本」就够，与「原始音频 + 切片」效果相同，不需要 ASR。
  // 这个门只管复用路径；自带新音频会送上一份全新语料，一直允许。
  // 空跑重建还在加载时 state 是 null，此时不拦，避免误拦。
  const reuseMissing = state ? [
    (!state.Mg || !state.Ms) && t('models', '模型'),
    (!state.S && !state.R) && t('reference audio', '参考音频'),
    (!state.Seg && !state.L) && t('reference text / segments', '参考文本 / 分段'),
  ].filter(Boolean) : []
  const reuseReady = !state || reuseMissing.length === 0
  const reuseBlocked = !useOwnData && !reuseReady

  const doStart = async (graceOverride) => {
    if (!refinementType) return
    setBusy(true); setError(null)
    try {
      const body = {
        refinement_type: refinementType,
        display_name: displayName.trim(),
        params: { training: buildTrainingParams(form) },
        base_s1_file: baseName(selS1),
        base_s2_file: baseName(selS2),
      }
      if (useOwnData) {
        body.use_own_data = true
        body.input_dir = inputDir.trim()
        // 只在用户声明了与父级确实不同的语言时才发 language。
        // 空串 = 继承；声明与父级相同的语言等同于继承（不派生语言分支），
        // 所以也不发，让服务端回落到父音色的语言。
        if (language && language !== (parentLanguage || 'auto')) body.language = language
        body.steps = {
          denoise: ownSteps.denoise,
          slice: ownSteps.slice,
          asr: ownSteps.asr,
          pauseAfterAsr: ownSteps.pauseAfterAsr,
          pauseAfterDenoise: ownSteps.denoise && ownSteps.pauseAfterDenoise,
          ...(graceOverride != null ? { asrGraceSec: Number(graceOverride) } : {}),
        }
      }
      const r = await api(`/api/assets/${voiceId}/refine`, { method: 'POST', body })
      if (!r.ok) throw new Error(r.data?.error || 'Failed to start refinement')
      if (onStarted) onStarted(r.data)
    } catch (e) { setError(e.message); setBusy(false) }
  }

  const start = () => {
    if (!refinementType) return
    // 复用路径的健康门：父音色冻结的数据集不完整时拦下。
    if (reuseBlocked) {
      setError(t(
        `This Voice can’t be refined on its existing data — missing ${reuseMissing.join(', ')}. Complete the asset first (e.g. rebuild segments / re-import audio), or enable “Bring my own new audio” above.`,
        `无法在该音色的现有数据上精修，缺少 ${reuseMissing.join('、')}。请先补全资产（例如重建分段 / 重新导入音频），或勾选上方的「导入我自己的新音频」。`))
      return
    }
    if (useOwnData && !inputDir.trim()) { setError(t('Please provide the source audio folder for own-data refinement.', '请填写自备数据精修的源音频文件夹。')); return }
    // 未开 ASR 的自带数据管线：警告并让用户填等待秒数（用户可以自带转写清单）。
    if (useOwnData && !ownSteps.asr) { setGate('g2'); return }
    doStart()
  }

  const planStages = useOwnData
    ? [ownSteps.denoise && 'denoise', ownSteps.slice && 'slice', ownSteps.asr && 'asr', 'preprocess',
       refineS1 && 'train_s1', refineS2 && 'train_s2', 'finalize'].filter(Boolean)
    : ['preprocess', refineS1 && 'train_s1', refineS2 && 'train_s2', 'finalize'].filter(Boolean)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card restore-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hdr">
          <div>
            <div className="modal-title">{t('Refine Voice', '精修音色')}</div>
            <div className="modal-subtitle">{parent}</div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <p className="modal-desc">
          {t(
            <>Continue training from this Voice's existing checkpoints to further adapt it. S1 (GPT)
            and S2 (SoVITS) are independent — refine either or both. This creates a new derived
            Voice; the source Voice and its checkpoints are always preserved.</>,
            <>在该音色现有 checkpoint 的基础上继续训练，以进一步适配。S1 (GPT) 与 S2 (SoVITS)
            相互独立，可只精修其一或两者都精修。这会创建一个新的派生音色；源音色及其 checkpoint 始终会被保留。</>)}
        </p>

        {/* 派生关系：抽象的代数链，Gen 0 是最初那版录音。 */}
        <div className="asset-lineage" style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', margin: '2px 0 10px' }}>
          <span className="badge" style={{ marginRight: 8 }}>Gen {lineage.generation}</span>
          {t('This derived Voice will become', '本次派生音色将成为第')}{' '}
          <strong style={{ color: 'var(--text)' }}>Gen {lineage.generation + 1}</strong>{' '}
          {t('— direct parent:', '代，直接父级为')} <strong style={{ color: 'var(--text)' }}>{parent}</strong>
          {lineage.root && lineage.root !== lineage.parent && (
            <span> · {t('root', '根')}: <code>{lineage.root}</code></span>
          )}
        </div>

        {/* 父音色的产物状态，界面与修复弹窗保持一致。 */}
        {state && (
          <div className="asset-state-row">
            {[['R', t('Raw', '原始')], ['S', t('Slices', '切片')], ['L', t('Transcript', '转写文本')], ['Seg', t('Segments', '分段')], ['Mg', 'GPT'], ['Ms', 'SoVITS']].map(([k, label]) => (
              <span key={k} className={`state-pip ${state[k] ? 'on' : 'off'}`}>
                <span className="state-pip-sym">{state[k] ? '✓' : '–'}</span>{label}
              </span>
            ))}
          </div>
        )}

        {/* 数据来源：复用（退火）或自带新音频目录（完整管线）。 */}
        <div className="restore-group">
          <div className="restore-group-title">{t('Data source', '数据来源')}</div>
          <label className="toggle-row">
            <input type="checkbox" checked={useOwnData} onChange={e => setUseOwnData(e.target.checked)} />
            <span>
              {t('Bring my own new audio (full pipeline)', '导入我自己的新音频（完整管线）')}
              <span className="hint"> {t('— off: anneal on the parent\u2019s existing dataset (slice/ASR reused). On: run slice/ASR/preprocess on a new folder; new data only, no merge.', '关：在父级现有数据集上退火（复用切片/ASR）。开：对新文件夹运行切片/ASR/预处理；仅用新数据，不做合并。')}</span>
            </span>
          </label>
          {reuseBlocked && (
            <div className="hint-warn" style={{ marginTop: 8, color: 'var(--warning)' }}>
              {t(
                `⚠ This Voice isn’t complete enough to refine on its existing data — missing ${reuseMissing.join(', ')}. Complete the asset first (e.g. rebuild segments / re-import audio), or enable “Bring my own new audio” to train from a fresh corpus.`,
                `⚠ 该音色尚不足以在现有数据上精修，缺少 ${reuseMissing.join('、')}。请先补全资产（例如重建分段 / 重新导入音频），或勾选「导入我自己的新音频」以用全新语料训练。`)}
            </div>
          )}
          {useOwnData && (
            <div style={{ marginTop: 8 }}>
              <input
                className="control"
                value={inputDir}
                placeholder={t('Absolute path to the new source audio folder', '新源音频文件夹的绝对路径')}
                onChange={e => setInputDir(e.target.value)}
                style={{ width: '100%' }}
              />
              <div style={{ marginTop: 8 }}>
                <label className="field-label">{t('New corpus language', '新语料语言')}</label>
                <select className="control" value={language} onChange={e => setLanguage(e.target.value)} style={{ width: '100%' }}>
                  <option value="">
                    {t(`Inherit from parent (${parentLanguage || 'auto'})`, `继承父级（${parentLanguage || 'auto'}）`)}
                  </option>
                  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
                <div className="field-hint" style={{ marginTop: 4 }}>
                  {language === ''
                    ? t('Not declared — this branch inherits the parent Voice\u2019s language. Only pick a language if you want to declare one for the new corpus.',
                        '未声明：本分支继承父级音色的语言。仅当需要为新语料指定语言时才需选择。')
                    : language === (parentLanguage || 'auto')
                      ? t('Same as the parent Voice — this is equivalent to inheriting; no separate language branch is created.',
                          '与父级音色相同，等同于继承，不会额外产生语言派生。')
                      : t('⚠ Different from the parent Voice — this derives a cross-language branch, recorded on the new Voice as its own language (a Japanese model annealed on Chinese data, for example).',
                          '⚠ 与父级音色不同，将派生一条跨语言分支，并作为新音色自身的语言记录（例如把日语模型用中文数据退火）。')}
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 8 }}>
                <label className="toggle-row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={ownSteps.denoise} onChange={e => setOwnStep('denoise', e.target.checked)} />
                  <span>{t('Denoise', '降噪')}</span>
                </label>
                <label className="toggle-row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={ownSteps.pauseAfterDenoise} onChange={e => setOwnStep('pauseAfterDenoise', e.target.checked)} disabled={!ownSteps.denoise} />
                  <span>{t('Pause after denoise (preview)', '降噪后暂停（试听）')}</span>
                </label>
                <label className="toggle-row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={ownSteps.slice} onChange={e => setOwnStep('slice', e.target.checked)} />
                  <span>{t('Slice', '切片')}</span>
                </label>
                <label className="toggle-row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={ownSteps.asr} onChange={e => setOwnStep('asr', e.target.checked)} />
                  <span>{t('ASR', '转写')}</span>
                </label>
                <label className="toggle-row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={ownSteps.pauseAfterAsr} onChange={e => setOwnStep('pauseAfterAsr', e.target.checked)} disabled={!ownSteps.asr} />
                  <span>{t('Pause after ASR (proofread)', 'ASR 后暂停（人工校对）')}</span>
                </label>
              </div>
              <div className="field-hint" style={{ marginTop: 6 }}>
                {t('New data only — the parent dataset is NOT merged. Integrate any upstream data into this folder yourself before starting.',
                   '仅使用新数据（不会与父级数据集合并）。开始前请自行把任何上游数据整合进该文件夹。')}
              </div>
            </div>
          )}
        </div>

        {/* 模型选择：S1 与 S2 各自独立，至少要选一个。 */}
        <div className="restore-group">
          <div className="restore-group-title">{t('Models to refine', '要精修的模型')}</div>
          <label className="toggle-row">
            <input type="checkbox" checked={refineS1} onChange={e => setRefineS1(e.target.checked)} />
            <span>
              {t('Refine S1 (GPT)', '精修 S1 (GPT)')}
              <span className="hint"> {t('— continues from the parent S1 checkpoint; adapts semantic rhythm & prosody', '从父级 S1 checkpoint 继续训练；适配语义层面的节奏与韵律')}</span>
            </span>
          </label>
          {refineS1 && ckpts.gpt.length > 0 && (
            <div className="field-row" style={{ margin: '2px 0 6px 26px' }}>
              <label style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', minWidth: 96 }}>{t('Warm-start S1', 'S1 起点')}</label>
              <select className="control" value={selS1} onChange={e => setSelS1(e.target.value)} style={{ flex: 1 }}>
                {ckpts.gpt.map(c => (
                  <option key={c.path} value={c.path}>{c.name}{c.steps != null ? ` (step ${c.steps})` : ''}{c.default ? ' ★' : ''}</option>
                ))}
              </select>
            </div>
          )}
          <label className="toggle-row">
            <input type="checkbox" checked={refineS2} onChange={e => setRefineS2(e.target.checked)} />
            <span>
              {t('Refine S2 (SoVITS)', '精修 S2 (SoVITS)')}
              <span className="hint"> {t('— continues from the parent S2 checkpoint; adapts timbre & acoustics', '从父级 S2 checkpoint 继续训练；适配音色与音质')}</span>
            </span>
          </label>
          {refineS2 && ckpts.sovits.length > 0 && (
            <div className="field-row" style={{ margin: '2px 0 6px 26px' }}>
              <label style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', minWidth: 96 }}>{t('Warm-start S2', 'S2 起点')}</label>
              <select className="control" value={selS2} onChange={e => setSelS2(e.target.value)} style={{ flex: 1 }}>
                {ckpts.sovits.map(c => (
                  <option key={c.path} value={c.path}>{c.name}{c.version ? ` [${c.version}]` : ''}{c.default ? ' ★' : ''}</option>
                ))}
              </select>
            </div>
          )}
          {!refinementType && (
            <div className="msg msg-warn" style={{ marginTop: 4 }}>{t('Select at least one model to refine.', '请至少选择一个要精修的模型。')}</div>
          )}

          {/* 热启动起点：始终告诉用户这次是从哪一份继续训的。 */}
          <div className="field-hint" style={{ marginTop: 8 }}>
            {t('Warm-start source:', '精修起点：')}{' '}
            {refineS1 && <strong>S1 = {selS1Obj ? baseName(selS1Obj.path) : '—'}</strong>}
            {refineS1 && refineS2 && ' · '}
            {refineS2 && <strong>S2 = {selS2Obj ? baseName(selS2Obj.path) : '—'}</strong>}
            {'  '}({t('version', '版本')} {parentVersion || 'v2'})
          </div>

          <div className="collapsible" style={{ marginTop: 10 }}>
            <div className="collapsible-hdr" onClick={() => setShowParams(v => !v)}>
              <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--muted)' }}>{t('Training Parameters', '训练参数')}</span>
              <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>{showParams ? '▲' : '▼'}</span>
            </div>
            {showParams && (
              <div className="collapsible-body" style={{ padding: 12 }}>
                <div className="field-hint" style={{ marginBottom: 8 }}>
                  {t('Epochs here are the additional epochs to train this session (warm-started from the parent). The model version is fixed to the source Voice\u2019s for warm-start compatibility.',
                     '这里的 epoch 数是本次会话额外训练的 epoch（从父级 warm-start 继续）。模型版本固定为源音色的版本，以保证 warm-start 兼容性。')}
                </div>
                <TrainParamFields form={form} setField={setField} part={part} />
              </div>
            )}
          </div>
        </div>

        {/* 派生音色的名称 */}
        <div className="restore-group">
          <div className="restore-group-title">{t('Derived Voice name', '派生音色名称')}</div>
          <input
            className="control"
            value={displayName}
            placeholder={namePlaceholder}
            onChange={e => setDisplayName(e.target.value)}
            style={{ width: '100%' }}
          />
          <div className="field-hint" style={{ marginTop: 6 }}>
            {t(`Leave blank to auto-name as \u201c${namePlaceholder}\u201d.`, `留空则自动命名为 \u201c${namePlaceholder}\u201d。`)}
          </div>
        </div>

        <div className="field-note" style={{ marginTop: 4 }}>
          {t('This operation creates a new derived Voice asset. The source Voice will not be modified or overwritten.',
             '此操作会创建一个新的派生音色资源。源音色不会被修改或覆盖。')}
        </div>
        <div className="field-note" style={{ color: 'var(--warning)', marginTop: 6 }}>
          {t('Refinement does not guarantee better results and may cause overfitting. The original Voice and checkpoints will be preserved.',
             '精修并不保证效果更好，还可能导致过拟合。原始音色及其 checkpoint 会被保留。')}
        </div>

        {/* 流程预览 */}
        <div className="plan-preview">
          <div className="plan-preview-label">PLAN</div>
          <div className="plan-preview-body">{planStages.join('  →  ')}</div>
        </div>

        {error && <div className="msg msg-error" style={{ marginBottom: 10 }}>{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={busy}>{t('Cancel', '取消')}</button>
          <button className="btn btn-sm btn-primary" onClick={start} disabled={busy || !refinementType || reuseBlocked}>
            {busy ? t('Starting…', '启动中…') : t('Create Derived Voice', '创建派生音色')}
          </button>
        </div>
      </div>

      {/* 未开 ASR 的自带数据管线：强警告，不拦停。 */}
      <ConfirmDialog
        open={gate === 'g2'}
        danger
        icon={<span style={{ fontSize: 'var(--fs-18)' }}>⚠️</span>}
        title={t('ASR is not enabled', '未启用 ASR')}
        confirmLabel={t('Continue anyway', '仍然继续')}
        onCancel={() => setGate(null)}
        onConfirm={() => { setGate(null); doStart(graceSec) }}
        message={
          <div style={{ fontSize: 'var(--fs-13)', lineHeight: 1.6 }} onClick={e => e.stopPropagation()}>
            <p style={{ marginTop: 0 }}>
              {t('The own-data pipeline is enabled but ASR is off, so no transcript will be produced. Without a transcript, preprocessing will fail — unless you supply your own.',
                 '已启用自备数据管线但未勾选 ASR，本次不会生成转写。若没有转写，预处理会失败，除非自备转写。')}
            </p>
            <p>
              {t('Before preprocessing, the system will wait for the seconds below so you can copy your file into the staging folder (its absolute path is printed in the logs).',
                 '在预处理前，系统会等待下面设定的秒数，以便将文件复制进暂存目录（其绝对路径会打印在日志中）。')}
            </p>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-12)' }}>
              {t('Rule: a .list overrides segments.json; or drop segments.json directly. Provide only one.',
                 '规则：放 .list 会覆写 segments.json；或直接放 segments.json。二者只放其一。')}
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span>{t('Grace period (seconds)', '宽限期（秒）')}</span>
              <input type="number" className="control" min={0} max={600} value={graceSec}
                     onChange={e => setGraceSec(e.target.value)} style={{ width: 90 }} />
            </label>
          </div>
        }
      />
    </div>
  )
}
