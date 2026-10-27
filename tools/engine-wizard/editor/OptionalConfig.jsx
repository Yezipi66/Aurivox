import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { OPTIONAL_KEYS, SOURCES, get, setPath, rowVisible, addItem, removeItem, platformDefaultedRows } from './optionalKeys'

// 可选参数里的「引擎配置」：除了 5 项必填之外、平台有默认、要改才填的那几项。
//
// 默认一行都不显示，每一行写着「不填时平台怎么办」；要改才点「添加」，加出来的才写进名片。
// 前面几步已经定下的（源码、安装、权重、调用形态）不在这里出现，要动它们到 JSON 视图里改。
// 清单与变换在 optionalKeys.js。

function Control ({ item, value, onValue, t }) {
  if (item.kind === 'number') {
    return <input className="control" type="number" value={value ?? ''}
      onChange={(e) => onValue(e.target.value === '' ? undefined : Number(e.target.value))} />
  }
  if (item.kind === 'bool') {
    return (
      <select className="control" value={String(value ?? '')}
        onChange={(e) => onValue(e.target.value === '' ? undefined : e.target.value === 'true')}>
        <option value="true">{t('yes', '是')}</option>
        <option value="false">{t('no', '否')}</option>
      </select>
    )
  }
  if (item.kind === 'select') {
    return (
      <select className="control" value={value ?? ''} onChange={(e) => onValue(e.target.value || undefined)}>
        {item.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (item.kind === 'range') {
    const unlimited = value === null
    const [lo, hi] = Array.isArray(value) ? value : ['', '']
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {!unlimited && (
          <React.Fragment>
            <input className="control" type="number" style={{ width: 84 }} value={lo}
              placeholder={t('shortest', '最短')}
              onChange={(e) => onValue([Number(e.target.value || 0), hi === '' ? 0 : hi])} />
            <input className="control" type="number" style={{ width: 84 }} value={hi}
              placeholder={t('longest', '最长')}
              onChange={(e) => onValue([lo === '' ? 0 : lo, Number(e.target.value || 0)])} />
          </React.Fragment>
        )}
        <button className="btn btn-sm" type="button" onClick={() => onValue(unlimited ? [3, 10] : null)}>
          {unlimited ? t('set a range', '设一个范围') : t('no limit', '不限制')}
        </button>
      </div>
    )
  }
  if (item.kind === 'list') {
    return <input className="control" type="text" value={(value || []).join(' ')}
      placeholder={t('space separated', '空格分隔')}
      onChange={(e) => onValue(e.target.value.split(/\s+/).filter(Boolean))} />
  }
  if (item.kind === 'json') {
    return <JsonInput value={value} onValue={onValue} />
  }
  return <input className="control" type="text" value={value ?? ''}
    onChange={(e) => onValue(e.target.value === '' ? undefined : e.target.value)} />
}

// JSON 对象输入：解析不了时先留着原文，不往名片里写坏值。
function JsonInput ({ value, onValue }) {
  const [text, setText] = React.useState(JSON.stringify(value ?? {}))
  const [bad, setBad] = React.useState(false)
  return (
    <input className={`control${bad ? ' wz-field-guess' : ''}`} type="text" value={text}
      onChange={(e) => {
        setText(e.target.value)
        try { onValue(JSON.parse(e.target.value || '{}')); setBad(false) } catch { setBad(true) }
      }} />
  )
}

export default function OptionalConfig ({ manifest, onChange }) {
  const { t } = useT()
  const m = manifest || {}
  const visible = OPTIONAL_KEYS.filter((it) => rowVisible(m, it))
  // 平台对盘上这张名片的读数：哪些项是平台默认答的（profile.defaulted）。
  //   名片还没落盘时读不到，就不标（不猜）。
  const [defaulted, setDefaulted] = React.useState(null)
  React.useEffect(() => {
    if (!m.id) { setDefaulted(null); return undefined }
    let live = true
    fetch(`/wizard/profile/${encodeURIComponent(m.id)}`)
      .then((r) => r.json())
      .then((j) => { if (live) setDefaulted(j && j.ok && j.profile ? j.profile.defaulted || [] : null) })
      .catch(() => { if (live) setDefaulted(null) })
    return () => { live = false }
  }, [m.id])
  const byDefault = platformDefaultedRows(m, defaulted)
  const addable = OPTIONAL_KEYS.filter((it) => !rowVisible(m, it) && (!it.when || it.when(m)))

  return (
    <React.Fragment>
      {/* 不包一层 div：小标题要是区内的非首个子元素，才吃得到 .wz-subhead 的上边距。 */}
      <div className="wz-subhead">{t('Engine settings', '引擎配置')}</div>
      <div>
        {visible.length === 0 && (
          <div className="field-hint">
            {t('Nothing to set: the platform answers all of these by default.',
              '都不用填：不填时平台按默认处理。')}
          </div>
        )}
        {visible.map((it) => (
          <div className="field" key={it.path}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <label className="field-label" style={{ margin: 0 }}>{t(it.en, it.zh)}</label>
              <span className="badge badge-accent">{it.path}</span>
              <span className="field-hint" style={{ margin: 0 }}>
                {t(`if left out: ${it.fallbackEn}`, `不填时：${it.fallbackZh}`)}
              </span>
              {get(m, it.path) !== undefined && (
                <button className="btn btn-sm" type="button" onClick={() => onChange(removeItem(m, it))}>
                  {t('remove', '移除')}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Control item={it} value={get(m, it.path)} t={t}
                onValue={(v) => onChange(setPath(m, it.path, v))} />
              {it.source && get(m, it.path) !== undefined && (
                <select className="control" style={{ width: 120 }} value={get(m, it.source) || 'estimated'}
                  title={t('where that number came from', '这个数的出处')}
                  onChange={(e) => onChange(setPath(m, it.source, e.target.value))}>
                  {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>
          </div>
        ))}
        {byDefault.map((it) => (
          <div className="field-hint" key={`d-${it.path}`}
            style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="badge">{t('platform default', '平台默认')}</span>
            <span>{t(it.en, it.zh)}：{t(it.fallbackEn, it.fallbackZh)}</span>
          </div>
        ))}
        {addable.length > 0 && (
          <select className="control" value="" style={{ maxWidth: 260 }}
            onChange={(e) => {
              const it = OPTIONAL_KEYS.find((x) => x.path === e.target.value)
              if (it) onChange(addItem(m, it))
            }}>
            <option value="">{t('Add a setting', '添加一项')}</option>
            {addable.map((it) => <option key={it.path} value={it.path}>{t(it.en, it.zh)}</option>)}
          </select>
        )}
      </div>
    </React.Fragment>
  )
}
