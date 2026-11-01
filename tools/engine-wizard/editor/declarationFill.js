// 名片声明的兜底自动填：models.required 与 runtime.verify。
// 判定与填值都是纯函数（与 manifestAutoFill.js 同一层），
// 抽出来是因为「该不该填」的边界塞在 React effect 里只能靠点界面验，
// 而点界面验不到「不该填的时候没填」。
//
// 为什么这两格要兜底：runtime.checkpoints 说的是「权重放哪」，
//   models.required 说的是「哪几个文件算齐」，runtime.verify 说的是
//   「拿这台引擎的解释器 import 哪些模块」。
//   后两格空着时，平台只能说「目录在不在」，说不出「齐不齐」「起不起得来」
//   （checkpoints.js 的 ready:null 与 env_deep 无 spec）。
//   兜底的素材不靠猜：models.required 照第 3 步实际下到盘上的文件，
//   verify.imports 照 call 段已经定下的模块。只有 sys_path 是按
//   「克隆根」猜的（src 布局的引擎要把源码目录改进来），
//   猜的那一格在界面上标黄（FILL_NOTES）。

// 不算权重的文件：仓库说明、许可证、校验和、下载工具残留。
// 只剔「 Provably 不是权重」的：README / LICENSE 这类文档名、
//   校验和文件、锁文件、点开头的隐藏文件。
// 不按扩展名乱剔：.txt / .json / .yaml 在权重目录里可能是
//   词表或配置（有的引擎把它们算进 required），剔了反而让平台说「缺」。
const NOT_MODEL_PATTERNS = [
  /^readme/i, /^licen[cs]e/i, /^notice/i, /^changelog/i, /^changes/i,
  /^authors/i, /^citation/i, /^code_of_conduct/i, /^contributing/i,
  /^checksums?/i, /^md5sums?/i, /^sha\d*sums?/i,
  /\.md5$/i, /\.sha256$/i, /\.sha512$/i, /\.lock$/i,
  /\.md$/i, /\.rst$/i,
  /thumbs\.db$/i,
]

function isModelFile (relPath) {
  const name = relPath.split('/').pop()
  if (!name || name.startsWith('.')) return false
  return !NOT_MODEL_PATTERNS.some((re) => re.test(name))
}

/**
 * 把盘上的文件清单折成 models.required 的候选：剔杂质、排序。
 *
 * @param {string[]} files 相对 checkpoints 的正斜杠路径（installState.model_files）
 * @returns {string[]} 可写进 models.required 的路径列表（原数组不动）
 */
export function requiredFromFiles (files) {
  if (!Array.isArray(files)) return []
  return files.filter(isModelFile).slice().sort()
}

/**
 * 从 call 段推出 verify.imports 该点名的模块。
 *
 * python 形态直接读 call.module；cli 形态找 argv 里的 -m 目标。
 *   两者都没有（cli 直接跑脚本文件、或 call 段还没填）时返回 null，
 *   那就填不了 imports，不硬猜。
 *
 * @param {object} manifest 当前名片
 * @returns {string|null} 模块名；推不出来则 null
 */
export function verifyModuleFromCall (manifest) {
  const call = (manifest && manifest.call) || {}
  const kind = call.kind || 'python'
  if (kind === 'python') {
    return typeof call.module === 'string' && call.module ? call.module : null
  }
  if (kind === 'cli' && Array.isArray(call.argv)) {
    const i = call.argv.indexOf('-m')
    if (i >= 0 && i + 1 < call.argv.length) {
      const m = call.argv[i + 1]
      if (typeof m === 'string' && m) return m
    }
  }
  return null
}

// ---- models.required ----

/**
 * 该不该把 models.required 填成盘上文件的清单。
 *
 * 该填：引擎 id 定了（否则 required 与这台引擎无关）、盘上有可声明的文件、
 *   且这一格空着（没声明过）。
 * 不该填：使用者声明过（哪怕只写了一个文件，那也是他的判断，不许覆盖）。
 *
 * @param {object} manifest 当前名片
 * @param {string[]} files installState 送来的盘上文件清单
 * @returns {boolean} 该填就 true
 */
export function shouldFillModelsRequired (manifest, files) {
  if (!manifest || !manifest.id) return false
  if (requiredFromFiles(files).length === 0) return false
  const cur = (manifest.models && manifest.models.required) || []
  return !Array.isArray(cur) || cur.length === 0
}

/**
 * 填上 models.required。调用前先问 shouldFillModelsRequired。
 *
 * @param {object} manifest 当前名片
 * @param {string[]} required 盘上文件折成的清单（requiredFromFiles 的返回）
 * @returns {object} 填好的新名片（原对象不动）
 */
export function withModelsRequired (manifest, required) {
  const m = (manifest && manifest.models) || {}
  return { ...manifest, models: { ...m, required } }
}

// ---- runtime.verify.sys_path ----

/**
 * 该不该把 verify.sys_path 填成引擎克隆根（engines/<id>）。
 *
 * sys_path 是「宿主与校验都从哪加载这台引擎的模块」：
 *   envCheck 的 shallow 会要求每个路径在盘上存在，克隆根天然存在。
 * 注意这一格是**猜的**（界面标黄）：源码在 src/ 子目录的引擎
 *   要把它改成 engines/<id>/src，平台没法替引擎决定它的源码布局。
 *
 * @param {object} manifest 当前名片
 * @returns {boolean} 该填就 true
 */
export function shouldFillVerifySysPath (manifest) {
  if (!manifest || !manifest.id) return false
  const v = (manifest.runtime && manifest.runtime.verify) || {}
  return !Array.isArray(v.sys_path) || v.sys_path.length === 0
}

