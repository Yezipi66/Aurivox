// 合成参数的投放区，接收拖拽与点击加入。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { applyParamDrop, paramNameOf, PARAM_MIME } from './paramDrop'
import { withArgKey } from './paramFields'

// 中栏的落点：参数区（parameters[]）。
//
// 本区即 parameters（界面参数），与「常用可选」合成这一个区：
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

  // 开关改名时，call.args 的键要一起搬：它既是参数名，也是命令行映射的键。
  //   只改 parameters[].name 会留下一个永远上不了命令行的旧条目，存盘直接被拒。
  const setParam = (i, v, meta = {}) => {
    const next = { ...manifest }
    const copy = [...list]
    copy[i] = v
    next.parameters = copy
    if (meta.argv && next.call) next.call = withArgKey(next.call, meta.argv)
    onChange(next)
  }

  const delParam = (i) => {
    const next = { ...manifest }
    const gone = list[i] && list[i].name
    const copy = [...list]
    copy.splice(i, 1)
    next.parameters = copy.length ? copy : undefined
    if (gone && next.call && next.call.args) {
      const args = { ...next.call.args }
      delete args[gone]
      next.call = { ...next.call, args }
    }
    onChange(next)
  }

  // 落下：读 dataTransfer 里的参数，写进名片。
  const onDrop = (e) => {
    e.preventDefault()
    setOver(false)
    // 机器读的那份在自定义类型里；text/plain 只有给人看的开关写法。
    //   两种都试：外部拖进来的或旧版拖拽源可能只给 text/plain。
    const raw = e.dataTransfer.getData(PARAM_MIME) || e.dataTransfer.getData('text/plain')
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
        {/* 标题、落点、添加按钮压成一行：标题、小标题、说明段、虚线框四行本来说的是同一件事。
            说明降级成落点的 title，鼠标停一下才展开。 */}
        <div className="wz-param-head">
          <span className="wz-subhead wz-subhead-inline">{t('Synthesis parameters', '合成参数')}</span>
          <div
            className={`wz-dropzone wz-dropzone-inline${over ? ' wz-dropzone-over' : ''}`}
            title={t('Drag a scanned parameter here: its name, type and help are filled in, and the preview updates. Confirm anything marked yellow.',
              '将左侧扫描到的参数拖至此处：参数名、类型与说明会自动填入，右侧预览同步更新。标记为推测值的项请核对。')}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            onClick={onClick}>
            {list.length === 0
              ? (
                <span>
                  {selectedParam
                    ? t('Click to add the selected parameter', '点击把选中的参数加进来')
                    : t('Drag a parameter here', '拖一个参数到这里')}
                </span>
                )
              : (
                <span>
                  {t(`Drop here to add another one (${list.length} already added)`,
                    `拖至此处可继续添加（已添加 ${list.length} 项）`)}
                </span>
                )}
          </div>
          <button className="btn btn-sm" type="button" onClick={addParam}>
            + {t('Add a parameter', '添加一个参数')}
          </button>
        </div>

        {/* 填写引导留在框外；表头与参数行同处一个大框，行间只用分隔线。
            没有参数时不显示大框，空区由落点自己说明。 */}
        {list.length > 0 && (
          <>
            <p className="wz-param-guide">
              {t('One row per engine switch. The two labels appear above the control on the synthesis page; the type decides which control is drawn.',
                '每行对应引擎的一个开关。两类名字显示在合成页控件上方，类型决定控件长相。')}
            </p>
            <div className="card wz-param-sheet">
              <div className="wz-param-row wz-param-cols">
                <span className="wz-param-argv"
                  title={t('The switch the engine takes, for example --speed. The parameter name drops the leading dashes.',
                    '引擎命令行上使用的开关，例如 --speed。参数名由它去掉开头横线得到。')}>
                  {t('CLI switch', '命令行开关')}
                </span>
                <span className="wz-param-zh"
                  title={t('Chinese name above the control. Falls back to the parameter name when empty.',
                    '合成页控件上方显示的中文名。留空则显示参数名。')}>
                  {t('Chinese label', '中文名')}
                </span>
                <span className="wz-param-en"
                  title={t('English name above the control. Falls back to the parameter name when empty.',
                    '合成页控件上方显示的英文名。留空则显示参数名。')}>
                  {t('English label', '英文名')}
                </span>
                <span className="wz-param-type"
                  title={t('Which control the synthesis page draws. Select and vector need the table below.',
                    '合成页为这一格绘制哪种控件。select 与 vector 还需在下方补一张表。')}>
                  {t('Control type', '控件类型')}
                </span>
                <span className="wz-param-place"
                  title={t('Which screen in Advanced Settings shows this field',
                    '这一格出现在 Advanced Settings 的常用区还是高级区')}>
                  {t('Shown in', '显示位置')}
                </span>
                <span className="wz-param-ops" />
              </div>

              {/* 已声明的参数：每一项可改字段，也可删。select / vector 的选项表是
                  这一行的 flex 子项，分隔线因此落在细节项下面。 */}
              {list.map((p, i) => {
                // 这一行在 call.args 里的那一条：开关与样式都从它读。
                const arg = (manifest.call && manifest.call.args
                  && manifest.call.args[(p || {}).name]) || {}
                return (
                  <ParamRow key={i} entry={p || {}} index={i} spec={spec}
                    argv={arg.flag || ''}
                    argStyle={arg.style || ''}
                    typeGuessed={!!(guessed && p && guessed.has(p.name))}
                    onTypeConfirmed={onTypeConfirmed}
                    onChange={setParam} onDelete={delParam} />
                )
              })}
            </div>
          </>
        )}


        {/* 同一个「可选参数」区里的第二段（ManifestForm 传进来的引擎配置）。 */}
        {children}
      </div>
    </div>
  )
}
