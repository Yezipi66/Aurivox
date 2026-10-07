'use strict'
// ============================================================================
//  DOWNLOAD —— 向导第 3 步：执行模型下载（统一落盘 engines/<id>/checkpoints/）
//
//  ⭐ 本文件只做一件事：**执行一条下载命令**，把输出逐行透传给调用方。
//     ⛔ 不决定下什么（那是 README 提取 + 用户勾选的事）
//     ⛔ 不决定下到哪（落盘路径由调用方替换好再传进来）
//
//  ⭐ 为什么异步流式：下载要几分钟到几十分钟，同步 spawnSync 会阻塞到结束。
//     改 spawn 后 stdout/stderr 逐行回调，进度条才有米下锅。
//
//  ⭐ 统一落盘：调用方（wizardbridge.handleDownload）负责把命令里的
//     local_dir 替换成 engines/<id>/checkpoints/，本文件不碰路径。
//
//  ⚠️ 断点续传：hf / modelscope CLI 本身有缓存（.hf_cache / .modelscope），
//     重跑同一条命令只补缺的。本文件不删缓存 —— 删缓存是用户主动行为。
// ============================================================================

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')

/**
 * 进度文件路径 —— 每个引擎目录下记录已完成的下载命令。
 * ⭐ 断点续传：重跑时跳过已完成的命令（hf/modelscope CLI 自带缓存，
 *    重复跑同一条命令只补缺的，不会重下已下载的）。
 */
function progressFile (root, id) {
  return path.join(root, 'engines', String(id || ''), '.wizard-download-progress.json')
}

/** 读进度文件，返回已完成的命令 key 集合 */
function readProgress (root, id) {
  const f = progressFile(root, id)
  try {
    if (!fs.existsSync(f)) return new Set()
    const data = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (Array.isArray(data.done)) return new Set(data.done.map((d) => d.key))
  } catch (e) { /* 损坏的进度文件 ⇒ 从头来 */ }
  return new Set()
}

/** 写进度文件 */
function writeProgress (root, id, doneKeys) {
  const f = progressFile(root, id)
  try {
    fs.writeFileSync(f, JSON.stringify({
      engine: id, updatedAt: new Date().toISOString(),
      done: [...doneKeys].map((key) => ({ key, at: new Date().toISOString() })),
    }, null, 2), 'utf8')
  } catch (e) { /* 进度文件写不进不该拦住下载 */ }
}

/**
 * 执行一条下载命令（异步流式 + 断点续传）。
 *
 * @param {object} input
 * @param {string} input.id        引擎 id（用于日志）
 * @param {string} input.root      项目根
 * @param {string[]} input.argv    完整命令（已替换好 local_dir）
 * @param {(line:string, isErr:boolean)=>void} [input.onLine]  每行输出回调
 * @param {number} [input.timeoutMs]  超时（毫秒），默认 2 小时
 * @returns {Promise<{ok:boolean, code:string, status:number|null, stdout:string, stderr:string, error?:string}>}
 */
