import { Select } from './Select'
import {
  canonicalType, repeatOf, isFieldVisible, selectSourceOf, fieldLabel, fieldHelp, textOf
} from '../../lib/engines'
import { recipePath } from '../../lib/recipes'

// ---------------------------------------------------------------------------
//  一个格子 —— 五种预设样式的**唯一**渲染处
// ---------------------------------------------------------------------------
//
// ⭐⭐ 这个文件存在的理由：以后每台引擎都会有自己的一页（生成出来的
//    `web/src/components/engines/<id>.jsx`）。那些页面**拼装**这个组件，
//    ⛔ 不各自实现一遍控件 —— 否则「五种样式」就变成了 N 份互相漂移的实现，
//    而漂移的症状是「换一台引擎，同一种参数的格子长得不一样」。
//
// ⛔ 这个文件里不许出现任何引擎的参数名、引擎 id、或任何业务身份
//   （"权重" / "参考音频" / "情绪"）。它只认得五种样式。
//   判据：paramField.node.test.js 会 grep 这个文件。
//
// 五种样式 ⇄ 控件：
//   text     <input type="text">
//   number   <input type="number">（min/max/step/unit 只是刻度，⛔ 不是校验）
//   select   <Select>（choices 写死 / source 平台扫盘；multi 多选；
//                      allow_custom ⇒ 变成「可打字的下拉」= input + datalist）
//   boolean  <ToggleField>（⭐ 统一的一行，见下面那段注释）
//   file     input + datalist（custom file，⛔ 没有候选就是没有候选）
//
// 修饰：
//   repeat N  一排 N 个，dim_labels 给每格起名
//   only_when 条件显示，⭐ fail-open

/**
 * ⭐⭐ 勾选框统一走这一个组件。
 *
 * ⛔ 起因是 Owner 2026-08-29 报的一条：「引擎详细日志和引擎批量并行都是勾选框，
 *    你一个左上一个右下」。根子在 `styles.css:575` 的 `.form-grid` 是两列
 *    `align-items: start` —— 别的格子是「标签在上、控件在下」占满一格高，
 *    而裸 `<input type=checkbox>` 只有一行高，于是它在自己那一格里贴着顶，
 *    邻格的输入框贴着底，两个勾选框就一个在左上一个在右下。
 *
 * ⇒ 勾选框不再自己排版：标签和方框放同一行，整行占满格子的高度，
 *   于是同一排里几个勾选框永远对齐。⛔ 不要再在别处手写 <input type=checkbox>。
 */
export function ToggleField({ label, help, checked, onChange, disabled }) {
  return (
    // 排版全部在 styles.css 的 .toggle-field 里，⛔ 别写回内联 ——
    // 一个共享组件的样式散在 JSX 里，下一个人调对齐时根本找不到它。
    <label className={`toggle-field${disabled ? ' is-disabled' : ''}`} title={help || undefined}>
      <input
        type="checkbox"
        checked={checked === true}
        disabled={!!disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="field-label">{label}</span>
    </label>
  )
}

/** choices 里一项 → 显示文字。裸字符串和 {value,label} 两种形状都收。 */
function choiceLabel(c, lang) {
  if (c === null || c === undefined) return ''
  if (typeof c !== 'object') return String(c)
  if (c.label && typeof c.label === 'object') return textOf(c.label, lang, String(c.value))
  return String(c.label !== undefined ? c.label : c.value)
}

function choiceValue(c) {
  return (c && typeof c === 'object') ? c.value : c
}

/**
 * 一个格子的**标量**控件（不含 repeat / multi 的外壳）。
 *
 * @param options 这一格的候选项。`select + source` 时由调用方扫盘给进来 ——
 *                ⛔ 这个组件不去扫盘，它不知道 voices/weights/audio 是什么。
 */
function ScalarControl({ field, value, onChange, lang, options, t }) {
  const type = canonicalType(field.type)

  if (type === 'boolean') {
    // 走 ToggleField 的分支在外层（要吞掉外层那个 <label>），这里不该到达
    return null
  }

  if (type === 'select') {
    const source = selectSourceOf(field)
    const list = source
      ? (Array.isArray(options) ? options : [])
      : (Array.isArray(field.choices) ? field.choices : [])

    // ⭐ allow_custom：库里没有想要的那个时，让用户自己打一个。
    //   实现成「可打字的输入框 + datalist 候选」，⛔ 不是「下拉 + 另一个输入框」：
    //   两个控件表达同一个值，用户会同时填，而我们只能发一个。
    if (field.allow_custom === true) {
      const listId = `opts-${field.name}`
      return (
        <>
          <input type="text" className="control"
            list={listId}
            placeholder={source
              ? t('pick one, or type any path', '从库里挑一个，或者自己填')
              : undefined}
            value={typeof value === 'string' ? value : (value == null ? '' : recipePath(value))}
            onChange={e => onChange(e.target.value)} />
          <datalist id={listId}>
            {list.map((c, i) => <option key={i} value={choiceValue(c)}>{choiceLabel(c, lang)}</option>)}
          </datalist>
        </>
      )
    }

    return (
      <Select className="control"
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}>
        {/* ⭐ 留一个空项：不选也是一种选择。⛔ 没有它，用户选错了就再也回不到
            「我不设这一项」—— 而那是他表达「用引擎自己的默认值」的唯一方式。 */}
        <option value="">{t('(not set)', '（不设置）')}</option>
        {list.map((c, i) => (
          <option key={i} value={choiceValue(c)}>{choiceLabel(c, lang)}</option>
        ))}
      </Select>
    )
  }

  if (type === 'file') {
    // custom file —— 平台不认识这个文件是什么。
    // ⚠ 这里**没有**候选列表：有候选的那种是 select + source。
    return (
      <input type="text" className="control"
        placeholder={t('empty = do not send this file', '留空 = 不发这个文件')}
        /* 配方里存的可能是 {base, path} 那种形状（老配方的权重就是），
           显示时摊成一行路径，否则用户会看到一个空格子而实际上值还在。 */
        value={typeof value === 'string' ? value : (value == null ? '' : recipePath(value))}
        onChange={e => onChange(e.target.value)} />
    )
  }

  if (type === 'number') {
    // ⛔ min/max/step 只是滑块刻度，不是校验：浏览器不会拦住越界的值，
    //    我们也不拦 —— 越界该由引擎自己说话（平台是搬运工，不是翻译）。
    return (
      <input type="number" className="control"
        step={field.step ?? (field.int === true || field.type === 'integer' ? 1 : 'any')}
        min={field.min ?? undefined}
        max={field.max ?? undefined}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)} />
    )
  }

  // text —— ⛔ 不 trim、不截断：用户打的空格可能就是他要的
  return (
    <input type="text" className="control"
      value={value ?? ''}
      onChange={e => onChange(e.target.value)} />
  )
}

