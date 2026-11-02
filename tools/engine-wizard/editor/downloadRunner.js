// 第 3 步的下载执行器：发起请求与归并结果，不碰 React，也不管界面怎么显示。
// 并发数与「下一个该下谁」的取舍都在 downloadQueue.js。

// Node 的 ESM 解析器要求带扩展名（vite 能解析无扩展名，Node 不能）。
import { createDownloadQueue, DEFAULT_CONCURRENCY } from './downloadQueue.js'

/**
 * 读一个 SSE 响应，把事件解析出来交给回调。
 *
 * @param {Response} resp fetch 的响应
 * @param {(event: string, data: object) => void} onEvent 每收到一个事件调一次
 * @returns {Promise<void>} 响应读完就 resolve
 */
export async function readSse (resp, onEvent) {
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let sep
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      const line = raw.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      let ev
      try { ev = JSON.parse(line.slice(6)) } catch (e) { continue }
      onEvent(ev)
    }
  }
}

/**
 * 下载一个文件，读它的 SSE 流，把进度与结果报出来。
 *
 * @param {object} opts
 * @param {string} opts.id 引擎 id
 * @param {string} opts.root 项目根
 * @param {string} [opts.repo] 仓库，文件自己没带 repo 时用它
 * @param {string} [opts.tool] 来源（hf / modelscope），文件自己没带 tool 时用它
 * @param {object} opts.file 文件信息（name / size / sha256 / repo / tool）
 * @param {(name: string, progress: object) => void} opts.onProgress 进度回调
 * @param {(name: string, result: object) => void} opts.onDone 单个文件结束回调
 * @returns {Promise<object>} 该文件的结果
 */
export async function downloadOneFile (opts) {
  const { id, root, file, onProgress, onDone } = opts
  // 仓库与来源以文件自己带的为准：「下载全部」一批里可能混着几个仓库、两个来源，
  //   只用 opts 上的一份会把它们全发到同一个仓库去。
  const repo = file.repo || opts.repo || ''
  const tool = file.tool || opts.tool || ''
  const finish = (result) => {
    if (onDone) onDone(file.name, result)
    return result
  }
  try {
    const resp = await fetch('/wizard/download/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        root: root || '',
        repo,
        file: { name: file.name, size: file.size, sha256: file.sha256, tool },
      }),
    })
    if (!resp.ok) {
      // 后端在开流之前拒绝（缺仓库、来源未知）时回的是 JSON，把它的原因带出来。
      let j = null
      try { j = await resp.json() } catch (e) { /* 不是 JSON 就只报状态码 */ }
      return finish({
        ok: false,
        code: (j && j.code) || ('HTTP_' + resp.status),
        status: resp.status,
        error: (j && j.error) || ('HTTP ' + resp.status),
        errorZh: (j && j.errorZh) || null,
      })
    }
    let result = { ok: false, error: 'Download ended without a result.' }
    await readSse(resp, (ev) => {
      if (!ev) return
      if (typeof ev.percent === 'number' && onProgress) onProgress(file.name, ev)
      if ('ok' in ev || 'error' in ev) result = ev
    })
    return finish(result)
  } catch (e) {
    return finish({ ok: false, error: (e && e.message) || String(e) })
  }
}

/**
 * 下载一批文件，最多同时下 concurrency 个。
 *
 * 每个文件的进度与结果分别回调，界面据此按文件分槽显示：
 *   同时下几个文件时，若只有一条全局进度，后到的会把先到的盖掉，
 *   界面上看着像其余几个没动。
 *
 * @param {object} opts
 * @param {Array<object>} opts.files 要下的文件
 * @param {number} [opts.concurrency] 同时最多下几个
 * @param {(name: string, progress: object) => void} [opts.onProgress]
 * @param {(name: string, result: object) => void} [opts.onDone]
 * @param {() => boolean} [opts.shouldStop] 返回 true 时不再派新任务
 * @returns {Promise<{ok: boolean, total: number, succeeded: number, failed: number,
 *                    results: object[], firstError?: string, firstErrorZh?: string}>}
 */
export async function downloadFiles (opts) {
  const {
    files,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress,
    onDone,
    shouldStop,
  } = opts
  const list = Array.isArray(files) ? files : []
  const results = []
  if (!list.length) {
    return { ok: true, total: 0, succeeded: 0, failed: 0, results }
  }

  const queue = createDownloadQueue(list, concurrency)
  let pending = 0
  let settle = null
  const allDone = new Promise((resolve) => { settle = resolve })

  // 全部结束的判据：在途的为 0，且没有还没派出去的任务。
  const checkDone = () => {
    if (pending === 0 && queue.isDone()) settle()
  }

  // 停止时把没派出去的任务取走：它们没有结果，不取走的话
  //   队列永远不为空，allDone 永远不会 resolve。
  const drainRest = () => {
    for (const item of queue.drain()) {
      const result = { ok: false, code: 'CANCELLED', error: 'Download was cancelled.' }
      results.push({ name: item.name, ...result })
      if (onDone) onDone(item.name, result)
    }
  }

  const pump = () => {
    for (;;) {
      if (shouldStop && shouldStop()) {
        queue.stop()
        drainRest()
        break
      }
      const item = queue.next()
      if (!item) break
      pending += 1
      downloadOneFile({
        ...opts,
        file: item,
        onProgress,
        onDone: (name, result) => {
          results.push({ name, ...result })
          if (onDone) onDone(name, result)
        },
      }).catch(() => { /* 结果已在 onDone 里归并 */ })
        .then(() => {
          pending -= 1
          queue.finish(item)
          pump()
          checkDone()
        })
    }
    checkDone()
  }

  pump()
  await allDone

  const failed = results.filter((r) => !r || r.ok !== true)
  const first = failed[0]
  return {
    ok: failed.length === 0,
    total: list.length,
    succeeded: results.length - failed.length,
    failed: failed.length,
    results,
    firstError: first ? (first.error || null) : null,
    firstErrorZh: first ? (first.errorZh || null) : null,
  }
}
