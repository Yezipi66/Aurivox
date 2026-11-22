'use strict'
// 第 5 步右侧「参考音频资产」的数据源：直接读盘，不经平台后端。
//   向导与平台在同一个仓库，资产就是 assets/<voice>/ 下的文件；为了列一份磁盘清单
//   要求平台后端（9886）正在运行是多余的前置条件。这一步的用途正是平台还没接上时
//   校验一台引擎，平台进程不应当参与。
//   落点取 lib/paths（与 9886 同一个解析优先级），字段形状与 /api/assets/* 一致，
//   前端只换 URL，读取逻辑不变。
//   口径与 lib/routes/assets/segments.js 对齐：切片按磁盘现存文件标记 exists，
//   原始音频的转写文本取自 asr_opt/raw_opt.list。两处若有一处改了取法，另一处要同步。

const fs = require('node:fs')
const path = require('node:path')

const PATHS = require('../../../lib/paths')
const { parseSlicerOptList } = require('../../../lib/assetScanner/transcript')
const { getWavDuration } = require('../../../lib/assetScanner/audioDuration')

// 认得的音频扩展名与内容类型。扩展名不认的一律拒绝：宿主把路径原样交给引擎，
//   放进去一个文本文件只会在几分钟之后以「解码失败」的形式回来。
const CONTENT_TYPE = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
}

function json (res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** 音色 id 的合法形状，与平台资产路由的判据一致。 */
function safeVoiceId (id) {
  return /^[a-zA-Z0-9_-]+$/.test(String(id || ''))
}

/**
 * 音色清单，取自平台的注册表 data/voices.json。
 *   底模条目不在清单里：这一步只列可拖动的资产，前端本来也会过滤 builtin。
 */
function listVoices (voicesJson = PATHS.VOICES_JSON) {
  const data = JSON.parse(fs.readFileSync(voicesJson, 'utf-8'))
  return Object.entries(data || {})
    .filter(([, cfg]) => cfg && typeof cfg === 'object')
    .map(([id, cfg]) => ({
      id,
      display_name: cfg.display_name || id,
      language: cfg.language || cfg.text_lang || 'unknown',
    }))
}

/**
 * 一个音色的切片清单。segments.json 是扫描时的快照，切片文件可能已被删除，
 *   所以逐条核对磁盘，并把结果写进 exists：前端据此过滤，不让点一条放不出来的音频。
 * @returns {object|null} 没有 segments.json 时返回 null（这是「没有」，不是错误）
 */
function listSegments (assetsRoot, voice) {
  const segPath = path.join(assetsRoot, voice, 'segments.json')
  if (!fs.existsSync(segPath)) return null
  const data = JSON.parse(fs.readFileSync(segPath, 'utf-8'))
  const slicesDir = path.join(assetsRoot, voice, 'slicer_opt')
  if (data && Array.isArray(data.segments)) {
    let liveMatched = 0
    for (const seg of data.segments) {
      const fname = seg.audio_filename
        || (seg.audio_path ? String(seg.audio_path).replace(/\\/g, '/').split('/').pop() : '')
      const exists = !!(fname && fs.existsSync(path.join(slicesDir, fname)))
      seg.exists = exists
      if (exists) liveMatched += 1
    }
    data.live_matched = liveMatched
  }
  return data
}

/**
 * 一个音色的原始音频清单。转写文本按文件名从 asr_opt/raw_opt.list 取，
 *   取不到就留空；读不懂这份 list 不影响列出文件。
 */
function listRaw (assetsRoot, voice) {
  const rawDir = path.join(assetsRoot, voice, 'raw')
  if (!fs.existsSync(rawDir)) return []
  const textByName = {}
  const listFile = path.join(assetsRoot, voice, 'asr_opt', 'raw_opt.list')
  if (fs.existsSync(listFile)) {
    try {
      for (const entry of parseSlicerOptList(fs.readFileSync(listFile, 'utf-8'))) {
        if (entry.origName && entry.text) textByName[entry.origName] = entry.text
      }
    } catch { /* 这份 list 读不懂就当没有转写文本 */ }
  }
  return fs.readdirSync(rawDir)
    .filter((f) => CONTENT_TYPE[path.extname(f).toLowerCase()])
    .map((f) => ({
      filename: f,
      text: textByName[f] || '',
      duration: path.extname(f).toLowerCase() === '.wav'
        ? Math.round(getWavDuration(path.join(rawDir, f)) * 100) / 100
        : 0,
    }))
}

/**
 * 把试听请求的三元组解成一个磁盘文件。
 *   只认 slicer_opt 与 raw 两个区，文件名必须是单段（路径分隔符一律拒绝），
 *   扩展名必须在白名单里：三条同时满足才可能落到 assets/<voice>/<区>/ 下。
 * @returns {{file:string, ext:string}|{code:number, error:string}}
 */
function resolveAssetFile (assetsRoot, query) {
  const voice = String((query && query.voice) || '')
  const area = String((query && query.area) || '')
  const name = String((query && query.name) || '')
  if (!safeVoiceId(voice)) return { code: 400, error: '?voice= is required' }
  if (area !== 'slicer_opt' && area !== 'raw') {
    return { code: 400, error: '?area= must be slicer_opt or raw' }
  }
  if (!name || path.basename(name) !== name) {
    return { code: 400, error: '?name= must be a plain file name' }
  }
  const ext = path.extname(name).toLowerCase()
  if (!CONTENT_TYPE[ext]) return { code: 415, error: 'unsupported audio extension' }
  const file = path.join(assetsRoot, voice, area, name)
  if (!fs.existsSync(file)) return { code: 404, error: 'audio file not found' }
  return { file, ext }
}

// 试听要能拖进度：按 Range 回 206，不带的回 200。片段只有几秒，但浏览器的
//   audio 元素会先发 Range 探测，直接回 200 整段在部分浏览器里会没有时长。
function serveAudio (req, res, file, ext) {
  const stat = fs.statSync(file)
  const type = CONTENT_TYPE[ext]
  const range = req.headers && req.headers.range
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : null
    let end = m[2] ? Number(m[2]) : null
    if (start === null) {
      start = Math.max(0, stat.size - end)
      end = stat.size - 1
    } else if (end === null || end >= stat.size) {
      end = stat.size - 1
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
    })
    if (req.method === 'HEAD') { res.end(); return }
    const stream = fs.createReadStream(file, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
  })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = fs.createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * GET /wizard/assets/{voices|segments|raw-list|file}
 *   四个端点同属一栏数据，用一个前缀分发；响应体形状与 /api/assets/* 一致，
 *   前端那边只换 URL，不再关心平台进程在不在。
 * @param {{VOICES_JSON:string, ASSETS_ROOT:string}} [roots] 仅供测试注入；默认取 lib/paths
 */
