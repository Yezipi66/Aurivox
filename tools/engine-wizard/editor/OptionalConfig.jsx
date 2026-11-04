// 引擎配置的可选参数区。
﻿import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { OPTIONAL_KEYS, SOURCES, PLATFORM_DEFAULTS, get, setPath, removeItem, prefillReferenceAudio, platformDefaultedRows, localMeasuredRows } from './optionalKeys'
import PlatformDeclarations from './PlatformDeclarations'

// 可选参数里的「引擎配置」：除 5 项必填外、平台有兜底常量、按需再填的项。
//
// 全量列出：没写的项也各占一行，控件留空；行内徽标标出平台按常量兜底的项与本机量得的项。
// 前面几步已定下的（源码、安装、权重、调用形态）不在这里出现，改它们走 JSON 视图。
// 清单与变换在 optionalKeys.js。

// 三个出处值由平台定（lib/engines/profile/topkeys.js 的 MEASURED_SOURCES：measured / upstream / estimated）：measured = 本项目自己量得，
//   upstream = 上游文档给出，estimated = 推算或经验估计。控件显示中文标签，名片里仍是原值。
const SOURCE_LABEL = {
  estimated: { en: 'estimated', zh: '估算' },
  measured: { en: 'measured', zh: '实测' },
  upstream: { en: 'upstream', zh: '上游文档' },
}

// 不填时平台的取值（数值取 PLATFORM_DEFAULTS，与 lib/engines/profile.js 的 DEFAULTS 一致）。
//   数值项给具体数，文字项给 fallbackZh；它同时作为「默认」徽标后的值与数字控件的占位提示。
function defaultText (item) {
  const key = item.path.split('.').pop()
  const num = PLATFORM_DEFAULTS[key]
  return num !== undefined ? String(num) : item.fallbackZh
}

// 时长区间：两个数字格。
//   清空要真的回到「不限制」，所以这里存的是本地草稿（与 JsonInput 同一个做法）：
//   两格都空就把这一项从名片里删掉，只有两格都填好才写进去。
//   直接写名片会在空串上折成 0：清掉第一格得到 [0, x]，再清第二格得到 [0, 0]，
//   那是「必须正好 0 秒」的真约束，界面上也就再回不到空。
function RangeInput ({ value, onValue, t }) {
  const toDraft = (v) => {
    const [lo, hi] = Array.isArray(v) ? v : ['', '']
    const one = (x) => (x === '' || x === null || x === undefined ? '' : String(x))
    return [one(lo), one(hi)]
  }
  const [draft, setDraft] = React.useState(() => toDraft(value))
  const sig = Array.isArray(value) ? value.join(',') : ''
  // 名片被别处改动（换引擎、撤销、JSON 视图）时把草稿拉回真实值。
  React.useEffect(() => { setDraft(toDraft(value)) }, [sig])
  const set = (i, v) => {
    const next = i === 0 ? [v, draft[1]] : [draft[0], v]
    setDraft(next)
    if (next[0] === '' && next[1] === '') { onValue(undefined); return }
    if (next[0] === '' || next[1] === '') return
    const a = Number(next[0])
    const b = Number(next[1])
    if (!Number.isFinite(a) || !Number.isFinite(b)) return
    onValue([a, b])
  }
  return (
    <div className="wz-range">
      <input className="control" type="number" value={draft[0]}
        placeholder={t('shortest', '最短')}
        onChange={(e) => set(0, e.target.value)} />
      <input className="control" type="number" value={draft[1]}
        placeholder={t('longest', '最长')}
        onChange={(e) => set(1, e.target.value)} />
    </div>
  )
}