function runDownload (input = {}) {
  return new Promise((resolve) => {
    const argv = input.argv || []
    if (!argv.length) {
      resolve({ ok: false, code: 'NO_ARGV', status: null, stdout: '', stderr: '',
        error: 'No command to run.' })
      return
    }
    const root = input.root || process.cwd()
    const id = input.id || ''
    const argvKey = argv.join(' ')
    // ⭐ 断点续传：这条命令上次已经成功跑完 ⇒ 跳过
    const doneKeys = readProgress(root, id)
    if (doneKeys.has(argvKey)) {
      resolve({ ok: true, code: 'SKIPPED', status: 0, stdout: '', stderr: '',
        output: 'Previously completed — skipped (breakpoint resume).',
        outputZh: '上次已成功执行，跳过（断点续传）。' })
      return
    }
    const child = spawn(argv[0], argv.slice(1), {
      cwd: root,
      windowsHide: true,
      shell: false,
    })
    let stdoutTail = ''
    let stderrTail = ''
    let killedByTimeout = false
    const onChunk = (buf, isErr) => {
      const text = buf.toString('utf8')
      if (isErr) stderrTail = (stderrTail + text).slice(-16000)
      else stdoutTail = (stdoutTail + text).slice(-16000)
      if (typeof input.onLine === 'function') {
        try { input.onLine(text, isErr) } catch (e) { /* 忽略 */ }
      }
    }
    child.stdout.on('data', (d) => onChunk(d, false))
    child.stderr.on('data', (d) => onChunk(d, true))
    child.on('error', (err) => {
      resolve({ ok: false, code: 'SPAWN_FAILED', status: null,
        stdout: stdoutTail, stderr: stderrTail, error: err.message })
    })
    child.on('close', (code) => {
      if (killedByTimeout) {
        resolve({ ok: false, code: 'DL_TIMEOUT', status: code,
          stdout: stdoutTail, stderr: stderrTail,
          error: `Download timed out (${Math.round((input.timeoutMs || 7200000) / 60000)} min).` })
        return
      }
      // ⭐ 下载成功 ⇒ 写入进度文件（下次重跑会跳过）
      if (code === 0) {
        doneKeys.add(argvKey)
        writeProgress(root, id, doneKeys)
      }
      resolve({
        ok: code === 0,
        code: code === 0 ? 'OK' : 'DL_FAILED',
        status: code,
        stdout: stdoutTail.trim(),
        stderr: stderrTail.trim(),
      })
    })
    const timeoutMs = input.timeoutMs || 2 * 60 * 60 * 1000
    if (timeoutMs > 0) {
      setTimeout(() => {
        killedByTimeout = true
        try { child.kill('SIGKILL') } catch (e) { /* 已退出 */ }
      }, timeoutMs).unref()
    }
  })
}

/**
 * 把一条下载命令的 local_dir 替换成统一落盘路径。
 *
 * ⭐ 统一落盘：所有引擎的模型都下到 engines/<id>/checkpoints/。
 *   ⛔ 不删原目录 —— hf/modelscope 的缓存在那里，删了要重下。
 *
 * @param {string[]} argv     原始命令
 * @param {string} engineId   引擎 id
 * @param {string} root       项目根
 * @returns {string[]}        替换后的 argv
 */
function unifyDest (argv, engineId, root) {
  const dest = path.join(root, 'engines', engineId, 'checkpoints')
  const out = argv.slice()
  // hf: --local-dir=<dir> 或 --local-dir <dir>
  for (let i = 0; i < out.length; i++) {
    if (/^--local-dir[=\s]/.test(out[i])) {
      out[i] = out[i].replace(/^--local-dir[=\s]\S+/, `--local-dir=${dest}`)
    }
  }
  // modelscope: --local_dir <dir>
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '--local_dir' && i + 1 < out.length) {
      out[i + 1] = dest
    }
  }
  // snapshot_download: local_dir='...' 或 local_dir="..."
  for (let i = 0; i < out.length; i++) {
    if (/local_dir\s*=/.test(out[i])) {
      out[i] = out[i].replace(/local_dir\s*=\s*['"][^'"]*['"]/, `local_dir='${dest}'`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
//  fetchRemoteManifest —— 请求 HF/ModelScope API 获取文件列表
// ---------------------------------------------------------------------------
//  ⭐ 返回 { ok, files, error }，API 失败时 ok=false + error 信息
//  ⭐ HF API 返回 hex 格式 SHA-256，ModelScope 可能返回 base64，统一转 hex
function fetchRemoteManifest (repo, tool, baseUrl) {
  return new Promise((resolve) => {
    const base = baseUrl || (tool === 'modelscope' ? 'https://modelscope.cn' : 'https://huggingface.co')
    // ⭐ HF API 需要 ?blobs=true 才返回 size 和 blobId
    const url = tool === 'modelscope'
      ? `${base}/api/v1/models/${repo}`
      : `${base}/api/models/${repo}?blobs=true`
    const client = url.startsWith('http:') ? require('node:http') : https
    const req = client.get(url, {
      headers: { 'user-agent': 'aurivox-engine-wizard' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve({ ok: false, files: [], error: `API returned HTTP ${res.statusCode}` })
        return
      }
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          const files = []
          // HF API: data.siblings = [{ rfilename, size, blobId }]
          // ⚠️ blobId 不是 SHA-256，是 HF 的内部 blob 标识
          if (data.siblings) {
            for (const s of data.siblings) {
              files.push({
                name: s.rfilename,
                size: s.size || 0,
                blobId: s.blobId || null,
              })
            }
          }
          // ModelScope API: data.Data.Files = [{ Name, Size, Sha256 }]
          if (data.Data && data.Data.Files) {
            for (const f of data.Data.Files) {
              files.push({
                name: f.Name || f.Path,
                size: f.Size || 0,
                blobId: f.Sha256 || null,
              })
            }
          }
          resolve({ ok: true, files, error: null })
        } catch (e) {
          resolve({ ok: false, files: [], error: e.message })
        }
      })
    })
    req.on('error', (e) => resolve({ ok: false, files: [], error: e.message }))
    req.setTimeout(30000, () => {
      req.destroy()
      resolve({ ok: false, files: [], error: 'Request timed out' })
    })
  })
}

