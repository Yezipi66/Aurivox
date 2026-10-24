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
  probeTorchVersion,
  readDeclaredTorchVersion,
  BACKENDS_WITH_INDEX,
} = require('./torchVersionProbe')

/**
 * 探测「上游钉的 torch 版本在本机后端上能不能用」，给出升级建议。
 *
 * 判据只有两样：上游声明的版本 + 本机后端官方 index 上有哪些轮子。
 *   查不出来（没声明 / 后端没 index / 抓不到）⇒ 返回 null，
 *   不猜、不给假建议。
 *
 * @param {object} input {id, root, backend}
 * @returns {Promise<object|null>} 建议对象，或 null
 */
async function suggestTorchUpgrade (input = {}) {
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
    const r = await probeTorchVersion({
      dir, backend, pythonVersion,
      platform: process.platform, arch: process.arch,
      timeoutMs: 15000,
    })
    if (!r || r.ok) return null
    // 「上游钉的版本在这个后端上不可用」有两种形态，两种都要报给使用者：
    //   ① version-not-on-this-backend：这个 index 上有这个版本，但配不了本机 Python
    //      ⇒ 可以给出「换一个可用的版本」的建议，由使用者决定升不升级。
    //   ② no-wheel-for-this-python：这个 index 在本机 Python 上一个轮子都没有
    //      ⇒ 换 torch 版本解决不了（得换 Python 版本或换后端），不给版本建议，
    //      但仍然要如实告诉使用者「这个后端上装不了上游钉的版本」。
    if (r.reason !== 'version-not-on-this-backend' && r.reason !== 'no-wheel-for-this-python') {
      return null
    }
    return r
  } catch (e) {
    // 探测失败不是安装失败：不给建议，让计划照常出。
    return null
  }
}

/**
 * 探测「能不能确认上游钉的 torch 版本在本机后端上可用」。
 *
 * 与 suggestTorchUpgrade 的区别：那个只报「确定不可用」，
 * 这个把「没能确认」也报出来。两者一起用，界面才能区分：
 *   ① 确认不可用 ⇒ 弹窗问要不要升级（或者说明换版本也解决不了）；
 *   ② 没能确认（网络不通、index 抓不到）⇒ 如实说「没确认」，
 *      并告诉使用者「装 Torch 那一项可以先跳过、自己装」。
 * ② 这一条不能省：探测不到就静默放行，使用者会撞上 uv 的原始报错，
 *   而那个报错看不出真因是版本与后端/ABI 不匹配。
 *
 * @param {object} input 与 suggestTorchUpgrade 相同
 * @returns {Promise<object|null>} null 表示「确认可用」或「与 torch 无关」
 */
async function probeTorchAvailability (input = {}) {
  const root = input.root || projectRoot()
  if (!root) return null
  const id = String(input.id || '')
  if (!id) return null
  const dir = engineDir(id, root)
  if (!fs.existsSync(dir)) return null

  // 上游没声明 torch 版本 ⇒ 与 torch 版本无关，不打扰使用者。
  const declaredTorch = readDeclaredTorchVersion(dir)
  if (!declaredTorch) return null

  const pythonVersion = readEnginePythonVersion(dir)
    ? readEnginePythonVersion(dir).version
    : PLATFORM_BASE_PYTHON
  let backend = input.backend
  if (!backend) {
    try {
      const hw = require('./hardware')
      const rec = hw.recommendBackend(hw.detectGpus())
      backend = rec && rec.recommended
    } catch (e) { backend = null }
  }
  if (!backend) return null
  // 没有官方 index 的后端无从比对，交给别处的检查报「这个后端装不了」。
  if (!BACKENDS_WITH_INDEX[backend]) return null

  let r = null
  try {
    r = await probeTorchVersion({
      dir, backend, pythonVersion,
      platform: process.platform, arch: process.arch,
      timeoutMs: 15000,
    })
  } catch (e) { r = null }
  if (r && r.ok) return null
  if (r && r.reason === 'version-not-on-this-backend') return r
  if (r && r.reason === 'no-wheel-for-this-python') return r
  // 到这里就是「没能确认」：抓不到 index 或抓到的内容没法判断。
  return {
    ok: false,
    backend,
    pythonVersion,
    declared: declaredTorch.version,
    declaredSource: declaredTorch.source,
    available: [],
    reason: 'could-not-check',
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
  // torch 版本与本机后端的匹配探测（异步，给出升级建议）
  suggestTorchUpgrade,
  // 同一件事的完整版：连「没能确认」也报出来（探测失败时不静默放行）
  probeTorchAvailability,
}
