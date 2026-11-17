// 与向导服务的连接看守。
//
// 页面上的取数全部走 fetch，服务未启动时浏览器只会给出一句 Failed to fetch：
// 界面各处的 catch 各自沉默，使用者看到的是「莫名失败」。这里把那一类失败
// 统一接住，记下是哪个地址失败，并在后台每三秒探一次；探通后自动清掉，
// 页面上的提示随之消失，不用刷新。
//
// 判据只看网络层失败（TypeError + fetch/network 字样）。HTTP 4xx/5xx 是
// 服务答了话，不算断开：那是业务错误，由各自的界面显示；主动取消（AbortSignal）
// 也不算，那是页面自己断的。
//
// 做成可以注入 fetch 的工厂，单测不依赖浏览器。

const NET_RE = /failed to fetch|fetch failed|networkerror|load failed|network request failed/i

/** 网络层失败：服务未启动、连不上、连接中断。业务错误不算。 */
export function isNetworkError (err) {
  if (!err || typeof err !== 'object') return false
  if (err.name === 'AbortError') return false
  return err instanceof TypeError ? NET_RE.test(String(err.message || '')) : false
}

function urlOf (input) {
  if (typeof input === 'string') return input
  if (input && typeof input.url === 'string') return input.url
  return String(input || '')
}

/**
 * @param {object} opts
 * @param {Function} opts.fetch 真正的 fetch（注入以便测试）
 * @param {string} [opts.probeUrl] 探活地址：最便宜的一个端点
 * @param {number} [opts.delay] 重探间隔（毫秒）
 * @param {Function} [opts.now] 时钟（测试用）
 * @returns {{fetch: Function, subscribe: Function, state: Function}}
 */
export function createConnGuard ({ fetch: baseFetch, probeUrl = '/wizard/spec', delay = 3000, now = Date.now } = {}) {
  if (typeof baseFetch !== 'function') throw new Error('createConnGuard 需要注入 fetch')
  let down = null
  let timer = null
  const subs = new Set()
  const emit = () => { for (const fn of [...subs]) fn(down) }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(probe, delay)
    // Node 里别把测试进程钉住；浏览器里没有这个方法。
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  async function probe () {
    timer = null
    try {
      const r = await baseFetch(probeUrl, { cache: 'no-store' })
      if (r && r.ok) {
        if (down) { down = null; emit() }
        return
      }
    } catch (e) { /* 服务尚未恢复，继续探活 */ }
    schedule()
  }

  const markDown = (url) => {
    if (down) return
    down = { url, at: now() }
    emit()
    schedule()
  }

  const fetch = (input, init) => baseFetch(input, init).catch((e) => {
    const aborted = !!(init && init.signal && init.signal.aborted)
    if (!aborted && isNetworkError(e)) markDown(urlOf(input))
    throw e
  })

  return {
    fetch,
    /** 订阅连接状态：立即回报一次当前值，返回退订函数。 */
    subscribe: (fn) => {
      subs.add(fn)
      fn(down)
      return () => { subs.delete(fn) }
    },
    state: () => down,
  }
}
