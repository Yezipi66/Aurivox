import React, { useMemo } from 'react'
// 名片参数面板的预览：用平台在用的 ParamField 渲染名片的参数，不另画一份表单。
// 复用真组件 ⇒ 平台改了字段行为，预览跟着变；另画一份 HTML 会停在旧样子并骗人。
// 预览只读，改不动名片：值存在本地 state 里，回写由保存按钮触发。
import { useT } from '../../../web/src/lib/i18n'
import { ParamField } from '../../../web/src/components/common/ParamField'
import MainArea from './MainArea'
import {
  fieldsForTier, isFieldVisible, initialParamValues, coerceParamValue, TIERS,
} from '../../../web/src/lib/engines'

// 名片面板预览：直接用平台在用的组件渲染，不另画一份。
// 另画一份 HTML 的话，平台改了真组件之后预览仍停在旧样子，预览就开始骗人。
// t 必须显式传给 ParamField：它自己不调 useT，t 是 props。
// 漏传不报编译错，只在渲染到那一格时抛 "t is not a function"，整页白屏。

export default function PanelPreview ({ manifest, children }) {
  return (
    <ErrorBoundary label="preview">
      <PreviewInner manifest={manifest}>{children}</PreviewInner>
    </ErrorBoundary>
  )
}

/**
 * 参数面板要有自己的错误边界。
 * ParamField 是项目的组件，它内部出错会一路往上炸，把整页打白，
 * 用户看到的只是「页面坏了」，跟「是哪个引擎的名片不对」毫无关系。
 * 这里把错误关在预览区里：左边的填表、JSON 与保存仍然可用。
 */
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

function PreviewInner ({ manifest, children }) {
  const { t, lang } = useT()
  const engine = useMemo(() => {
    // 只喂给 ParamField 需要的形状，不改名片本身。
    return { id: manifest.id, param_schema: manifest.parameters || [] }
  }, [manifest])

  const [values, setValues] = React.useState(() => initialParamValues(engine))

  // 名片换了（用户改了 JSON）⇒ 初始值重算
  React.useEffect(() => {
    setValues(initialParamValues(engine))
  }, [engine])

  const setParam = (name, raw) => {
    setValues((prev) => ({ ...prev, [name]: coerceParamValue(name, raw, prev[name]) }))
  }

  // 平台那三个硬编码过滤（STREAM_ONLY）在这里照抄一份，
  // 因为它们写在 GenerateTab 里，没有导出。
  // 这是已知的一处重复：平台改了这条名单，预览就会与真界面不一致。
  const STREAM_ONLY = ['streaming_mode', 'overlap_length', 'min_chunk_length']

  const visible = (tier) =>
    fieldsForTier(engine, tier)
      .filter((f) => !STREAM_ONLY.includes(f.name))
      .filter((f) => isFieldVisible(f, values))

  const [tier, setTier] = React.useState('common')
  // Advanced 默认折叠用 state 而不是 <details>：折叠要靠 onClick 切 state
  // （项目的 .collapsible 是给 div 用的），而 <details> 自带浏览器箭头，
  // 会和标题里的 ▼ 叠在一起。
  const [showAdvanced, setShowAdvanced] = React.useState(false)

  const cols = visible(tier)
  const other = visible(tier === 'common' ? 'advanced' : 'common').length

  return (
    /* 这里不写死 maxWidth:760 + margin:'0 auto'：
       宽度由外层 .workspace-right 决定。 */
    <div>
      {/* 外壳用项目的 .section（.section-hdr + .section-body）。
         预览栏也是一节内容，不自造栏头：主界面里每一块都是这么长的。 */}
      <div className="section">
        <div className="section-hdr">
          <h2>{t('Preview', '预览')}</h2>
          {children}
        </div>
        <div className="section-body">
          {/* 主区域：照真界面渲染 */}
          <MainArea manifest={manifest} />

          {/* `Advanced Settings` 保持英文、不翻译：
               主界面 GenerateTab.jsx 里就是硬编码的英文（没走 t()）。
               这里若单独翻成中文，预览就跟真界面长得不一样。 */}
          <div className="collapsible" style={{ marginTop: 8 }}>
            <div className="collapsible-hdr" onClick={() => setShowAdvanced((v) => !v)}>
              <span>Advanced Settings</span>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                {showAdvanced ? '▲' : '▼'}
              </span>
            </div>
            {showAdvanced && (
            <div className="collapsible-body">
          {/* 档位切换用项目的 .chip / .chip-on（就是给「几档里选一档」用的）*/}
          <div className="filter-chips" style={{ marginBottom: 12 }}>
            {TIERS.map((x) => {
              const n = visible(x).length
              return (
                <button key={x} type="button"
                  className={`chip${tier === x ? ' chip-on' : ''}`}
                  onClick={() => setTier(x)}>
                  {x}<span style={{ opacity: 0.7, marginLeft: 4 }}>{n}</span>
                </button>
              )
            })}
          </div>

          <div className="param-grid">
            {cols.length
              ? cols.map((f) => (
                <ParamField key={f.name} field={f} values={values}
                  onChange={setParam} lang={lang} options={[]} t={t} />
              ))
              : (
                <div className="field-hint" style={{ gridColumn: '1 / -1' }}>
                  {t('(no parameters in this tier)', '（该档暂无参数）')}
                </div>
                )}
          </div>

          {other > 0 && (
            <p className="field-hint" style={{ marginTop: 10 }}>
              ▸ {t(`the other tier has ${other} more — switch tabs to see them`,
                `另一档还有 ${other} 个，切换标签即可查看`)}
            </p>
          )}
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
