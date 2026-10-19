// lib/assetScanner.js
// 目录入口转发：实现已拆到 lib/assetScanner/，导出名单不变。
const scanner = require("./assetScanner/index");

module.exports = scanner;

// If run directly, do a full scan
if (require.main === module) {
  scanner.fullScan();
}
