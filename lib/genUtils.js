// lib/genUtils.js
// 纯工具函数：newGenId / genBaseName。从 server.js 提取，供测试与复用。

/**
 * 生成唯一 id：ISO 时间戳（截断到分钟十位）+ 5 位随机后缀。
 * 格式：YYYY-MM-DDTHH-mm_xxxxx
 */
function newGenId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}_${rand}`;
}

/**
 * 从路径中提取文件名（同时支持正反斜杠）。
 * 非字符串输入返回空串。
 */
function genBaseName(p) {
  if (!p || typeof p !== "string") return "";
  return p.replace(/\\/g, "/").split("/").pop();
}

module.exports = { newGenId, genBaseName };