/** base64 → hex（ModelScope API 可能返回 base64 格式的 SHA-256） */
function base64ToHex (b64) {
  try {
    const buf = Buffer.from(b64, 'base64')
    return buf.toString('hex')
  } catch (e) { return b64 }
}

// ---------------------------------------------------------------------------
//  checkFileStatus —— 三态判断
// ---------------------------------------------------------------------------
//  ⭐ 正式文件存在 + 大小匹配 → 'ok'（SHA-256 是实际计算的，不是远端 blobId）
//  ⛔ 正式文件存在但**远端没给大小** → 'partial' —— 无法确认完整性，
//     默认报 'ok' 就是给假绿灯（文件可能是上次中断留下的半截）。
//  ⭐ .tmp 文件存在 → 'partial'
//  ⭐ 都不存在 → 'missing'
function checkFileStatus (file, expectedSize, root, id) {
  const dir = path.join(root, 'engines', String(id || ''), 'checkpoints')
  const finalPath = path.join(dir, file)
  const tmpPath = finalPath + '.tmp'

  // 检查正式文件
  if (fs.existsSync(finalPath)) {
    const stat = fs.statSync(finalPath)
    // ⛔ 远端没给大小 ⇒ 无从比对，不能当作已下载完成
    if (!expectedSize) {
      return {
        status: 'partial',
        size: stat.size,
        sha256: sha256File(finalPath),
        note: 'The remote file list gives no size for this file — completeness cannot be confirmed.',
        noteZh: '远端文件列表没有给出这个文件的大小，无法确认完整性。',
      }
    }
    if (stat.size !== expectedSize) {
      return {
        status: 'partial',
        size: stat.size,
        sha256: sha256File(finalPath),
        note: 'The file on disk does not match the size the remote file list reports.',
        noteZh: '磁盘上的文件和远端文件列表给出的大小不一致。',
      }
    }
    return { status: 'ok', size: stat.size, sha256: sha256File(finalPath) }
  }

  // 检查 .tmp 文件
  if (fs.existsSync(tmpPath)) {
    const stat = fs.statSync(tmpPath)
    return { status: 'partial', size: stat.size, sha256: null }
  }

  return { status: 'missing', size: 0, sha256: null }
}

