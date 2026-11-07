// vector 控件：一个大框里按维度分格。
//
// 大框标题是这一项在界面上的名字（中文或英文，随界面语言），每个小框的标题
// 是那一维自己的名字。八维情绪向量就是八个文本输入框：格子用 text，
// 因为既能填 0.8 也能填标识符，平台不替引擎规定数制。
//
// 这里只画控件与收整排值；值怎么进命令行由 call.args 的 style 决定。

import { textOf } from '../../lib/engines'

/**
 * @param {object} field 这一项的 param_schema（type=vector，含 dim_labels 与 label）
 * @param {Array} value 当前值（长度应与维度数一致）
 * @param {Function} onValueChange 改整排值
 * @param {string} lang 界面语言
 * @param {Function} t 翻译函数
 */
export default function VectorField ({ field, value, onValueChange, lang, t }) {
  const dims = Array.isArray(field.dim_labels) ? field.dim_labels : []
  const n = dims.length || Math.max(1, Number(field.repeat) || 1)
  const cur = Array.isArray(value) && value.length === n
    ? value
    : Array.from({ length: n }, (_, i) => (Array.isArray(value) ? value[i] : ''))
  const title = field.label && typeof field.label === 'object'
    ? textOf(field.label, lang, field.name)
    : String(field.label || field.name)

  return (
    <fieldset className="field-vector" title={field.help ? textOf(field.help, lang, '') : undefined}>
      <legend className="field-vector-title">{title}</legend>
      <div className="field-vector-dims">
        {cur.map((v, i) => {
          const one = dims[i]
          const sub = one && typeof one === 'object'
            ? textOf(one, lang, String(one.en || one.zh || ''))
            : String(one == null ? '' : one)
          return (
            <label className="field-vector-dim" key={i}>
              <span className="field-vector-dim-label">{sub || `#${i + 1}`}</span>
              <input type="text" className="control"
                value={v == null ? '' : String(v)}
                placeholder={t('value', '值')}
                onChange={(e) => {
                  const next = cur.slice()
                  next[i] = e.target.value
                  onValueChange(next)
                }} />
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
