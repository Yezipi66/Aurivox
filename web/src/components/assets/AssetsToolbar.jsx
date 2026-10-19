// AssetsToolbar.jsx — 资源列表的汇总条与筛选工具栏
//
// 从 AssetsTab.jsx 搬出：顶部的统计条（音色数 / 原始文件 / 切片 / 分段 / 各引擎模型数）
// 与下方的搜索框 + 状态筛选芯片。
import { NamingNotePill } from '../common/Fields'

export function AssetsSummaryBar({ totals, noteExpanded, onOpenNote }) {
  return (
    <div className="summary-bar">
      <span className="stat-pill"><span className="sp-v">{totals.voices}</span><span className="sp-k">voices</span></span>
      <span className="stat-pill"><span className="sp-v">{totals.raw}</span><span className="sp-k">raw files</span></span>
      <span className="stat-pill"><span className="sp-v">{totals.rawDur.toFixed(1)}s</span><span className="sp-k">raw dur</span></span>
      <span className="stat-pill"><span className="sp-v">{totals.slices}</span><span className="sp-k">slices</span></span>
      {Object.keys(totals.byEngine).sort().map(eid => (
        <span className="stat-pill" key={eid}><span className="sp-v">{totals.byEngine[eid]}</span><span className="sp-k">{eid} models</span></span>
      ))}
      <span className="stat-pill"><span className="sp-v">{totals.segments}</span><span className="sp-k">segments</span></span>
      {/* Collapsed hint floats to the free space right of the stat pills */}
      {!noteExpanded && <NamingNotePill className="nn-in-bar" onOpen={onOpenNote} />}
    </div>
  )
}

export function AssetsToolbar({ filterChips, healthCounts, textIssueCount, filter, onFilter, search, onSearch }) {
  return (
    <div className="assets-toolbar">
      <input
        className="control assets-search"
        type="text"
        placeholder="Search by voice name…"
        value={search}
        onChange={e => onSearch(e.target.value)}
      />
      <div className="filter-chips">
        {filterChips.map(f => {
          const count = f === 'Text Issues' ? textIssueCount : healthCounts[f]
          const warn = f === 'Text Issues'
          return (
            <button
              key={f}
              className={`chip ${warn ? 'chip-warn' : ''} ${filter === f ? 'chip-on' : ''}`}
              onClick={() => onFilter(f)}
            >
              {f}{f !== 'All' && count ? ` (${count})` : ''}
            </button>
          )
        })}
      </div>
    </div>
  )
}
