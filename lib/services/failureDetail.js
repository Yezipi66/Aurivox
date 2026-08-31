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

// ⭐⭐⭐ 刀 D1（2026-08-31）：兜底正则不再认「GPT-SoVITS」这四个字。
//   文案由 upstreamError.js 拼成 `${label} ${FAILED} (${status}): ${body}`，
//   label 是**名片上的**。⇒ 正则也必须认那个常量，⛔ 不许各写一份。
//   常量改了、正则跟着改，这才是"一个来源"。
const { FAILED } = require('../engines/upstreamError');

/**
 * 兜底外壳正则：`<名片 label> /tts failed (<状态码>): <上游原话>`
 *
 * ⛔ 三条不许动的地方：
 *  ① **锚在开头**（`^`）。upstreamFailure 永远把 label 放在第一个字节
 *    （`upstreamError.js:58`）⇒ 锚得住。不锚的后果：上游原话里如果自己带了
 *    一句 "... /tts failed (500):"，会从中间截断，把真正的错误吞掉。
 *  ② label 段限长 1–64 且**不许跨行**。名片 label 是一个短名字；放开成
 *    `[\s\S]*?` 就等于让任意一坨 Python traceback 都能冒充外壳。
 *  ③ `FAILED` 里有 `/`，进正则前必须转义 —— ⛔ 不许直接内插。
 *
 * ⚠ 覆盖面与改之前**一字不差**：只认非流式那一支。流式（`/tts streaming
 *   failed`）改之前就不在这条正则里，这一刀⛔不顺手扩大 —— 扩大是行为变化，
 *   要单独一刀单独验。流式那条路今天走 `err.upstreamBody` 结构化字段。
 */
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
  // ⚠ 正则**不能删**：它是兜底。老的、第三方的、以及任何还没接到
  //   upstreamError.js 上的抛错点，仍然只抛一个字符串。
  //
  // ⭐ 刀 D1：正则里的引擎名已经拔掉（见文件头 UPSTREAM_SHELL）。
  //   ⛔ 拔掉的理由不是"好看"：装了 IndexTTS2 的用户，走兜底那条路时
  //     外壳**剥不掉** —— 他看到的是 "IndexTTS2 /tts failed (500): {...}"
  //     一整坨，而 GSV 用户看到的是干净的一句。同一个平台两种表现，
  //     且没有任何东西会喊一声。
  if (err && typeof err.upstreamBody === "string" && err.upstreamBody !== "") {
    message = unwrapUpstreamBody(err.upstreamBody);
  } else {
    const upstream = message.match(UPSTREAM_SHELL);
    if (upstream) message = unwrapUpstreamBody(upstream[2]);
  }
  // Avoid sending machine-specific absolute paths while preserving the actual
  // exception type/message. Keep the response small even for Python tracebacks.
  message = message.replace(/[A-Za-z]:[\\/][^\s"']+|\/(?:[^\s"']+\/){2,}[^\s"']+/g, "[path]");
  return message.replace(/\s+/g, " ").trim().slice(0, 600) || "Unknown inference error";
};


module.exports = { synthesisFailureDetail, unwrapUpstreamBody };
