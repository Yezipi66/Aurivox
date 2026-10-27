'use strict'

// 引擎名片的落盘读写：保存、校验 id、列已装引擎、按 id 读回。
// 写入一律走 engines/<id>/manifest.json，路径穿越先用 validateId 再用 path.relative 挡两次；
// 注释键写盘时原样保留，剥注释只发生在读取侧（lib/engines/registry.js 的 stripComments）。

const fs = require('node:fs')
const path = require('node:path')
const wizardRoot = require('./wizardRoot')

// 名片落盘的根：本 checkout；设了 WIZARD_PROJECT_ROOT 才写到那里（见 wizardRoot.js）。
//   读取另走 readRoots：本 checkout 优先，主仓库兜底。
function repoRoot (opts = {}) {
  return wizardRoot.writeRoot(opts) || path.resolve(__dirname, '..', '..', '..')
}

// 不给 enginesDir 时，读侧依次查找的 engines/ 目录。
function readEnginesDirs (opts = {}) {
  if (opts.enginesDir) return [opts.enginesDir]
  const roots = wizardRoot.readRoots(opts)
  const dirs = roots.map((r) => path.join(r, 'engines'))
  return dirs.length ? dirs : [path.join(repoRoot(opts), 'engines')]
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
  const enginesDir = opts.enginesDir || path.join(repoRoot(opts), 'engines')

  // ---- 1. 形状 ----
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, code: 'BAD_SHAPE', error: 'manifest must be a JSON object',
      errorZh: 'manifest 必须是一个 JSON 对象' }
  }

  // ---- 2. id（最常错的一项，先查）----
  const idErr = validateId(manifest.id)
  if (idErr) return { ok: false, code: 'BAD_ID', error: idErr }

  const id = manifest.id
  const dir = path.join(enginesDir, id)

  // ---- 3. 不许写到 engines/ 之外 ----
  const rel = path.relative(enginesDir, dir)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'OUT_OF_SCOPE',
      error: 'refusing to write outside engines/', errorZh: '拒绝写到 engines/ 之外' }
  }

  // ---- 4. 目录在不在 ----
  //   但我们是开发工具，建目录是合理的：这里如实说明建了什么。
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
      error: `engines/${id}/manifest.json already exists — overwrite was not requested`,
      errorZh: `engines/${id}/manifest.json 已存在，且未请求覆盖` }
  }

  // ---- 6. 注释键原样保留 ----
  //  平台是在读取时剥（lib/engines/registry.js 的 stripComments），不是写入时剥。
  //    写盘时剥 ⇒「读回来再存一次」就把文档永久删了。
  const clean = manifest

  //   这里必须兜住：不然异常一路冒到 HTTP 层变成 500，
  //   而用户填的名片本身没问题：错的是「有一个字段无法写入」。
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

  // ---- 7. 覆盖前先备份，再写临时文件改名 ⇒ 不会写出半个 JSON ----
  //   备份只留一份：反复保存不该攒出一堆 .bak。
  //   备份失败不阻断保存（备份是保险，不是前置条件）。
  const bak = file + '.bak'
  if (exists) {
    try { fs.copyFileSync(file, bak) } catch (e) { /* 备份不了照样存，只是少了回滚点 */ }
  }

  const tmp = file + '.tmp-wizard'
  try {
    fs.writeFileSync(tmp, text, 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    // 写入失败时原文件未被改动（改名前失败），备份还在，如实报错。
    return { ok: false, code: 'WRITE_FAILED', error: e.message, backup: exists ? bak : null }
  }

  return { ok: true, path: file, bytes: text.length, createdDir, replaced: exists,
    backup: exists ? bak : null }
}

/**
 * 已装引擎的清单（给「覆盖前先看看」用），
 * 只读目录，不解析内容：解析是平台 registry 的事。
 */
function listInstalled (opts = {}) {
  // 多个读根时按顺序合并：同名的以先找到的为准（本 checkout 盖住主仓库）。
  const seen = new Set()
  const out = []
  for (const enginesDir of readEnginesDirs(opts)) {
    for (const row of listInstalledIn(enginesDir, opts)) {
      if (seen.has(row.id || row)) continue
      seen.add(row.id || row)
      out.push(row)
    }
  }
  return out
}

function listInstalledIn (enginesDir, opts) {
  let names = []
  try {
    names = fs.readdirSync(enginesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
  } catch {
    return []
  }
  // opts.all：列出所有文件夹（含还没名片的），供「新建名片」入口扫描；
  //   默认仍只列有 manifest 的。
  const withManifest = (n) => {
    const mf = path.join(enginesDir, n, 'manifest.json')
    if (!fs.existsSync(mf)) return null
    let has = false
    try {
      has = JSON.parse(fs.readFileSync(mf, 'utf-8')).id === n
    } catch { /* 无法读取就当不知道 */ }
    return { id: n, manifestPresent: true, idMatchesDir: has }
  }
  if (opts.all) {
    return names.map((n) => withManifest(n) || { id: n, manifestPresent: false, idMatchesDir: false })
  }
  return names
    .map((n) => withManifest(n))
    .filter(Boolean)
}

/**
 * 读一张已装引擎的名片。
 * 路径穿越防护与写入同等严格：先过 validateId，再用 path.relative
 *   确认解析结果仍在 engines/ 之内，两条都过才读盘。
 */
function readManifestById (id, opts = {}) {
  const idErr = validateId(id)
  if (idErr) return { ok: false, code: 'BAD_ID', error: idErr }

  // 多个读根时取第一个真有这张名片的（本 checkout 优先）；都没有就按第一个报「不存在」。
  const dirs = readEnginesDirs(opts)
  const enginesDir = dirs.find((d) => fs.existsSync(path.join(d, id, 'manifest.json'))) || dirs[0]
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
    // 坏掉的 JSON 要如实报「无法读取」+ 为什么，
    //    不能返回空对象：那会让用户以为这是一张空名片。
    return { ok: false, code: 'BAD_JSON', path: file,
      error: `engines/${id}/manifest.json is not valid JSON: ${e.message}` }
  }
  return { ok: true, id, manifest, path: file, bytes: text.length }
}

module.exports = { saveManifest, validateId, listInstalled, readManifestById, repoRoot }