// 「默认」是常量取值的别名，不是额外选项：没写过这个键时下拉就落在那个取值上，
//   选中那一条等于不写这个键（回 removeItem，值与 <key>_source 一起删）。
function Control ({ item, value, onValue, t, placeholder }) {
  const shown = value === undefined || value === null || value === ''
    ? (item.defaultValue !== undefined ? item.defaultValue : '')
    : String(value)
  if (item.kind === 'number') {
    return <input className="control" type="number" value={value ?? ''} placeholder={placeholder}
      onChange={(e) => onValue(e.target.value === '' ? undefined : Number(e.target.value))} />
  }
  if (item.kind === 'bool') {
    return (
      <select className="control" value={shown}
        title={item.ctrlTitleZh ? t(item.ctrlTitleEn, item.ctrlTitleZh) : undefined}
        onChange={(e) => onValue(e.target.value === '' ? undefined : e.target.value === 'true')}>
        <option value="true">{item.optionLabels && item.optionLabels.true ? t(item.optionLabels.true.en, item.optionLabels.true.zh) : t('yes', '是')}</option>
        <option value="false">{item.optionLabels && item.optionLabels.false ? t(item.optionLabels.false.en, item.optionLabels.false.zh) : t('no', '否')}</option>
      </select>
    )
  }
  if (item.kind === 'select') {
    return (
      <select className="control" value={shown}
        title={item.ctrlTitleZh ? t(item.ctrlTitleEn, item.ctrlTitleZh) : undefined}
        onChange={(e) => onValue(e.target.value || undefined)}>
        {item.options.map((o) => (
          <option key={o} value={o}>{item.optionLabels && item.optionLabels[o] ? t(item.optionLabels[o].en, item.optionLabels[o].zh) : o}</option>
        ))}
      </select>
    )
  }
  if (item.kind === 'range') {
    return <RangeInput value={value} onValue={onValue} t={t} />
  }
  if (item.kind === 'list') {
    return <input className="control" type="text" value={(value || []).join(' ')}
      placeholder={t('space separated', '空格分隔')}
      onChange={(e) => onValue(e.target.value.split(/\s+/).filter(Boolean))} />
  }
  if (item.kind === 'json') {
    return <JsonInput value={value} onValue={onValue} placeholder={placeholder} />
  }
  return <input className="control" type="text" value={value ?? ''} placeholder={placeholder}
    onChange={(e) => onValue(e.target.value === '' ? undefined : e.target.value)} />
}

// JSON 对象输入：解析失败时保留原文，不向名片写入非法值。
// 名片里没有这一项时输入框为空；未填不写，清空即删键。
function JsonInput ({ value, onValue, placeholder }) {
  const [text, setText] = React.useState(value === undefined ? '' : JSON.stringify(value))
  const [bad, setBad] = React.useState(false)
  const sig = value === undefined ? '' : JSON.stringify(value)
  // 名片被别处改动时把草稿拉回真实值。
  React.useEffect(() => { setText(sig); setBad(false) }, [sig])
  return (
    <input className={`control${bad ? ' wz-field-guess' : ''}`} type="text" value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        if (e.target.value.trim() === '') { onValue(undefined); setBad(false); return }
        try { onValue(JSON.parse(e.target.value)); setBad(false) } catch { setBad(true) }
      }} />
  )
}

// 从 argv 里读一个开关后面的值：["--device", "0"] 读 "--device" 得 "0"。
//   同一个开关出现多次时取最后一次，argparse 也是后者胜。
function readFlagValue (argv, flag) {
  const list = Array.isArray(argv) ? argv : []
  let out = ''
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === flag && i + 1 < list.length) out = list[i + 1]
  }
  return out
}

// 把一个开关的值写回 argv：先摘掉这个开关和紧跟的值，有新值就追加到末尾。
//   其余词的顺序不动，{checkpoints} 这类占位符原样留着。
function writeFlagValue (manifest, flag, value) {
  const call = { ...((manifest && manifest.call) || {}) }
  const list = Array.isArray(call.argv) ? call.argv : []
  const kept = []
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === flag) { i += 1; continue }
    kept.push(list[i])
  }
  const v = String(value == null ? '' : value).trim()
  if (v) kept.push(flag, v)
  call.argv = kept
  return { ...manifest, call }
}

