'use strict'

/**
 * 执行一条下载命令，把输出逐行透传给调用方。
 * 异步流式：下载要几分钟到几十分钟，同步 spawnSync 会阻塞到结束。
 * 统一落盘：调用方负责把命令里的 local_dir 替换成 engines/<id>/checkpoints/。
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')

/**
 * 进度文件路径：每个引擎目录下记录已完成的下载命令。
 */
const { progressFile, readProgress: readProgressOf, writeProgress: writeProgressOf,
  resetProgress: resetProgressOf } = require('./installState')

/** 读进度文件，返回已完成的命令 key 集合（models 段） */
function readProgress (root, id) {
  return readProgressOf(root, id, 'models')
}

/** 写进度文件（models 段） */
function writeProgress (root, id, doneKeys) {
  writeProgressOf(root, id, 'models', doneKeys)
}

/** 清空这一段的进度：从头重下（不删已下载的文件） */
function resetProgress (root, id) {
  resetProgressOf(root, id, 'models')
}

//  parseDownloadProgress / parseSize：解析 hf/modelscope tqdm 风格进度
//  hf / modelscope CLI 的下载进度是 tqdm 风格：
//     Downloading model.safetensors: 45%|████▌     | 1.2GB/2.7GB [00:30<00:45, 25.3MB/s]
//  parseDownloadProgress 解析一行，返回 { file, percent, downloaded, total } 或 null
//  parseSize 把 "1.2GB" 之类的字符串转成字节数（1.2GB → 1288490188）
function parseDownloadProgress (line) {
  const m = line.match(/Downloading (.+?): (\d+)%\|.*?\| ([\d.]+[KMG]?B?)\/([\d.]+[KMG]?B?) \[/)
  if (!m) return null
  return {
    file: m[1],
    percent: parseInt(m[2], 10),
    downloaded: m[3],
    total: m[4],
  }
}

function parseSize (s) {
  if (!s) return 0
  const m = String(s).trim().match(/^([\d.]+)\s*([KMG]?B?)$/i)
  if (!m) return 0
  const num = parseFloat(m[1])
  const unit = (m[2] || '').toUpperCase()
  const mult = { '': 1, 'B': 1, 'KB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3, 'TB': 1024 ** 4 }[unit] || 1
  return Math.floor(num * mult)
}

/**
 * 执行一条下载命令（异步流式 + 断点续传）。
 *
 * @param {object} input
 * @param {string} input.id        引擎 id（用于日志）
 * @param {string} input.root      项目根
 * @param {string[]} input.argv    完整命令（已替换好 local_dir）
 * @param {(line:string, isErr:boolean)=>void} [input.onLine]  每行输出回调
 * @param {(progress:{file:string, percent:number, downloaded:string, total:string})=>void} [input.onProgress]  下载进度回调
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
    // 断点续传：这条命令上次已经成功执行完成，跳过
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
      // 解析 hf/modelscope tqdm 风格进度，触发 onProgress 回调
      if (!isErr && typeof input.onProgress === 'function') {
        const lines = text.split('\n')
        for (const line of lines) {
          const progress = parseDownloadProgress(line)
          if (progress) {
            try { input.onProgress(progress) } catch (e) { /* 忽略 */ }
          }
        }
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
      // 下载成功，写入进度文件（下次重跑会跳过）
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
 * 统一落盘：所有引擎的模型都下到 engines/<id>/checkpoints/。
 *   不删原目录：hf/modelscope 的缓存在那里，删了要重下。
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

