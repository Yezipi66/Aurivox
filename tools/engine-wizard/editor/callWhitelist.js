// 一个参数与宿主的调用期白名单一起写。
//
// host.py 只把白名单里的键交给引擎（`call_params = {k: body[k] for k in body if k in call_time}`），
//   而 build_cli_argv 对「白名单里有、call.args 里没有」是当场抛错，两处必须同步加减。
//   少一处的症状两种，都不报对的地方：漏加 ⇒ 界面调了引擎没收到；
//   漏删 ⇒ 那台引擎一被填值就拒收整次调用。
//
// 两种名片写法，白名单的来源不同：
//   旧版：手写的 params.call_time
//   新版：写了 parameters[] 的名片，白名单由它派生（lib/engines/parameterDeclaration.js），
//         再自己写一份 params 会被当场拒（ENGINE_MANIFEST_INVALID_VALUE：
//         「同时写了新版 parameters 和旧字段 params」）
//         ⇒ 那种名片只加减 parameters[] 里那一条，不碰 params。
//
// 与 weightSlots.js 的 wire() 是同一条规矩（多权重位那边也是「三份名单一起写」），
//   两处都别绕过：绕过的那一次会把名片写成平台加载不了的样子。

/**
 * 这一张名片是不是「新版 parameters[]」的写法。
 * @param {object} manifest 名片
 * @returns {boolean}
 */
export function hasNewParams (manifest) {
  return Array.isArray(manifest && manifest.parameters)
}

/**
 * 声明 / 撤销一个参数的调用期白名单，按名片的写法走对应那一条路。
 *
 * @param {object} cur 当前名片（不改原对象）
 * @param {string} name 参数名
 * @param {boolean} on true＝进白名单，false＝从白名单摘掉
 * @param {string} [type] 只在需要补一条 parameters[] 条目时用（device=text / audio_ref=file /
 *   output_format=text）；已有的条目不覆盖，使用者写的 label / help 不会被这一步冲掉。
 * @returns {object} 新名片
 */
export function withCallKey (cur, name, on, type) {
  if (hasNewParams(cur)) {
    const list = cur.parameters.slice()
    const at = list.findIndex((p) => p && p.name === name)
    if (on) {
      // 已经在 parameters[] 里的不动：那一条可能带着 label / help / 默认值，
      //   这里要的只是「这一格被声明了」，不是把它重写一遍。
      if (at < 0) list.push({ name, type: type || 'text', phase: 'call', tier: 'advanced' })
    } else if (at >= 0) {
      list.splice(at, 1)
    }
    if (!list.length) {
      // 最后一条也走了：删掉整份 parameters，别留一个空数组
      //   （空数组派生出一份空 params，平台那边就成了一张「什么都不收」的名片）。
      const out = { ...cur }
      delete out.parameters
      return out
    }
    return { ...cur, parameters: list }
  }

  const p = { ...(cur.params || {}) }
  const ct = Array.isArray(p.call_time) ? p.call_time : []
  if (on) {
    if (!ct.includes(name)) p.call_time = [...ct, name]
  } else {
    const next = ct.filter((k) => k !== name)
    // 空了就整段删掉，不写一个空的 call_time：名片里「没写这一段」与
    //   「写了但一项都没有」在平台那边不是一回事。
    if (next.length) p.call_time = next
    else delete p.call_time
  }
  return { ...cur, params: p }
}