export default function OptionalConfig ({ manifest, onChange }) {
  const { t } = useT()
  const m = manifest || {}
  // 全量列出：名片没写的项也各占一行，控件留空，不再把未填项藏进「添加一项」下拉
  //   （要挨个展开才看得见全貌）。
  //   条件式的两项（启动脚本非通用宿主、生成器形态）仍然按 when 判。
  const rows = OPTIONAL_KEYS.filter((it) => !it.when || it.when(m))
  // 平台对盘上这张名片的读数：哪些项是平台自己答的（profile.defaulted）。
  //   名片还没落盘时读不到，就不标（不猜）。
  //   本机测得的项（profile.value_sources 为 local）不在 defaulted 里，另列一行。
  const [profile, setProfile] = React.useState(null)
  // 引擎配置默认收起：这一堆多数保持默认就够，全展开会把真正要人答的格子挤到屏幕外。
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (!m.id) { setProfile(null); return undefined }
    let live = true
    fetch(`/wizard/profile/${encodeURIComponent(m.id)}`)
      .then((r) => r.json())
      .then((j) => { if (live) setProfile(j && j.ok && j.profile ? j.profile : null) })
      .catch(() => { if (live) setProfile(null) })
    return () => { live = false }
  }, [m.id])
  const defaulted = profile ? profile.defaulted || [] : null
  // 参考音频直接用普通预填：没写这个键就补上 true；用函数式更新拿最新名片，不冲掉别的字段。
  React.useEffect(() => {
    if (get(m, 'capabilities.requires_reference_audio') !== undefined) return
    onChange((cur) => (cur && get(cur, 'capabilities.requires_reference_audio') === undefined
      ? prefillReferenceAudio(cur) : cur))
  })
  const byDefault = platformDefaultedRows(m, defaulted)
  const byLocal = profile ? localMeasuredRows(profile.value_sources) : []
  // 徽标挂在行尾，不再另开两块列表重复同一信息。
  const defaultSet = new Set(byDefault.map((it) => it.path))
  const localSet = new Set(byLocal.map((it) => it.path))

  // 写了值就必须写出处（topkeys.js 的 checkMeasuredSources() 会校验）。跟 addItem 同一个语义，
  //   只是入口从「添加一项」下拉换成了直接在这一行里填：
  //   填了值而还没写处，就补一个 estimated。
  //   清空 = 移除：走 removeItem，值与出处一起删，不留半条。
  const applyValue = (it, v) => {
    // 常量默认是取值的别名：选中它等于不写这个键，走 removeItem（值与 <key>_source 一起删）。
    // 用户自己清空参考音频：记住这次决定，预填不再把它加回来。
    if (v === undefined || (it.defaultValue !== undefined && v === it.defaultValue)) { onChange(removeItem(m, it)); return }
    let next = setPath(m, it.path, v)
    if (it.source && get(next, it.source) === undefined) next = setPath(next, it.source, 'estimated')
    onChange(next)
  }

  return (
    <React.Fragment>
      {/* 不包一层 div：小标题要是区内的非首个子元素，才吃得到 .wz-subhead 的上边距。 */}
      {/* 运行设备：夹在合成参数与引擎配置之间。它不是必填，但选错卡直接跑不起来，
          所以既不能埋进折叠里，也不该混在合成参数里跟别的旋钮一起被忽略。
          格子照必填区那几格的样子做（标签 + 键名徽章 + 输入框 + 说明），读名片 call.args 里 role="device" 的项。 */}
      {/* 运行参数声明行：运行设备与参考文本一行排开（一行多列，后续参数也放这里）。
          参考文本声明的是「参考文本由哪个开关收」（call.bind.ref_text，平台四个核心槽位之一）：
          合成时平台把请求里的参考文本（音色卡自动或手工）填进这个开关。 */}
      {(() => {
        const devRows = Object.entries((m.call && m.call.args) || {})
          .filter(([, entry]) => entry && entry.role === 'device')
        // 这一格永远可填。名片里还没有这一项时，填值就等于把它声明出来：
        //   开关默认叫 --device，格式按设备字符串处理，之后还能在 JSON 视图里改。
        //   做成只读的灰框等于告诉人这里没他的事，而这正是名片要人填的东西。
        const rows = devRows.length ? devRows : [['device', null]]
        return (
          <div className="form-grid">
            {rows.map(([name, entry]) => {
              const flag = (entry && entry.flag) || '--device'
              const fmt = (entry && entry.device_format) || 'torch'
              // 填的是开关后面那个值，直接进命令行：--device 后面跟这里填的内容。
              //   值写在 call.argv 里，和 {checkpoints} 那些固定参数同一处。
              //   合成时若请求另给了 device，argparse 取最后一个，等于覆盖这里。
              const value = readFlagValue(m.call && m.call.argv, flag)
              const apply = (v) => {
                let next = m
                if (!entry && String(v).trim()) {
                  next = {
                    ...m,
                    call: {
                      ...(m.call || {}),
                      args: {
                        ...((m.call && m.call.args) || {}),
                        [name]: { flag, style: 'value', role: 'device', device_format: fmt },
                      },
                    },
                  }
                }
                onChange(writeFlagValue(next, flag, v))
              }
              return (
                <div className="field" key={'device-' + name}>
                  <label className="field-label" style={{ margin: 0 }}>{t('Runtime device', '运行设备')}</label>
                  <input className="control"
                    value={value}
                    onChange={(e) => apply(e.target.value)} />
                </div>
              )
            })}
            {(() => {
              const bindNow = (m.call && m.call.bind) || {}
              return (
                <div className="field">
                  <label className="field-label" style={{ margin: 0 }}>{t('Reference text', '参考文本')}</label>
                  <input className="control"
                    value={bindNow.ref_text || ''}
                    onChange={(e) => {
                      const v = e.target.value
                      const c = m.call || {}
                      const nextBind = { ...(c.bind || {}) }
                      if (!String(v).trim()) delete nextBind.ref_text
                      else nextBind.ref_text = v
                      onChange({ ...m, call: { ...c, bind: nextBind } })
                    }} />
                </div>
              )
            })()}
          </div>
        )
      })()}

      {/* 平台声明：音频类输入 / 多权重位 / 输出格式。声明了才有对应前端控件。 */}
      <PlatformDeclarations manifest={m} onChange={onChange} />

      {/* 引擎配置默认收起：多数保持默认就够，全展开会把真正要人答的格子挤到屏幕外。
          运行设备不塞进折叠里：它选错卡会直接跑不起来，藏起来等于没人会看一眼。
          它按同一套行格式排在这里，只是不跟着折叠。 */}
      <div
        className="wz-subhead"
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) }
        }}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
        title={t('Most of these are fine at their defaults.', '这些多数保持默认即可。')}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {t('Engine settings', '引擎配置')}
        <span className="badge">{rows.length}</span>
        <span className="field-hint" style={{ marginLeft: 'auto' }}>
          {open ? t('click to collapse', '点击收起') : t('all left at defaults', '全部保持默认')}
        </span>
      </div>


      {open && (
      <div className="wz-opt-grid">
        {rows.map((it) => {
          const value = get(m, it.path)
          // 「不填时平台取值」不再单独占行：一进标签 title，二进标签后的灰色说明。
          const fallback = t(`if left out: ${it.fallbackEn}`, `不填时：${it.fallbackZh}`)
          const isLocal = localSet.has(it.path)
          const isDefault = !isLocal && defaultSet.has(it.path)
          const def = defaultText(it)
          const note = it.noteZh ? t(it.noteEn, it.noteZh) : ''
          const hintText = it.hintZh
            ? t(it.hintEn, it.hintZh)
            : (it.kind === 'number' && value !== undefined ? t(`default ${def}`, `默认 ${def}`) : '')
          // 数字控件用兜底常量做占位；文字与 JSON 控件不预填，说明文字排在标签之后。
          const ph = it.kind === 'number' ? def : ''
          // 数字项没有「还没选」这种状态可当选项，所以兜底常量用两处常驻表达：
          // 空着时徽标 + 输入框占位写着它；写了值以后右侧灰字写「默认 X」，
          // 默认值不会因为填了值就消失。
          return (
            <div className="wz-opt-row" key={it.path}>
              <label className="field-label wz-opt-label" title={`${it.path} · ${fallback}${note ? ' · ' + note : ''}`}>
                {t(it.en, it.zh)}
                {isLocal && <span className="badge" title={fallback}>{t('measured here', '本机实测')}</span>}
                {isDefault && (
                  <React.Fragment>
                    <span className="badge" title={fallback}>{t('default', '默认')}</span>
                    <span className="wz-opt-default" title={fallback}>{def}</span>
                  </React.Fragment>
                )}
                {hintText && (
                  <span className="wz-opt-hint" title={hintText}>{hintText}</span>
                )}
              </label>
              <div className={`wz-opt-control${it.source ? ' has-source' : ''}`}>
                <Control item={it} value={value} t={t} placeholder={ph}
                  onValue={(v) => applyValue(it, v)} />
                {/* 出处控件常驻同一格：未填时禁用（沿用 .control:disabled 的 0.4 透明度），
                    有值时可改。行宽不随状态变化。 */}
                {it.source && (
                  <select className="control wz-opt-source"
                    value={value === undefined ? '' : (get(m, it.source) || 'estimated')}
                    disabled={value === undefined}
                    title={t('Where this number came from: measured = we measured it here, upstream = from the upstream docs, estimated = a guess. A value must carry one of the three (lib/engines/profile/topkeys.js).',
                      '这个数怎么来的：实测 = 本项目量的，上游文档 = 官方文档写的，估算 = 推算/经验拍。'
                      + '写了值就必须写出处，三选一（lib/engines/profile/topkeys.js 的规矩）。')}
                    onChange={(e) => onChange(setPath(m, it.source, e.target.value))}>
                    {value === undefined && (
                      <option value="">{t('(no value)', '（未填）')}</option>
                    )}
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>{t(SOURCE_LABEL[s].en, SOURCE_LABEL[s].zh)}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          )
        })}
      </div>
      )}
    </React.Fragment>
  )
}
