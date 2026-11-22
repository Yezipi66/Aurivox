// 第 3 步：一个文件对应一个下载任务。状态只由任务事件写，不从磁盘反推。
// 一个文件只有四个状态，界面与动作都从这里取，不再有第二份判据。
export const NOT_DOWNLOADED = 'not_downloaded'
export const DOWNLOADING = 'downloading'
export const DONE = 'done'
export const INTERRUPTED = 'interrupted'

// 任务派出。点下载的那一刻就写，不必等第一个字节回来。
export function startedTask (prev, label) {
  return { ...(prev || {}), label, state: DOWNLOADING, percent: 0, error: null }
}

// 进度事件。只更新同一个任务对象，不产生新的状态容器。
export function progressTask (prev, label, ev) {
  return {
    ...(prev || {}), label, state: DOWNLOADING,
    percent: ev.percent || 0,
    downloaded: ev.downloaded,
    total: ev.total,
  }
}

// 结束事件。正常收完就是完成，异常结束就是中断。
// 远端有没有给 SHA-256 不参与判定，只在界面上作为完成态的说明。
export function finishedTask (prev, label, result) {
  const ok = !!(result && result.ok === true)
  return {
    ...(prev || {}), label,
    state: ok ? DONE : INTERRUPTED,
    percent: ok ? 100 : ((prev && prev.percent) || 0),
    error: ok ? null : ((result && (result.errorZh || result.error)) || null),
    code: (result && result.code) || null,
  }
}

// 初次加载且没有活跃任务时，用读盘结果给一个初始态。
export function stateFromDisk (status) {
  if (status === 'ok') return DONE
  if (status === 'partial') return INTERRUPTED
  return NOT_DOWNLOADED
}

// 只有这两个状态需要再下一次。
export function needsDownload (state) {
  return state === NOT_DOWNLOADED || state === INTERRUPTED
}
