// 合成参数的投放区，接收拖拽与点击加入。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import {
  applyParamDrop, paramNameOf, PARAM_MIME, countUnshapedParams, fillTypesFromScan, scanParamFor,
  addParamsFromScan, isParamTaken,
} from './paramDrop'
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
  guessed, onParamDropped, onTypeConfirmed, scanned, poolParams, children,
}) {
  const { t } = useT()
  const [over, setOver] = React.useState(false)
  // 形态决定这一列的语义：cli 是开关输入框，python 是方法参数名镜像。
  const isPython = manifest && manifest.call && manifest.call.kind === 'python'
  // 整个「合成参数」区和下方的「引擎配置」一样可收起：一次扫描进来十几二十行，
  //   占满整屏，往下的「可选能力」「引擎配置」全被挤到看不见的地方。
  const [open, setOpen] = React.useState(true)

  const list = params || []
  // 手敲开关加进来的行类型停在 text：这里算一下有多少行能按扫描结果补齐。
  //   数量为 0 时不显示按钮，界面上不留一个点了没反应的入口。
  const unshaped = countUnshapedParams(manifest, scanned)

  // 扫描列出、名片里还没有的那些参数：一次全部加进来，不必逐条拖。
  //   名单就是左栏此刻列出的那一份（已按入口与分组筛过），点一次与拖一次的
  //   结果完全一致；已有的行保持原样。
  //   已经有归属的开关不算在内（isParamTaken）：必填参数区的 bind 槽位、
  //   可选能力 / 引擎配置的 role 槽位、以及已经进了 parameters 的行。
  //   这三处用的是同一条判据，左栏把卡片弱化用的也是它。
  const addable = []
  const seen = new Set()
  for (const p of (Array.isArray(poolParams) ? poolParams : [])) {
    const name = paramNameOf(p)
    if (!name || seen.has(name)) continue
    if (isParamTaken(manifest, p)) continue
    seen.add(name)
    addable.push(p)
  }

  const addAll = () => {
    const r = addParamsFromScan(manifest, addable)
    if (!r.added.length) return
    onChange(r.manifest)
    // 与拖入同一条路：类型来自推测的，中栏那一行要标出来请人核对。
    if (onParamDropped) {
      for (const name of r.added) {
        const param = scanParamFor(name, scanned)
        if (param) onParamDropped(param, name)
      }
    }
  }

  const fillTypes = () => {
    const r = fillTypesFromScan(manifest, scanned)
    if (!r.filled) return
    onChange(r.manifest)
    // 补过的行按扫描的确定度标「推测」：上游没写明类型的，仍要人核对一眼。
    //   与拖拽那条路同一套判定，徽标含义不因来路不同而变化。
    if (onParamDropped) {
      for (const name of r.names) {
        const param = scanParamFor(name, scanned)
        if (param) onParamDropped(param, name)
      }
    }
  }

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
    // 人接过这一行就标 manual：扫描写回不再按形态删它，后续重扫也不覆盖它的字段。
    //   manual 是来源域的第三态，与 cli / python 并列，不靠「中文名填没填」去猜。
    copy[i] = { ...v, scan_kind: 'manual' }
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
        {/* 标题即折叠开关：整段收起后只剩这一行，往下的可选能力与引擎配置才露得出来。 */}
        <div className="wz-param-head">
          <span className="wz-subhead wz-subhead-inline" role="button" tabIndex={0}
            aria-expanded={open}
            style={{ cursor: 'pointer' }}
            title={open
              ? t('Click to collapse this section', '点击收起这一段')
              : t('Click to expand this section', '点击展开这一段')}
            onClick={() => setOpen((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) }
            }}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            {' '}{t('Synthesis parameters', '合成参数')}
            <span className="badge" style={{ marginLeft: 6 }}>{list.length}</span>
          </span>
          {open && (
            <>
              {/* 标题、落点、添加按钮压成一行：标题、小标题、说明段、虚线框四行本来说的是同一件事。
                  说明降级成落点的 title，鼠标停一下才展开。 */}
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
              {/* 扫描已经把这个入口的开关列全了：一次加进来，不必一个一个人工拖。
                  加的结果与逐个拖入完全一致；名片里已有的行不动。 */}
              {addable.length > 0 && (
                <button className="btn btn-sm" type="button" onClick={addAll}
                  title={t('Add every parameter the left column lists for this entry in one go. Types, English names and switches are filled in exactly as a single drop does; rows you already have stay as they are.',
                    '把左栏为这个入口列出的参数一次全部加进来。类型、英文名与命令行开关的填法和单个拖入完全一致；已有的行保持原样。')}>
                  {t(`Add all listed (${addable.length})`, `把列出的 ${addable.length} 个一起加入`)}
                </button>
              )}
              {/* 手敲开关的行没有类型可依，扫描结果里有：一次补齐，不必回去逐行挑一遍。 */}
              {unshaped > 0 && (
                <button className="btn btn-sm" type="button" onClick={fillTypes}
                  title={t('Match these rows against the scanned parameters by name and set the control type the upstream declares. Description and choices are filled in on the way.',
                    '按参数名对上扫描结果，把这些行的控件类型改成上游声明的类型，说明与候选值一并补上。')}>
                  {t(`Set types from the scan (${unshaped})`, `按扫描结果定类型（${unshaped}）`)}
                </button>
              )}
            </>
          )}
        </div>

        {/* 填写引导留在框外；表头与参数行同处一个大框，行间只用分隔线。
            没有参数时不显示大框，空区由落点自己说明。 */}
        {open && list.length > 0 && (
          <>
            <p className="wz-param-guide">
              {t('One row per engine switch. The two labels appear above the control on the synthesis page; the type decides which control is drawn.',
                '每行对应引擎的一个开关。两类名字显示在合成页控件上方，类型决定控件长相。')}
            </p>
            <div className="card wz-param-sheet">
              <div className="wz-param-row wz-param-cols">
                <span className="wz-param-argv"
                  title={isPython
                    ? t('The upstream method parameter this row binds to. It is the method parameter name, not a command line switch.',
                      '这一行绑定的上游方法参数名。Python 类形态下没有命令行开关，参数名即方法参数名。')
                    : t('The switch the engine takes, for example --speed. The parameter name drops the leading dashes.',
                      '引擎命令行上使用的开关，例如 --speed。参数名由它去掉开头横线得到。')}>
                  {isPython
                    ? t('Method parameter', '方法参数名')
                    : t('CLI switch', '命令行开关')}
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
                    kind={isPython ? 'python' : 'cli'}
                    argv={arg.flag || ''}
                    argStyle={arg.style || ''}
                    typeGuessed={!!(guessed && p && guessed.has(p.name))}
                    scanned={scanned}
                    onTypeGuessed={onParamDropped}
                    onTypeConfirmed={onTypeConfirmed}
                    onChange={setParam} onDelete={delParam} />
                )
              })}
            </div>
          </>
        )}


        {/* 分隔线：上面是合成参数（生成页上给用户调的旋钮），
            下面是可选能力与引擎配置（引擎自身的开关与启动项），两者不是同一类事。 */}
        <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />

        {/* 同一个「可选参数」区里的第二段（ManifestForm 传进来的引擎配置）。 */}
        {children}
      </div>
    </div>
  )
}
