'use strict'

// ===========================================================================
//  传输层失败必须点名引擎 —— 守卫
// ===========================================================================
//
// 背景（2026-08-23 真机实测）：引擎没启动时 broker 只吐
// {"error":"Internal server error"}，而日志里写着 connect ECONNREFUSED
// 127.0.0.1:9880。甲刀的承重是 err.upstreamBody，可传输层失败根本没有
// 上游正文 ⇒ 绕过甲刀落到通用兜底。
//
// 这组测试钉三件事：
//   1. 哪些错误算传输层失败（含 client.js 自建的 "Request timed out"）
//   2. 消息里必须同时有引擎名和地址
//   3. ⛔ 消息不能被 synthesisFailureDetail 的脱敏正则吃掉地址

const test = require('node:test')
const assert = require('node:assert')

const {
  isTransportError,
  transportFailure,
  upstreamFailure,
  TRANSPORT_HINTS,
} = require('./upstreamError')

const PROFILE = Object.freeze({ id: 'my-engine', label: 'My Engine', base_url: 'http://127.0.0.1:9999' })

const nodeErr = (code) => Object.assign(new Error(`connect ${code} 127.0.0.1:9999`), { code })

test('isTransportError 认得 Node 的连接类错误码，也认得 client.js 自建的超时', () => {
  for (const code of Object.keys(TRANSPORT_HINTS)) {
    assert.equal(isTransportError(nodeErr(code)), true, `${code} 应算传输层失败`)
  }
  // lib/gsv/client.js:70 自己 req.destroy() 后抛的这一个没有 code。
  // 漏掉它 ⇒ 自建超时那条路仍然不点名。
  assert.equal(isTransportError(new Error('Request timed out')), true)
})

test('isTransportError 不把「引擎回了话但报错」误判成连不上', () => {
  // 上游 400 是 upstreamFailure 的地盘，两者的处置完全不同：
  // 一个该让用户去启动引擎，一个该让用户去看参数。
  const up = upstreamFailure(PROFILE, 400, '{"message":"bad param"}')
  assert.equal(isTransportError(up), false)
  assert.equal(isTransportError(new Error('some other failure')), false)
  assert.equal(isTransportError(null), false)
  assert.equal(isTransportError(undefined), false)
})

test('transportFailure 的消息同时说出引擎名和地址', () => {
  const err = transportFailure(PROFILE, nodeErr('ECONNREFUSED'), { baseUrl: PROFILE.base_url })
  assert.match(err.message, /My Engine/, '必须点名这台引擎')
  assert.match(err.message, /http:\/\/127\.0\.0\.1:9999/, '必须说出连的是哪个地址')
  assert.match(err.message, /ECONNREFUSED/, '必须带原始错误码')
  assert.match(err.message, /not running/, 'ECONNREFUSED 要给一句人话')
})

test('transportFailure 把承重放在属性上，不是文案上', () => {
  const cause = nodeErr('ECONNREFUSED')
  const err = transportFailure(PROFILE, cause, { baseUrl: PROFILE.base_url })
  assert.equal(err.transport, true)
  assert.equal(err.transportCode, 'ECONNREFUSED')
  assert.equal(err.engineId, 'my-engine')
  assert.equal(err.engineLabel, 'My Engine')
  assert.equal(err.baseUrl, 'http://127.0.0.1:9999')
  assert.equal(err.cause, cause, '原始错误要留着，否则栈就断了')
  // ⭐ upstreamStatus/upstreamBody 必须保持「没有」——调用方就是靠这个区分
  //   「引擎拒绝了请求」和「引擎不在」。给个空串会让 synthesisFailureDetail
  //   走进剥壳分支，把这条消息整个换掉。
  assert.equal(err.upstreamStatus, undefined)
  assert.equal(err.upstreamBody, undefined)
})

test('名片解析不出来时也不能崩，退回一个通用称呼', () => {
  const err = transportFailure(null, nodeErr('ECONNREFUSED'), { baseUrl: 'http://x:1' })
  assert.match(err.message, /TTS engine/)
  assert.equal(err.engineId, null)
})

test('不认识的错误码不猜人话，原样带上', () => {
  const err = transportFailure(PROFILE, Object.assign(new Error('weird failure'), { code: 'EWEIRD' }))
  // 没有 code 提示时用原始 message 兜底，而不是编一句可能指错方向的诊断。
  assert.match(err.message, /weird failure/)
  // 地址没传就从名片取。
  assert.match(err.message, /http:\/\/127\.0\.0\.1:9999/)
})

test('⛔ 脱敏正则不能把引擎地址吃掉', () => {
  // 这是本次差点漏掉的坑：synthesisFailureDetail 的脱敏正则第一支
  // /[A-Za-z]:[\\/][^\s"']+/ 认 "C:\..."，但 "http://..." 里的 `p://`
  // 同样命中 ⇒ 地址被换成 [path]，消息里唯一有用的信息没了。
  const scrub = (s) => s.replace(/[A-Za-z]:[\\/][^\s"']+|\/(?:[^\s"']+\/){2,}[^\s"']+/g, '[path]')
  const raw = transportFailure(PROFILE, nodeErr('ECONNREFUSED'), { baseUrl: PROFILE.base_url }).message
  // 先证明这个坑是真的（不是我臆想出来的）——正则确实会吃掉地址。
  assert.doesNotMatch(scrub(raw), /9999/, '前提：裸跑脱敏确实会毁掉地址')

  // 再证明真实通路上没被吃掉 —— 走的是合成路径真正调用的那个函数，
  // 不是这里再抄一份实现（抄一份就只能证明抄得对，证明不了盘上的对）。
  const { synthesisFailureDetail } = require('../services/failureDetail')
  const detail = synthesisFailureDetail(
    transportFailure(PROFILE, nodeErr('ECONNREFUSED'), { baseUrl: PROFILE.base_url }))
  assert.match(detail, /http:\/\/127\.0\.0\.1:9999/, '真实通路必须保住地址')
  assert.match(detail, /My Engine/)
})
