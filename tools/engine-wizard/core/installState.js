'use strict'
const fs = require('node:fs')
const path = require('node:path')

/** 进度文件名（env 与 models 两段合并在同一个文件里） */
const INSTALL_FILE = '.wizard-install.json'

function progressFile (root, id) {
  return path.join(root, 'engines', String(id || ''), INSTALL_FILE)
}


function readProgress (root, id, section) {
  const sec = section === 'models' ? 'models' : 'env'
  const f = progressFile(root, id)
  try {
    if (!fs.existsSync(f)) return new Set()
    const data = JSON.parse(fs.readFileSync(f, 'utf8'))
    // 记录里写的引擎与本次要装的不是同一台 ⇒ 整段作废。
    //   目录被挪过、文件被复制过、id 改过名时会出现这种错配；
    //   继承别人的完成记录会让本步被跳过，而产物并不存在。
    if (data && data.engine && String(data.engine) !== String(id)) return new Set()
    const list = data && data[sec] && data[sec].done
    if (Array.isArray(list)) return new Set(list.map((d) => d.key))
  } catch (e) { /* 损坏的进度文件 ⇒ 从头来 */ }
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
  } catch (e) { /* 损坏的旧文件 ⇒ 从头建（不清另一段：已经读不出来了） */ }
  const at = new Date().toISOString()
  data.engine = id
  data.updatedAt = at
  data[sec] = { done: [...doneKeys].map((key) => ({ key, at })) }
  try {
    // 目录可能还没建（引擎目录被删过、或首次写入）：先建再写。
    //   不建的话 writeFileSync 抛 ENOENT，被下面的 catch 吞掉，
    //   表现为「进度永远无法写入、每次都从头执行」。
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) { /* 进度文件写不进不该拦住安装 */ }
}

/**
 * 清空进度：从头重装的语义。
 *
 * @param {'env'|'models'|'all'} section 默认只清调用方自己那一段。
 *        不清源码、不删已装依赖、不删模型文件：那是另一回事（删目录），
 *        这里只清「哪些步骤算做完了」这份记录。
 */
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
    } catch (e) { /* 损坏 ⇒ 按空文件处理 */ }
    if (sec === 'all') { data.env = { done: [] }; data.models = { done: [] } } else if (sec) data[sec] = { done: [] }
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

/** 目录在，且不是一个空壳（clone 完至少有一个条目） */
function dirHasContent (dir) {
  try {
    if (!fs.existsSync(dir)) return false
    return fs.readdirSync(dir).length > 0
  } catch (e) { return false }
}

/** manifest.json 在不在（且能 parse 成对象） */
function manifestPresent (dir) {
  const mf = path.join(dir, 'manifest.json')
  try {
    if (!fs.existsSync(mf)) return false
    return typeof JSON.parse(fs.readFileSync(mf, 'utf8')) === 'object'
  } catch (e) { return false }
}

/** engines/<id>/checkpoints 下有没有非空文件 */
function weightsOnDisk (root, id) {
  const dir = path.join(root, 'engines', String(id || ''), 'checkpoints')
  try {
    if (!fs.existsSync(dir)) return null          // 目录都没有 ⇒ 说不出来
    const files = fs.readdirSync(dir).filter((f) => {
      try { return fs.statSync(path.join(dir, f)).isFile() } catch (e) { return false }
    })
    if (files.length === 0) return null
    // 不完整的文件（大小 0）也算「有东西但不完整」⇒ 仍报 true（查过了），
    // 完不完整由第 3 步自己的逐文件校验说，不在这里重复判一遍。
    return files.some((f) => {
      try { return fs.statSync(path.join(dir, f)).size > 0 } catch (e) { return false }
    })
  } catch (e) { return null }
}

/**
 * 「装到哪了」的完整快照。
 *
 * @param {string} root 项目根
 * @param {string} id   引擎 id
 * @param {{spawnProbe?:(id:string)=>boolean}} [deps] 注入 venv 探针
 *        为什么可注入：canUseEngineVenv 会真的 spawn python，而单测
 *          不能真起解释器 ⇒ 测试注入一个假的，产物判据本身不变。
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
  const envOk = hasClone ? !!probe(id) : false
  const weights = hasClone ? weightsOnDisk(root, id) : null
  const manifestOk = hasClone ? manifestPresent(dir) : false
  // verify 恒 false：这一步的检测逻辑尚未实现（见 editor/StepVerify.jsx 头部），
  //   而「没有实现」不能被伪装成对勾。
  const verified = false
  const steps = {
    prepare: { done: hasClone, why: hasClone ? 'cloned' : 'missing' },
    env: { done: envOk, why: hasClone ? (envOk ? 'venv-spawns' : 'venv-unusable') : 'missing' },
    // models 是三态：true=齐了 · false=缺了 · null=说不出来。
    //   ⇒ done（喂给 steps.js 的 stepDone）在 true/false 两种下都为真：
    //     stepDone('models') 判的就是 weightsReady===true || weightsReady===false
    //：「确实缺了」也算查过了。null（说不出来）才不算做完。
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
  return { ok: true, id, steps, steps_done, artifacts: { engineDir: dir, hasClone, envOk, weights, manifestOk } }
}

module.exports = {
  INSTALL_FILE,
  progressFile,
  readProgress,
  writeProgress,
  resetProgress,
  installState,
  dirHasContent,
  manifestPresent,
  weightsOnDisk,
}
