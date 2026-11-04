// 第 4 步「可选能力」区：声明每个能力从 CLI 的哪个开关进去。
//   运行设备、参考文本、音频输入、输出格式、多权重位都在这里填开关名，填了才有对应控件。
//   具体取值是运行时的东西（合成页选哪块卡、选哪种格式），名片不承载，平台负责把值填进这些开关。
//   本区只编辑名字与标签，平台不解释上游语义。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { readSlots, writeSlots, emptySlot } from './weightSlots'

const APPLIES = ['call', 'launch']

// 声明一个角色开关，同时把名字写进 params.call_time：host 只把白名单里的键交给引擎，
//   漏了这一句界面能填、命令行上却不会出现，而且不报错。
function declareArg (cur, name, entry) {
  const c = cur.call || {}
  const args = { ...(c.args || {}), [name]: { ...(c.args && c.args[name]), ...entry } }
  const p = { ...(cur.params || {}) }
  const ct = Array.isArray(p.call_time) ? p.call_time : []
  if (!ct.includes(name)) p.call_time = [...ct, name]
  return { ...cur, call: { ...c, args }, params: p }
}

export default function OptionalCapabilities ({ manifest, onChange }) {
  const { t } = useT()
  const m = manifest || {}
  const call = m.call || {}
  const audio = Object.entries(call.args || {}).filter(([, e]) => e && e.role === 'audio_ref')
  const weights = Array.isArray(m.weights) ? m.weights : []
  const formats = Array.isArray(m.output_formats) ? m.output_formats : []
  // 输出格式这一项声明过没有：区尾那行「添加」按钮按它决定要不要摆第二个。
  const hasFormatArg = Object.entries(call.args || {})
    .some(([, e]) => e && e.role === 'output_format')
  // 重要但非必填：默认展开，想收起点标题即可。
  const [open, setOpen] = React.useState(true)

  // 全部走函数式更新：同一次提交里别的区也在改名片，用快照整份写回会互相盖掉。
  const patch = (fn) => onChange((cur) => fn(cur || {}))

  const setAudio = (name, key, value) => patch((cur) => {
    const c = cur.call || {}
    const args = { ...(c.args || {}) }
    const p = { ...(cur.params || {}) }
    const ct = Array.isArray(p.call_time) ? p.call_time : []
    const v = String(value == null ? '' : value).trim()
    // 开关名清空（含只敲了空格）＝这一项不声明：参数、白名单一起收走，
    //   前端那一格随之消失，命令上也不会多一个空白词。
    if (key === 'flag' && !v) {
      delete args[name]
      p.call_time = ct.filter((k) => k !== name)
      if (!p.call_time.length) delete p.call_time
      return { ...cur, call: { ...c, args }, params: p }
    }
    const old = args[name] || {}
    const next = { ...old, [key]: key === 'flag' ? v : value }
    if (key === 'label' && !String(value).trim()) delete next.label
    if (key === 'label_en' && !String(value).trim()) delete next.label_en
    args[name] = next
    return { ...cur, call: { ...c, args } }
  })

  // 音频输入：手填开关名 = 开放这项能力（与运行设备同一口径）。
  //   名片里没有这类项时，这一格直接给一个空行，填上开关名就补上它的声明，
  //   并同时写进 params.call_time（host 只认白名单里的键，不写进去界面选了也不发）。
  const addAudio = (flag) => patch((cur) => {
    const name = 'audio_ref'
    const given = String(flag == null ? '' : flag).trim()
    if (!given) return cur
    const c = cur.call || {}
    const args = { ...(c.args || {}) }
    const next = { ...(args[name] || {}), flag: given,
      style: (args[name] && args[name].style) || 'value', role: 'audio_ref' }
    args[name] = next
    const p = { ...(cur.params || {}) }
    const ct = Array.isArray(p.call_time) ? p.call_time : []
    if (!ct.includes(name)) p.call_time = [...ct, name]
    return { ...cur, call: { ...c, args }, params: p }
  })

  const dropAudio = (name) => patch((cur) => {
    const c = cur.call || {}
    const args = { ...(c.args || {}) }
    delete args[name]
    const p = { ...(cur.params || {}) }
    if (Array.isArray(p.call_time)) p.call_time = p.call_time.filter((k) => k !== name)
    return { ...cur, call: { ...c, args }, params: p }
  })

  const setFormats = (list) => patch((cur) => ({ ...cur, output_formats: list.length ? list : undefined }))
  // 输出格式开关：空格＝这项能力不声明。参数、白名单、允许值一起收走，
  //   否则会留下「允许值还在、开关没了」的半张名片。
  const setFormatFlag = (name, value) => patch((cur) => {
    const c = cur.call || {}
    const args = { ...(c.args || {}) }
    const p = { ...(cur.params || {}) }
    const ct = Array.isArray(p.call_time) ? p.call_time : []
    const v = String(value == null ? '' : value).trim()
    if (!v) {
      delete args[name]
      p.call_time = ct.filter((k) => k !== name)
      if (!p.call_time.length) delete p.call_time
      const out = { ...cur, call: { ...c, args }, params: p }
      delete out.output_formats
      return out
    }
    args[name] = { ...(args[name] || {}), flag: v }
    if (!ct.includes(name)) p.call_time = [...ct, name]
    return { ...cur, call: { ...c, args }, params: p }
  })
  // 权重位只有一个写入口：weights 与它需要的接线一起写。
  // 接线包括 param_keys（词汇表，不在表上的键名片装不上）、payload_keys（请求体透传）、
  // params.call_time（宿主白名单）、call.args（命令行形态的开关形状）。
  // 少任何一处的症状都是「下拉能选、引擎没收到」，而且三处都不报错。
  // 权重位的草稿：界面上可以有还没起名的行，而名片里不存空位（位名就是磁盘目录名）。
  //   名片被别处改动（JSON 视图、撤销、换引擎）时重新取一次草稿；自己写出去的那一次不覆盖，
  //   否则刚点「＋」加出来、还没有位名的那一行会被冲掉。
  const weightSig = JSON.stringify(m.weights || null)
  const [slotRows, setSlotRows] = React.useState(() => readSlots(m))
  const lastWritten = React.useRef(weightSig)
  React.useEffect(() => {
    if (weightSig === lastWritten.current) return
    lastWritten.current = weightSig
    setSlotRows(readSlots(m))
  }, [weightSig])
  // 权重位只有一个写入口：weights 与它需要的接线一起写。
  // 接线包括 param_keys（词汇表，不在表上的键名片装不上）、payload_keys（请求体透传）、
  // params.call_time（宿主白名单）、call.args（命令行形态的开关形状）。
  // 少任何一处的症状都是「下拉能选、引擎没收到」，而且三处都不报错。
  const setWeights = (list) => {
    setSlotRows(list)
    patch((cur) => {
      const out = writeSlots(cur, list)
      lastWritten.current = JSON.stringify(out.weights || null)
      return out
    })
  }

  // 运行设备：读名片 call.args 里 role="device" 的项。这一格永远可填，
  //   名片里还没有这一项时填开关名就等于把它补上（默认 --device）。
  const devRows = Object.entries(call.args || {})
    .filter(([, entry]) => entry && entry.role === 'device')
  const deviceFields = devRows.length ? devRows : [['device', null]]

  return (
    <React.Fragment>
      <div
        className="wz-subhead"
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) }
        }}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
        title={t('Important, but optional. Fill in a switch to enable the matching front-end control.',
          '重要但非必填。填了开关才有对应的前端控件。')}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {t('Optional capabilities', '可选能力')}
        <span className="field-hint" style={{ marginLeft: 'auto' }}>
          {t('important, but optional', '重要但非必填')}
        </span>
      </div>

      {open && (
      <div>
        <div className="field-hint" style={{ marginBottom: 8 }}>
          {t('A control appears only when its switch is filled in. Leave it out and the front-end has no such control.',
            '填了才有对应的前端控件；不填，前端就没有那一格。')}
        </div>

        {/* 运行设备与参考文本：一行多列。两格填的都是「参数从哪个开关进去」，
            不是运行时的取值：选哪块卡在合成页，参考文本由音色卡或手工输入给。 */}
        <div className="form-grid">
          {deviceFields.map(([name, entry]) => {
            // 只在真声明过时显示开关名。空名片给的是 placeholder，不是 value：
            //   显示一个没写进名片的 --device，人会以为已经声明了。
            const flag = (entry && entry.flag) || ''
            const apply = (v) => patch((cur) => {
              const c = cur.call || {}
              const args = { ...(c.args || {}) }
              const p = { ...(cur.params || {}) }
              const ct = Array.isArray(p.call_time) ? p.call_time : []
              const nextFlag = String(v == null ? '' : v).trim()
              // 清空（含只敲了空格）＝这台引擎不声明运行设备：参数与白名单一起收走。
              if (!nextFlag) {
                delete args[name]
                p.call_time = ct.filter((k) => k !== name)
                if (!p.call_time.length) delete p.call_time
                return { ...cur, call: { ...c, args }, params: p }
              }
              const next = { ...(args[name] || {}), flag: nextFlag }
              if (!next.style) next.style = 'value'
              if (!next.role) next.role = 'device'
              args[name] = next
              if (!ct.includes(name)) p.call_time = [...ct, name]
              return { ...cur, call: { ...c, args }, params: p }
            })
            return (
              <div className={`field${flag ? '' : ' wz-unset'}`} key={'device-' + name}>
                <label className="field-label" style={{ margin: 0 }}
                  title={t('The switch that receives the selected device. The device itself is chosen on the synthesis page.',
                    '接收所选设备的开关；具体选哪块卡在合成页完成。')}>
                  {t('Runtime device', '运行设备')}
                </label>
                <input className="control"
                  value={flag}
                  placeholder="--device"
                  onChange={(e) => apply(e.target.value)} />
              </div>
            )
          })}
          {(() => {
            const bindNow = (m.call && m.call.bind) || {}
            return (
              <div className={`field${bindNow.ref_text ? '' : ' wz-unset'}`}>
                <label className="field-label" style={{ margin: 0 }}>{t('Reference text', '参考文本')}</label>
                <input className="control"
                  value={bindNow.ref_text || ''}
                  onChange={(e) => {
                    const v = e.target.value
                    onChange((cur) => {
                      const cm = cur || {}
                      const c = cm.call || {}
                      const nextBind = { ...(c.bind || {}) }
                      if (!String(v).trim()) delete nextBind.ref_text
                      else nextBind.ref_text = String(v).trim()
                      return { ...cm, call: { ...c, bind: nextBind } }
                    })
                  }} />
              </div>
            )
          })()}
        </div>

        {/* 音频类输入：每条一行，开关名与标签都可改。
            名片里没有这类项时，这一格直接给一个空行填开关名（与运行设备同一口径）。
            不在这一行里区分单选/多选：9886 的 AuxReferencePicker 一律是选列表，
            单选/多选的差别只在 value / repeat 两种开关样式，平台不猜。 */}
        {(audio.length ? audio : [['audio_ref', null]]).map(([name, e]) => {
          const ee = e || { flag: '' }
          return (
          <div key={name} className={e ? undefined : 'wz-unset'}
            style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'nowrap', marginTop: 6 }}>
            <div className="field" style={{ flex: '1 1 0', minWidth: 0, marginBottom: 0 }}>
              <label className="field-label">{t('Audio input', '音频输入')}</label>
              <input className="control" value={ee.flag || ''}
                placeholder="--emotion-audio"
                title={t('The switch that receives the selected audio path', '接收所选音频路径的开关')}
                onChange={(ev) => {
                  const v = ev.target.value
                  if (audio.length === 0) addAudio(v)
                  else setAudio(name, 'flag', v)
                }} />
            </div>
            <div className="field" style={{ flex: '1 1 0', minWidth: 0, marginBottom: 0 }}>
              <label className="field-label">{t('Label', '显示名')}</label>
              <input className="control" value={ee.label || ''}
                placeholder={name}
                onChange={(ev) => setAudio(name, 'label', ev.target.value)} />
            </div>
            {e && (
              <button type="button" className="btn btn-sm" style={{ marginBottom: 0 }}
                onClick={() => dropAudio(name)}>{t('Remove', '移除')}</button>
            )}
          </div>
          )
        })}

        {/* 输出格式：主格填「参数从哪个开关进去」，允许值只是这台引擎认哪几种容器，
            由扫描该开关的 choices 自动带出，也可以手改。两者都不是运行时的取值。 */}
        {(() => {
          const decl = Object.entries(call.args || {}).find(([, e]) => e && e.role === 'output_format')
          const [name, entry] = decl || ['format', null]
          // 没声明时不在这里放按钮：这一区的「添加」统一排在区尾一行，见文件底部。
          if (!entry) return null
          return (
            <div className={`form-grid${entry.flag ? '' : ' wz-unset'}`} style={{ marginTop: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label"
                  title={t('The switch that receives the selected format. The format itself is chosen on the synthesis page.',
                    '接收所选格式的开关；具体选哪种格式在合成页完成。')}>
                  {t('Output format switch', '输出格式开关')}
                </label>
                <input className="control" value={entry.flag || ''} placeholder="--format"
                  onChange={(ev) => setFormatFlag(name, ev.target.value)} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label"
                  title={t('Which containers this engine can emit. Used for the front-end options and the host format check.',
                    '这台引擎能出哪几种容器，供前端下拉选项与宿主格式校验使用。')}>
                  {t('Allowed values', '允许值')}
                </label>
                <input className="control" value={formats.join(', ')} placeholder="wav, mp3"
                  onChange={(ev) => setFormats(ev.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))} />
              </div>
            </div>
          )
        })()}

        {/* 多权重位：排在其它参数之后，紧挨着「加一位权重位」那个按钮，
            这样「摆着几位 + 再加一位」是同一组，不用在区首区尾两头找。
            它决定合成页长几个模型下拉。
            一位一个框：框的左上角是标题「第N权重位」，框里四个参数并排一行
            （权重位名/显示名/参数名/生效时机），框尾一个小「＋」加下一位，可以一直加到无数位。
            编号从 2 起：第 1 位是必填字段的「模型权重」那一格，它声明权重从哪个参数进来、
            值落在第 3 步的下载落点，开进程时载入，平台只送得进一份（{checkpoints}）。
            那一格在必填区，不在这区；这里管的是合成时还能按位换的那几份，所以从第 2 位起。
            不需要多权重位的引擎（单权重那类）一位都不声明，本区就只剩一个「加一位」按钮：
            不给空框，否则那框永远减不掉，等于替单权重引擎虚报了一项能力。
            位名进磁盘路径（assets/<音色>/models/<引擎 id>/<位名>/），也是合成页那个下拉的名字；
            参数名是这一份权重从哪个开关进命令行；生效时机是「换它要不要重开进程」。
            清空位名就等于去掉这一位：位名是磁盘目录名，没有名字的一行不进名片。 */}
        {(() => {
          const shown = slotRows
          const boxStyle = { marginBottom: 6, padding: '6px 8px',
            border: '1px solid var(--border)', borderRadius: 6 }
          const lineStyle = { display: 'grid', gap: 8, alignItems: 'end',
            gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1.1fr) minmax(0, 1.1fr) 96px auto' }
          const cellLabel = { margin: 0 }
          const setCell = (k, key, v) => setWeights(
            shown.map((r, j) => (j === k ? { ...r, [key]: v } : r)))
          // 参数名那一格是行里唯一的真源：写 param，开关形状由 writeSlots 按名片形态补。
          const setParamCell = (k, v) => setWeights(
            shown.map((r, j) => (j === k ? { ...r, param: v, flag: '' } : r)))
          // 一位都没有就整块不出现（单权重引擎），也就不留分隔线。
          if (!shown.length) return null
          // 与上方参数分隔：本段说明的是另一件事（合成页长几个下拉），
          // 只靠行距挤在一起会看成上一段的续行。
          return (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              {shown.map((row, i) => (
                <div key={'slot-' + i} style={boxStyle}>
                  <div className="field-label" style={{ margin: '0 0 6px', fontWeight: 600 }}>
                    {t(`Weight slot ${i + 2}`, `第${i + 2}权重位`)}
                  </div>
                  <div style={lineStyle}>
                    <div>
                      <label className="field-label" style={cellLabel}
                        title={t('Goes into the disk path: assets/<voice>/models/<engine id>/<slot name>/',
                          '进磁盘路径：assets/<音色>/models/<引擎 id>/<位名>/')}>
                        {t('Slot name', '权重位名')}
                      </label>
                      <input className="control" value={row.name || ''}
                        onChange={(ev) => setCell(i, 'name', ev.target.value)} />
                    </div>
                    <div>
                      <label className="field-label" style={cellLabel}>{t('Label', '显示名')}</label>
                      <input className="control" value={row.label || ''}
                        placeholder={t('the slot name', '用位名')}
                        onChange={(ev) => setCell(i, 'label', ev.target.value)} />
                    </div>
                    <div>
                      <label className="field-label" style={cellLabel}>{t('Parameter', '参数名')}</label>
                      <input className="control" value={row.flag || row.param || ''}
                        placeholder={t('empty: not switchable at run time', '留空：运行时不可换')}
                        onChange={(ev) => setParamCell(i, ev.target.value)} />
                    </div>
                    <div>
                      <label className="field-label" style={cellLabel}>{t('Applies at', '生效时机')}</label>
                      <select className="control" value={row.applies_at || 'call'}
                        onChange={(ev) => setCell(i, 'applies_at', ev.target.value)}>
                        <option value="call">{t('on each call', '调用时换')}</option>
                        <option value="launch">{t('at startup', '启动时载入')}</option>
                      </select>
                    </div>
                    {/* 加在上、减在下。位名留空的行本来就会被忽略（位名是磁盘目录名），
                        但加号误点一次就多一行，所以减号得留着收回来。
                        只剩这一位时减号变灰：再减连行都没有了，要它不生效就把位名清空。 */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <button type="button" className="btn btn-sm"
                        title={t('Add another weight slot', '再加一位')}
                        onClick={() => setWeights([...shown, emptySlot()])}>
                        +
                      </button>
                      <button type="button" className="btn btn-sm"
                        disabled={shown.length <= 1}
                        title={shown.length <= 1
                          ? t('The only slot stays: clear its name to drop it', '只剩这一位；清空位名就等于不要它')
                          : t('Remove this weight slot', '去掉这一位')}
                        onClick={() => setWeights(shown.filter((_, j) => j !== i))}>
                        −
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        })()}

        {/* 添加类按钮排一行：都是「这一段还没声明，点一下加上」。
            不各占一行、也不塞进各自的段里，否则一条孤零零的按钮会把版面割开，
            同类的东西还得上下找。 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {/* 权重位一位都没有时才出现在这里：那时没有卡可点，需要一个起点。
              已有位时加号在每张卡的右侧，不在这一行重复。 */}
          {!slotRows.length && (
            <button type="button" className="btn btn-sm"
              title={t('Add a weight slot', '加一位权重位')}
              onClick={() => setWeights([emptySlot()])}>
              + {t('Add a weight slot', '加一位权重位')}
            </button>
          )}
          {!hasFormatArg && (
            <button type="button" className="btn btn-sm"
              title={t('Add output formats', '添加输出格式')}
              onClick={() => patch((cur) => {
                // 允许值给 wav 起步：hostProfile 的默认就是只出 wav，界面照同一份契约。
                // 扫到该开关的 choices 时，建议会按「已有声明不覆盖」带出更多值。
                const next = declareArg(cur, 'format', {
                  flag: '--format', style: 'value', role: 'output_format',
                })
                return cur.output_formats === undefined ? { ...next, output_formats: ['wav'] } : next
              })}>
              + {t('Add output formats', '添加输出格式')}
            </button>
          )}
        </div>
      </div>
      )}
    </React.Fragment>
  )
}
