'use strict'
// ENV：第 3 步，给引擎建自己的 Python 环境并装依赖。
// 装法由名片的 install.env_command 决定，没有「没声明就默认 uv sync」这类分支：
// uv / poetry / pip -r / conda 各家不同，猜错的表现是装到一半失败、磁盘留一半。
// torch 系包体积大且与显卡绑定，上游通常单独装；锁文件锁的后端与本机不一致时
// 跳过 torch 系包，另给一条装本机后端的命令（envDetect.js 的 suggestBackendAlternative）。
// 实现拆在 envDetect.js（检测）、envInstall.js（安装）、envProgress.js（断点续传）三处。

const fs = require('node:fs')
const { projectRoot, engineDir } = require('./clone.js')
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
const {
  judgeTorchVersion,
} = require('./torchVersionProbe')

/**
 * 判「上游钉的 torch 版本在本机后端上能不能用」，给出升级建议。
 *
 * 判据只有两样，都是确定的事实：
 *   ① 上游声明的 torch 版本（requirements / pyproject / lock 里读出来的）；
 *   ② 该 (官方 index, 平台, Python ABI) 组合的版本下界
 *      （backendTorchSupport.js 的事实表）。
 *
 * **全程不联网**：后端对 torch 版本的支持有下界且方向单向
 *   （XPU 从 2.6.0 起才有官方轮子，不会回头兼容 2.5），
 *   所以查表比大小就能定论。
 *
 * 与 torch 无关的情形（没声明 / 后端没官方 index）⇒ 返回 null，不打扰使用者。
 *
 * @param {object} input {id, root, backend}
 * @returns {object|null} 建议对象，或 null
 */
function suggestTorchUpgrade (input = {}) {
  if (!input) return null
  const root = input.root || projectRoot()
  if (!root) return null
  const id = String(input.id || '')
  if (!id) return null
  const dir = engineDir(id, root)
  if (!fs.existsSync(dir)) return null
  // 引擎环境用哪个 Python 版本：声明了就用声明的，没声明用平台基座。
  const declared = readEnginePythonVersion(dir)
  const pythonVersion = declared ? declared.version : PLATFORM_BASE_PYTHON
  let backend = input.backend
  if (!backend) {
    try {
      const hw = require('./hardware')
      const rec = hw.recommendBackend(hw.detectGpus())
      backend = rec && rec.recommended
    } catch (e) { backend = null }
  }
  if (!backend) return null
  try {
    const r = judgeTorchVersion({ dir, backend, pythonVersion })
    if (!r || r.ok) return null
    // 「上游钉的版本在这个后端上不可用」有两种形态，两种都要报给使用者：
    //   ① version-not-on-this-backend：低于这个组合的下界
    //      ⇒ 可以给出「换一个可用的版本」的建议，由使用者决定升不升级。
    //   ② no-wheel-for-this-python：这个组合没有官方轮子
    //      ⇒ 换 torch 版本解决不了（得换 Python 版本或换后端），不给版本建议，
    //      但仍然要如实告诉使用者「这个后端上装不了上游钉的版本」。
    if (r.reason !== 'version-not-on-this-backend' && r.reason !== 'no-wheel-for-this-python') {
      return null
    }
    return r
  } catch (e) {
    // 判断本身出错（不该发生，判据是纯查表）：不给建议，让计划照常出。
    return null
  }
}

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
  // torch 版本与本机后端的匹配判断（离线查表，给出升级建议）
  suggestTorchUpgrade,
}