//  fetchRemoteManifest：请求 HF/ModelScope API 获取文件列表
//  返回 { ok, files, error }，API 失败时 ok=false + error 信息
function fetchRemoteManifest (repo, tool, baseUrl) {
  return new Promise((resolve) => {
    const base = baseUrl || (tool === 'modelscope' ? 'https://modelscope.cn' : 'https://huggingface.co')
    // HF API 需要 ?blobs=true 才返回 size 和 blobId
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
          // blobId 不是 SHA-256，是 HF 的内部 blob 标识
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
                sha256: f.Sha256 || null,
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

/**
 * base64 → hex。
 * HF API 返回 hex 格式 SHA-256，ModelScope 可能返回 base64，统一转 hex 便于比对。
 */
function base64ToHex (b64) {
  try {
    const buf = Buffer.from(b64, 'base64')
    return buf.toString('hex')
  } catch (e) { return b64 }
}

//  checkFileStatus：三态判断
//  正式文件存在 + 大小匹配 + 有上游 sha 时比对通过 → 'ok'
//  正式文件存在但远端没给大小 → 'partial'：无法确认完整性，
//     默认报 'ok' 就是给假绿灯（文件可能是上次中断留下的不完整文件）。
//  大小不符、或与上游 sha 不符 → 'partial'（磁盘文件是坏的，重下）
//  正式文件不存在但 .tmp 存在 → 'partial'
//  都不存在 → 'missing'
//
//  sha 只在两边都有时才比对：上游没给就只报实际算出的值，
//  不声称校验过。本地算出 sha 与上游一致才算真校验。
async function checkFileStatus (file, expectedSize, root, id, expectedSha) {
  const dir = path.join(root, 'engines', String(id || ''), 'checkpoints')
  const finalPath = path.join(dir, file)
  const tmpPath = finalPath + '.tmp'

  if (fs.existsSync(finalPath)) {
    const stat = fs.statSync(finalPath)
    // 远端没给大小，无从比对，不能当作已下载完成
    if (!expectedSize) {
      return {
        status: 'partial',
        size: stat.size,
        sha256: await sha256File(finalPath),
        note: 'The remote file list gives no size for this file — completeness cannot be confirmed.',
        noteZh: '远端文件列表没有给出这个文件的大小，无法确认完整性。',
      }
    }
    if (stat.size !== expectedSize) {
      return {
        status: 'partial',
        size: stat.size,
        sha256: await sha256File(finalPath),
        note: 'The file on disk does not match the size the remote file list reports.',
        noteZh: '磁盘上的文件和远端文件列表给出的大小不一致。',
      }
    }
    const actualSha = await sha256File(finalPath)
    // 上游给了 sha 就必须比对。大小对但内容是坏的（写入中断、磁盘出错），
    // 只看大小会当成好的，装上之后在推理阶段才炸。
    if (expectedSha && actualSha && actualSha !== expectedSha) {
      return {
        status: 'partial',
        size: stat.size,
        sha256: actualSha,
        expectedSha,
        shaVerified: false,
        note: 'The file size matches but its SHA-256 differs from the value the remote reports.',
        noteZh: '文件大小一致，但 SHA-256 与远端给出的不一致，内容已损坏。',
      }
    }
    return { status: 'ok', size: stat.size, sha256: actualSha,
      shaVerified: Boolean(expectedSha) }
  }

  if (fs.existsSync(tmpPath)) {
    const stat = fs.statSync(tmpPath)
    return { status: 'partial', size: stat.size, sha256: null }
  }

  return { status: 'missing', size: 0, sha256: null }
}

/**
 * 计算文件 SHA-256（流式读取，支持大文件）。
 * 不用远端 blobId：HF 的 blobId 是内部标识，不是文件内容的真实哈希。
 */
function sha256File (filePath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', () => resolve(null))
  })
}

//  enrichManifestFiles：给远端文件列表补上本地状态 + 来源
//  每条 = 远端给的事实（name/size）+ 本地查出来的状态（status/sha256）
//  必须带 repo/tool：前端单文件下载完成后会重新调 /wizard/download/manifest
//     刷新，而刷新是整表替换：不带来源就等于把每一项「属于哪个仓库」
//     抹掉，仓库列、重下、续传按钮会一起失效。
//  partial 时带上 note/noteZh 说明为什么不完整（远端没给大小 / 大小不符），
//     不是笼统一句「不完整」。
//  expectedSha 参与判断：上游给了 sha 就比对，两边都有才算校验过。
//  结果里带 shaVerified 说明「这一条到底有没有真的校验过」，
//  前端不许把它当成「已校验」来展示。
async function enrichManifestFiles (files, repo, tool, root, id) {
  const results = []
  for (const f of (files || [])) {
    const st = await checkFileStatus(f.name, f.size, root, id, f.sha256 || null)
    results.push({
      name: f.name, size: f.size, sha256: st.sha256 || f.sha256 || null, status: st.status,
      shaVerified: st.shaVerified === true,
      repo, tool,
      note: st.note || null, noteZh: st.noteZh || null,
    })
  }
  return results
}

//  downloadFileFromUrl：从指定 URL 下载文件（支持重定向）
//  写入 .tmp 文件，完成后原子重命名
//  断点续传：检查 .tmp 文件大小，发送 Range: bytes=<size>- 请求
//  SHA-256：下载完成后算实际哈希，不用远端 blobId（那不是真哈希）
//  非 2xx 一律不写盘（原来 404 的 HTML 错误页会被当成模型文件落盘）
//  content-type 是 text/html，判失败
//  下载完比对 file.size（远端没给就退一步比对 content-length），
//     不符即删掉脏文件并判失败
//  @param {boolean} [skipTmpDetect] 内部用：不许外部传。
//    从零重来时置 true，否则下一跳又会探测到同一个 .tmp，无限递归。
function downloadFileFromUrl (url, file, repo, root, id, onLine, onProgress, resumeFrom = 0, skipTmpDetect = false) {
  return new Promise((resolve) => {
    const dir = path.join(root, 'engines', String(id || ''), 'checkpoints')
    const finalPath = path.join(dir, file.name)
    const tmpPath = finalPath + '.tmp'

    // 期望大小来自远端文件列表（file.size）：下载完按它逐字节校验。
    //   没给（0）就退一步比对响应声明的 content-length。
    const expectedSize = Number(file && file.size ? file.size : 0)

    // 确保目录存在（含子目录，如 qwen0.6bemo4-merge/）
    try { fs.mkdirSync(path.dirname(finalPath), { recursive: true }) } catch (e) {
      resolve({ ok: false, code: 'MKDIR_FAILED', status: null, error: e.message })
      return
    }

    // 检查 .tmp 文件大小（断点续传）
    //   从零重来的那一跳不许再探测：否则又拿到同一个 size，无限递归
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

      if (status >= 300 && status < 400 && res.headers.location) {
        req.destroy()
        // Location 可能是相对路径（如 /api/resolve-cache/...），必须解析为绝对 URL
        const redirectUrl = new URL(res.headers.location, url).href
        downloadFileFromUrl(redirectUrl, file, repo, root, id, onLine, onProgress, resumeFrom).then(resolve)
        return
      }

      // 非 2xx，报错，不写盘
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

      // content-type 是 HTML，这是错误页面，不是要下的文件
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

      // 服务器不支持 Range，从零重来（不再探测 .tmp，否则无限递归）
      if (resumeFrom > 0 && status !== 206) {
        resumeFrom = 0
        req.destroy()
        downloadFileFromUrl(url, file, repo, root, id, onLine, onProgress, 0, true).then(resolve)
        return
      }

      // 本次响应声明的长度：带 Range 时它是剩余部分，不是整个文件。
      //   不判 status !== 206 会怎样：hf 对 Range 请求仍返回 200 时会重下整份。
      const contentLength = Number(res.headers['content-length'] || 0)
      const startOffset = resumeFrom

      // Range 续传时接着写（'a'），从零或不支持 Range 时从头写（'w'）
      const flags = resumeFrom > 0 ? 'a' : 'w'
      const out = fs.createWriteStream(tmpPath, { flags })
      let downloaded = resumeFrom

      // 任何失败都删掉不完整的 .tmp：不留脏文件让下一次误判成 partial
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
        if (typeof onProgress === 'function') {
          const total = expectedSize > 0 ? expectedSize : (startOffset + contentLength)
          if (total > 0) {
            try {
              onProgress({
                file: file.name,
                percent: Math.min(100, Math.round((downloaded / total) * 100)),
                downloaded: downloaded,
                total: total,
              })
            } catch (e) { /* 忽略 */ }
          }
        }
      })
      res.on('end', () => {
        out.end(async () => {
          // 大小校验：远端给了大小就逐字节比对，不符即判失败并删掉脏文件
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
            // 远端没给大小，退一步比对响应声明的 content-length
            dropTmp()
            resolve(sizeMismatch(contentLength, 'the server'))
            return
          }
          // 计算实际 SHA-256（不用远端 blobId，因为不是真实哈希）
          const actualSha256 = await sha256File(tmpPath)
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

//  downloadFile：下载单个文件（入口函数，构建 URL 后调用 downloadFileFromUrl）
//  URL 编码：对 file.name 的每个路径部分编码，但保留 / 作为路径分隔符
//  分支名：优先使用传入的 branch，否则依次尝试 main、master
//  404 重试：当前分支 404 时自动尝试下一个分支
function encodeFilePath (filePath) {
  if (!filePath) return ''
  return filePath.split('/').map(encodeURIComponent).join('/')
}

function tryDownloadWithBranches (file, repo, root, id, onLine, onProgress, branches) {
  if (!branches || branches.length === 0) {
    return Promise.resolve({
      ok: false,
      code: 'ALL_BRANCHES_FAILED',
      status: null,
      error: 'All branch attempts failed (tried: main, master).',
      errorZh: '所有分支尝试均失败（已尝试：main、master）。',
    })
  }
  const [currentBranch, ...rest] = branches
  const encodedName = encodeFilePath(file.name)
  const url = `https://huggingface.co/${repo}/resolve/${currentBranch}/${encodedName}`
  return downloadFileFromUrl(url, file, repo, root, id, onLine, onProgress, 0).then((result) => {
    if (result.ok || !result.status || result.status !== 404) {
      return result
    }
    return tryDownloadWithBranches(file, repo, root, id, onLine, onProgress, rest)
  })
}

function downloadFile (file, repo, root, id, onLine, onProgress, branch) {
  const branches = branch ? [branch] : ['main', 'master']
  return tryDownloadWithBranches(file, repo, root, id, onLine, onProgress, branches)
}

/**
 * 删掉不完整的文件，让它回到 missing 以便重下。
 *
 * 只删确实残缺的，缺信息不等于残缺。
 *    「删 ok 会让使用者白下一遍」比「漏删一个不完整的文件」严重得多：前者毁掉
 *    已经下完的数 GB，后者只是下次重下时多等一会儿。所以判据从严：
 *
 *    一、上游给了 sha 且与本地的相符 ⇒ 这个文件的内容是真的，不删
 *    二、没有 sha 可比对（上游没给、或调用方没传）时，只能用大小，
 *       而大小对得上不代表内容对（写入中断留下的文件大小也可能凑巧一致）。
 *       这种情况不删，报 NEEDS_VERIFY 让使用者自己确认。
 *    三、只有 .tmp、或文件中途断了（大小介于 0 与上游大小之间）、
 *       或大小为 0 ⇒ 明确残缺，删
 *    四、上游给了 sha 且不符 ⇒ 明确损坏，删
 *
 * @param {Array<{name:string, size?:number, sha256?:string}>} files 要删的文件
 * @param {string} root 项目根
 * @param {string} id 引擎 id
 * @returns {Promise<{deleted: string[], skipped: {name:string, status:string, code?:string}[], bytes: number}>}
 */
async function removePartialFiles (files, root, id) {
  const deleted = []
  const skipped = []
  let bytes = 0
  const dir = path.join(root, 'engines', String(id || ''), 'checkpoints')
  for (const f of (files || [])) {
    const name = f && typeof f === 'object' ? f.name : f
    const size = f && typeof f === 'object' ? (f.size || null) : null
    const sha = f && typeof f === 'object' ? (f.sha256 || null) : null
    const finalPath = path.join(dir, name)
    const tmpPath = finalPath + '.tmp'

    // 正式文件不存在，只有 .tmp ⇒ 明确残缺
    const hasFinal = fs.existsSync(finalPath)
    const hasTmp = fs.existsSync(tmpPath)
    if (!hasFinal && !hasTmp) { skipped.push({ name, status: 'missing' }); continue }
    if (!hasFinal && hasTmp) {
      // 只有临时文件，没有别的可判断
      try { bytes += fs.statSync(tmpPath).size; fs.rmSync(tmpPath, { force: true }) } catch (e) {}
      deleted.push(name)
      continue
    }

    const stat = fs.statSync(finalPath)
    // 文件是空的，或比上游说的大小小 ⇒ 下载真中断了。
    // 只在没有 sha 可比对时才用大小判断：有 sha 就由 sha 说话，
    //    大小差一点更可能是上游给错、或单位/换算问题，不该因此毁掉文件。
    if (!sha && (stat.size === 0 || (size && stat.size < size))) {
      for (const p of [finalPath, tmpPath]) {
        try {
          if (fs.existsSync(p)) { bytes += fs.statSync(p).size; fs.rmSync(p, { force: true }) }
        } catch (e) { /* 删不掉的留给下一次续传 */ }
      }
      deleted.push(name)
      continue
    }

    // 有 sha 可比对：不符就是坏了，删
    if (sha) {
      const actual = await sha256File(finalPath)
      if (actual !== sha) {
        for (const p of [finalPath, tmpPath]) {
          try {
            if (fs.existsSync(p)) { bytes += fs.statSync(p).size; fs.rmSync(p, { force: true }) }
          } catch (e) { /* 删不掉的留给下一次续传 */ }
        }
        deleted.push(name)
        continue
      }
      skipped.push({ name, status: 'ok' })
      continue
    }

    // 走到这里：文件在、大小也凑得上，但没有 sha 能证明内容是好的。
    // 缺信息不等于残缺，不删，如实报需要校验。
    skipped.push({ name, status: 'needs-verify', code: 'NEEDS_VERIFY' })
  }
  return { deleted, skipped, bytes }
}

module.exports = { runDownload, unifyDest, readProgress, writeProgress, resetProgress, fetchRemoteManifest, checkFileStatus, enrichManifestFiles, removePartialFiles, downloadFile, downloadFileFromUrl, parseDownloadProgress, parseSize }