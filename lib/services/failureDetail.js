// ===========================================================================
//  合成失败 → 一句说得清的话
// ===========================================================================
//
// 从 lib/services/synthesisService.js 提出来（原封不动，只多了 transport 那一支）。
//
// 为什么值得单独一个文件：
//   1. 它是纯函数，不碰 ctx —— 埋在 createSynthesisService 的闭包里纯属历史；
//   2. 它现在是**两个调用方**的共同承重（分段支 + 刚补上的单段支），
//      而闭包里的东西没法给它单独立守卫；
//   3. ⛔ 它里面有一条极容易踩的脱敏正则 —— 会把 "http://127.0.0.1:9880"
//      当成 Windows 绝对路径吃掉。这种坑必须有测试钉着。

'use strict';

// 上游引擎的原话藏在哪：JSON 里的 detail / message / error，取不到就用整坨正文。
const unwrapUpstreamBody = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.detail || parsed.message || parsed.error || raw);
  } catch { return raw; }
};

const synthesisFailureDetail = (err) => {
  let message = String((err && err.message) || err || "Unknown inference error");
  // ⛔⛔ 传输层失败必须在脱敏之前返回。
  //   下面那条脱敏正则的第一支是 /[A-Za-z]:[\\/][^\s"']+/ —— 它认的是
  //   "C:\..." 这种 Windows 绝对路径，但 "http://127.0.0.1:9880" 里的
  //   `p://` 同样命中（p 是字母、冒号、斜杠），整个地址会被替换成 [path]，
  //   用户看到的是 "Cannot reach GPT-SoVITS at htt[path]"。
  //   ⇒ 恰恰把这条消息唯一有用的信息（连哪个地址失败了）擦掉。
  //
  //   引擎地址不是敏感信息：它是名片上写的、用户自己配的，也正是他要拿去
  //   排查的东西。所以这一支直接返回，不进脱敏。
  if (err && err.transport === true) {
    return message.replace(/\s+/g, " ").trim().slice(0, 600) || "Unknown inference error";
  }
  // ⭐⭐ 第 3 步（甲）：上游报错**首选走结构化字段**（upstreamError.js 挂的）。
  //   过去这里只有下面那条正则，而正则认的是一句人类可读的文案里的
  //   "GPT-SoVITS" 四个字 —— 等于让文案当机器接口：错误文案里的引擎名一改，
  //   正则就静默失配，webui 从此显示一坨带前缀的原文，没有任何东西会喊一声。
  //
  // ⚠ 正则**一个字都没改，也不能删**：它是兜底。老的、第三方的、以及任何
  //   还没接到 upstreamError.js 上的抛错点，仍然只抛一个字符串。
  if (err && typeof err.upstreamBody === "string" && err.upstreamBody !== "") {
    message = unwrapUpstreamBody(err.upstreamBody);
  } else {
    const upstream = message.match(/GPT-SoVITS \/tts failed \(\d+\):\s*([\s\S]*)$/);
    if (upstream) message = unwrapUpstreamBody(upstream[1]);
  }
  // Avoid sending machine-specific absolute paths while preserving the actual
  // exception type/message. Keep the response small even for Python tracebacks.
  message = message.replace(/[A-Za-z]:[\\/][^\s"']+|\/(?:[^\s"']+\/){2,}[^\s"']+/g, "[path]");
  return message.replace(/\s+/g, " ").trim().slice(0, 600) || "Unknown inference error";
};


module.exports = { synthesisFailureDetail, unwrapUpstreamBody };
