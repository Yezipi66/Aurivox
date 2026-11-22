// 名片声明的兜底自动填：models.required 与 runtime.verify.sys_path。
// 判定与填值都是纯函数（与 manifestAutoFill.js 同一层），
// 抽出来是因为「该不该填」的边界塞在 React effect 里只能靠点界面验，
// 而点界面验不到「不该填的时候没填」。
//
// 为什么这两格要兜底：runtime.checkpoints 说的是「权重放哪」，
//   models.required 说的是「哪几个文件算齐」，verify.sys_path 说的是
//   「导入之前把哪个目录加进 sys.path」。
//   空着时，平台只能说「目录在不在」，说不出「齐不齐」「起不起得来」
//   （checkpoints.js 的 ready:null 与 env_deep 无 spec）。
//   兜底的素材不靠猜：models.required 照第 3 步实际下到盘上的文件，
//   sys_path 按「克隆根」猜（src 布局的引擎要把源码目录改进来），
//   猜得对不对不靠界面提示：第 5 步「引擎模块可导入」会报告实际结果。
//   verify.imports 不兜底：它是静态声明，入口模块由检查侧在读取时现算。

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
  // 下载中间态：平台自己的下载器先写 `<正式文件名>.tmp`，下完才改名。
  //   下载进行中取快照时它是盘上唯一那个文件，写进 required 就变成
  //   「声明了一个下完就消失的名字」，第 5 步必然报缺。
  /\.(tmp|part|partial|crdownload)$/i,
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

// verify.imports 不在这里自动填。它是名片里的静态声明：写进来就代表使用者
//   额外要求验某个模块/类/方法。把它当作推理入口的副本写进去，等于在静态
//   名片里存一份派生值，入口一改副本就过期，还会被第 5 步当成独立事实去 import。
//   入口模块由检查侧在读取时现算（lib/engines/envCheck.js），不落盘。
//
// ---- models.required ----

/**
 * 从盘上文件快照里取文件清单。
 *
 * 快照的形状是 `{ id, files }`：install-state 回报的文件清单必须与
 *   它是按哪个引擎问来的一起存。换引擎的那一瞬，清单还是上一台的，
 *   光看一个数组分不出归属（ZipVoice 的名片因此写进过 66 个 Kokoro 文件名）。
 * 数组形状只认作「没有身份的清单」，供只取文件的界面调用；
 *   要不要据此写名片由 shouldFillModelsRequired 判。
 *
 * @param {{id?: string, files?: string[]}|string[]|null} snapshot
 * @returns {string[]} 文件清单（形状不对给空数组）
 */
export function modelFilesOf (snapshot) {
  if (Array.isArray(snapshot)) return snapshot
  if (snapshot && Array.isArray(snapshot.files)) return snapshot.files
  return []
}

/**
 * 该不该把 models.required 填成盘上文件的清单。
 *
 * 该填：引擎 id 定了（否则 required 与这台引擎无关）、快照确实属于这台引擎、
 *   盘上有可声明的文件、且这一格空着（没声明过）。
 * 不该填：使用者声明过（哪怕只写了一个文件，那也是他的判断，不许覆盖）；
 *   快照是另一台的（换引擎时清完 models 的下一个渲染就会撞上这个），
 *   拿它填等于把上一台的文件名写进这一台的名片。
 *
 * @param {object} manifest 当前名片
 * @param {{id?: string, files?: string[]}|null} snapshot installState 送来的盘上文件快照
 * @returns {boolean} 该填就 true
 */
export function shouldFillModelsRequired (manifest, snapshot) {
  if (!manifest || !manifest.id) return false
  // 没有身份的清单不许用来写名片：唯一能证明「这份文件属于这台引擎」的
  //   是 install-state 回报里的 id，一个裸数组证明不了。
  if (!snapshot || Array.isArray(snapshot)) return false
  if (!snapshot.id || snapshot.id !== manifest.id) return false
  if (requiredFromFiles(snapshot.files).length === 0) return false
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
 * 注意这一格是**猜的**：源码在 src/ 子目录的引擎
 *   要把它改成 engines/<id>/src，平台没法替引擎决定它的源码布局。
 *   推测结果不由界面提示判定，第 5 步「引擎模块可导入」会报告实际结果。
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

// ---- 合起来：一个 effect 填 verify 段 ----

/**
 * verify 段还能填（眼下只有 sys_path 这一格）就 true。
 *
 * imports 不参与自动填：它是静态声明，不是推理入口的副本。
 *
 * @param {object} manifest 当前名片
 * @returns {boolean}
 */
export function shouldFillVerify (manifest) {
  return shouldFillVerifySysPath(manifest)
}

/**
 * 把 verify 段缺的格补上。
 *
 * @param {object} manifest 当前名片
 * @returns {object} 补好的新名片（原对象不动；补不了时原样返回）
 */
export function withAutoFilledVerify (manifest) {
  let next = manifest
  if (shouldFillVerifySysPath(next)) next = withVerifySysPath(next)
  return next
}
