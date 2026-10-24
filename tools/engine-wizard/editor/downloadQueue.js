// 第 3 步的下载调度：把「依次下载」改成「同时下载若干个」。
//
// 为什么要并发：模型权重常常是十来个文件，其中一两个是 GB 级的。
//   依次下载的总时间等于每个文件时间之和，其中大部分时间花在等网络上。
//   同时下载几个，总时间接近最慢的那一个。
//   并发数有上限：每个下载是一条独立的 HTTP 连接，开太多会互相抢带宽，
//   反而比少开几个慢，还会让进度条抖动。
//
// 这份是纯逻辑，不碰 React、不碰网络：调度器只管「下一个该下谁」和
// 「什么时候算全部下完」。测试直接跑它，不点界面。

/** 同时最多下几个。 */
export const DEFAULT_CONCURRENCY = 6

/**
 * 一个下载队列的调度器。
 *
 * 用法：
 *   const q = createDownloadQueue(files, concurrency)
 *   q.next()          取下一个要下的文件（没有了就返回 null）
 *   q.finish(key)     某个文件下完了（成功或失败都算完）
 *   q.isDone()        全部下完了？
 *   q.running()       现在几个在执行
 *   q.paused          暂停标志：置 true 后 next() 不再给新任务
 */
export function createDownloadQueue (items, concurrency = DEFAULT_CONCURRENCY) {
  const queue = Array.isArray(items) ? items.slice() : []
  const limit = Math.max(1, Math.floor(Number(concurrency) || DEFAULT_CONCURRENCY))
  const inFlight = new Set()
  let doneCount = 0
  let paused = false
  let stopped = false

  return {
    get total () { return queue.length },
    get concurrency () { return limit },
    get completed () { return doneCount },
    get paused () { return paused },
    get stopped () { return stopped },

    /** 暂停：不再派新任务，已经在执行的继续执行完。 */
    pause () { paused = true },
    /** 恢复：继续派新任务。 */
    resume () { if (!stopped) paused = false },
    /** 停止：不再派新任务，已经在执行的由调用方去中止。 */
    stop () { stopped = true; paused = true },

    /**
     * 取下一个要下的文件。返回 null 表示没有可派的任务了
     *   （队列空了、或者已暂停、或者已停止、或者并发数已满）。
     */
    next () {
      if (paused || stopped) return null
      if (inFlight.size >= limit) return null
      if (!queue.length) return null
      const item = queue.shift()
      inFlight.add(item)
      return item
    },

    /**
     * 某个文件下完了。key 是这个文件在队列里的标识。
     *   传错 key 不会影响别的任务，只当它没发生过。
     */
    finish (key) {
      if (!inFlight.has(key)) return false
      inFlight.delete(key)
      doneCount += 1
      return true
    },

    /** 现在几个在执行。 */
    running () { return inFlight.size },

    /**
     * 取走队列里还没派出去的全部任务。
     *
     *   停止时必须调它：这些任务没有结果，留着的话队列永远不为空，
     *   「全部结束」的判据就永远不会成立，调用方会一直等下去。
     */
    drain () {
      const rest = queue.splice(0, queue.length)
      return rest
    },

    /** 全部下完了吗（队列空且没有在执行的）。 */
    isDone () { return !queue.length && inFlight.size === 0 },
  }
}

/**
 * 汇总一轮下载的结果。
 *
 * @param {Array<{ok:boolean, error?:string, errorZh?:string}>} results 每个文件的结果
 * @returns {{ok:boolean, total:number, succeeded:number, failed:number,
 *            firstError?:string, firstErrorZh?:string}}
 */
export function summarizeDownloads (results) {
  const list = Array.isArray(results) ? results : []
  const failed = list.filter((r) => !r || r.ok !== true)
  const succeeded = list.length - failed.length
  const first = failed[0]
  return {
    ok: failed.length === 0,
    total: list.length,
    succeeded,
    failed: failed.length,
    firstError: first ? (first.error || null) : null,
    firstErrorZh: first ? (first.errorZh || null) : null,
  }
}
