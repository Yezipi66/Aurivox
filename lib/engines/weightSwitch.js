'use strict'

// 权重位的执行器：按名片 weight_slots 把这次选中的权重换进引擎。
// 判据只看名片：applies_at=call 且写了 switch 的位才额外发一次切换请求；没有 switch 的位，值随请求体送到。
// 驻留表按地址记（没地址才回落 id）：地址就是 HTTP 引擎的进程身份，两张名片指同一地址时共享一格。
// 并发前提：合成都在同一把全局生成锁下，ensure() 同一时刻只有一个请求进得来；失败后清空该位。

const { callSlots } = require('./residency')

class WeightSwitch {
  // httpGet: (pathStr, params, opts) => { statusCode, body }，注入进来让本模块不依赖具体的 HTTP 客户端。
  constructor(httpGet) {
    if (typeof httpGet !== 'function') {
      throw new TypeError('WeightSwitch requires a httpGet(pathStr, params, opts) function')
    }
    this._get = httpGet
    this._resident = new Map() // key -> { ids:Set, values:{} }
    this._engineOnlineLast = null // null=未探测，true/false 是健康探测报过的
  }

  _key(engine) {
    return String(engine.base_url || engine.id || '')
  }

  // 记下这个地址现在坐着哪份权重，以及是哪几张名片在用它。
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

  // 忘掉缓存的驻留权重（例如引擎重启之后），下一次 ensure() 会重新发切换请求。
  // 清的是所有引擎那一格：健康探测只报总的在线/不在线，说不出哪台重启了；多清几格
  // 慢一点，少清一格可能用错权重出声，所以往多了清。
  reset() {
    this._resident.clear()
  }

  // supervisor 关掉这一台的进程时调用。键按地址记，两张名片共用地址时一起清：那是同一个进程。
  forgetEngine(id) {
    const name = String(id || '')
    for (const [key, entry] of this._resident) {
      if (entry.ids.has(name)) this._resident.delete(key)
    }
  }

  // 喂进引擎的存活状态，让重启能作废缓存。离线→上线说明引擎重启过、显存里的权重
  // 已经没了，缓存仍指着它们，下一次 ensure() 就会用错的模型出声，因此在那个跳变上
  // reset()；只有真的 false→true 才重置。
  noteEngineHealth(online) {
    const wasOffline = this._engineOnlineLast === false
    this._engineOnlineLast = !!online
    if (online && wasOffline) {
      this.reset()
      return true
    }
    return false
  }

  // 读回某个地址当前驻留的权重；只有测试用它。
  loadedFor(engine) {
    const entry = this._resident.get(this._key(engine))
    return entry ? { ...entry.values } : {}
  }

  // 确保引擎里坐着 cfg 这次点名的那些权重，只有要的和已驻留的不同才真的换。
  async ensure(cfg, engine) {
    if (!engine) {
      throw new Error('WeightSwitch: engine is required — 平台没有默认引擎。' +
        ' 调用方必须先解析出这次要打哪一台（resolveEngineProfile(engine_id)）。')
    }
    cfg = cfg || {}
    const result = { switched: [], skipped: [] }
    const resident = this._slot(engine)
    const opts = { baseUrl: engine.base_url, reqTimeout: engine.timeout_ms }

    for (const slot of callSlots(engine)) {
      if (!slot.param || !slot.switch) continue
      const value = cfg[slot.param]
      if (!value) continue // 调用方没钉这一份：引擎里现有的不动
      if (resident[slot.name] === value) {
        result.skipped.push(slot.name)
        continue
      }
      const { endpoint, query } = slot.switch
      const r = await this._get(endpoint, { [query]: value }, opts)
      if (r.statusCode >= 400) {
        resident[slot.name] = null // 切换没完成，驻留状态已不可知
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
