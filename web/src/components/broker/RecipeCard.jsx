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
import { RecipeModelRebind } from './RecipeModelRebind'

export function RecipeCard({ recipe, endpoint, onChanged }) {
  const { t } = useT()
  // 参数摘要：按这个配方自己带的键渲染，键的顺序尽量按当前引擎的
  //   param_schema 走（paramsSummaryOf）。键名一个都不写死。
  //   配方没有 engine_id（配方格式不动），所以不按引擎身份过滤，
  //   参数就在配方里，显示配方里有的，不编配方里没有的。这比「猜它是哪台
  //   引擎然后只显示那几个键」更不容易错。
  const { short: paramSummary, full: paramSummaryFull } =
    useMemo(() => paramsSummaryOf(recipe.params, null), [recipe.params])
  const [copied, setCopied] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  // 7.3: Example call is collapsed and single-line by default. Windows PS/CMD handle `\\` line
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
                <option value="">{t('(follow asset → auto)', '（跟随资产 → 自动）')}</option>
                {TARGET_LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              {langMsg && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{langMsg}</span>}
            </span>
          </div>
          <div><span className="rc-k">{t('Model slot 1', '模型位 1')}</span><span className="rc-v" title={recipe.gpt_ckpt}>{recipe.gpt_ckpt ? basename(recipe.gpt_ckpt) : t('(none)', '（无）')}</span></div>
          <div><span className="rc-k">{t('Model slot 2', '模型位 2')}</span><span className="rc-v" title={recipe.sovits_pth}>{recipe.sovits_pth ? basename(recipe.sovits_pth) : t('(none)', '（无）')}</span></div>
          {/* 参数按当前引擎名片上的 param_schema 渲染：有什么显示什么，
              一个都没有就老实说「没有参数」。
              不写死键名的话，一台别的引擎的配方在 Broker 里显示的是
              「top_k undefined · temp undefined · speed undefined」，
              而这个配方明明带着 prompt_text / spk_id，参数就在那儿，
              只是这一页不认识它们的键名。
              前端不猜哪几个参数值得显示（那又是一个写死的清单）。 */}
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