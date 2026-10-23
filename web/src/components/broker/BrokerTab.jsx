// Broker 分发页：展示 /v1/audio/speech 这个兼容 OpenAI 的入口，以及按 role 分组的配方列表。
// 判据全在接口返回里（配方自带的模型、参考音频与参数），界面不判断能不能合成；
// 单个配方由 RecipeCard 渲染，顶部上下文状态行是 ContextRow。
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Select } from '../common/Select'
import { api } from '../../lib/api'
import { FsFilePicker } from '../common/Dialogs'
import { basename } from '../../lib/pathText'
import { TARGET_LANG_OPTIONS } from '../../lib/langOptions'
import { usePreviewMode } from '../../lib/previewMode'
import { useT } from '../../lib/i18n'
import { usePersistentState } from '../../usePersistentState'
import { BrokerApiNoteCard, BrokerApiNotePill } from '../common/Fields'
import { modelCountsByEngine, paramsSummaryOf } from '../../lib/modelPickers.pure.js'
import { RecipeCard } from './RecipeCard'
import { ContextRow } from './ContextRow'

export function BrokerTab() {
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
