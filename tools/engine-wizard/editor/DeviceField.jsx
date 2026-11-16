// 第 4 步「引擎配置」里的运行设备声明。
//   设备是进程启动期的设置：具体选哪块卡由 9886 的引擎设置决定，改了要重启引擎；
//   名片只承载「从哪个开关进去、取值写成什么形状」，不承载具体卡（A60）。
//   放在引擎配置区而不是可选能力区，是因为它跟启动参数同类，不是合成时的能力开关。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import Select from '../../../web/src/components/common/Select'
import { withCallKey } from './callWhitelist'
import { deviceSlots } from './deviceSlots'

export default function DeviceField ({ manifest, onChange }) {
  const { t } = useT()
  const m = manifest || {}
  // 写名片一律交函数：同一次提交里别的区也在写，整份快照回写会互相盖掉。
  const patch = (fn) => onChange((cur) => fn(cur || {}))

  const deviceFields = deviceSlots(m)

  return (
    <React.Fragment>
      {deviceFields.map(([name, entry]) => {
        // 只在真声明过时显示开关名。空名片给的是 placeholder，不是 value：
        //   显示一个没写进名片的 --device，人会以为已经声明了。
        const flag = (entry && entry.flag) || ''
        // 平台把「选中的那块卡」换算成引擎认的写法，写法由这一项说了算：
        //   设备名（cpu / cuda:1 / xpu）是 torch 系；编号（0 / 1）是收整数的引擎；
        //   引擎自己列了 choices 时只能照表里的值挑。缺省按设备名。
        const format = (entry && entry.device_format) || 'torch'
        const choiceList = (entry && Array.isArray(entry.choices) && entry.choices.length)
          ? entry.choices
          : null
        const apply = (v) => patch((cur) => {
          const c = cur.call || {}
          const args = { ...(c.args || {}) }
          const nextFlag = String(v == null ? '' : v).trim()
          // 清空（含只敲了空格）＝这台引擎不声明运行设备：参数与白名单一起收走。
          if (!nextFlag) {
            delete args[name]
            return withCallKey({ ...cur, call: { ...c, args } }, name, false)
          }
          const next = { ...(args[name] || {}), flag: nextFlag }
          if (!next.style) next.style = 'value'
          if (!next.role) next.role = 'device'
          if (!next.device_format) next.device_format = 'torch'
          args[name] = next
          return withCallKey({ ...cur, call: { ...c, args } }, name, true, 'text')
        })
        // 写法只在真声明了开关之后才有意义：没声明时下拉不可点，
        //   免得人以为选个「编号」就把这项能力打开了。
        const setFormat = (v) => patch((cur) => {
          const c = cur.call || {}
          const args = { ...(c.args || {}) }
          if (!args[name]) return cur
          const next = { ...args[name] }
          // 设备名是缺省写法，不写进名片：留空即按它算，名片少一个会漂的字段。
          if (v === 'torch') delete next.device_format
          else next.device_format = v
          args[name] = next
          return { ...cur, call: { ...c, args } }
        })
        return (
          <div className={`field${flag ? '' : ' wz-unset'}`} key={'device-' + name}>
            {/* 下拉不放进 label 里：那样标签的可访问名称会变成「运行设备 设备名 编号」，
                读屏器会把候选当成本格的说明念出来，测试里按标签取文案也会取到一长串。 */}
            <div className="wz-device-label">
              <label className="field-label" style={{ margin: 0 }}
                title={t('The switch that receives the selected device. The card itself is chosen in engine settings on 9886; changing it restarts the engine.',
                  '接收所选设备的开关；具体选哪块卡在 9886 的引擎设置里完成，改了要重启引擎。')}>
                {t('Runtime device', '运行设备')}
              </label>
              <Select className="control wz-device-format"
                value={format}
                disabled={!flag}
                aria-label={t('Device value format', '设备取值写法')}
                title={t('How the chosen card is written into this switch: a device name (cpu / cuda:1 / xpu) for torch engines, an integer for engines that take an index, or one of the values the engine itself lists.',
                  '选中的卡怎么写成这个开关的值：torch 系引擎要设备名（cpu / cuda:1 / xpu）；收整数的引擎要编号；引擎自己列了候选值时只能照表挑。')}
                onChange={(e) => setFormat(e.target.value)}>
                <option value="torch">{t('name', '设备名')}</option>
                <option value="index">{t('index', '编号')}</option>
                {choiceList && <option value="enum">{t('choices', '候选值')}</option>}
              </Select>
            </div>
            <input className="control"
              value={flag}
              placeholder="--device"
              onChange={(e) => apply(e.target.value)} />
          </div>
        )
      })}
    </React.Fragment>
  )
}
