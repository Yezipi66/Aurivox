import React, { useMemo, useState, useEffect } from 'react'
// 预览复用 9886 真实的生成页组件（ModelPickRow / DeviceSelect / AdvancedParamsPanel），
// 而不是另画一份：平台改了真界面，预览跟着变，不会停在旧样子骗人。
// 这些组件是纯展示型，只吃 props 不碰后端；预览没有后端，控件都给空数据 / 禁用。
// 预览只读：ParamField 的改动只进本地 values，不写回名片。
import { useT } from '../../../web/src/lib/i18n'
import { Select } from '../../../web/src/components/common/Select'
import { ModelPickRow } from '../../../web/src/components/generate/ModelPickRow'
import { AdvancedParamsPanel } from '../../../web/src/components/generate/AdvancedParamsPanel'
import DeviceSelect from '../../../web/src/components/common/DeviceSelect'
import {
  fieldsForTier, isFieldVisible, initialParamValues, coerceParamValue,
} from '../../../web/src/lib/engines'
import { TARGET_LANG_OPTIONS } from '../../../web/src/lib/langOptions'

// 名片写的是声明（parameters[]），9886 组件读的是派生后的 param_schema。
// 预览没有后端，这里只做形状换算，不重做后端的校验：
// 默认值的键名不同，label 与 tier 要有和后端一致的兜底。
function previewSchema (parameters) {
  if (!Array.isArray(parameters)) return []
  return parameters.map((p) => {
    const field = { ...(p || {}) }
    if (field.suggested_value !== undefined) {
      field.default = field.suggested_value
      delete field.suggested_value
    }
    if (!field.label || typeof field.label !== 'object') {
      field.label = { en: field.name, zh: field.name }
    }
    field.tier = field.tier === 'common' ? 'common' : 'advanced'
    return field
  })
}

export default function PanelPreview ({ manifest }) {
  // 内容复用 9886 的两栏骨架：左栏表单、右栏 380px（与 9886 参考音频侧栏同宽）。
  // 预览没有后端、未选音色，右栏留空，与 9886 未选音色时一致。窄抽屉里是单列，
  // 全屏才展开两栏（见 editor.css 的 .wz-preview-grid），让表单宽度对齐 9886。
  return (
    <ErrorBoundary label="preview">
      <div className="wz-preview-grid">
        <div className="workspace-left">
          <PreviewInner manifest={manifest} />
        </div>
        <div className="workspace-right" />
      </div>
    </ErrorBoundary>
  )
}

function PreviewInner ({ manifest }) {
  const { t, lang } = useT()
  const engine = useMemo(() => ({ id: manifest.id, param_schema: previewSchema(manifest.parameters) }), [manifest])
  const [values, setValues] = useState(() => initialParamValues(engine))
  useEffect(() => { setValues(initialParamValues(engine)) }, [engine])
  // 值转换要拿整条字段，不是参数名：类型、候选与默认值都在字段上。
  const setParam = (name, raw) => setValues((prev) => {
    const field = engine.param_schema.find((f) => f.name === name)
    return { ...prev, [name]: coerceParamValue(field, raw) }
  })

  const STREAM_ONLY = ['streaming_mode', 'overlap_length', 'min_chunk_length']
  const visibleFields = (tier) => fieldsForTier(engine, tier)
    .filter((f) => !STREAM_ONLY.includes(f.name))
    .filter((f) => isFieldVisible(f, values))

  // 模型位来自名片：候选要扫盘才有，预览没有后端，groups 留空 ⇒ 与 9886 未扫描时一致（不显示下拉）。
  const weightSlots = Array.isArray(manifest.weights)
    ? manifest.weights.map((w) => ({ name: w.name, label: w.label || w.name, help: w.help || '' }))
    : []

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advTier, setAdvTier] = useState('common')
  const [seed, setSeed] = useState(-1)

  return (
    <div className="section">
      <div className="section-hdr"><span>{t('Generate', '生成')}</span></div>
      <div className="section-body">
        <ModelPickRow
          selectedVoice=""
          onSelectVoice={() => {}}
          voiceOptions={[]}
          weightSlots={weightSlots}
          groupsBySlot={{}}
          selWeights={{}}
          onSelectWeight={() => {}}
          modelSummary=""
          relaunchHint={false}
          modelNotes={[]}
          incompleteItems={[]}
        />

        <div className="field">
          <label className="field-label">{t('Text', '文本')}</label>
          <textarea className="control" rows={5} disabled
            placeholder={t('(fixed by the platform, not from the manifest)', '（平台固定，不来自名片）')} />
          <div style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)', marginTop: 4 }}>
            <span>Characters: <span style={{ color: 'var(--text)' }}>0</span></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 'var(--fs-11)', color: 'var(--muted)' }}>Target language:</span>
            <Select className="control" disabled style={{ height: 22, fontSize: 'var(--fs-11)', padding: '0 4px', width: 'auto', minWidth: 0 }} value="auto_zh_ja_yue" onChange={() => {}}>
              {TARGET_LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </div>
        </div>

        <DeviceSelect options={[]} value={{ kind: 'auto' }} onChange={() => {}} disabled />

        <AdvancedParamsPanel
          showAdvanced={showAdvanced}
          onToggle={() => setShowAdvanced((v) => !v)}
          advTier={advTier}
          onTier={setAdvTier}
          engine={engine}
          engineName={manifest.label || manifest.id || t('the engine', '引擎')}
          visibleFields={visibleFields}
          paramValues={values}
          onParam={setParam}
          uiLang={lang}
          selectOptions={() => []}
          seed={seed}
          onSeed={setSeed}
          forceResynth={false}
          onForceResynth={() => {}}
          engineBatch={false}
          onEngineBatch={() => {}}
          mediaType="wav"
          onMediaType={() => {}}
          hasAuxRefs={false}
        />
      </div>
    </div>
  )
}

// 参数面板要有自己的错误边界：ParamField 是项目组件，它内部出错会一路往上炸，把整页打白。
// 这里把错误关在预览区里：左侧的填表与保存仍然可用。
class ErrorBoundary extends React.Component {
  constructor (p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError (err) { return { err } }
  componentDidCatch (err, info) {
    // 打到控制台便于开发时定位，但不弹给用户：提示里已经说清楚了
    if (typeof console !== 'undefined') console.error(this.props.label, err, info)
  }
  render () {
    if (this.state.err) {
      return (
        <div className="msg msg-danger">
          <b>{`preview crashed: ${this.state.err.message}`}</b>
          <div className="field-hint">
            {t2('This is a bug in the preview, not in the manifest — '
              + 'the form on the left and saving still work.',
              '这是预览的缺陷，与 Manifest 填写无关，左侧的填表与存盘仍可使用。')}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// 小工具：错误边界不能调 useT（出错时上下文可能已坏）。
function t2 (en, zh) {
  try {
    const ctx = JSON.parse(localStorage.getItem('tf.v1.ui.lang') || '"en"')
    return ctx === 'zh' && zh ? zh : en
  } catch { return en }
}
