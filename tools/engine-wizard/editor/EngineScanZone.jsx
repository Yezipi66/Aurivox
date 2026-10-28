import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import ParamPool from './ParamPool'

// 左栏：扫到的参数。扫描按钮在中栏身份条上；引擎身份也跟着 Manifest 放在中栏顶部，
// 左栏只放外部输入。
//
// 扫描不覆盖已有内容：扫到的参数进池子，池子只是可拖的源，往中栏落点拖才会改 Manifest；
// 已有 Manifest 的引擎扫完之后，里面原有的 call.args 保持原样。
//
// 视觉外壳用项目的 .section（.section-hdr + .section-body），不自造栏头。

/**
 * 左栏：分组选择 + 参数池。
 *
 * @param {Array} params 扫到的参数（当前分组的）
 * @param {object|null} selected 当前选中的参数
 * @param {Function} onSelect 选中参数回调
 * @param {Function} onDragStart 拖拽开始回调
 * @param {Array} groups 扫到的分组
 * @param {string} group 当前分组
 * @param {Function} onGroupChange 切分组回调
 * @param {boolean} busy 扫描中
 * @param {string|null} err 扫描错误
 * @param {React.ReactNode} children 额外内容（收起按钮等）
 */
export default function EngineScanZone ({
  params, selected, onSelect, onDragStart,
  groups, group, onGroupChange, busy, err, children,
}) {
  const { t } = useT()

  return (
    <div className="section">
      <div className="section-hdr">
        <h2>{t('Scanned parameters', '扫到的参数')}</h2>
        {children}
      </div>
      <div className="section-body">
        {/* 扫描按钮在中栏身份条上（和选引擎、读取、保存是同一串动作），
            这里只留分组切换与扫描结果。 */}
        {groups && groups.length > 1 && (
          <div className="field">
            <label className="field-label">{t('Group', '分组')}</label>
            <select className="control" value={group}
              disabled={busy}
              onChange={(e) => onGroupChange && onGroupChange(e.target.value)}>
              <option value="">{t('— all groups —', '全部分组')}</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        )}

        {err && <div className="msg msg-danger">{err}</div>}

        <ParamPool params={params} selected={selected}
          onSelect={onSelect} onDragStart={onDragStart} />
      </div>
    </div>
  )
}
