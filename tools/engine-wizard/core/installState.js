'use strict'

// 引擎安装进度：读写真实的完成记录，并汇总「装到哪了」的五步快照。
// 进度按引擎 id 存在 engines/<id>/.wizard-install.json，env 段与 models 段的完成记录合并在这一个文件里。
// 只认磁盘上的产物：记录里的引擎 id 与本次不一致、或文件损坏时整段作废，不继承别的引擎的完成记录。

const fs = require('node:fs')
const path = require('node:path')

// 权重落盘路径只有一处答案：core/checkpointsPath.js。
const { checkpointsAbsPath, resolveCheckpointsRel } = require('./checkpointsPath')

// 进度文件名。
const INSTALL_FILE = '.wizard-install.json'

function progressFile (root, id) {
  return path.join(root, 'engines', String(id || ''), INSTALL_FILE)
}

// 第 2 步的执行结果。venv 的 python 能启动不等于依赖装齐：
//   uv 会先建好 .venv 再解析依赖，解析或构建失败时目录仍在。
//   只靠 canUseEngineVenv 会把失败的安装报成「已完成」。
function envFailure (root, id) {
  const f = progressFile(root, id)
  try {
    if (!fs.existsSync(f)) return null
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (d && d.engine && String(d.engine) !== String(id)) return null
    return d && d.envFailure && d.envFailure.ok === false ? d.envFailure : null
  } catch (e) { return null }
}

// 第 2 步正在执行的标记。venv 一旦建好解释器就能启动，但依赖仍在安装；
//   没有这个标记，安装尚未结束时状态会先报「已完成」。标记带时间戳，
//   超过两小时视为过期，避免进程被强制结束后永久停在「进行中」。
const ENV_RUNNING_TTL_MS = 2 * 60 * 60 * 1000

function envRunning (root, id) {
  const f = progressFile(root, id)
  try {
    if (!fs.existsSync(f)) return null
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!d || (d.engine && String(d.engine) !== String(id))) return null
    const r = d.envRunning
    if (!r || !r.at) return null
    const at = Date.parse(r.at)
    if (!Number.isFinite(at) || Date.now() - at > ENV_RUNNING_TTL_MS) return null
    return r
  } catch (e) { return null }
}

function markEnvRunning (root, id, on) {
  const f = progressFile(root, id)
  let data = {}
  try {
    if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8')) || {}
  } catch (e) { data = {} }
  if (data.engine && String(data.engine) !== String(id)) data = {}
  data.engine = id
  data.updatedAt = new Date().toISOString()
  if (on) data.envRunning = { at: new Date().toISOString() }
  else delete data.envRunning
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) { /* 进度写不进不拦住安装 */ }
}

function markEnvResult (root, id, result) {
  const f = progressFile(root, id)
  let data = {}
  try {
    if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8')) || {}
  } catch (e) { data = {} }
  if (data.engine && String(data.engine) !== String(id)) data = {}
  data.engine = id
  data.updatedAt = new Date().toISOString()
  delete data.envRunning
  if (result && result.ok === true) delete data.envFailure
  else data.envFailure = {
    ok: false,
    code: (result && result.code) || 'ENV_FAILED',
    at: new Date().toISOString(),
  }
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) { /* 进度写不进不拦住安装 */ }
}


function readProgress (root, id, section) {
  const sec = section === 'models' ? 'models' : 'env'
  const f = progressFile(root, id)
  try {
    if (!fs.existsSync(f)) return new Set()
    const data = JSON.parse(fs.readFileSync(f, 'utf8'))
    // 记录里的引擎 id 与本次要装的不是同一台时整段作废：目录被挪过或 id 改过名都会造成这种错配，
    // 继承别人的完成记录会让这一步被跳过，而产物并不存在。
    if (data && data.engine && String(data.engine) !== String(id)) return new Set()
    const list = data && data[sec] && data[sec].done
    if (Array.isArray(list)) return new Set(list.map((d) => d.key))
  } catch (e) { /* 进度文件损坏 ⇒ 当作没有进度 */ }
  return new Set()
}


