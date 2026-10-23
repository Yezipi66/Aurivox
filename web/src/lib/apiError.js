// 调用 /api/outputs/* 时的错误信息构造。
// 响应体里带 error 时原样返回；否则拼上 HTTP 状态码，
// 调用方据此区分「引擎报错」与「路由不存在」。
function outputsError(r, fallback) {
  if (r && r.data && typeof r.data === 'object' && r.data.error) return r.data.error
  const status = r ? r.status : 0
  if (status === 404) return 'HTTP 404 - the /api/outputs endpoints are missing. The backend is running an older build; restart it after applying the server patch.'
  return `${fallback} (HTTP ${status || '?'})`
}

export { outputsError }
