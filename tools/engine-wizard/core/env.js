'use strict'
//  ENV：第 3 步，建引擎自己的 Python 环境并装依赖。
//
//  装法由名片的 install.env_command 决定，这里没有「没声明就默认 uv sync」这类分支：
//  uv / poetry / pip -r / conda 各家不同，猜错的表现是装到一半失败、磁盘留一半。
//
//  torch 系包体积大且与显卡绑定，上游通常单独装。本文件不特殊处理 torch，
//  env_command 里写什么就跑什么；没包含 torch 是上游的选择。
//  例外：锁文件锁的后端与本机不一致时，跳过 torch 系包，另给一条装本机后端的命令
//  （见 suggestBackendAlternative）。
//
//  本文件是入口：导出保持向后兼容。职责已拆分为：
//    · envDetect.js   环境检测（解释器、venv 检查、装法探测）
//    · envInstall.js  依赖安装逻辑（计划组装、单步执行、自检）
//    · envProgress.js 进度持久化（断点续传产物检查）

const {
  readEnvCommand,
  detectDependencyManifest,
  suggestEnvCommand,
  engineVenvDirAbs,
  engineVenvPythonAbs,
  canUseEngineVenv,
  platformPythonAbs,
  buildVenvStep,
  withTargetPython,
  syncEnvFor,
  isVenvCreateStep,
  partialVenvMarkAbs,
  hasPartialVenvMark,
  markPartialVenv,
} = require('./envDetect')
const {
  buildSteps,
  uvRelPath,
  resolveUv,
  buildEnvPlan,
  verifyEngineEnvImports,
  probeImportInEngineVenv,
  parseProgress,
  runOne,
  runEnv,
} = require('./envInstall')
const {
  sitePackagesNonEmpty,
  stepArtifactExists,
} = require('./envProgress')

module.exports = {
  readEnvCommand, detectDependencyManifest, buildEnvPlan, runEnv,
  uvRelPath, resolveUv,
  // 建隔离环境用得上的那几件（buildVenvStep / canUseEngineVenv 等）
  engineVenvDirAbs, engineVenvPythonAbs, canUseEngineVenv,
  platformPythonAbs, buildVenvStep, withTargetPython, syncEnvFor,
  // 装完自检（装出来的环境缺 torch 却报成功）
  verifyEngineEnvImports, probeImportInEngineVenv, isVenvCreateStep,
  // 断点续传的产物检查（命令相同但产物没了仍跳过）
  stepArtifactExists, sitePackagesNonEmpty,
  // 单步执行（取消通道的载体，测试注入 spawn 不真跑）
  runOne,
  // 取消/失败后留半截环境的标记（重跑先删 .venv 再建）
  partialVenvMarkAbs, hasPartialVenvMark, markPartialVenv,
}
