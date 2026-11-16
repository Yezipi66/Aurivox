// 运行设备下拉：把后端探测到的显卡摆成一个下拉，选中项原样交回调用方。
// 列表来自后端（本机有哪几块卡只有后端知道），组件不缓存、不猜，也不做换算；
// 换算成引擎认的写法由 lib/engines/deviceValue.js 在下发前做。
//
// 选项按引擎声明的形状摆（名片里的 device_format），所以同一个控件在不同引擎上
// 长得不一样：设备名（cpu / cuda:1）、编号（0 / 1）、或引擎自己列的候选值。
// 每一项带一个 sends 串（「--device cuda:1」），这里只负责显示，让人看得到平台
// 把「哪块卡」翻译成了什么，而不用自己心算。
//
// 引擎认的值未必都在列表里（多卡串 cuda:0,1、npu、某些引擎的私有词），所以末尾
// 留一个「自定义…」：值以 { kind: 'raw' } 原样送出，平台不解释、不换算。
//
// 两处共用：9886 主应用的合成页与接入向导的第 5 步。两边各自取列表，组件只管渲染。
import { useState } from 'react'
import { useT } from '../../lib/i18n'

// 下拉里的哨兵值：它不是设备，只是「切到输入框」的入口，不参与值比较。
const CUSTOM = '__custom__'

export default function DeviceSelect ({
  options = [], value, onChange, id = 'device-select', disabled = false,
}) {
  const { t } = useT()
  // 设备是对象（{ kind: 'auto' } / { kind: 'gpu', index: 0, backend: 'cuda' }），
  //   每次渲染都会新建，不能按引用比，按序列化后的字面量比。
  const keyOf = (v) => JSON.stringify(v || { kind: 'auto' })
  const cur = keyOf(value)

  const rawValue = value && value.kind === 'raw'
    ? String(value.value == null ? '' : value.value)
    : ''
  // 值是原样下发的、又不在候选里（服务端回读时就是这种情况），直接落在自定义模式：
  //   否则下拉会显示成别的一项，而请求里发的是那个人看不见的值。
  const rawInList = options.some((o) => o.value && o.value.kind === 'raw' &&
    String(o.value.value) === rawValue)
  const [customOpen, setCustomOpen] = useState(false)
  const showCustom = customOpen || (!!value && value.kind === 'raw' && !rawInList)

  const picked = options.find((o) => keyOf(o.value) === cur) || null
  const sends = showCustom
    ? (rawValue.trim()
      ? t('Sent as-is: ', '原样下发：') + rawValue.trim()
      : t('Empty: nothing is sent, the engine uses its own default',
        '空值：这一项不发送，引擎用自己的默认值'))
    : (picked && picked.sends) || ''

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{t('Device', '运行设备')}</label>
      <select
        id={id}
        className="control"
        disabled={disabled || !options.length}
        value={showCustom ? CUSTOM : (picked ? cur : (options[0] ? keyOf(options[0].value) : ''))}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustomOpen(true)
            return
          }
          setCustomOpen(false)
          const hit = options.find((o) => keyOf(o.value) === e.target.value)
          if (hit) onChange(hit.value)
        }}
      >
        {options.map((o) => (
          <option key={keyOf(o.value)} value={keyOf(o.value)} disabled={o.selectable === false}>
            {t(o.labelEn || o.labelZh, o.labelZh || o.labelEn)}
          </option>
        ))}
        <option value={CUSTOM}>{t('Custom…', '自定义…')}</option>
      </select>
      {showCustom && (
        <input
          className="control"
          style={{ marginTop: 4 }}
          value={rawValue}
          placeholder={t('the exact value this engine expects', '这台引擎认的原值')}
          disabled={disabled}
          aria-label={t('Custom device value', '自定义设备值')}
          onChange={(e) => onChange({ kind: 'raw', value: e.target.value })}
        />
      )}
      {sends && <div className="field-hint">{sends}</div>}
    </div>
  )
}
