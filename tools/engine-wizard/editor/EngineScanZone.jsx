import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import ParamPool from './ParamPool'

// 左栏：扫到的参数。
//
// 这一栏只放「扫到的参数」与「怎么扫」两件事。
// 引擎身份不在这里：身份跟着名片走，放在中栏顶部
// （EngineIdentity.jsx）。左栏是外部输入，中栏是这张名片本身。
//
// 扫描不覆盖已有内容：扫到的参数进池子，池子只是可拖的源，
// 往中栏落点拖才会改名片。已有名片的引擎扫完之后，
// 名片里原有的 call.args 保持原样。
//
// 视觉外壳用项目的 .section（.section-hdr + .section-body），
// 不自造栏头：主界面里每一块内容都是这么长的。

/**
 * 左栏：分组选择 + 扫描 + 参数池。
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
 * @param {Function} onScan 扫描回调
 * @param {boolean} canScan 现在能不能扫（引擎选了没）
 * @param {React.ReactNode} children 额外内容（收起按钮等）
 */
export default function EngineScanZone ({
  params, selected, onSelect, onDragStart,
  groups, group, onGroupChange, busy, err, onScan, canScan, children,
}) {
  const { t } = useT()

  return (
    <div className="section">
      <div className="section-hdr">
        <h2>{t('Scanned parameters', '扫到的参数')}</h2>
        {children}
      </div>
      <div className="section-body">
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          {groups && groups.length > 1 && (
            <div className="field" style={{ flex: 1, minWidth: 0 }}>
              <label className="field-label">{t('Group', '分组')}</label>
              <select className="control" value={group}
                disabled={!params || !params.length}
                onChange={(e) => onGroupChange && onGroupChange(e.target.value)}>
                <option value="">{t('— pick a group —', '— 选一个分组 —')}</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          )}
          <div style={{ flexShrink: 0, paddingBottom: 2 }}>
            <button className="btn btn-sm btn-primary" type="button"
              disabled={busy || !canScan}
              onClick={onScan}>
              {busy
                ? t('Scanning…', '扫描中…')
                : t('Scan parameters', '扫描参数')}
            </button>
          </div>
        </div>

        {err && <div className="msg msg-danger">{err}</div>}

        <ParamPool params={params} selected={selected}
          onSelect={onSelect} onDragStart={onDragStart} />
      </div>
    </div>
  )
}
