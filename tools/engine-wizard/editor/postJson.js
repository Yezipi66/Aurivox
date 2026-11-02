// 发 POST 请求并读 JSON。把失败也变成可读的结论，不让异常冒出去。
//
// 为什么单独成文件：这段逻辑过去写在组件里，两处「请求失败」会让界面
//   永久停在「正在读…」，而且一个字的错误提示都没有。写成独立函数后
//   可以直接单测，两类失败各判一次。
//
// 两类失败：
//   ① 网络层失败（连接被拒、DNS 失败、请求超时）=> fetch 抛。
//   ② 响应不是 JSON（服务端返回 HTML 错误页、网关返回纯文本）=> r.json() 抛。

/**
 * 读一次 JSON 响应；读不出来就返回一条可读的失败结论。
 *
 * @param {string} path_ 请求路径（用于错误文案里说明是哪个接口）
 * @param {object} body 请求体
 * @param {function} [fetchImpl] 注入的 fetch（测试用）
 * @returns {Promise<object>} 成功=>后端那个 JSON；失败=>{ok:false, code, ...}
 */
export async function postJson (path_, body, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) {
    return {
      ok: false,
      code: 'REQUEST_FAILED',
      path: path_,
      error: `Could not reach the platform service (${path_}): fetch is unavailable`,
      errorZh: `无法连接平台服务（${path_}）：当前环境没有可用的请求接口。`
        + '请检查平台服务是否在运行，然后重试。',
    }
  }
  let r
  try {
    r = await doFetch(path_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    return {
      ok: false,
      code: 'REQUEST_FAILED',
      path: path_,
      error: `Could not reach the platform service (${path_}): ${msg}`,
      errorZh: `无法连接平台服务（${path_}）：${msg}。`
        + '请检查平台服务是否在运行，然后重试。',
    }
  }
  try {
    return await r.json()
  } catch (e) {
    return {
      ok: false,
      code: 'BAD_RESPONSE',
      path: path_,
      status: r.status,
      error: `The platform service (${path_}) returned a response that is not JSON `
        + `(HTTP ${r.status}).`,
      errorZh: `平台服务（${path_}）返回的不是 JSON 响应（HTTP ${r.status}）。`
        + '请检查平台服务是否正常，然后重试。',
    }
  }
}
