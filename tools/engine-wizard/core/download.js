'use strict'

// 引擎安装向导的下载层：执行下载命令、拉远端文件清单、续传与完整性核对。
// 下载走异步流式：一次下载要几分钟到几十分钟，同步调用会阻塞到结束。
// 统一落盘到 engines/<id>/checkpoints/；只负责下载，不管装环境。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')

/** 进度文件：每个引擎目录下记录已完成的下载命令，本文件只操作 models 段。 */
const { progressFile, readProgress: readProgressOf, writeProgress: writeProgressOf,
  resetProgress: resetProgressOf } = require('./installState')
// 落盘路径只有一处答案：core/checkpointsPath.js。
const { checkpointsAbsPath } = require('./checkpointsPath')

function readProgress (root, id) {
  return readProgressOf(root, id, 'models')
}

function writeProgress (root, id, doneKeys) {
  writeProgressOf(root, id, 'models', doneKeys)
}

// 清空 models 段的进度记录：让这批命令重新下载，已下好的文件不动。
function resetProgress (root, id) {
  resetProgressOf(root, id, 'models')
}

// 解析 hf / modelscope 的 tqdm 风格进度行，返回 { file, percent, downloaded, total }，
// 不是进度行返回 null。parseSize 把「1.2GB」这类带单位的字符串转成字节数。
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
 * 把一条下载命令的 local_dir 替换成统一落盘路径 engines/<id>/checkpoints/。
 * 不删原目录：hf / modelscope 的缓存在那里，删了要重下。
 *
 * @param {string[]} argv     原始命令
 * @param {string} engineId   引擎 id
 * @param {string} root       项目根
 * @returns {string[]}        替换后的 argv
 */