/** 计算文件 SHA-256 */
function sha256File (filePath) {
  try {
    const buf = fs.readFileSync(filePath)
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch (e) { return null }
}

// ---------------------------------------------------------------------------
//  enrichManifestFiles —— 给远端文件列表补上本地状态 + 来源
// ---------------------------------------------------------------------------
//  ⭐ 每条 = 远端给的事实（name/size）+ 本地查出来的状态（status/sha256）
//  ⛔ 必须带 repo/tool：前端单文件下载完成后会重新调 /wizard/download/manifest
//     刷新，而刷新是整表替换 —— 不带来源就等于把每一项「属于哪个仓库」
//     抹掉，仓库列、重下、续传按钮会一起失效。
//  ⭐ partial 时带上 note/noteZh 说明**为什么**不完整（远端没给大小 / 大小不符），
//     ⛔ 不是笼统一句「半截」。
function enrichManifestFiles (files, repo, tool, root, id) {
  return (files || []).map((f) => {
    const st = checkFileStatus(f.name, f.size, root, id)
    return {
      name: f.name, size: f.size, sha256: st.sha256, status: st.status,
      repo, tool,
      note: st.note || null, noteZh: st.noteZh || null,
    }
  })
}

// ---------------------------------------------------------------------------
//  downloadFileFromUrl —— 从指定 URL 下载文件（支持重定向）
// ---------------------------------------------------------------------------
//  ⭐ 写入 .tmp 文件，完成后原子重命名
//  ⭐ 断点续传：检查 .tmp 文件大小，发送 Range: bytes=<size>- 请求
//  ⭐ SHA-256：下载完成后算**实际**哈希，⛔ 不用远端 blobId（那不是真哈希）
//  ⛔ 非 2xx 一律不写盘（原来 404 的 HTML 错误页会被当成模型文件落盘）
//  ⛔ content-type 是 text/html ⇒ 判失败
//  ⛔ 下载完比对 file.size（远端没给就退一步比对 content-length），
//     不符即删掉脏文件并判失败
//  @param {boolean} [skipTmpDetect] 内部用：⛔ 不许外部传。
//    从零重来时置 true，否则下一跳又会探测到同一个 .tmp ⇒ 无限递归。
function downloadFileFromUrl (url, file, repo, root, id, onLine, resumeFrom = 0, skipTmpDetect = false) {
  return new Promise((resolve) => {
    const dir = path.join(root, 'engines', String(id || ''), 'checkpoints')
    const finalPath = path.join(dir, file.name)
    const tmpPath = finalPath + '.tmp'

    // ⭐ 期望大小来自远端文件列表（file.size）—— 下载完按它逐字节校验。
    //   ⛔ 没给（0）就退一步比对响应声明的 content-length。
    const expectedSize = Number(file && file.size ? file.size : 0)

    // 确保目录存在（含子目录，如 qwen0.6bemo4-merge/）
    try { fs.mkdirSync(path.dirname(finalPath), { recursive: true }) } catch (e) {
      resolve({ ok: false, code: 'MKDIR_FAILED', status: null, error: e.message })
      return
    }

    // 检查 .tmp 文件大小（断点续传）
    //   ⛔ 从零重来的那一跳不许再探测 —— 否则又拿到同一个 size，无限递归
    if (!skipTmpDetect && resumeFrom === 0 && fs.existsSync(tmpPath)) {
      resumeFrom = fs.statSync(tmpPath).size
    }

    const headers = { 'user-agent': 'aurivox-engine-wizard' }
    if (resumeFrom > 0) {
      headers.range = `bytes=${resumeFrom}-`
    }

    const client = url.startsWith('http:') ? require('node:http') : https
    const req = client.get(url, { headers }, (res) => {
      const status = res.statusCode

      // ⭐ 跟随重定向
      if (status >= 300 && status < 400 && res.headers.location) {
        req.destroy()
        // ⚠️ Location 可能是相对路径（如 /api/resolve-cache/...），必须解析为绝对 URL
        const redirectUrl = new URL(res.headers.location, url).href
        downloadFileFromUrl(redirectUrl, file, repo, root, id, onLine, resumeFrom).then(resolve)
        return
      }

      // ⛔ 非 2xx ⇒ 报错，⛔ 不写盘
      //   原来无论 404/403/500 都把响应体写盘、重命名、报 ok:true，
      //   于是 404 的 HTML 错误页被当成模型文件落盘。
      if (status < 200 || status >= 300) {
        res.resume()
        resolve({
          ok: false, code: `HTTP_${status}`, status,
          error: `The server answered HTTP ${status} for ${file.name}.`,
          errorZh: `服务器对 ${file.name} 返回 HTTP ${status}。`,
        })
        return
      }

      // ⛔ content-type 是 HTML ⇒ 这是错误页面，不是要下的文件
      const ctype = String(res.headers['content-type'] || '').toLowerCase()
      if (ctype.includes('text/html')) {
        res.resume()
        resolve({
          ok: false, code: 'HTML_RESPONSE', status,
          error: `The server returned an HTML page instead of ${file.name}.`,
          errorZh: `服务器返回的是 HTML 页面，不是 ${file.name}。`,
        })
        return
      }

      // 服务器不支持 Range ⇒ 从零重来（⛔ 不再探测 .tmp，否则无限递归）
      if (resumeFrom > 0 && status !== 206) {
        resumeFrom = 0
        req.destroy()
        downloadFileFromUrl(url, file, repo, root, id, onLine, 0, true).then(resolve)
        return
      }

      // ⭐ 本次响应声明的长度 —— 带 Range 时它是剩余部分，不是整个文件
      const contentLength = Number(res.headers['content-length'] || 0)
      const startOffset = resumeFrom

      const flags = resumeFrom > 0 ? 'a' : 'w'
      const out = fs.createWriteStream(tmpPath, { flags })
      let downloaded = resumeFrom

      // ⛔ 任何失败都删掉半截的 .tmp —— ⛔ 不留脏文件让下一次误判成 partial
      const fail = (code, msg) => {
        try { out.destroy() } catch (e) { /* 已关闭 */ }
        try { fs.rmSync(tmpPath, { force: true }) } catch (e) { /* 删不掉就算了 */ }
        resolve({ ok: false, code, status, error: msg })
      }

      res.on('data', (chunk) => {
        downloaded += chunk.length
        out.write(chunk)
        if (typeof onLine === 'function') {
          try { onLine(`Downloaded ${downloaded} bytes`, false) } catch (e) { /* 忽略 */ }
        }
      })
      res.on('end', () => {
        out.end(() => {
          // ⛔ 大小校验：远端给了大小就逐字节比对，不符即判失败并删掉脏文件
          const sizeMismatch = (expected, source) => ({
            ok: false, code: 'SIZE_MISMATCH', status,
            size: downloaded, expected,
            error: `Size mismatch for ${file.name}: got ${downloaded} bytes, ${source} reports ${expected}.`,
            errorZh: `${file.name} 大小不符：实际 ${downloaded} 字节，${source}给出 ${expected} 字节。`,
          })
          const dropTmp = () => {
            try { fs.rmSync(tmpPath, { force: true }) } catch (e) { /* 删不掉就算了 */ }
          }
          if (expectedSize > 0) {
            if (downloaded !== expectedSize) {
              dropTmp()
              resolve(sizeMismatch(expectedSize, 'the remote file list'))
              return
            }
          } else if (startOffset === 0 && contentLength > 0 && downloaded !== contentLength) {
            // ⭐ 远端没给大小 ⇒ 退一步比对响应声明的 content-length
            dropTmp()
            resolve(sizeMismatch(contentLength, 'the server'))
            return
          }
          // 计算实际 SHA-256（不用远端 blobId，因为不是真实哈希）
          const actualSha256 = sha256File(tmpPath)
          // 原子重命名
          try {
            fs.renameSync(tmpPath, finalPath)
            resolve({ ok: true, code: 'OK', status: 0, size: downloaded, sha256: actualSha256 })
          } catch (e) {
            resolve({ ok: false, code: 'RENAME_FAILED', status: null, error: e.message })
          }
        })
      })
      res.on('error', (e) => fail('DOWNLOAD_ERROR', e.message))
      out.on('error', (e) => { req.destroy(); fail('WRITE_ERROR', e.message) })
    })
    req.on('error', (e) => {
      resolve({ ok: false, code: 'REQUEST_ERROR', status: null, error: e.message })
    })
    req.setTimeout(2 * 60 * 60 * 1000, () => {
      req.destroy()
      resolve({ ok: false, code: 'TIMEOUT', status: null, error: 'Download timed out' })
    })
  })
}

// ---------------------------------------------------------------------------
//  downloadFile —— 下载单个文件（入口函数，构建 URL 后调用 downloadFileFromUrl）
// ---------------------------------------------------------------------------
function downloadFile (file, repo, root, id, onLine) {
  const url = `https://huggingface.co/${repo}/resolve/main/${file.name}`
  return downloadFileFromUrl(url, file, repo, root, id, onLine, 0)
}

module.exports = { runDownload, unifyDest, readProgress, fetchRemoteManifest, checkFileStatus, enrichManifestFiles, downloadFile, downloadFileFromUrl }