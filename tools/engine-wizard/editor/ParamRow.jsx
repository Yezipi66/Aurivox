// 「合成参数」一条：主行五列 + 按类型展开的选项表。
//
// 这块只服务一件事：把某个引擎的额外旋钮翻译成 9886 Advanced Settings 里的一格。
// 主行回答五件事：命令行上敲哪个开关、界面上中文叫什么、英文叫什么、长成哪种控件、
// 摆在 common 还是 advanced。text / number / boolean / file 到此为止；
// select 与 vector 还要各自补一张表。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import {
  nameFromFlag, readLabel, withLabel, readChoices, readDims, resizeRows, withCell, boolStyle,
} from './paramFields'

const TYPES = ['text', 'number', 'select', 'boolean', 'file', 'vector']

/**
 * @param {object} entry 这条参数的内容
 * @param {number} index 它在 parameters[] 里的位置
 * @param {Function} onChange 改这一条：(index, next, meta) => void
 *   meta.argv 让落点同步迁移 call.args 的键，开关改名后不留一个永远上不了命令行的条目
 * @param {Function} onDelete 删这一条（传索引）
 */
export default function ParamRow ({ entry, index, spec, argv = '', argStyle = '', onChange, onDelete, typeGuessed = false, onTypeConfirmed }) {
  const { t } = useT()
  void spec

  const type = TYPES.includes(entry.type) ? entry.type : 'text'
  // 有没有否定式开关，只由 call.args 的 style 决定（boolean_optional 才有）。
  const negatable = argStyle === 'boolean_optional'
  const label = readLabel(entry)
  const patch = (partial, meta) => onChange(index, { ...entry, ...partial }, meta)
  const set = (k, v) => {
    const next = { ...entry }
    if (v === undefined || v === '') delete next[k]
    else next[k] = v
    onChange(index, next)
  }

  // 命令行开关：参数名由它派生，call.args 的键由落点一起迁移。
  const setArgv = (raw) => {
    const flag = String(raw == null ? '' : raw).trim()
    const name = nameFromFlag(flag)
    patch({ name }, { argv: { from: entry.name, to: name, flag } })
  }

  // 换类型时收走上一个类型专属的字段，避免旧值以错误形状留到下次存盘。
  // 命令行样式也要跟着换：boolean 走 boolean / boolean_optional，其余回到值型。
  //   留在 value 上的布尔会拼成 `--x True`，上游把 True 当成多余的位置参数。
  const setType = (next) => {
    const out = { ...entry, type: next }
    for (const k of ['suggested_value', 'dim_labels', 'choices', 'allow_custom', 'item', 'repeat']) {
      delete out[k]
    }
    if (next === 'select') {
      out.choices = [{ value: '', label: { zh: '', en: '' } }, { value: '', label: { zh: '', en: '' } }]
      // 输入与候选并存：库里没有想要的值时，使用者仍能自己打一个。
      out.allow_custom = true
    }
    if (next === 'vector') {
      out.dim_labels = [{ zh: '', en: '' }, { zh: '', en: '' }]
      out.suggested_value = [null, null]
    }
    const style = next === 'boolean' ? boolStyle(negatable) : (next === 'vector' ? 'join' : 'value')
    onChange(index, out, { argv: { from: entry.name, to: entry.name, flag: argv, style } })
    if (onTypeConfirmed) onTypeConfirmed(entry.name)
  }

  // select：一行一个选项，三列分别是传给 CLI 的值、中文显示、英文显示。
  const choices = readChoices(entry)
  const setChoiceCount = (n) => patch({
    choices: resizeRows(choices, n, () => ({ value: '', zh: '', en: '' }))
      .map((c) => ({ value: c.value, label: { zh: c.zh, en: c.en } })),
  })
  const setChoice = (i, key, v) => patch({
    choices: withCell(choices, i, key, v).map((c) => ({ value: c.value, label: { zh: c.zh, en: c.en } })),
  })

  // vector：一行一维，两列是中英文名字。维度里的值在 9886 每次合成时填。
  const dims = readDims(entry)
  const setDimCount = (n) => {
    const rows = resizeRows(dims, n, () => ({ zh: '', en: '' }))
    patch({
      dim_labels: rows,
      suggested_value: rows.map((_, i) => (Array.isArray(entry.suggested_value) ? entry.suggested_value[i] : null)),
    })
  }
  const setDim = (i, key, v) => patch({ dim_labels: withCell(dims, i, key, v) })

  return (
    <div className="wz-param-row">
      {/* 主行：开关 / 中文名 / 英文名 / 类型 / common-advanced */}
      <input className="control wz-param-argv" value={argv || ''}
        placeholder="--argv"
        title={t('The switch the engine takes. The parameter name is derived from it.',
          '引擎接收的命令行开关。参数名由它去掉开头横线得到。')}
        onChange={(e) => setArgv(e.target.value)} />
      <input className="control wz-param-zh" value={label.zh}
        placeholder={t('Chinese label', '中文名')}
        title={t('Shown above this field on the synthesis page (Chinese)', '合成页这一格上方显示的中文名')}
        onChange={(e) => onChange(index, withLabel(entry, 'zh', e.target.value))} />
      <input className="control wz-param-en" value={label.en}
        placeholder={t('English label', '英文名')}
        title={t('Shown above this field on the synthesis page (English)', '合成页这一格上方显示的英文名')}
        onChange={(e) => onChange(index, withLabel(entry, 'en', e.target.value))} />
      <select className={`control wz-param-type${typeGuessed ? ' wz-field-guess' : ''}`} value={type}
        title={t('Control type', '控件类型')} onChange={(e) => setType(e.target.value)}>
        {TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      <select className="control wz-param-place" value={entry.tier === 'common' ? 'common' : 'advanced'}
        title={t('Which screen in Advanced Settings shows this field', '这一格出现在 Advanced Settings 的哪一屏')}
        onChange={(e) => set('tier', e.target.value)}>
        <option value="common">{t('common', '常用')}</option>
        <option value="advanced">{t('advanced', '高级')}</option>
      </select>

      {/* 尾部定宽：推测徽标出现与否都不改这一格宽度，表头的列才对得上。 */}
      <div className="wz-param-tail">
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
      </div>

      {type === 'select' && (
        <div className="wz-param-table">
          <div className="wz-param-table-head">
            <span className="wz-param-table-label">{t('Options', '选项')}</span>
            <input className="control wz-param-count" type="number" min="1" max="64" value={choices.length}
              title={t('How many options the drop-down has', '下拉里有几个选项')}
              onChange={(e) => setChoiceCount(Number(e.target.value))} />
            <span className="wz-param-table-hint">
              {t('Each option is what goes after the switch. The two labels are what the drop-down shows. The field stays editable as an escape hatch.',
                '每个选项就是开关后面要填的值，两列名字是下拉里显示的内容。合成页仍可直接输入，作为逃生口。')}
            </span>
          </div>
          <div className="wz-param-table-row wz-param-table-cols">
            <span />
            <span>{t('value (--argv <value>)', '值（--argv <值>）')}</span>
            <span>{t('Chinese', '中文显示')}</span>
            <span>{t('English', '英文显示')}</span>
          </div>
          {choices.map((c, i) => (
            <div className="wz-param-table-row" key={i}>
              <span className="wz-param-no">{t(`arg${i + 1}`, `args${i + 1}`)}</span>
              <input className="control" value={c.value} placeholder={t('value', '值')}
                onChange={(e) => setChoice(i, 'value', e.target.value)} />
              <input className="control" value={c.zh} placeholder={t('Chinese', '中文')}
                onChange={(e) => setChoice(i, 'zh', e.target.value)} />
              <input className="control" value={c.en} placeholder={t('English', '英文')}
                onChange={(e) => setChoice(i, 'en', e.target.value)} />
            </div>
          ))}
        </div>
      )}

      {type === 'vector' && (
        <div className="wz-param-table">
          <div className="wz-param-table-head">
            <span className="wz-param-table-label">{t('Dimensions', '维度')}</span>
            <input className="control wz-param-count" type="number" min="2" max="64" value={dims.length}
              title={t('How many values this control has', '这个向量有几维')}
              onChange={(e) => setDimCount(Math.max(2, Number(e.target.value)))} />
            <span className="wz-param-table-hint">
              {t('One row per dimension, left to right in the order the engine reads. The large box is titled with the Chinese / English label above; each small box is titled with its own.',
                '一行一维，按引擎读取的顺序排列。9886 上的大框标题取上方的中英文名字，每个小输入框的标题取本行的名字。')}
            </span>
          </div>
          <div className="wz-param-table-row wz-param-table-cols wz-param-table-2">
            <span />
            <span>{t('Chinese', '中文显示')}</span>
            <span>{t('English', '英文显示')}</span>
          </div>
          {dims.map((d, i) => (
            <div className="wz-param-table-row wz-param-table-2" key={i}>
              <span className="wz-param-no">{t(`#${i + 1}`, `第 ${i + 1} 维`)}</span>
              <input className="control" value={d.zh} placeholder={t('Chinese', '中文')}
                onChange={(e) => setDim(i, 'zh', e.target.value)} />
              <input className="control" value={d.en} placeholder={t('English', '英文')}
                onChange={(e) => setDim(i, 'en', e.target.value)} />
            </div>
          ))}
        </div>
      )}

      {/* boolean：只补一件主行说不清楚的事，取消勾选时发不发否定式开关。
             上游写成 --x/--no-x 时勾上；只写 --x 时留空。 */}
      {type === 'boolean' && (
        <div className="wz-param-table">
          <label className="wz-param-bool-row">
            <input type="checkbox" checked={negatable}
              onChange={(e) => patch({}, {
                argv: { from: entry.name, to: entry.name, flag: argv, style: boolStyle(e.target.checked) },
              })} />
            <span>{t('Send a negative switch when unchecked', '取消勾选时发送否定式开关')}</span>
            {negatable && argv && (
              <code className="wz-param-bool-neg">{'--no-' + String(argv).replace(/^-+/, '')}</code>
            )}
          </label>
          <span className="wz-param-table-hint">
            {t('On: unchecked sends --no-x. Off: unchecked sends nothing and the engine keeps its own default.',
              '勾上：取消勾选时发 --no-x。不勾：取消勾选时什么都不发，由引擎用自己的默认值。')}
          </span>
        </div>
      )}
    </div>
  )
}