/**
 * 一个格子（含标签、help、repeat 一排、only_when）。
 *
 * @param field    名片里的一项（已经过后端 param_schema 归一化，type 是五种之一）
 * @param values   整个面板的当前值 —— only_when 要看别的格子
 * @param onChange (name, nextValue) => void
 * @param options  `select + source` 的候选项（调用方扫盘给进来）
 */
export function ParamField({ field, values, onChange, lang, options, t }) {
  if (!field || field.name === undefined) return null
  // ⭐ fail-open：only_when 引用一个面板上没有的键 ⇒ 照常显示。
  //   少画一格找不到、还不报错，比多画一格坏得多。
  if (!isFieldVisible(field, values)) return null

  const value = values ? values[field.name] : undefined
  const label = fieldLabel(field, lang)
  const help = fieldHelp(field, lang)
  const n = repeatOf(field)
  const type = canonicalType(field.type)
  const wide = field.width === 'full' || n > 1 || field.multi === true

  // 勾选：整格换成一行对齐的开关（见 ToggleField 的注释）
  if (type === 'boolean' && n === 1) {
    return (
      <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
        <ToggleField label={label} help={help}
          checked={value === true}
          onChange={v => onChange(field.name, v)} />
      </div>
    )
  }

  // multi：多选多，几项由**用户**定 ⇒ 用原生多选。
  // ⛔ 不做成「一排固定几个」——那是 repeat，几格由名片定死，两者不能互相顶替。
  if (field.multi === true && type === 'select') {
    const source = selectSourceOf(field)
    const list = source ? (Array.isArray(options) ? options : []) : (Array.isArray(field.choices) ? field.choices : [])
    const cur = Array.isArray(value) ? value : []
    return (
      <div style={{ gridColumn: '1 / -1' }} title={help || undefined}>
        <label className="field-label">{label}</label>
        <select multiple className="control" style={{ minHeight: 88 }}
          value={cur}
          onChange={e => onChange(field.name, Array.from(e.target.selectedOptions, o => o.value))}>
          {list.map((c, i) => (
            <option key={i} value={choiceValue(c)}>{choiceLabel(c, lang)}</option>
          ))}
        </select>
      </div>
    )
  }

  // repeat：一排 N 个，格子数由**名片**定死。
  if (n > 1) {
    // ⛔ 值不是数组、或者长度对不上时，补成 N 格再画 —— 但**不改 values**：
    //   我们只是没法画一个长度不对的东西，不代表要替用户改他的值。
    const cur = Array.isArray(value) && value.length === n
      ? value
      : Array.from({ length: n }, (_, i) => (Array.isArray(value) ? value[i] : undefined))
    const labels = Array.isArray(field.dim_labels) ? field.dim_labels : []
    const scalar = { ...field, repeat: 1 }
    return (
      <div style={{ gridColumn: '1 / -1' }} title={help || undefined}>
        <label className="field-label">{label}</label>
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(n, 4)}, minmax(0, 1fr))`,
          gap: 6
        }}>
          {cur.map((v, i) => (
            <div key={i}>
              {labels[i] !== undefined && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>
                  {choiceLabel({ value: i, label: labels[i] }, lang)}
                </div>
              )}
              <ScalarControl field={{ ...scalar, name: `${field.name}[${i}]` }}
                value={v} lang={lang} options={options} t={t}
                onChange={nv => {
                  const next = cur.slice()
                  next[i] = nv
                  onChange(field.name, next)
                }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined} title={help || undefined}>
      <label className="field-label">{label}</label>
      <ScalarControl field={field} value={value} lang={lang} options={options} t={t}
        onChange={v => onChange(field.name, v)} />
    </div>
  )
}

export default ParamField
