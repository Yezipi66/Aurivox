import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { paramTypeOf } from './paramType'

// 中栏的落点：界面参数区（parameters[]）。
//
// 左栏扫到的参数拖到这里，就变成名片的一条界面参数。
// 名片里 parameters[] 的每一项都有 name / type 等字段；拖进来时按
// 扫到的信息预填，用户再改。
//
// 参数名从哪来：扫到的 cli 参数是命令行开关（--speed），
// 界面参数的名字是平台侧的名字，去掉开头的横线（speed）。
// python 参数本身就是方法参数名，原样用。
//
// 拖进来的 cli 参数还要写 call.args：宿主在命令行形态下只认 call.args 里
// 声明过的名字（host.py 的 args_table），参数名没在那儿声明就被拒。
// 这里写的是用户刚刚拖进来的那个开关，不是平台猜的对应关系。

/**
 * 去掉开关前面的横线，得到界面参数名。
 * @param {object} param 扫到的参数
 * @returns {string} 参数名
 */
export function paramNameOf (param) {
  if (!param) return ''
  if (param.source === 'cli') return String(param.name || param.target || '').replace(/^-+/, '')
  return String(param.name || param.target || '')
}

/**
 * 拖一个参数落进 parameters[] 时要改哪些地方。
 *
 * 纯函数：不读组件 state，不调 onChange。这样这一步能单独测。
 *
 * @param {object} manifest 当前名片
 * @param {object} param 扫到的参数
 * @returns {object} 新的名片
 */
export function applyParamDrop (manifest, param) {
  const m = { ...(manifest || {}) }
  const name = paramNameOf(param)
  if (!name) return m

  const list = Array.isArray(m.parameters) ? [...m.parameters] : []
  // 已经声明过同名参数就不重复加：拖两次同一个东西不该出现两条。
  if (!list.some((p) => p && p.name === name)) {
    const entry = { name, type: paramTypeOf(param), tier: 'common' }
    if (param.help) entry.help = param.help
    list.push(entry)
  }
  m.parameters = list.length ? list : undefined

  // cli 形态：把参数名写进 call.args，声明它对应哪个命令行开关。
  // 名片里已有的条目不动：用户手填过的映射比扫描猜的准。
  if (param.source === 'cli' && m.call && m.call.kind === 'cli') {
    const args = { ...(m.call.args || {}) }
    if (!args[name]) {
      const entry = { flag: param.target }
      if (param.style) entry.style = param.style
      args[name] = entry
    }
    m.call = { ...m.call, args }
  }
  return m
}

/**
 * 界面参数区：可增删的行 + 拖拽落点。
 *
 * @param {object} manifest 当前名片
 * @param {Function} onChange 名片变化回调
 * @param {Array} params 名片里已有的界面参数
 * @param {object|null} selectedParam 左栏当前选中的参数（点击选中路径）
 * @param {object} spec 字段规格
 */
export default function ParamDropZone ({
  manifest, onChange, params, selectedParam, spec, ParamRow,
}) {
  const { t } = useT()
  const [over, setOver] = React.useState(false)

  const list = params || []

  const addParam = () => {
    const next = { ...manifest }
    next.parameters = [...list, { name: '', type: 'text', tier: 'common' }]
    onChange(next)
  }

  const setParam = (i, v) => {
    const next = { ...manifest }
    const copy = [...list]
    copy[i] = v
    next.parameters = copy
    onChange(next)
  }

  const delParam = (i) => {
    const next = { ...manifest }
    const copy = [...list]
    copy.splice(i, 1)
    next.parameters = copy.length ? copy : undefined
    onChange(next)
  }

  // 落下：读 dataTransfer 里的参数，写进名片。
  const onDrop = (e) => {
    e.preventDefault()
    setOver(false)
    const raw = e.dataTransfer.getData('text/plain')
    if (!raw) return
    let param
    try { param = JSON.parse(raw) } catch { return }
    onChange(applyParamDrop(manifest, param))
  }

  // 点击选中路径：左栏选中的参数，点这个落点直接加进去。
  const onClick = () => {
    if (!selectedParam) return
    onChange(applyParamDrop(manifest, selectedParam))
  }

  return (
    <div className="section">
      <div className="section-hdr"><h2>{t('parameters', 'parameters（界面参数）')}</h2></div>
      <div className="section-body">
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('Drag a scanned parameter here to make it a parameter of this engine.',
            '把左栏扫到的参数拖到这里，它就成为这台引擎的一个界面参数。')}
        </p>

        {/* 落点区：高亮表示鼠标正在上方，落下即写进 parameters[] */}
        <div
          className={`wz-dropzone${over ? ' wz-dropzone-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onClick={onClick}>
          {list.length === 0
            ? (
              <span className="field-hint">
                {selectedParam
                  ? t('Click to add the selected parameter', '点击把选中的参数加进来')
                  : t('No parameters yet. Drag one here.', '还没有参数。把一个拖到这里。')}
              </span>
              )
            : (
              <span className="field-hint">
                {t(`Drop here to add another one (${list.length} already added)`,
                  `拖到这里再加一个（已加 ${list.length} 个）`)}
              </span>
              )}
        </div>

        {/* 已声明的参数：每一项可改字段，也可删 */}
        {list.map((p, i) => (
          <ParamRow key={i} entry={p || {}} index={i} spec={spec}
            onChange={setParam} onDelete={delParam} />
        ))}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button className="btn btn-sm" type="button" onClick={addParam}>
            + {t('Add a parameter', '添加一个参数')}
          </button>
        </div>
      </div>
    </div>
  )
}
