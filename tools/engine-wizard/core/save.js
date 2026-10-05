'use strict'
// ============================================================================
//  SAVE —— 把填好的名片落盘
//
//  ⭐ 落盘规矩**照平台的，不自己发明**
//  · 位置：engines/<id>/manifest.json（lib/paths.js:236 ENGINES_DIR）
//  · ⛔ id 必须与目录名逐字相同，否则平台报 ENGINE_MANIFEST_ID_MISMATCH
//    （lib/engines/registry.js:59）—— 这里**提前拦**，不让用户存完才发现
//  · 目录必须已存在或有 _comment_* 说明 —— 平台有目录清点守卫盯着
//
//  ⛔⛔ 安全：⛔ 不许写到 engines/ 以外的任何地方。
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const fs = require('node:fs')
const path = require('node:path')

function repoRoot () {
  return path.resolve(__dirname, '..', '..', '..')
}

/** 合法的引擎 id：能当目录名，且不是平台保留的那些 */
const RESERVED = new Set(['_TEMPLATE', 'node_modules', '.git'])

function validateId (id) {
  if (typeof id !== 'string' || !id.trim()) {
    return 'id is required'
  }
  const s = id.trim()
  if (s !== id) return 'id must not have leading or trailing spaces'
  // 目录名的实际限制：不能有路径分隔符和 Windows 的非法字符
  if (/[\\/:*?"<>|]/.test(s)) {
    return 'id must not contain \\ / : * ? " < > | — those are not valid in a folder name'
  }
  if (RESERVED.has(s)) return `id "${s}" is reserved by the platform`
  if (s.startsWith('.')) return 'id must not start with a dot'
  return null
}

/**
 * 存一张名片。
 * @returns {{ok:boolean, path?:string, error?:string, code?:string}}
 */
function saveManifest (manifest, opts = {}) {
  const dryRun = opts.dryRun === true
  const enginesDir = opts.enginesDir || path.join(repoRoot(), 'engines')

  // ---- 1. 形状 ----
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, code: 'BAD_SHAPE', error: 'manifest must be a JSON object' }
  }

  // ---- 2. id（最常错的一项，先查）----
  const idErr = validateId(manifest.id)
  if (idErr) return { ok: false, code: 'BAD_ID', error: idErr }

  const id = manifest.id
  const dir = path.join(enginesDir, id)

  // ---- 3. ⛔ 不许写到 engines/ 之外 ----
  const rel = path.relative(enginesDir, dir)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'OUT_OF_SCOPE',
      error: 'refusing to write outside engines/' }
  }

  // ---- 4. 目录在不在 ----
  // ⛔ 平台不建目录：那是「只验不建」的一部分。
  //    但**我们**是开发工具，建目录是合理的 —— 这里如实说明建了什么。
  let createdDir = false
  if (!fs.existsSync(dir)) {
    if (opts.allowCreateDir === false) {
      return { ok: false, code: 'NO_DIR',
        error: `engines/${id}/ does not exist — create it first` }
    }
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true })
      createdDir = true
    }
  }

  const file = path.join(dir, 'manifest.json')

  // ---- 5. 已有文件 ⇒ 不覆盖，除非显式允许 ----
  const exists = fs.existsSync(file)
  if (exists && !opts.overwrite) {
    return { ok: false, code: 'EXISTS', path: file,
      error: `engines/${id}/manifest.json already exists — overwrite was not requested` }
  }

  // ---- 6. ⛔⛔ 注释键**原样保留** ----
  //  ⚠⚠ 这里曾写着「剥掉下划线开头的键（平台会剥）」—— **那是错的**。
  //
  //  真相比「平台会剥」更具体（2026-10-04 在四张已装名片上数过）：
  //  · **每一张**都有 _ 开头的键，少则十来个，多则二十出头
  //  · 上游作者靠它们写「权重放哪」「这段为什么这么写」——那是名片的**文档**
  //
  //  ⛔ 平台是在**读取时**剥（lib/engines/registry.js:56 stripComments），
  //    不是写入时剥。写盘时剥 ⇒ 「读回来再存一次」就把文档永久删了。
  //    （save.node.test.js 的往返用例抓到的就是这条）
  //
  //  ⇒ 写盘：逐字保留，不做任何过滤。
  const clean = manifest

  // ⚠ 序列化**可能自己抛**（循环引用、BIGINT、超深嵌套）。
  //   ⛔ 这里必须兜住：不然异常一路冒到 HTTP 层变成 500，
  //   而用户填的名片本身没问题 —— 错的是「有一个字段存不下来」。
  //   （2026-10-03 实测：save.node.test.js 的循环引用用例抓到的就是这条）
  let text
  try {
    text = JSON.stringify(clean, null, 2) + '\n'
  } catch (e) {
    return { ok: false, code: 'NOT_SERIALISABLE',
      error: `this manifest cannot be written as JSON: ${e.message}. `
        + 'A field probably contains a circular reference.' }
  }

  if (dryRun) {
    return { ok: true, path: file, dryRun: true, bytes: text.length, createdDir }
  }

  // ---- 7. 先写临时文件再改名 ⇒ 不会写出半个 JSON ----
  const tmp = file + '.tmp-wizard'
  try {
    fs.writeFileSync(tmp, text, 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    return { ok: false, code: 'WRITE_FAILED', error: e.message }
  }

  return { ok: true, path: file, bytes: text.length, createdDir, replaced: exists }
}

