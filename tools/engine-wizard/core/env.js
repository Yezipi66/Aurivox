'use strict'
// ENV：第 3 步，给引擎建自己的 Python 环境并装依赖。
// 装法由名片的 install.env_command 决定，没有「没声明就默认 uv sync」这类分支：
// uv / poetry / pip -r / conda 各家不同，猜错的表现是装到一半失败、磁盘留一半。
// torch 系包体积大且与显卡绑定，上游通常单独装；锁文件锁的后端与本机不一致时
// 跳过 torch 系包，另给一条装本机后端的命令（envDetect.js 的 suggestBackendAlternative）。
// 实现拆在 envDetect.js（检测）、envInstall.js（安装）、envProgress.js（断点续传）三处。

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
  readEnginePythonVersion,
  PLATFORM_BASE_PYTHON,
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
  engineVenvDirAbs, engineVenvPythonAbs, canUseEngineVenv,
  platformPythonAbs, buildVenvStep, withTargetPython, syncEnvFor,
  // 装完自检：装出来的环境缺 torch 却报成功
  verifyEngineEnvImports, probeImportInEngineVenv, isVenvCreateStep,
  // 断点续传的产物检查：命令相同但产物没了仍跳过
  stepArtifactExists, sitePackagesNonEmpty,
  // 单步执行，取消通道的载体（测试注入 spawn 不真跑）
  runOne,
  // 取消/失败后留不完整环境的标记，重跑先删 .venv 再建
  partialVenvMarkAbs, hasPartialVenvMark, markPartialVenv,
  // 引擎声明的 Python 版本：声明了用声明的，没声明用平台基座
  readEnginePythonVersion, PLATFORM_BASE_PYTHON,
}