function unifyDest (argv, engineId, root) {
  const dest = checkpointsAbsPath(root, engineId)
  const out = argv.slice()
  for (let i = 0; i < out.length; i++) {
    if (/^--local-dir[=\s]/.test(out[i])) {
      out[i] = out[i].replace(/^--local-dir[=\s]\S+/, `--local-dir=${dest}`)
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '--local_dir' && i + 1 < out.length) {
      out[i + 1] = dest
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (/local_dir\s*=/.test(out[i])) {
      out[i] = out[i].replace(/local_dir\s*=\s*['"][^'"]*['"]/, `local_dir='${dest}'`)
    }
  }
  return out
}

/**
 * 请求 HF / ModelScope 的仓库 API，取回远端文件清单。
 * @returns {Promise<{ok:boolean, files:Array<{name:string,size:number,blobId?:string|null,sha256?:string|null}>, error:string|null}>}
 *   HF 的接口要带 ?blobs=true 才返回 size 与 blobId；ModelScope 的接口直接给 size 与 sha256。
 *   请求失败、超时都返回 ok=false 与 error，不抛。
 */
function fetchRemoteManifest (repo, tool, baseUrl) {
  return new Promise((resolve) => {
    const base = baseUrl || (tool === 'modelscope' ? 'https://modelscope.cn' : 'https://huggingface.co')
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
          if (data.siblings) {
            for (const s of data.siblings) {
              files.push({
                name: s.rfilename,
                size: s.size || 0,
                blobId: s.blobId || null,
              })
            }
          }
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
 * base64 转 hex。HF 的接口给 hex 格式的 SHA-256，ModelScope 可能给 base64，
 * 统一转成 hex 才能逐字比对。
 */
function base64ToHex (b64) {
  try {
    const buf = Buffer.from(b64, 'base64')
    return buf.toString('hex')
  } catch (e) { return b64 }
}

/**
 * 判断一个模型文件在盘上的状态。
 * @returns {Promise<{status:'ok'|'partial'|'missing', size:number, sha256:string|null,
 *   shaVerified?:boolean, expectedSha?:string, note?:string, noteZh?:string}>}
 *   'ok' 表示正式文件存在、大小与远端一致、且有上游 SHA-256 时比对通过。
 *   远端没给大小时一律报 'partial'：无法确认完整性，报 'ok' 就是假绿灯。
 *   大小不符、与上游 SHA-256 不符、只有 .tmp 残留，都是 'partial'（要重下）。
 *   SHA-256 只在两边都有时才比对：上游没给就只报实际算出的值。
 */
async function checkFileStatus (file, expectedSize, root, id, expectedSha) {
  const dir = checkpointsAbsPath(root, id)
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
    // 上游给了 sha 就必须比对：大小对但内容是坏的（写入中断、磁盘出错），只看大小会当成好的，
    // 装上之后在推理阶段才炸。
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

/**
 * 给远端文件清单补上本地状态与来源。
 * @returns {Promise<Array<{name:string,size:number,sha256:string|null,status:string,
 *   shaVerified:boolean,repo:string,tool:string,note:string|null,noteZh:string|null}>>}
 *   每一条 = 远端给的事实（name / size）+ 本地查出来的状态（status / sha256）。
 *   必须带 repo 与 tool：前端单文件下载完成后会重新调 /wizard/download/manifest 刷新，
 *   而刷新是整表替换，不带来源就等于把每一项「属于哪个仓库」抹掉，仓库列与重下、续传按钮会一起失效。
 */
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

/**
 * 从指定 URL 下载一个文件，写入 .tmp 后改名成正式文件。
 * @param {boolean} [skipTmpDetect] 内部用：不许外部传。从零重来时置 true，
 *   否则下一跳又会探测到同一个 .tmp，无限递归。
 * @returns {Promise<{ok:boolean, code:string, status:number|null, size?:number, sha256?:string, error?:string}>}
 *   非 2xx 一律不写盘：把 404 的 HTML 错误页当成模型文件落盘是最难查的一类坏法。
 *   下载完比对大小：远端没给大小就退一步比对 content-length，不符即删掉脏文件并判失败。
 */
function downloadFileFromUrl (url, file, repo, root, id, onLine, onProgress, resumeFrom = 0, skipTmpDetect = false, signal = null) {
  return new Promise((resolve) => {
    const dir = checkpointsAbsPath(root, id)
    const finalPath = path.join(dir, file.name)
    const tmpPath = finalPath + '.tmp'

    const expectedSize = Number(file && file.size ? file.size : 0)

    // 取消：信号在请求发出前就被触发 ⇒ 什么都不做，直接报取消。
    //   不留半截文件，也不把半截文件当成续传起点。
    if (signal && signal.aborted) {
      resolve({ ok: false, code: 'CANCELLED', status: null,
        error: 'Download was cancelled.', errorZh: '下载已取消。' })
      return
    }

    try { fs.mkdirSync(path.dirname(finalPath), { recursive: true }) } catch (e) {
      resolve({ ok: false, code: 'MKDIR_FAILED', status: null, error: e.message })
      return
    }

    // 检查 .tmp 文件大小，作为续传起点。
    // 从零重来的那一跳不许再探测：否则又拿到同一个 size，无限递归
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
        downloadFileFromUrl(redirectUrl, file, repo, root, id, onLine, onProgress, resumeFrom, skipTmpDetect, signal).then(resolve)
        return
      }

      // 非 2xx，报错，不写盘：把 404/403/500 的响应体写盘、重命名、报 ok:true 的话，
      // 404 的 HTML 错误页会被当成模型文件落盘。
      if (status < 200 || status >= 300) {
        res.resume()
        resolve({
          ok: false, code: `HTTP_${status}`, status,
          error: `The server answered HTTP ${status} for ${file.name}.`,
          errorZh: `服务器对 ${file.name} 返回 HTTP ${status}。`,
        })
        return
      }

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

      if (resumeFrom > 0 && status !== 206) {
        resumeFrom = 0
        req.destroy()
        downloadFileFromUrl(url, file, repo, root, id, onLine, onProgress, 0, true).then(resolve)
        return
      }

      const contentLength = Number(res.headers['content-length'] || 0)
      const startOffset = resumeFrom

      const flags = resumeFrom > 0 ? 'a' : 'w'
      const out = fs.createWriteStream(tmpPath, { flags })
      let downloaded = resumeFrom

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
            dropTmp()
            resolve(sizeMismatch(contentLength, 'the server'))
            return
          }
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

    // 取消：中断 HTTP 请求，删掉半截文件，报 CANCELLED。
    //   删掉 .tmp 而不是留着：留着会被下一次下载当成续传起点，
    //   而使用者按下取消的意思是「这个文件别下了」，不是「下到一半留着」。
    if (signal) {
      const onAbort = () => {
        try { req.destroy() } catch (e) { /* 已结束 */ }
        try { fs.rmSync(tmpPath, { force: true }) } catch (e) { /* 删不掉就算了 */ }
        resolve({ ok: false, code: 'CANCELLED', status: null,
          error: 'Download was cancelled.', errorZh: '下载已取消。' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      // 请求自己结束时摘掉监听：否则 signal 上会一直挂着一个闭包，
      //   而 signal 本身要活到整轮下载结束，闭包越挂越多。
      const cleanup = () => {
        try { signal.removeEventListener('abort', onAbort) } catch (e) { /* 忽略 */ }
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
    }
  })
}

// 把文件路径的每一段分别编码，保留 / 作路径分隔符。
function encodeFilePath (filePath) {
  if (!filePath) return ''
  return filePath.split('/').map(encodeURIComponent).join('/')
}

// 依次尝试给定的分支：当前分支返回 404 才换下一个分支，其它结果原样返回。
function tryDownloadWithBranches (file, repo, root, id, onLine, onProgress, branches, signal = null) {
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
  return downloadFileFromUrl(url, file, repo, root, id, onLine, onProgress, 0, false, signal).then((result) => {
    if (result.ok || !result.status || result.status !== 404) {
      return result
    }
    return tryDownloadWithBranches(file, repo, root, id, onLine, onProgress, rest, signal)
  })
}

// 下载单个文件：拼好 URL 后交给 downloadFileFromUrl。
// 分支优先用传入的 branch，否则依次尝试 main 与 master。
function downloadFile (file, repo, root, id, onLine, onProgress, branch, signal = null) {
  const branches = branch ? [branch] : ['main', 'master']
  return tryDownloadWithBranches(file, repo, root, id, onLine, onProgress, branches, signal)
}

/**
 * 删掉不完整的文件，让它回到 missing 以便重下。
 *
 * 只删确实残缺的，缺信息不等于残缺：「删 ok 会让使用者白下一遍」比「漏删一个不完整的文件」
 * 严重得多，前者毁掉已经下完的数 GB，后者只是下次重下时多等一会儿。判据从严：
 *
 * 一、上游给了 sha 且与本地的相符 ⇒ 内容是真的，不删
 * 二、没有 sha 可比对时只能用大小，而大小对得上不代表内容对 ⇒ 不删，报 NEEDS_VERIFY 让使用者自己确认
 * 三、只有 .tmp、大小为 0、或比上游说的大小小 ⇒ 明确残缺，删
 * 四、上游给了 sha 且不符 ⇒ 明确损坏，删
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
  const dir = checkpointsAbsPath(root, id)
  for (const f of (files || [])) {
    const name = f && typeof f === 'object' ? f.name : f
    const size = f && typeof f === 'object' ? (f.size || null) : null
    const sha = f && typeof f === 'object' ? (f.sha256 || null) : null
    const finalPath = path.join(dir, name)
    const tmpPath = finalPath + '.tmp'

    const hasFinal = fs.existsSync(finalPath)
    const hasTmp = fs.existsSync(tmpPath)
    if (!hasFinal && !hasTmp) { skipped.push({ name, status: 'missing' }); continue }
    if (!hasFinal && hasTmp) {
      try { bytes += fs.statSync(tmpPath).size; fs.rmSync(tmpPath, { force: true }) } catch (e) {}
      deleted.push(name)
      continue
    }

    const stat = fs.statSync(finalPath)
    // 文件是空的，或比上游说的大小小 ⇒ 下载真中断了。
    // 只在没有 sha 可比对时才用大小判断：有 sha 就由 sha 说话，
    // 大小差一点更可能是上游给错、或单位换算问题，不该因此毁掉文件。
    if (!sha && (stat.size === 0 || (size && stat.size < size))) {
      for (const p of [finalPath, tmpPath]) {
        try {
          if (fs.existsSync(p)) { bytes += fs.statSync(p).size; fs.rmSync(p, { force: true }) }
        } catch (e) { /* 删不掉的留给下一次续传 */ }
      }
      deleted.push(name)
      continue
    }

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