/**
 * 已装引擎的清单（给「覆盖前先看看」用）——
 * ⛔ 只读目录，不解析内容：解析是平台 registry 的事。
 */
function listInstalled (opts = {}) {
  const enginesDir = opts.enginesDir || path.join(repoRoot(), 'engines')
  let names = []
  try {
    names = fs.readdirSync(enginesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
  } catch {
    return []
  }
  return names
    .filter((n) => fs.existsSync(path.join(enginesDir, n, 'manifest.json')))
    .map((n) => {
      let has = false
      try {
        has = JSON.parse(fs.readFileSync(
          path.join(enginesDir, n, 'manifest.json'), 'utf-8')).id === n
      } catch { /* 读不了就当不知道 */ }
      return { id: n, manifestPresent: true, idMatchesDir: has }
    })
}

/**
 * 读一张已装引擎的名片。
 * ⛔⛔ 路径穿越防护与写入**同等严格** —— 读盘也能被 ../ 骗出去。
 *   1) 先过 validateId（禁 / \ : * ? " < > |、禁 .. 开头、禁保留名）
 *   2) 再用 path.relative 确认解析结果仍在 engines/ 之内
 *   3) 两条都过才读盘 —— 只做一条是不够的
 */
function readManifestById (id, opts = {}) {
  const enginesDir = opts.enginesDir || path.join(repoRoot(), 'engines')

  const idErr = validateId(id)
  if (idErr) return { ok: false, code: 'BAD_ID', error: idErr }

  const dir = path.join(enginesDir, id)
  const rel = path.relative(enginesDir, dir)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'OUT_OF_SCOPE',
      error: 'refusing to read outside engines/' }
  }

  const file = path.join(dir, 'manifest.json')
  if (!fs.existsSync(file)) {
    return { ok: false, code: 'NO_MANIFEST',
      error: `engines/${id}/manifest.json does not exist` }
  }
  let text
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    return { ok: false, code: 'READ_FAILED', error: e.message }
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (e) {
    // ⛔ 坏掉的 JSON 要如实报「读不了」+ 为什么，
    //    不能返回空对象 —— 那会让用户以为这是一张空名片。
    return { ok: false, code: 'BAD_JSON', path: file,
      error: `engines/${id}/manifest.json is not valid JSON: ${e.message}` }
  }
  return { ok: true, id, manifest, path: file, bytes: text.length }
}

module.exports = { saveManifest, validateId, listInstalled, readManifestById, repoRoot }