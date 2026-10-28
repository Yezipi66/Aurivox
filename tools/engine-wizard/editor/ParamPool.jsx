import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { paramTypeOf } from './paramType'

// 左栏：扫到的参数。
//
// 这一栏是拖拽的源。每一项是一张可拖的卡片，拖动时把参数信息放进
// dataTransfer，中栏的落点读它。
//
// 数据形状与 /wizard/discover 返回的一致：
//   source  cli 或 python
//   name    命令行开关去掉横线的部分（cli 路）；上游方法参数名（python 路）
//   target  命令行开关本身（cli 路）；参数名（python 路）
//   kind    统一层归出来的类型名（str / number / boolean / array）
//   kind_certain 类型是上游写明的（true）还是猜的（false）
//   style   名片 args 段认的写法词（value / boolean / repeat）
//   help    上游原话说明
//   required 是否必填
//   group   所属子命令或分组
//   is_tool 是否是工具脚本的参数而非推理参数

/**
 * 参数池的一行。
 *
 * 拖拽用 HTML5 drag&drop，不引库：数据量小（几十个 flag），
 * 且平台已有的拖拽绑定区用的是同一套写法，两处行为一致。
 */
function ParamItem ({ param, selected, onSelect, onDragStart }) {
  const { t } = useT()
  const type = paramTypeOf(param)

  return (
    <div
      className={`wz-param-item${selected ? ' wz-param-item-on' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, param)}
      onClick={() => onSelect(param)}
      title={param.help || ''}>
      <div className="wz-param-top">
        <code className="wz-param-name">{param.target}</code>
        {param.source === 'python'
          ? <span className="badge badge-neutral">py</span>
          : null}
        {param.is_tool
          ? <span className="badge badge-neutral">{t('tool', '工具')}</span>
          : null}
        {param.required
          ? <span className="badge badge-warn">{t('required', '必填')}</span>
          : null}
      </div>
      <div className="wz-param-meta">
        {/* 类型上色：绿 = 上游自己写明的（argparse type= / action=、python 注解）；
            灰 = 按默认值或参数名推断的，拖进中栏后需人工确认。 */}
        <span className={`badge ${param.kind_certain ? 'badge-ok' : 'badge-muted'}`}
          title={param.kind_certain
            ? t('Type declared by upstream', '类型由上游声明')
            : t('Type guessed: confirm it after dropping', '类型为推测值：拖入后请核对')}>
          {type}
        </span>
        {param.group && param.group !== '(root)'
          ? <span className="wz-param-group">{param.group}</span>
          : null}
      </div>
      {param.help
        ? <div className="wz-param-help">{param.help}</div>
        : null}
    </div>
  )
}

/**
 * 左栏参数池。
 *
 * @param {Array} params 扫到的参数
 * @param {object|null} selected 当前选中的参数（点击选中，拖拽之外的主路径）
 * @param {Function} onSelect 选中回调
 * @param {Function} onDragStart 拖拽开始回调
 * @param {React.ReactNode} children 池下方的额外内容（如分组切换、扫描按钮）
 */
export default function ParamPool ({ params, selected, onSelect, onDragStart, children }) {
  const { t } = useT()
  const list = params || []

  if (!list.length) {
    return (
      <div>
        <div className="empty-state">
          <div className="es-title">
            {t('No parameters scanned yet', '还没有扫到参数')}
          </div>
          <div className="es-sub">
            {t('Pick an engine and scan it. The parameters show up here.',
              '选一台引擎并扫描，参数会出现在这里。')}
          </div>
        </div>
        {children}
      </div>
    )
  }

  return (
    <div>
      <div className="wz-param-count">
        {t(`Scanned parameters (${list.length})`, `扫到的参数（${list.length} 个）`)}
      </div>
      <div className="wz-param-list">
        {list.map((p) => (
          <ParamItem key={`${p.source}-${p.name}-${p.target}`}
            param={p}
            selected={!!selected && selected.name === p.name && selected.source === p.source}
            onSelect={onSelect}
            onDragStart={onDragStart} />
        ))}
      </div>
      {children}
    </div>
  )
}
