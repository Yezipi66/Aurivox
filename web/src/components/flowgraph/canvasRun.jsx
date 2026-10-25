// 流程图运行面板：渲染一次运行的暂停/选择请求、中间结果驻留提示与事件流。
// 事件类型由后端下发（preview / table / saved / released / recipe 等），本文件只按 type 分发渲染，
// 不认识具体是哪台引擎；EventView 是它的事件渲染分支。

import { useState, useEffect } from 'react'
import { pickText } from './graphModel'
import {
  MUTED, buttonStyle, cellStyle, preStyle,
  plainStatus, describeCandidate, formatCell, formatValue,
} from './canvasShared'
import { Panel } from './canvasChrome'

export function RunPanel({ run, busy, onAnswer, problems, lang, t }) {
  const [picked, setPicked] = useState([])
  useEffect(() => { setPicked([]) }, [run?.pending?.node_id])

  if (!run) {
    return (
      <Panel title={t('Run', '运行')}>
        {problems.length > 0
          ? <div style={{ fontSize: 'var(--fs-12)', color: 'var(--warn, #e0b341)' }}>
            {problems.slice(0, 6).map((p, i) => (
              <div key={i}>{p.message_i18n ? pickText(p.message_i18n, lang, p.message) : p.message}</div>
            ))}
            {problems.length > 6 && <div>{t(`…and ${problems.length - 6} more`, `…另有 ${problems.length - 6} 处`)}</div>}
          </div>
          : <div style={{ fontSize: 'var(--fs-12)', color: MUTED }}>{t('Not run yet. Press Run to start.', '尚未运行。点击「运行」开始。')}</div>}
      </Panel>
    )
  }

  const request = run.pending?.request
  return (
    <Panel title={t(`Run · ${plainStatus(run.status, 'en')}`, `运行 · ${plainStatus(run.status, 'zh')}`)}>
      {request && (
        <div style={{ marginBottom: 10, padding: 9, borderRadius: 8, border: '1px solid var(--warn, #e0b341)' }}>
          <div style={{ fontSize: 'var(--fs-12)', marginBottom: 7 }}>{request.prompt}</div>
          {request.kind === 'pause' && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button disabled={busy} onClick={() => onAnswer(true)} style={buttonStyle}>{t('Continue', '继续执行')}</button>
              <button disabled={busy} onClick={() => onAnswer(false)} style={buttonStyle}>{t('Stop here', '终止')}</button>
            </div>
          )}
          {request.kind === 'select' && (
            <div>
              <div style={{ fontSize: 'var(--fs-11)', color: MUTED, marginBottom: 5 }}>
                {t(`${request.count} items — tick the ones to carry on with:`, `共 ${request.count} 项，请勾选需要继续处理的条目：`)}
              </div>
              {(request.candidates || []).map((candidate, i) => (
                <label key={i} style={{ display: 'block', fontSize: 'var(--fs-12)', marginBottom: 4 }}>
                  <input
                    type="checkbox" checked={picked.includes(i)}
                    onChange={e => setPicked(p => (e.target.checked ? [...p, i] : p.filter(x => x !== i)))}
                  />
                  <span style={{ marginLeft: 6 }}>{describeCandidate(candidate, i, t)}</span>
                  {candidate?.url && <audio src={candidate.url} controls style={{ height: 26, marginLeft: 8, verticalAlign: 'middle' }} />}
                </label>
              ))}
              <button disabled={busy} onClick={() => onAnswer(picked.slice().sort((a, b) => a - b))} style={buttonStyle}>
                {t(`Confirm (${picked.length} selected)`, `确认选择（${picked.length} 项）`)}
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 'var(--fs-11)', color: MUTED, marginBottom: 7 }}>
        {t(
          `${run.live_values} intermediate results are held in memory (they remain until a release node frees them)`,
          `内存中驻留 ${run.live_values} 个中间结果（未接入释放节点将持续占用）`,
        )}
      </div>

      {(run.events || []).filter(e => ['preview', 'table', 'saved', 'released', 'recipe'].includes(e.type)).map((event, i) => (
        <EventView key={i} event={event} t={t} />
      ))}
    </Panel>
  )
}

export function EventView({ event, t }) {
  if (event.type === 'table') {
    return (
      <div style={{ marginBottom: 10, overflowX: 'auto' }}>
        <div style={{ fontSize: 'var(--fs-11)', color: MUTED, marginBottom: 4 }}>
          {t(`Score table (pass mark ${event.table.pass_score})`, `评分表（及格线 ${event.table.pass_score}）`)}
        </div>
        <table style={{ fontSize: 'var(--fs-11)', borderCollapse: 'collapse' }}>
          <thead><tr>{event.table.columns.map(c => (
            <th key={c} style={cellStyle}>{c}</th>
          ))}</tr></thead>
          <tbody>{event.table.rows.map((row, i) => (
            <tr key={i}>{event.table.columns.map(c => (
              <td key={c} style={{ ...cellStyle, color: c === '结果' && String(row[c]).startsWith('未通过') ? 'var(--danger, #cf6679)' : 'inherit' }}>
                {formatCell(row[c])}
              </td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
    )
  }
  if (event.type === 'saved') {
    const names = event.files.map(f => f.split(/[\\/]/).pop())
    return (
      <div style={{ fontSize: 'var(--fs-11)', marginBottom: 6 }}>
        {t(`Wrote ${event.files.length} files: ${names.join(', ')}`, `已写入 ${event.files.length} 个文件：${names.join('、')}`)}
      </div>
    )
  }
  if (event.type === 'released') {
    return (
      <div style={{ fontSize: 'var(--fs-11)', marginBottom: 6, color: MUTED }}>
        {t(`Released ${event.freed} intermediate results`, `已释放 ${event.freed} 个中间结果`)}
      </div>
    )
  }
  if (event.type === 'recipe') {
    return (
      <div style={{ fontSize: 'var(--fs-11)', marginBottom: 6 }}>
        <div style={{ color: MUTED }}>{t('Generation record (recipe)', '生成记录（配方）')}</div>
        <pre style={preStyle}>{JSON.stringify(event.recipe, null, 1)}</pre>
        <div style={{ color: MUTED, fontSize: 'var(--fs-11)', marginTop: 3, lineHeight: 1.6 }}>
          {t(
            'To keep these settings, connect the recipe output to a Save as Voice node.',
            '如需保留这组参数，请将配方输出连接到「保存为音色」节点。',
          )}
        </div>
      </div>
    )
  }
  if (event.type === 'voice_saved') {
    return (
      <div style={{ fontSize: 'var(--fs-11)', marginBottom: 6 }}>
        {t(`Saved as voice ${event.voice_id}`, `已保存为音色 ${event.voice_id}`)}
      </div>
    )
  }
  if (event.type === 'note') {
    return <div style={{ fontSize: 'var(--fs-11)', marginBottom: 6, color: MUTED }}>{event.message}</div>
  }
  return (
    <div style={{ fontSize: 'var(--fs-11)', marginBottom: 6 }}>
      <div style={{ color: MUTED }}>{event.label || event.node_id}</div>
      {event.value?.url
        ? <audio src={event.value.url} controls style={{ width: '100%', height: 30 }} />
        : <pre style={preStyle}>{formatValue(event.value)}</pre>}
    </div>
  )
}
