// 目录入口转发：实现已拆到 lib/assetScanner/，导出名单不变；直接运行本文件做一次全量扫描。
const scanner = require("./assetScanner/index");

module.exports = scanner;

if (require.main === module) {
  scanner.fullScan();
}