/**
 * 填上 verify.sys_path。调用前先问 shouldFillVerifySysPath。
 *
 * @param {object} manifest 当前名片（id 已定）
 * @returns {object} 填好的新名片（原对象不动）
 */
export function withVerifySysPath (manifest) {
  const rt = (manifest && manifest.runtime) || {}
  const v = rt.verify || {}
  return {
    ...manifest,
    runtime: { ...rt, verify: { ...v, sys_path: [`engines/${manifest.id}`] } },
  }
}

// ---- runtime.verify.imports ----

/**
 * 该不该把 verify.imports 填成 [{module}]（module-only，env_probe 认）。
 *
 * 该填：call 段推得出模块、且这一格空着。
 * 不该填：使用者或扫描已经写过 imports（非空就不覆盖）。
 *
 * @param {object} manifest 当前名片
 * @returns {boolean} 该填就 true
 */
export function shouldFillVerifyImports (manifest) {
  if (!verifyModuleFromCall(manifest)) return false
  const v = (manifest && manifest.runtime && manifest.runtime.verify) || {}
  return !Array.isArray(v.imports) || v.imports.length === 0
}

/**
 * 填上 verify.imports。调用前先问 shouldFillVerifyImports。
 *
 * @param {object} manifest 当前名片（call 段已有模块名）
 * @returns {object} 填好的新名片（原对象不动）
 */
export function withVerifyImports (manifest) {
  const module = verifyModuleFromCall(manifest)
  if (!module) return manifest
  const rt = (manifest && manifest.runtime) || {}
  const v = rt.verify || {}
  return {
    ...manifest,
    runtime: { ...rt, verify: { ...v, imports: [{ module }] } },
  }
}

// ---- 合起来：一个 effect 填完 verify 段 ----

/**
 * verify 段任一格还能填（sys_path 或 imports）就 true。
 *
 * @param {object} manifest 当前名片
 * @returns {boolean}
 */
export function shouldFillVerify (manifest) {
  return shouldFillVerifySysPath(manifest) || shouldFillVerifyImports(manifest)
}

/**
 * 把 verify 段缺的格补上（各自先问各自的 should，互不影响）。
 *
 * @param {object} manifest 当前名片
 * @returns {object} 补好的新名片（原对象不动；一格都补不了时原样返回）
 */
export function withAutoFilledVerify (manifest) {
  let next = manifest
  if (shouldFillVerifySysPath(next)) next = withVerifySysPath(next)
  if (shouldFillVerifyImports(next)) next = withVerifyImports(next)
  return next
}

// ---- 界面呈现：每一格自动填的置信度与说法 ----
//
// 平台猜可以，但猜的时候要说自己是猜的（确定=绿，猜的=黄）：
//   certain（确定）⇒ badge-ok 绿；guess（猜的）⇒ badge-warn 黄。
// models.required 照盘上实际文件填：下过什么填什么，确定。
// verify.imports 与 call 同一个模块：call 是扫描/使用者定下的，确定。
// verify.sys_path 按克隆根猜：对「包就在根目录」的引擎对，
//   对 src 布局的引擎错，所以要人确认。
export const FILL_NOTES = Object.freeze({
  models_required: {
    level: 'certain',
    en: 'models.required: filled from the files actually downloaded in step 3',
    zh: 'models.required：按第 3 步实际下到盘上的文件填的（下过什么填什么）',
  },
  verify_imports: {
    level: 'certain',
    en: 'runtime.verify.imports: same module as the call section',
    zh: 'runtime.verify.imports：与 call 段同一个模块（call 定了它就跟着定）',
  },
  verify_sys_path: {
    level: 'guess',
    en: 'runtime.verify.sys_path: guessed as the engine clone root; change it if the source lives under a subdirectory (e.g. src/)',
    zh: 'runtime.verify.sys_path：按引擎克隆根猜的；源码在子目录（如 src/）的引擎要改',
  },
})

/**
 * 当前名片里有哪几格处在「自动填出来的形状」，各该标什么置信度。
 *
 * 只按**当前值**判，不记「是不是平台刚才填的」：值还等于填出来的那个形状，
 *   就值得标（说明这一格的来历与把握）；使用者改走了就不标，
 *   那已经是他自己的判断，平台不再替他担保。
 *
 * @param {object} manifest 当前名片
 * @param {string[]} files installState 送来的盘上文件清单
 * @returns {{key:string, level:string, en:string, zh:string}[]} 要标出来的条目
 */
export function describeFilledNotes (manifest, files) {
  const out = []
  if (!manifest || !manifest.id) return out
  // models.required 与盘上清单一致（集合相等，顺序不重要）
  const required = (manifest.models && manifest.models.required) || []
  const fromDisk = requiredFromFiles(files)
  if (Array.isArray(required) && required.length > 0 && fromDisk.length > 0 &&
      required.slice().sort().join('\n') === fromDisk.join('\n')) {
    out.push({ key: 'models_required', ...FILL_NOTES.models_required })
  }
  // verify.imports 只有一条、模块与 call 段一致
  const v = (manifest.runtime && manifest.runtime.verify) || {}
  const module = verifyModuleFromCall(manifest)
  if (module && Array.isArray(v.imports) && v.imports.length === 1 &&
      v.imports[0] && v.imports[0].module === module) {
    out.push({ key: 'verify_imports', ...FILL_NOTES.verify_imports })
  }
  // verify.sys_path 还是克隆根（改走了就不标：使用者已经处理过这一格）
  if (Array.isArray(v.sys_path) && v.sys_path.length === 1 &&
      v.sys_path[0] === `engines/${manifest.id}`) {
    out.push({ key: 'verify_sys_path', ...FILL_NOTES.verify_sys_path })
  }
  return out
}
