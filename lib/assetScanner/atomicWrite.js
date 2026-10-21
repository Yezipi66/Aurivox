// 原子写盘：先写临时文件再改名，读方不会看到写了一半的 JSON。
const fs = require("fs");

function atomicWriteFile(filePath, content) {
 const tmp = filePath + ".tmp." + process.pid + "." + Date.now();
 fs.writeFileSync(tmp, content, "utf-8");
 fs.renameSync(tmp, filePath);
}

module.exports = { atomicWriteFile };
