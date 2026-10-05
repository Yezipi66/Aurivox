import React, { useMemo } from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { ParamField } from '../../../web/src/components/common/ParamField'
import MainArea from './MainArea'
import {
  fieldsForTier, isFieldVisible, initialParamValues, coerceParamValue, TIERS,
} from '../../../web/src/lib/engines'

// ============================================================================
//  名片面板预览 —— ⭐ 复用平台真正的组件，一个字都没重写
//
//  ⛔⛔ 这个文件存在的全部理由
//  预览的价值是「所见即真界面」。如果自己画一遍 HTML，那它就是第二份实现
//  —— 平台迟早改了真组件，预览还停在旧样子，于是**预览开始骗人**。
//  ⇒ 所以这里 import 的全是 web/src 下**真在用**的东西。
//
//  ⛔⛔ `t` **必须显式传给 ParamField**：ParamField 自己不调 useT，t 是 props。
//  ⛔ 漏传不报编译错、只在渲染到那一格时抛 "t is not a function" ⇒ 整页白屏。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。它只认名片，不认引擎。
// ============================================================================

export default function PanelPreview ({ manifest }) {
  return (
    <ErrorBoundary label="preview">
      <PreviewInner manifest={manifest} />
    </ErrorBoundary>
  )
}

/**
 * ⛔⛔ 为什么参数面板必须有自己的错误边界
 *   ParamField 是**项目的组件**，它内部出错会一路往上炸，把整页打白
 *   —— 用户看到的只是「页面坏了」，跟「是哪个引擎的名片不对」毫无关系。
 *   这里把爆炸关在预览区里：左边的填表、JSON、保存都还能用。
 */
class ErrorBoundary extends React.Component {
  constructor (p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError (err) { return { err } }
  componentDidCatch (err, info) {
    // ⛔ 打到控制台便于开发时定位，但不弹给用户 —— 提示里已经说清楚了
    if (typeof console !== 'undefined') console.error(this.props.label, err, info)
  }
  render () {
    if (this.state.err) {
      return (
        <div className="msg msg-danger">
          <b>{`preview crashed: ${this.state.err.message}`}</b>
          <div className="field-hint">
            {t2('This is a bug in the preview, not in your manifest — '
              + 'the form on the left and saving still work.',
              '这是预览的缺陷，不是你的名片填错了 —— 左边的填表和存盘仍然可用。')}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// 小工具：错误边界不能调 useT（出错时上下文可能已坏）
function t2 (en, zh) {
  try {
    const ctx = JSON.parse(localStorage.getItem('tf.v1.ui.lang') || '"en"')
    return ctx === 'zh' && zh ? zh : en
  } catch { return en }
}

function PreviewInner ({ manifest }) {
  const { t, lang } = useT()
  const engine = useMemo(() => {
    // ⚠ 只喂给 ParamField 需要的形状，不改名片本身
    return { id: manifest.id, param_schema: manifest.parameters || [] }
  }, [manifest])

  const [values, setValues] = React.useState(() => initialParamValues(engine))

  // 名片换了（用户改 JSON）⇒ 初始值重算
  React.useEffect(() => {
    setValues(initialParamValues(engine))
  }, [engine])

  const setParam = (name, raw) => {
    setValues((prev) => ({ ...prev, [name]: coerceParamValue(name, raw, prev[name]) }))
  }

  // 平台那三个硬编码过滤（STREAM_ONLY）在这里照抄一份，
  // 因为它们写在 GenerateTab 里、没导出。
  // ⛔ 这是**已知的一处重复**：若平台改了这条名单，预览会不一致。
  const STREAM_ONLY = ['streaming_mode', 'overlap_length', 'min_chunk_length']

  const visible = (tier) =>
    fieldsForTier(engine, tier)
      .filter((f) => !STREAM_ONLY.includes(f.name))
      .filter((f) => isFieldVisible(f, values))

  const [tier, setTier] = React.useState('common')

  const cols = visible(tier)
  const other = visible(tier === 'common' ? 'advanced' : 'common').length

  return (
    /* ⛔⛔ 之前这里写死了 maxWidth:760 + margin:'0 auto'
       —— Owner：「为什么要砍小容器宽度」。⛔ 现在不设任何限宽，
       宽度由外层 .workspace-right 决定。 */
    <div>
      <p className="msg msg-info" style={{ marginBottom: 8 }}>
        <b>{t('This is a preview', '这是预览')}</b>：
        {t('it renders with the platform’s own components',
          '它用的是平台自己的组件')}
        （{t('not a re-implementation', '不是另画一遍')}）。
      </p>

      {/* ⭐ 主区域 —— 真渲染 */}
      <MainArea manifest={manifest} />

      {/* ⛔ `Advanced Settings` **保持英文、不翻译** ——
           主界面 GenerateTab.jsx 里就是硬编码的英文（没走 t()）。
           ⛔ 这里若单独翻成中文，预览就跟真界面长得不一样 ——
             预览的第一职责是「所见即所得」，不是「文案更漂亮」。 */}
      <div className="collapsible" style={{ marginTop: 8 }}>
        <div className="collapsible-hdr">
          <span>Advanced Settings</span>
          <span className="field-hint" style={{ marginTop: 0 }}>
            ▼ {t('(collapsed by default)', '（默认折叠）')}
          </span>
        </div>
        <div className="collapsible-body">
          {/* ⭐ 档位切换用项目的 .chip / .chip-on（就是给「几档里选一档」用的）*/}
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
                  {t('(no parameters in this tier)', '（这一档还没有参数）')}
                </div>
                )}
          </div>

          {other > 0 && (
            <p className="field-hint" style={{ marginTop: 10 }}>
              ▸ {t(`the other tier has ${other} more — switch tabs to see them`,
                `另一档还有 ${other} 个 —— 切标签能看到`)}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
