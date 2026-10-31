'use strict'

// 权重位的执行器：按名片 weight_slots 把「这次选中的权重」换进引擎。
// 判据只看名片：call 位 + 带 switch 的位才需要一次额外请求；没有 switch 的位，
// 选中的值随请求体一起送到（stdio 宿主就靠这个），平台不额外发任何请求。
// 本文件不许出现具体引擎名或端点：换法来自名片。
//
// 驻留表按「引擎 id + 地址」记：id 区分共用一台机器的多张名片（stdio 引擎的
// base_url 全是 null），地址区分「同一个 id 换了机器或端口」。只认 id 会在换地址后
// 静默跳过，而那台进程里并没有旧权重。
// 并发前提：所有合成都在同一把全局生成锁下跑，ensure() 同一时刻只有一个请求进得来；
// 切换失败后该位的驻留状态不可知，清空，下次必定真换一次。

class WeightSwitch {
  // httpGet: (pathStr, params, opts) => { statusCode, body }，与 lib/gsv/client.js 的
  // gsvGet 同形；注入进来是为了让本模块不依赖具体的 HTTP 客户端。
  constructor(httpGet) {
    if (typeof httpGet !== 'function') {
      throw new TypeError('WeightSwitch requires a httpGet(pathStr, params, opts) function')
    }
    this._get = httpGet
    this._resident = new Map() // engineKey -> { [slotName]: value }
    this._engineOnlineLast = null // null=未探测，true/false 是健康探测报过的
  }

  _key(engine) {
    if (!engine) return ''
    return `${engine.id || ''}@${engine.base_url || ''}`
  }

  _slot(key) {
    let slot = this._resident.get(key)
    if (!slot) { slot = {}; this._resident.set(key, slot) }
    return slot
  }

  // 忘掉缓存的驻留权重（例如引擎重启之后），下一次 ensure() 会重新发切换请求。
  // 清的是所有引擎那一格：健康探测只报总的在线/不在线，说不出哪台重启了；多清几格
  // 慢一点，少清一格可能用错权重出声，所以往多了清。
  reset() {
    this._resident.clear()
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

  get loaded() {
    return this.loadedFor(null)
  }

  loadedFor(engine) {
    const slot = this._resident.get(this._key(engine))
    return slot ? { ...slot } : {}
  }

  // 确保引擎里坐着 cfg 这次点名的那些权重，只有要的和已驻留的不同才真的换。
  // 没给 engine 当场抛：平台没有默认引擎，猜一台的症状是「界面选 A、报错说 B」。
  async ensure(cfg, engine = null) {
    if (!engine) {
      throw new Error('WeightSwitch: engine is required — 平台没有默认引擎。' +
        ' 调用方必须先解析出这次要打哪一台（resolveEngineProfile(engine_id)）。')
    }
    cfg = cfg || {}
    const result = { switched: [], skipped: [] }
    const resident = this._slot(this._key(engine))
    const opts = { baseUrl: engine.base_url, reqTimeout: engine.timeout_ms }

    for (const slot of (engine.weight_slots || [])) {
      if (slot.applies_at !== 'call' || !slot.param || !slot.switch) continue
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
