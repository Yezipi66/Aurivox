'use strict'

// ===========================================================================
//  上游推理失败 —— 说出真正出事的那台引擎的名字
// ===========================================================================
//
// 契约 v2 第 3 步（甲）。这句话过去在三个地方各写了一遍，而且都把引擎名
// 硬编码成了 "GPT-SoVITS"：
//
//   server.js:890            老合成路径（webui）
//   lib/routes/synthesis.js  /v1/audio/speech 的非流式与流式两支
//
// 为什么是缺陷：请求今天已经按名片发给任意一台引擎了（第 1b/1c 步），
// 但一出错，平台一律自称 GPT-SoVITS。下游作者接了别的引擎，外部调用方
// （SillyTavern 这类走 OpenAI 兼容接口的）看到的报错会把他指向一台**可能
// 根本没启动、甚至没装**的引擎。诊断信息指错人，比没有诊断信息更费时间。
//
// ⭐⭐ 但这句话不只是给人看的：`services/synthesisService.js` 过去靠正则
//    匹配 "GPT-SoVITS /tts failed (\d+):" 把上游的原始报错从外壳里抠出来。
//    也就是说**一句人类可读的文案同时充当了机器接口**。只改文案不改正则，
//    后果是正则静默失配 ⇒ webui 不再剥壳、用户看到一坨带前缀的原文，
//    而且没有任何东西会喊一声。
//
//    所以这里的做法是：**把承重从字符串搬到属性上**。文案随人怎么写，
//    机器读 err.upstreamStatus / err.upstreamBody。正则留在那边当兜底，
//    一个字都不改 —— 老的、第三方的、还没接过来的抛错点仍然管用。
//
// 名字取 `label`，不取 `id`，也不写成 "Label (id)"：老路径引擎的名片上
// label 就是 "GPT-SoVITS"，所以对今天的用户来说**这几句话一个字节都没变**。
// 「行为不变」有据可查，比多印一个 id 值钱。

// 文案里这两个片段是 synthesisService.js 那条兜底正则认得的形状。
// 改它们要连那边一起改 —— 但现在即使漏改，结构化字段也已经先一步接住了。
const FAILED = '/tts failed'
const STREAMING_FAILED = '/tts streaming failed'

/**
 * 名片上写的引擎名。名片一定有 label（profile.js 保证 `label || id`），
 * 这里的兜底是为了防「压根没解析出名片」那种调用。
 */
function engineName (profile) {
  const raw = profile && (profile.label || profile.id)
  return (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'TTS engine'
}

/**
 * 上游返回了 >=400。
 *
 * @param {object} profile   引擎名片（解析失败时给 null 也行）
 * @param {number} statusCode 上游 HTTP 状态码
 * @param {*}      body       上游响应正文（Buffer / string 都收）
 * @param {{streaming?: boolean}} [opts]
 * @returns {Error} 带 upstreamStatus / upstreamBody / engineId / engineLabel
 */
function upstreamFailure (profile, statusCode, body, opts = {}) {
  const text = body === undefined || body === null ? '' : String(body)
  const what = opts.streaming ? STREAMING_FAILED : FAILED
  const err = new Error(`${engineName(profile)} ${what} (${statusCode}): ${text}`)
  // ⭐ 承重的是这两个字段，不是上面那句话。
  err.upstreamStatus = Number(statusCode)
  err.upstreamBody = text
  err.engineId = (profile && profile.id) || null
  err.engineLabel = engineName(profile)
  return err
}

/**
 * 上游返回 200 但正文是空的 —— 对调用方来说和失败没区别，同样要点名。
 */
function emptyAudioFailure (profile) {
  const err = new Error(`${engineName(profile)} returned empty audio`)
  err.engineId = (profile && profile.id) || null
  err.engineLabel = engineName(profile)
  return err
}

module.exports = { engineName, upstreamFailure, emptyAudioFailure, FAILED, STREAMING_FAILED }
