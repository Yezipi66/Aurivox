import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { applyParamDrop } from './paramDrop'

// 中栏的落点：界面参数区（parameters[]）。
//
// 左栏扫到的参数拖到这里，就变成名片的一条界面参数。
// 名片里 parameters[] 的每一项都有 name / type 等字段；拖进来时按
// 扫到的信息预填，用户再改。
//
// 拖进来要改哪些地方是纯计算，住在 editor/paramDrop.js：
// 参数名从哪来、类型怎么定、cli 形态要不要写 call.args，都在那边。

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
