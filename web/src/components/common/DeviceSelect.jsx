// 运行设备下拉：把后端探测到的显卡摆成一个下拉，选中项原样交回调用方。
// 列表来自后端（本机有哪几块卡只有后端知道），组件不缓存、不猜，也不做换算；
// 换算成引擎认的写法由 lib/engines/deviceValue.js 在下发前做。
//
// 两处共用：9886 主应用的合成页与接入向导的第 5 步。两边各自取列表，组件只管渲染。
import { useT } from '../../lib/i18n'

export default function DeviceSelect ({
  options = [], value, onChange, id = 'device-select', disabled = false,
}) {
  const { t } = useT()
  // 设备是对象（{ kind: 'auto' } / { kind: 'gpu', index: 0, backend: 'cuda' }），
  //   每次渲染都会新建，不能按引用比，按序列化后的字面量比。
  const keyOf = (v) => JSON.stringify(v || { kind: 'auto' })
  const cur = keyOf(value)
  const hit = options.some((o) => keyOf(o.value) === cur)
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{t('Device', '运行设备')}</label>
      <select
        id={id}
        className="control"
        disabled={disabled || !options.length}
        value={hit ? cur : (options[0] ? keyOf(options[0].value) : '')}
        onChange={(e) => {
          const picked = options.find((o) => keyOf(o.value) === e.target.value)
          if (picked) onChange(picked.value)
        }}
      >
        {options.map((o) => (
          <option key={keyOf(o.value)} value={keyOf(o.value)} disabled={o.selectable === false}>
            {t(o.labelEn || o.labelZh, o.labelZh || o.labelEn)}
          </option>
        ))}
      </select>
    </div>
  )
}
