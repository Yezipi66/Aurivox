import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

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
export default function ParamRow ({ entry, index, spec, onChange, onDelete }) {
  const { t } = useT()
  const set = (k, v) => {
    const next = { ...entry }
    if (v === undefined || v === '') delete next[k]
    else next[k] = v
    onChange(index, next)
  }
  const type = entry.type || 'text'
  void spec

  return (
    <div className="card">
      <div className="form-grid">
        <div className="field">
          <label className="field-label">
            {t('Parameter name', '参数名')}
          </label>
          <input className="control" value={entry.name || ''}
            onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label">type</label>
          <select className="control" value={type}
            onChange={(e) => set('type', e.target.value)}>
            {['text', 'number', 'select', 'boolean', 'file'].map((x) => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        </div>
      </div>

      {/* .param-grid：项目给「一堆小字段」准备的（2 列，gap 10px，
          而且 .param-grid label 自带 11px muted 的标签样式）*/}
      <div className="param-grid">
        <label><span>label</span>
          <input className="control" value={entry.label?.zh || entry.label || ''}
            placeholder={t('shown in the UI', '界面上显示的名字')}
            onChange={(e) => set('label', e.target.value)} /></label>

        <label><span>tier</span>
          <select className="control" value={entry.tier || ''}
            onChange={(e) => set('tier', e.target.value || undefined)}>
            <option value="">{t('(unset → advanced)', '（不写 → advanced）')}</option>
            <option value="common">common</option>
            <option value="advanced">advanced</option>
          </select></label>

        <label><span>phase</span>
          <select className="control" value={entry.phase || ''}
            onChange={(e) => set('phase', e.target.value || undefined)}>
            <option value="">{t('(unset → call)', '（不写 → call）')}</option>
            <option value="call">call</option>
            <option value="load">load</option>
          </select></label>

        <label><span>default</span>
          <input className="control" value={entry.suggested_value ?? ''}
            onChange={(e) => set('suggested_value',
              e.target.value === ''
                ? undefined
                : (type === 'number' || type === 'boolean')
                  ? (type === 'boolean' ? e.target.value === 'true' : Number(e.target.value))
                  : e.target.value)} /></label>

        {type === 'number' && (
          <label><span>min / max</span>
            <span className="form-grid">
              <input className="control" type="number" value={entry.min ?? ''}
                onChange={(e) => set('min',
                  e.target.value === '' ? undefined : Number(e.target.value))} />
              <input className="control" type="number" value={entry.max ?? ''}
                onChange={(e) => set('max',
                  e.target.value === '' ? undefined : Number(e.target.value))} />
            </span></label>
        )}

        {type === 'select' && (
          <label><span>choices</span>
            <input className="control"
              value={Array.isArray(entry.choices) ? entry.choices.join(',') : ''}
              placeholder="voices / weights / audio"
              onChange={(e) => set('choices', e.target.value
                ? e.target.value.split(',').map((s) => s.trim())
                : undefined)} /></label>
        )}

        <label><span>applies_to</span>
          <input className="control"
            value={Array.isArray(entry.applies_to) ? entry.applies_to.join(',') : ''}
            placeholder={t('comma separated', '逗号分隔')}
            onChange={(e) => set('applies_to', e.target.value
              ? e.target.value.split(',').map((s) => s.trim())
              : undefined)} /></label>
      </div>

      {/* 折叠用项目的 .expert-block + .expert-summary
          （不用裸 <details>：那个没有边框和间距，跟整页其它折叠长得不一样）*/}
      <details className="expert-block" style={{ marginTop: 8 }}>
        <summary className="expert-summary">
          {t('More (rarely needed)', '更多（多数用不到）')}
        </summary>
        <div className="param-grid" style={{ marginTop: 8 }}>
          <label><span>repeat</span>
            <input className="control" type="number" value={entry.repeat ?? ''}
              onChange={(e) => set('repeat',
                e.target.value === '' ? undefined : Number(e.target.value))} /></label>
          <label><span>group</span>
            <input className="control" value={entry.group || ''}
              onChange={(e) => set('group', e.target.value)} /></label>
          <label><span>order</span>
            <input className="control" type="number" value={entry.order ?? ''}
              onChange={(e) => set('order',
                e.target.value === '' ? undefined : Number(e.target.value))} /></label>
          <label><span>source</span>
            <select className="control" value={entry.source || ''}
              onChange={(e) => set('source', e.target.value || undefined)}>
              <option value="">{t('(unset)', '（不写）')}</option>
              <option value="voices">voices</option>
              <option value="weights">weights</option>
              <option value="audio">audio</option>
            </select></label>
        </div>
        {/* repeat 填错不报错：设了没效果。silent 档用黄框（msg-warn）*/}
        <p className="msg msg-warn">
          {t('repeat unset or 1 means a single value (scalar). Only 2 or more makes an array. '
            + 'Those are two different things to the engine, and neither is reported '
            + 'as an error.',
            'repeat 未填或填 1 表示单个值（标量），仅当大于等于 2 时才为数组。'
            + '这两种对引擎是两件事，而且都不会报错。')}
        </p>
      </details>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="btn btn-sm btn-danger" type="button"
          onClick={() => onDelete(index)}>
          {t('Delete this parameter', '删掉这个参数')}
        </button>
      </div>
    </div>
  )
}
