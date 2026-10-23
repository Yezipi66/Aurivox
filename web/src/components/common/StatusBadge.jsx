// 后端布尔检查结果的状态徽章。
// 渲染后端布尔检查结果的状态徽章（如 /api/voices/:id/validate）。
function statusBadge(ok, okLabel = 'Selected', missLabel = 'Missing') {
  return <span className={`badge ${ok ? 'badge-ok' : 'badge-danger'}`}>{ok ? okLabel : missLabel}</span>
}

export { statusBadge }
