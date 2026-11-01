'use strict'

// 权重位执行器：按名片 weight_slots 把本次选中的权重载入引擎。
// 判据只看名片：applies_at=call 且声明了 switch 的位才额外发送一次切换请求；没有 switch 的位，值随请求体送达。
// 驻留表按引擎地址记录（没有地址时回落到 id）：地址是 HTTP 引擎的进程身份，两张名片指向同一地址时共用一格。
// 并发前提：合成都在同一把全局生成锁下，ensure() 同一时刻只有一个请求进入；失败后清空该位。

const { callSlots } = require('./residency')

class WeightSwitch {
  // httpGet: (pathStr, params, opts) => { statusCode, body }，由外部注入，使本模块不依赖具体的 HTTP 客户端。
  constructor(httpGet) {
    if (typeof httpGet !== 'function') {
      throw new TypeError('WeightSwitch requires a httpGet(pathStr, params, opts) function')
    }
    this._get = httpGet
    this._resident = new Map() // key -> { ids:Set, values:{} }
    this._engineOnlineLast = null // null 表示未探测；true/false 为健康探测报过的结果
  }

  _key(engine) {
    return String(engine.base_url || engine.id || '')
  }

  // 记录该地址当前载入的权重，以及有哪些名片在使用该地址。
  _slot(engine) {
    const key = this._key(engine)
    let entry = this._resident.get(key)
    if (!entry) {
      entry = { ids: new Set(), values: {} }
      this._resident.set(key, entry)
    }
    entry.ids.add(String(engine.id || ''))
    return entry.values
  }

  // 清除缓存的驻留记录（例如引擎重启之后），下一次 ensure() 会重新发送切换请求。
  // 清除的是全部引擎的记录：健康探测只报告整体在线与否，无法说明是哪台重启；多清几条只是
  // 慢一点，少清一条会用错误的权重合成，因此按最大范围清除。
  reset() {
    this._resident.clear()
  }

  // supervisor 关闭该引擎进程时调用。键按地址记录，两张名片共用同一地址时一并清除：那是同一个进程。
  forgetEngine(id) {
    const name = String(id || '')
    for (const [key, entry] of this._resident) {
      if (entry.ids.has(name)) this._resident.delete(key)
    }
  }

  // 接收引擎的存活状态，使重启能作废缓存。离线→上线说明引擎重启过、显存中的权重
  // 已经失效，而缓存仍指向它们，下一次 ensure() 会用错误的模型合成，因此在该跳变上
  // reset()；仅在确实发生 false→true 时重置。
  noteEngineHealth(online) {
    const wasOffline = this._engineOnlineLast === false
    this._engineOnlineLast = !!online
    if (online && wasOffline) {
      this.reset()
      return true
    }
    return false
  }

  // 读回某个地址当前驻留的权重；仅供测试使用。
  loadedFor(engine) {
    const entry = this._resident.get(this._key(engine))
    return entry ? { ...entry.values } : {}
  }

  // 确保引擎中已载入 cfg 本次指定的权重；仅当所需权重与已驻留的不同时才真正切换。
  async ensure(cfg, engine) {
    if (!engine) {
      throw new Error('WeightSwitch: engine is required。'
        + '平台没有默认引擎，调用方必须先解析出这次要打哪一台（resolveEngineProfile(engine_id)）。')
    }
    cfg = cfg || {}
    const result = { switched: [], skipped: [] }
    const resident = this._slot(engine)
    const opts = { baseUrl: engine.base_url, reqTimeout: engine.timeout_ms }

    for (const slot of callSlots(engine)) {
      if (!slot.switch) continue
      const value = cfg[slot.param]
      if (!value) continue // 调用方未指定该位：引擎内现有权重保持不变
      if (resident[slot.name] === value) {
        result.skipped.push(slot.name)
        continue
      }
      const { endpoint, query } = slot.switch
      const r = await this._get(endpoint, { [query]: value }, opts)
      if (r.statusCode >= 400) {
        resident[slot.name] = null // 切换未完成，驻留状态不可知
        const msg = r.body ? r.body.toString() : ''
        console.error(`${endpoint} failed:`, msg)
        throw new Error(`${endpoint} failed (${r.statusCode}): ${msg}`)
      }
      resident[slot.name] = value
      result.switched.push(slot.name)
    }

    return result
  }
}

module.exports = { WeightSwitch }