function handleAssets (req, res, roots) {
  const paths = roots || PATHS
  if (!req.url) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  let url
  try {
    url = new URL(req.url, 'http://x')
  } catch { return false }
  const p = url.pathname
  if (p !== '/wizard/assets/voices' && p !== '/wizard/assets/segments'
    && p !== '/wizard/assets/raw-list' && p !== '/wizard/assets/file') {
    return false
  }

  if (p === '/wizard/assets/voices') {
    try {
      // 形状与 /api/voices 完全一致：前端拿到的 body 直接是 { voices }，
      //   再套一层 data 会让它静默读成空列表（不报错，只是「没有音色资产」）。
      json(res, 200, { voices: listVoices(paths.VOICES_JSON) })
    } catch (e) {
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
    return true
  }

  if (p === '/wizard/assets/segments') {
    const voice = url.searchParams.get('voice') || ''
    if (!safeVoiceId(voice)) {
      json(res, 400, { ok: false, error: '?voice= is required' })
      return true
    }
    try {
      const data = listSegments(paths.ASSETS_ROOT, voice)
      if (!data) {
        json(res, 404, { ok: false, error: `No segments.json for '${voice}'` })
        return true
      }
      json(res, 200, { ok: true, segments: data })
    } catch (e) {
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
    return true
  }

  if (p === '/wizard/assets/raw-list') {
    const voice = url.searchParams.get('voice') || ''
    if (!safeVoiceId(voice)) {
      json(res, 400, { ok: false, error: '?voice= is required' })
      return true
    }
    try {
      json(res, 200, { ok: true, raw: listRaw(paths.ASSETS_ROOT, voice) })
    } catch (e) {
      json(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
    return true
  }

  let resolved
  try {
    resolved = resolveAssetFile(paths.ASSETS_ROOT, {
      voice: url.searchParams.get('voice'),
      area: url.searchParams.get('area'),
      name: url.searchParams.get('name'),
    })
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) })
    return true
  }
  if (resolved.code) {
    json(res, resolved.code, { ok: false, error: resolved.error })
    return true
  }
  try {
    serveAudio(req, res, resolved.file, resolved.ext)
  } catch (e) {
    if (!res.headersSent) json(res, 500, { ok: false, error: String((e && e.message) || e) })
    else res.destroy()
  }
  return true
}

module.exports = {
  handleAssets,
  // 纯函数导出给测试：落点都显式传入，不依赖本机 assets/。
  listVoices, listSegments, listRaw, resolveAssetFile,
}
