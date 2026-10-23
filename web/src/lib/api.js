// Shared network helper + base URL. `API_BASE` is '' (same-origin); callers pass
// already-prefixed paths like `/api/...` and the dev server proxies `/api` to the
// backend, so no build-time URL switch is needed. `api` returns { ok, status, data }:
// Uint8Array for raw/audio bodies, the parsed object for application/json, text
// otherwise.
export const API_BASE = ''

export function api(path, opts = {}) {
  const url = `${API_BASE}${path}`
  const { method = 'GET', body, contentType, isRaw, signal } = opts
  const headers = contentType ? {} : { 'Content-Type': 'application/json' }
  const fetchOpts = { method, headers }
  if (body) fetchOpts.body = contentType ? body : JSON.stringify(body)
  if (signal) fetchOpts.signal = signal
  return fetch(url, fetchOpts).then(async r => {
    if (isRaw || r.headers.get('content-type')?.includes('audio/')) {
      const buf = await r.arrayBuffer()
      return { ok: r.ok, status: r.status, data: new Uint8Array(buf), contentType: r.headers.get('content-type') || '' }
    }
    if (r.headers.get('content-type')?.includes('application/json')) {
      const data = await r.json()
      return { ok: r.ok, status: r.status, data }
    }
    return { ok: r.ok, status: r.status, data: await r.text() }
  })
}
