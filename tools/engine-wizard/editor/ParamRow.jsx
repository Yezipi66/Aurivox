// 单条参数行：名称、类型、值、高级项。
import React, { useState } from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { repeatOf, defaultTextOf, defaultFromText } from './paramDefault'

// 名片里一条界面参数的可编辑行。
//
// 字段集与平台那份派生物一致（lib/engines/parameterDeclaration.js）：
// name / type / tier / label / help / suggested_value / min / max，
// 以及少数用得上的可选项（phase / choices / applies_to / repeat / group / order / source）。
//
// 单独一个文件：落点组件（ParamDropZone）与表单（ManifestForm）都要渲染它。
// 留在 ManifestForm 里会形成两个组件互相 import 的环。

/**
 * 一条界面参数的编辑行。
 *
 * @param {object} entry 这条参数的内容
 * @param {number} index 它在 parameters[] 里的位置
 * @param {object} spec 字段规格（当前不用，签名留着与调用方一致）
 * @param {Function} onChange 改这一条（传索引与新内容）
 * @param {Function} onDelete 删这一条（传索引）
 */
// 「去向」：把 tier 与 phase 合成一个选择。
//   把 tier 与 phase 合成一个「去向」选择：若分开，用户要在三处回答同一个问题：
//   参数放在界面哪里、改了要不要重启。
// TODO(骨架)：再加一档「固定值」（不上界面，写进 call.args / init_args 的定值）。
const PLACEMENTS = [
  { key: 'common', tier: 'common', phase: undefined, en: 'UI · common', zh: '界面 · 常用' },
  { key: 'advanced', tier: 'advanced', phase: undefined, en: 'UI · advanced', zh: '界面 · 高级' },
  { key: 'load', tier: 'advanced', phase: 'load', en: 'On load (restart to change)', zh: '加载时（改了要重启引擎）' },
]
function placementOf (entry) {
  if (entry.phase === 'load') return 'load'
  return entry.tier === 'common' ? 'common' : 'advanced'
}