function writeProgress (root, id, section, doneKeys) {
  const sec = section === 'models' ? 'models' : 'env'
  const f = progressFile(root, id)
  let data = { engine: id, updatedAt: new Date().toISOString(), env: { done: [] }, models: { done: [] } }
  try {
    if (fs.existsSync(f)) {
      const prev = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (prev && typeof prev === 'object') {
        data = { ...data, ...prev }
        data.env = prev.env && Array.isArray(prev.env.done) ? prev.env : { done: [] }
        data.models = prev.models && Array.isArray(prev.models.done) ? prev.models : { done: [] }
      }
    }
  } catch (e) { /* 旧的进度文件损坏 ⇒ 从头建，不清另一段（那一段已经读不出来了） */ }
  const at = new Date().toISOString()
  data.engine = id
  data.updatedAt = at
  data[sec] = { done: [...doneKeys].map((key) => ({ key, at })) }
  try {
    // 先建目录再写：引擎目录可能还不存在（首次写入或目录被删过），
    // 不建目录时 writeFileSync 抛 ENOENT 并被下面的 catch 吞掉，表现为进度永远写不进、每次都从头执行。
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) { /* 进度写不进不拦住安装 */ }
}

// 清空进度，语义是「这一步从头重装」。
// section 取 'env' | 'models' | 'all'，默认只清调用方自己那一段。
// 只清「哪些步骤算做完了」这份记录：不清源码、不删已装依赖、不删模型文件，那些是删目录的事。
function resetProgress (root, id, section) {
  const f = progressFile(root, id)
  const clear = (sec) => {
    let data = { engine: id, updatedAt: new Date().toISOString(), env: { done: [] }, models: { done: [] } }
    try {
      if (fs.existsSync(f)) {
        const prev = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (prev && typeof prev === 'object') {
          data = { ...data, ...prev }
          data.env = prev.env && Array.isArray(prev.env.done) ? prev.env : { done: [] }
          data.models = prev.models && Array.isArray(prev.models.done) ? prev.models : { done: [] }
        }
      }
    } catch (e) { /* 旧文件损坏 ⇒ 按空文件处理 */ }
    if (sec === 'all') { data.env = { done: [] }; data.models = { done: [] } } else if (sec) data[sec] = { done: [] }
    if (sec === 'all' || sec === 'env') delete data.envFailure
    if (sec === 'all' || sec === 'env') delete data.envRunning
    data.engine = id
    data.updatedAt = new Date().toISOString()
    return data
  }
  const sec = section === 'models' ? 'models' : section === 'all' ? 'all' : 'env'
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(clear(sec), null, 2), 'utf8')
  } catch (e) { /* 写不进就当已经清了 */ }
}

// 目录存在，且不是一个空壳（克隆完成后至少有一个条目）。
function dirHasContent (dir) {
  try {
    if (!fs.existsSync(dir)) return false
    return fs.readdirSync(dir).length > 0
  } catch (e) { return false }
}

// manifest.json 存在，且能解析成对象。
function manifestPresent (dir) {
  const mf = path.join(dir, 'manifest.json')
  try {
    if (!fs.existsSync(mf)) return false
    return typeof JSON.parse(fs.readFileSync(mf, 'utf8')) === 'object'
  } catch (e) { return false }
}

// 名片原文：权重落点以它为准（runtime.checkpoints）。读不到返回 null。
function readManifest (dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch (e) { return null }
}

// checkpoints 下的模型文件，递归列举（含子目录）。
// 权重不一定摊在顶层：有的引擎一层目录套一层（LLM/、BiCodec/ 各占一个子目录），
//   只看顶层会把这类引擎判成「目录在、文件没有」。
// rel 是名片声明的落点（相对项目根）；不传则用统一落点。
// 返回相对 checkpoints 的正斜杠路径；目录不存在或读不到 ⇒ 空数组。
// 隐藏目录（.git / .cache 这类）不进去：那是下载工具的元数据，不是权重。
function listModelFiles (root, id, rel) {
  const dir = rel ? path.join(root, rel) : checkpointsAbsPath(root, id)
  const out = []
  if (!dir) return out
  const walk = (d, rel, depth) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue
        // 深度封顶是防环（循环符号链接造出的假目录树），不是业务限制：
        //   权重目录没有深过这个的，真到了这一层说明目录结构已经不对。
        if (depth >= 8) continue
        walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1)
      } else if (e.isFile()) {
        out.push(rel ? `${rel}/${e.name}` : e.name)
      }
    }
  }
  walk(dir, '', 0)
  return out
}

