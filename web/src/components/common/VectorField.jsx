// 多维参数：一项若干同类型的值，每维一个名字。
//
// 八维情绪向量就是它：八个数字，按 [喜, 怒, 哀, …] 顺序，引擎把整串收成一个逗号分隔的词。
// 之前这一段挤在 ParamField 里用内联 grid 画，最多四列、没有样式类，
// 于是「这一排属于同一个参数」只能靠位置猜。
//
// 这里只管排布：每维一个名字 + 一个控件，控件由调用方按标量类型给。
// 不判断值对不对、不改值的长度：长度由名片定死，改在这里就等于替使用者改了声明。

/**
 * @param {object} props
 * @param {object} props.field 这一项的 param_schema（含 repeat 与 dim_labels）
 * @param {Array} props.value 当前值（长度应与重复数一致）
 * @param {Function} props.onChange 改一维（传新的整排值）
 * @param {Function} props.renderCell 画一维的控件：(index, value, onChange) => 节点
 * @param {Array} props.labels 每一维的名字（来自 dim_labels，已按界面语言取好）
 * @param {string} [props.title] 整块的提示
 */
export default function VectorField ({ field, value, onChange, renderCell, labels, title }) {
  const n = Array.isArray(labels) && labels.length
    ? labels.length
    : Math.max(1, Number(field && field.repeat) || 1)
  // 值不是数组、或长度不对时按 N 格画，但不改 values：
  //   只是没法画一个长度不对的东西，不代表要替使用者改他的值。
  const cur = Array.isArray(value) && value.length === n
    ? value
    : Array.from({ length: n }, (_, i) => (Array.isArray(value) ? value[i] : undefined))

  return (
    <div className="field-vector" title={title || undefined}>
      {cur.map((v, i) => (
        <div className="field-vector-dim" key={i}>
          <div className="field-vector-label">{labels[i] || `#${i + 1}`}</div>
          {renderCell(i, v, (nv) => {
            const next = cur.slice()
            next[i] = nv
            onChange(next)
          })}
        </div>
      ))}
    </div>
  )
}