export default function ParamRow ({ entry, index, spec, onChange, onDelete, typeGuessed = false, onTypeConfirmed }) {
  const { t } = useT()
  const set = (k, v) => {
    const next = { ...entry }
    if (v === undefined || v === '') delete next[k]
    else next[k] = v
    onChange(index, next)
  }
  const type = entry.type || 'text'
  // 高级正文不放 details 里：details 是 display:contents，挂在它下面的这一项算宽度时
  // 只看内容，行宽有富余时也不铺满，右侧会空出一条。
  // 所以 details 只装按钮，正文另作行内一项渲染，开关状态自己拿。
  const [moreOpen, setMoreOpen] = useState(false)
  void spec

  // repeat 大于等于 2 时默认值是一排（八维情绪向量就是八个），落盘必须是等长数组。
  // 这一格仍是一个输入框，按逗号分隔读写；形状换算在 paramDefault 里，单独可测。
  const repeat = repeatOf(entry)
  const isVector = repeat > 1
  const defaultText = defaultTextOf(entry)

  const setPlacement = (key) => {
    const p = PLACEMENTS.find((x) => x.key === key)
    if (!p) return
    const next = { ...entry, tier: p.tier }
    if (p.phase) next.phase = p.phase
    else delete next.phase
    onChange(index, next)
  }

  // 一行只放主信息：参数名 / 类型 / 去向 / 建议值，后面跟「高级」与删除。
  //   其余字段全进「高级」。一行只放主信息（参数名 / 类型 / 去向 / 建议值）加「高级」与删除；
  //   若表单、param-grid、删除各占一行，一条参数垒三层，五个参数就是五百多 px。
  return (
    <div className="card wz-param-row">
      <input className="control wz-param-name" value={entry.name || ''}
        placeholder={t('name', '参数名')}
        title={t('Parameter name (the flag the engine takes)', '参数名（引擎接收的那个开关）')}
        onChange={(e) => set('name', e.target.value)} />

      <select className={`control wz-param-type${typeGuessed ? ' wz-field-guess' : ''}`} value={type}
        title={t('type', '类型')}
        onChange={(e) => {
          set('type', e.target.value)
          if (onTypeConfirmed) onTypeConfirmed(entry.name)
        }}>
        {['text', 'number', 'select', 'boolean', 'file'].map((x) => (
          <option key={x} value={x}>{x}</option>
        ))}
      </select>

      <select className="control wz-param-place" value={placementOf(entry)}
        title={t('Placement: where this knob shows up, and whether changing it needs a restart',
          '去向：这个参数在界面何处出现、改动是否需要重启')}
        onChange={(e) => setPlacement(e.target.value)}>
        {PLACEMENTS.map((p) => <option key={p.key} value={p.key}>{t(p.en, p.zh)}</option>)}
      </select>

      <input className="control wz-param-default" value={defaultText}
        placeholder={isVector ? t(`${repeat} values, comma separated`, `${repeat} 个值，逗号分隔`) : t('value', '建议值')}
        title={isVector
          ? t('repeat is 2 or more, so the default is a list: write one value per dimension, comma separated. The count must match repeat.',
            'repeat 大于等于 2 时默认值是一排：按维度逐个写、逗号分隔，个数必须与 repeat 相同。')
          : t('Suggested value, filled into the UI first', '建议值：界面上预填的值')}
        onChange={(e) => set('suggested_value', defaultFromText(e.target.value, { ...entry, type }))} />

      {typeGuessed && (
        <span className="badge badge-warn" title={t('guessed, confirm', '推测值，请核对')}>
          {t('guessed', '推测')}
        </span>
      )}

      <button className="btn btn-sm btn-danger wz-param-del" type="button"
        title={t('Delete this parameter', '删除该参数')}
        onClick={() => onDelete(index)}>
        {t('Delete', '删除')}
      </button>

      <details className="wz-param-more" open={moreOpen}>
        <summary className="wz-param-more-btn"
          onClick={(e) => { e.preventDefault(); setMoreOpen(!moreOpen) }}>
          {t('More', '高级')}
        </summary>
      </details>
      {moreOpen && (
        <React.Fragment>
          {/* 高级：四个格子一行，最多两行，涵盖该参数可选的高级字段。 */}
          <div className="wz-param-more-grid">
            <input className="control" value={entry.label?.zh || entry.label || ''}
              placeholder={t('name', '名称')}
              title={t('label: shown in the UI', 'label：界面上显示的名字')}
              onChange={(e) => set('label', e.target.value)} />
            {type === 'number' && (
              <input className="control" type="number" value={entry.min ?? ''} placeholder={t('min', '最小')}
                title={t('min: minimum', 'min：最小值')}
                onChange={(e) => set('min', e.target.value === '' ? undefined : Number(e.target.value))} />
            )}
            {type === 'number' && (
              <input className="control" type="number" value={entry.max ?? ''} placeholder={t('max', '最大')}
                title={t('max: maximum', 'max：最大值')}
                onChange={(e) => set('max', e.target.value === '' ? undefined : Number(e.target.value))} />
            )}
            {type === 'select' && (
              <input className="control"
                value={Array.isArray(entry.choices) ? entry.choices.join(',') : ''}
                placeholder={t('options', '选项')}
                title={t('choices: options shown in the UI, comma separated', 'choices：下拉里的选项，逗号分隔')}
                onChange={(e) => set('choices', e.target.value
                  ? e.target.value.split(',').map((s) => s.trim())
                  : undefined)} />
            )}
            <input className="control"
              value={Array.isArray(entry.applies_to) ? entry.applies_to.join(',') : ''}
              placeholder={t('applies to', '适用')}
              title={t('applies_to: comma separated', 'applies_to：逗号分隔')}
              onChange={(e) => set('applies_to', e.target.value
                ? e.target.value.split(',').map((s) => s.trim())
                : undefined)} />
            <input className="control" type="number" value={entry.repeat ?? ''} placeholder={t('repeat', '重复')}
              title={t('repeat: unset or 1 means a single value (scalar); 2 or more means an array. The engine sees these as different types and neither is reported as an error.',
                'repeat 未填或填 1 表示单个值（标量），仅当大于等于 2 时才为数组。这两种对引擎是两件事，而且都不会报错。')}
              onChange={(e) => set('repeat', e.target.value === '' ? undefined : Number(e.target.value))} />
            <input className="control" value={entry.group || ''} placeholder={t('group', '分组')}
              title={t('group: which group it sits in', 'group：界面上归到哪一组')}
              onChange={(e) => set('group', e.target.value)} />
            <input className="control" type="number" value={entry.order ?? ''} placeholder={t('order', '排序')}
              title={t('order: sort order in the UI', 'order：界面里的排序号')}
              onChange={(e) => set('order', e.target.value === '' ? undefined : Number(e.target.value))} />
            <select className="control" value={entry.source || ''}
              title={t('source: where the default comes from (voices / weights / audio)', 'source：默认值的出处（voices / weights / audio）')}
              onChange={(e) => set('source', e.target.value || undefined)}>
              <option value="">{t('source', '出处')}</option>
              <option value="voices">voices</option>
              <option value="weights">weights</option>
              <option value="audio">audio</option>
            </select>
          </div>
        </React.Fragment>
      )}


    </div>
  )
}