// checkpoints 下有没有非空文件。返回 null 表示无法判定（目录不存在或无法读取）。
function weightsOnDisk (root, id, rel) {
  const dir = rel ? path.join(root, rel) : checkpointsAbsPath(root, id)
  if (!dir) return null
  const files = listModelFiles(root, id, rel)
  if (files.length === 0) return null          // 目录都没有或一个文件都没有 ⇒ 说不出来
  // 大小为 0 的文件也算「查过了」：确实缺了还是文件不完整，由下载那一步自己逐文件校验，
  // 这里不重复判一遍。
  return files.some((f) => {
    try { return fs.statSync(path.join(dir, f)).size > 0 } catch (e) { return false }
  })
}

/**
 * 「装到哪了」的完整快照。返回五步各自的完成状态与判据。
 *
 * @param {string} root 项目根
 * @param {string} id   引擎 id
 * @param {{spawnProbe?:(id:string)=>boolean}} [deps] 注入 venv 探针。
 *        默认探针会真的 spawn python，单测不能真起解释器，所以由测试注入一个假的，
 *        产物判据本身不变。
 * @returns {{ok:true, steps:{[k:string]:{done:boolean, why:string}},
 *            steps_done:{[k:string]:boolean}, artifacts:object}}
 */
function installState (root, id, deps = {}) {
  const probe = typeof deps.spawnProbe === 'function'
    ? deps.spawnProbe
    : (rid) => {
        try {
          const { canUseEngineVenv } = require('./env')
          return canUseEngineVenv(root, rid)
        } catch (e) { return false }
      }
  const dir = path.join(root, 'engines', String(id || ''))
  const hasClone = dirHasContent(dir)
  // 权重落点以名片为准：旧名片可能写在 models/tts/<id>，与统一落点不同。
  //   两套口径（这一步按统一落点、第 5 步按名片）会给出相反结论。
  const manifest = hasClone ? readManifest(dir) : null
  const weightRel = resolveCheckpointsRel(manifest, id)
  const failure = hasClone ? envFailure(root, id) : null
  const running = hasClone ? envRunning(root, id) : null
  const venvSpawns = hasClone ? !!probe(id) : false
  const envOk = venvSpawns && !failure && !running
  const envWhy = !hasClone ? 'missing'
    : running ? 'install-running'
      : failure ? `install-failed:${failure.code || 'ENV_FAILED'}`
        : (venvSpawns ? 'venv-spawns' : 'venv-unusable')
  const weights = hasClone ? weightsOnDisk(root, id, weightRel) : null
  const manifestOk = hasClone ? manifestPresent(dir) : false
  // verify 恒为 false：这一步没有对应的产物判据，未实现不能算做过。
  const verified = false
  const steps = {
    prepare: { done: hasClone, why: hasClone ? 'cloned' : 'missing' },
    env: { done: envOk, why: envWhy },
    // models 是三态：true=齐了 · false=缺了 · null=说不出来。
    //   done 在 true 与 false 两种下都为真：「确实缺了」也算查过了；
    //   只有 null（说不出来）不算做完。
    models: {
      done: weights !== null,
      ready: weights,
      why: weights === null ? 'unknown' : (weights ? 'present' : 'empty'),
    },
    manifest: { done: manifestOk, why: manifestOk ? 'present' : 'missing' },
    verify: { done: verified, why: 'not-implemented' },
  }
  const steps_done = Object.fromEntries(
    Object.entries(steps).map(([k, v]) => [k, v.done === true]))
  // 权重落盘的相对路径（相对项目根）：第 4 步的名片要填 runtime.checkpoints，
  //   填的就是这个值。第 3 步写盘、第 5 步判断、第 4 步声明，三处同源。
  const checkpointsPath = weightRel
  // 盘上实际有哪些模型文件：第 4 步的 models.required 自动填就照这份清单
  //   （下过什么就声明什么，不猜）。为空（没下或读不到）时前端自己会停。
  const modelFiles = hasClone ? listModelFiles(root, id, weightRel) : []
  return {
    ok: true,
    id,
    steps,
    steps_done,
    checkpoints_path: checkpointsPath,
    model_files: modelFiles,
    artifacts: {
      engineDir: dir,
      hasClone,
      envOk,
      envFailure: failure,
      envRunning: running,
      weights,
      manifestOk,
      checkpointsDir: weightRel ? path.join(root, weightRel) : null,
    },
  }
}

module.exports = {
  INSTALL_FILE,
  progressFile,
  readProgress,
  writeProgress,
  resetProgress,
  installState,
  markEnvResult,
  markEnvRunning,
  envRunning,
  dirHasContent,
  manifestPresent,
  weightsOnDisk,
  listModelFiles,
}
