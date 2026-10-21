// 合成失败 → 一句说得清的话。纯函数，不碰 ctx。
// 上游报错优先读结构化字段 err.upstreamBody（upstreamError.js 挂的），它与引擎叫什么名字
// 无关；读不到才退回兜底正则（只认非流式那一支）。传输层失败不进脱敏：脱敏正则会把
// "p://" 认成 Windows 绝对路径，那样就把「连哪个地址失败了」这条唯一有用的信息吃掉了。

'use strict';

// 兜底正则必须认 upstreamError.js 那个 FAILED 常量，不许各写一份。
const { FAILED } = require('../engines/upstreamError');

// 兜底外壳正则：`<名片 label> /tts failed (<状态码>): <上游原话>`
// 三条不许动的地方：① 锚在开头（`^`），否则上游原话里自己带的 "... /tts failed (500):"
// 会从中间截断，把真正的错误吞掉；② label 段限长 1–64 且不许跨行；
// ③ FAILED 里有 `/`，进正则前必须转义：不许直接内插。
const UPSTREAM_SHELL = new RegExp(
  `^.{1,64}? ${FAILED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\((\\d+)\\):\\s*([\\s\\S]*)$`
);

// 上游引擎的原话藏在哪：JSON 里的 detail / message / error，取不到就用整坨正文。
const unwrapUpstreamBody = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.detail || parsed.message || parsed.error || raw);
  } catch { return raw; }
};

const synthesisFailureDetail = (err) => {
  let message = String((err && err.message) || err || "Unknown inference error");
  // 传输层失败必须在脱敏之前返回。
  if (err && err.transport === true) {
    return message.replace(/\s+/g, " ").trim().slice(0, 600) || "Unknown inference error";
  }
  if (err && typeof err.upstreamBody === "string" && err.upstreamBody !== "") {
    message = unwrapUpstreamBody(err.upstreamBody);
  } else {
    const upstream = message.match(UPSTREAM_SHELL);
    if (upstream) message = unwrapUpstreamBody(upstream[2]);
  }
  // 不把机器专属的绝对路径发给客户端，但保留异常类型与消息本身。
  message = message.replace(/[A-Za-z]:[\\/][^\s"']+|\/(?:[^\s"']+\/){2,}[^\s"']+/g, "[path]");
  return message.replace(/\s+/g, " ").trim().slice(0, 600) || "Unknown inference error";
};

module.exports = { synthesisFailureDetail, unwrapUpstreamBody };
