'use strict'
// ============================================================================
//  INSTALL STATE —— 「这台引擎现在装到哪了」的**唯一判据来源**
//
//  ⭐ 存在理由：完成状态（流程条上的对勾）只由**真实产物**判，⛔ 不由
//    「用户点过什么」判。点过下一步不等于做完 —— 实际可能压根没解析成功。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
//   这个模块给**任意**上游用；写死任何一个名字，另一台就判不出来。
//
//  ⭐ 与 steps.js 的关系：这里是 stepDone(stepKey, facts) 里那份 facts 的
//    生产端 —— 前端拿 install-state 端点的返回直接喂 stepDone，两边同源，
//    ⛔ 不许在别处再写第二份「装好没有」的判据。
// ============================================================================

const fs = require('node:fs')
const path = require('node:path')

/** 进度文件名（env 与 models 两段合并在同一个文件里） */
const INSTALL_FILE = '.wizard-install.json'

/**
 * 进度文件路径 —— engines/<id>/.wizard-install.json
 *
 * ⭐ 2026-10-12 Owner 裁决合并：原来是两份形状相同的文件
 *   .wizard-env-progress.json（env.js）与 .wizard-download-progress.json
 *   （download.js），已退役。Owner 会手动清一次旧文件，所以这里无需
 *   向后兼容，⛔ 也不再写那两个旧名字。
 */
function progressFile (root, id) {
  return path.join(root, 'engines', String(id || ''), INSTALL_FILE)
}

/**
 * 读进度文件 —— 形状 `{ engine, updatedAt, env:{done:[]}, models:{done:[]} }`
 *
 * @param {'env'|'models'} section 两段互不干扰：env 的 done 与 models 的 done
 *        是两套 key（前者是 argv，后者也是 argv，但属于两条不同的安装线）。
 * @returns {Set<string>} 已完成的 key 集合
 */
function readProgress (root, id, section) {
  const sec = section === 'models' ? 'models' : 'env'
  const f = progressFile(root, id)
  try {
    if (!fs.existsSync(f)) return new Set()
    const data = JSON.parse(fs.readFileSync(f, 'utf8'))
    const list = data && data[sec] && data[sec].done
    if (Array.isArray(list)) return new Set(list.map((d) => d.key))
  } catch (e) { /* 损坏的进度文件 ⇒ 从头来 */ }
  return new Set()
}

/**
 * 写进度文件 —— **只改自己那一段**，另一段原样保留。
 *
 * ⛔ 不许整份重写：env 写盘时把 models 的 done 抹掉，反过来也是。
 *   两段各自独立，所以每次都是 read-modify-write 单段。
 */
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
  } catch (e) { /* 损坏的旧文件 ⇒ 从头建（⛔ 不清另一段：已经读不出来了） */ }
  const at = new Date().toISOString()
  data.engine = id
  data.updatedAt = at
  data[sec] = { done: [...doneKeys].map((key) => ({ key, at })) }
  try {
    fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) { /* 进度文件写不进不该拦住安装 */ }
}

/**
 * 清空进度 —— 从头重装的语义。
 *
 * @param {'env'|'models'|'all'} section 默认只清调用方自己那一段。
 *        ⛔ 不清源码、不删已装依赖、不删模型文件：那是另一回事（删目录），
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
    fs.writeFileSync(f, JSON.stringify(clear(sec), null, 2), 'utf8')
  } catch (e) { /* 写不进就当已经清了 */ }
}

// ---------------------------------------------------------------------------
//  ⭐ 产物判定 —— 「这台引擎现在装到哪了」
//
//  判据全部是**盘上的东西**：
//    prepare   → engines/<id>/ 是不是一个真克隆（目录在 + 有内容）
//    env       → 该引擎 .venv 的 python 能不能 spawn
//    models    → checkpoints 目录在不在 + 里面有没有非空文件
//    manifest  → manifest.json 在不在
//    verify    → 不猜：这一步的检测逻辑尚未实现，恒 false
//
//  ⛔ 这里不许写死任何引擎名；⛔ 不许读 localStorage（那是前端的事）。
// ---------------------------------------------------------------------------

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
    // 半截文件（大小 0）也算「有东西但不完整」⇒ 仍报 true（查过了），
    // 完不完整由第 3 步自己的逐文件校验说，⛔ 不在这里重复判一遍。
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
 *        ⭐ 为什么可注入：canUseEngineVenv 会真的 spawn python，而单测
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
  // ⛔ verify 恒 false：这一步的检测逻辑尚未实现（见 editor/StepVerify.jsx 头部），
  //   而「没有实现」不能被伪装成对勾。
  const verified = false
  const steps = {
    prepare: { done: hasClone, why: hasClone ? 'cloned' : 'missing' },
    env: { done: envOk, why: hasClone ? (envOk ? 'venv-spawns' : 'venv-unusable') : 'missing' },
    // ⭐ models 是三态：true=齐了 · false=缺了 · null=说不出来。
    //   ⇒ done（喂给 steps.js 的 stepDone）在 true/false 两种下都为真：
    //     stepDone('models') 判的就是 weightsReady===true || weightsReady===false
    //     —— 「确实缺了」也算查过了。null（说不出来）才不算做完。
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
