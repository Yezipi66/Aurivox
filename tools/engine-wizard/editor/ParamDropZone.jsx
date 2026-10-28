import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { applyParamDrop, paramNameOf } from './paramDrop'

// 中栏的落点：参数区（parameters[]）。
//
// 原来的「parameters（界面参数）」与「常用可选」合成这一个区：
//   parameters[] 本来就涵盖这台引擎对外的全部参数，拖拽填参的核心就在这里。
//   「常用可选」里真正属于「参数」的那部分（换值要不要重启 = phase、
//   常用还是高级 = tier）成了每一行最上面的「去向」，拖进来就能定；
//   不属于参数的（runtime 全量、call 其余字段、capabilities 开关）挪进「高级」。
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
  guessed, onParamDropped, onTypeConfirmed, children,
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
    if (onParamDropped) onParamDropped(param, paramNameOf(param))
  }

  // 点击选中路径：左栏选中的参数，点这个落点直接加进去。
  const onClick = () => {
    if (!selectedParam) return
    onChange(applyParamDrop(manifest, selectedParam))
    if (onParamDropped) onParamDropped(selectedParam, paramNameOf(selectedParam))
  }

  return (
    <div className="section">
      <div className="section-hdr"><h2>{t('Optional parameters', '可选参数')}</h2></div>
      <div className="section-body">
        <div className="wz-subhead">{t('Synthesis parameters', '合成参数')}</div>
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('Drag a scanned parameter here: its name, type and help are filled in, and the preview updates. Confirm anything marked yellow.',
            '将左侧扫描到的参数拖至此处：参数名、类型与说明会自动填入，右侧预览同步更新。标记为推测值的项请核对。')}
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
                  : t('No parameters yet. Drag one here.', '尚无参数。请从左侧拖入一项。')}
              </span>
              )
            : (
              <span className="field-hint">
                {t(`Drop here to add another one (${list.length} already added)`,
                  `拖至此处可继续添加（已添加 ${list.length} 项）`)}
              </span>
              )}
        </div>

        {/* 已声明的参数：每一项可改字段，也可删 */}
        {list.map((p, i) => (
          <ParamRow key={i} entry={p || {}} index={i} spec={spec}
            typeGuessed={!!(guessed && p && guessed.has(p.name))}
            onTypeConfirmed={onTypeConfirmed}
            onChange={setParam} onDelete={delParam} />
        ))}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button className="btn btn-sm" type="button" onClick={addParam}>
            + {t('Add a parameter', '添加一个参数')}
          </button>
        </div>

        {/* 同一个「可选参数」区里的第二段（ManifestForm 传进来的引擎配置）。 */}
        {children}
      </div>
    </div>
  )
}
