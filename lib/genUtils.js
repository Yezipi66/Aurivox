// 纯工具：生成一次合成的 id（当目录名用，所以不带路径分隔符），以及从路径里取文件名。

// 格式 YYYY-MM-DDTHH-mm_xxxxx：ISO 时间戳截到分钟十位 + 5 位随机后缀。
function newGenId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}_${rand}`;
}

function genBaseName(p) {
  if (!p || typeof p !== "string") return "";
  return p.replace(/\\/g, "/").split("/").pop();
}

module.exports = { newGenId, genBaseName };
