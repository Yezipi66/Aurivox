'use strict'

// 引擎安装向导的下载层：执行下载命令、拉远端文件清单、续传与完整性核对。
// 下载走异步流式：一次下载要几分钟到几十分钟，同步调用会阻塞到结束。
// 落盘路径以名片 runtime.checkpoints 为准，名片没写才用 engines/<id>/checkpoints/；
// 只负责下载，不管装环境。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')

// 进度按段记：本文件只操作 models 段，别段的进度不在这里读写。
const { progressFile, readProgress: readProgressOf, writeProgress: writeProgressOf,
  resetProgress: resetProgressOf } = require('./installState')
// 落盘路径由 checkpointsPath 统一算，不在各调用点拼。
const { resolveCheckpointsRel } = require('./checkpointsPath')
// 授权错误时的许可门槛说明，与第 4 步同一段文案。
const { LICENSE_GATE_NOTE } = require('./models')

// 两个来源的站点根。测试把它换成本地服务器，生产代码不改它。
const ENDPOINTS = { hf: 'https://huggingface.co', modelscope: 'https://modelscope.cn' }

/**
 * 把调用方给的来源归一成 'hf' 或 'modelscope'；认不出返回 null。
 *   认不出不许默认成 HF：同一个仓库名在两边可能都存在，下错来源时
 *   症状是 401 或文件内容不一致，查起来比当场报「来源未知」难得多。
 *   'snapshot' 只是命令形态（snapshot_download），本身不说明来源，同样返回 null。
 */
function normalizeSource (tool) {
  const t = String(tool || '').trim().toLowerCase()
  if (t === 'hf' || t === 'huggingface' || t === 'huggingface_hub') return 'hf'
  if (t === 'modelscope') return 'modelscope'
  return null
}

function unknownSourceResult (tool) {
  return {
    ok: false, code: 'UNKNOWN_SOURCE', status: null,
    error: `Unknown download source ${JSON.stringify(tool || '')}: choose Hugging Face or ModelScope.`,
    errorZh: `下载来源未知（${tool || '空'}），请选择 Hugging Face 或魔搭（ModelScope）。`,
  }
}

function missingRepoResult () {
  return {
    ok: false, code: 'MISSING_REPO', status: null,
    error: 'The repository is missing for this file.',
    errorZh: '这个文件缺少所属仓库，无法下载。',
  }
}

/** HF 仓库的网页地址：授权失败时给使用者去登录、接受许可协议的地方。 */
function hfRepoPage (repo) {
  return `${ENDPOINTS.hf}/${repo}`
}

/**
 * HF 以 401 / 403 拒绝时的结果。三种情形分开说，因为使用者要做的事不同：
 *   没配令牌            ⇒ 填令牌
 *   配了令牌但 401      ⇒ 令牌无效或过期，换一个
 *   配了令牌但 403      ⇒ 令牌有效但这个账号没有权限，通常是还没在仓库页接受许可协议
 * 结果里只有 tokenConfigured（布尔），没有令牌本身。
 */
function gatedResult (status, repo, tokenConfigured, fileName) {
  const repoPage = hfRepoPage(repo)
  let reason = 'NO_TOKEN'
  if (tokenConfigured) reason = status === 401 ? 'TOKEN_REJECTED' : 'LICENSE_NOT_ACCEPTED'
  const name = fileName ? `${fileName}: ` : ''
  const nameZh = fileName ? `${fileName}：` : ''
  const msg = {
    NO_TOKEN: [
      `${name}this Hugging Face repository requires authorization. Enter the HF access token.`,
      `${nameZh}这个 Hugging Face 仓库需要授权，请填写 HF 访问令牌。`,
    ],
    TOKEN_REJECTED: [
      `${name}Hugging Face rejected the saved token (HTTP 401). It may be invalid or expired; replace it.`,
      `${nameZh}Hugging Face 拒绝了已保存的令牌（HTTP 401），令牌可能无效或已过期，请更换。`,
    ],
    LICENSE_NOT_ACCEPTED: [
      `${name}${LICENSE_GATE_NOTE.en} The saved token is valid but has no access yet: `
        + `open ${repoPage}, sign in and accept the license, then retry. `
        + 'The ModelScope mirror can also be downloaded instead, if there is one.',
      `${nameZh}${LICENSE_GATE_NOTE.zh}已保存的令牌有效，但这个账号还没有访问权限：`
        + `请打开 ${repoPage} 登录并接受许可协议后重试。也可以改用魔搭（ModelScope）上的镜像（如有）。`,
    ],
  }[reason]
  return {
    ok: false, code: 'GATED', status, reason, tokenConfigured: !!tokenConfigured,
    repo, repoPage,
    licenseNote: LICENSE_GATE_NOTE.en, licenseNoteZh: LICENSE_GATE_NOTE.zh,
    error: msg[0], errorZh: msg[1],
  }
}

/**
 * 只对同源请求带令牌：HF 的 resolve 地址会 302 到 CDN（另一个域名，自带签名），
 *   把令牌跟着重定向发过去等于把它交给第三方，而且 CDN 见到两套鉴权会直接拒绝。
 */
function authHeaders (url, auth) {
  if (!auth || !auth.token || !auth.origin) return {}
  let origin
  try { origin = new URL(url).origin } catch { return {} }
  return origin === auth.origin ? { authorization: `Bearer ${auth.token}` } : {}
}

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
// 不是进度行返回 null。
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

// 带单位的大小字符串转成字节数，认不出单位返回 0。
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
 * 权重落点：名片写了 runtime.checkpoints 就用它，没写才用统一落点。
 * 第 3 步写盘、第 4 步声明、第 5 步判定要落在同一处，否则「下好了」与
 * 「目录不存在」会同时出现。
 */
function weightsDir (root, id) {
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'engines', String(id), 'manifest.json'), 'utf8'))
  } catch (e) { manifest = null }
  const rel = resolveCheckpointsRel(manifest, id)
  return rel ? path.join(root, rel) : null
}

/**
 * 一个仓库的文件可以落在 checkpoints 下的子目录里（上游常把可选的模型并排放）。
 * subdir 只认相对路径：带盘符、带 .. 的一律当没有，不让下载把文件写到别处。
 */
function weightsSubdir (value) {
  const parts = String(value == null ? '' : value)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.')
  if (parts.some((s) => s === '..' || /^[A-Za-z]:/.test(s))) return ''
  return parts.join('/')
}

/**
 * 下载位置是否可用。只接受权重目录内的相对路径。
 * 入口先判一次，避免非法值被 weightsSubdir 清空后悄悄落到权重根。
 */
function subdirIsSafe (value) {
  const raw = String(value == null ? '' : value)
  if (!raw) return true
  if (/^[/\\]/.test(raw)) return false
  return raw.replace(/\\/g, '/').split('/')
    .every((s) => s !== '..' && !/^[A-Za-z]:/.test(s))
}

/**
 * 一个远端文件该写到哪个绝对路径。
 * 落点 = 名片声明的 checkpoints + 这个仓库的子目录 + 仓库内的文件名。
 *
 * @param {string} root    项目根
 * @param {string} id      引擎 id
 * @param {string} subdir  仓库的子目录（可为空）
 * @param {string} name    仓库内的名字（可能自带子目录）
 * @returns {string|null}  无法确定落点时为 null
 */
function destPath (root, id, subdir, name) {
  const dir = weightsDir(root, id)
  if (!dir) return null
  const sub = weightsSubdir(subdir)
  return sub ? path.join(dir, sub, String(name || '')) : path.join(dir, String(name || ''))
}

/**
 * 请求 HF / ModelScope 的仓库 API，取回远端文件清单。
 * @returns {Promise<{ok:boolean, files:Array<{name:string,size:number,blobId?:string|null,sha256?:string|null}>, error:string|null}>}
 *   HF 的接口要带 ?blobs=true 才返回 size 与 blobId；ModelScope 的接口直接给 size 与 sha256。
 *   请求失败、超时都返回 ok=false 与 error，不抛。
 */
function fetchRemoteManifest (repo, tool, baseUrl, opts = {}) {
  return new Promise((resolve) => {
    const source = normalizeSource(tool)
    if (!source) {
      const r = unknownSourceResult(tool)
      resolve({ ok: false, files: [], code: r.code, status: null, error: r.error, errorZh: r.errorZh })
      return
    }
    tool = source
    const base = baseUrl || ENDPOINTS[source]
    // ModelScope 的文件清单在 /repo/files 下：/api/v1/models/<repo> 只回模型简介，
    //   没有 Data.Files，清单永远是空的（端到端验收时 neuphonic 的镜像就是这样「没有文件」）。
    const url = tool === 'modelscope'
      ? `${base}/api/v1/models/${repo}/repo/files?Recursive=true`
      : `${base}/api/models/${repo}?blobs=true`
    const client = url.startsWith('http:') ? require('node:http') : https
    // 令牌只给 HF 的清单请求：私有仓库不带令牌连清单都列不出来。
    const auth = source === 'hf' && opts.token ? { token: opts.token, origin: new URL(base).origin } : null
    const req = client.get(url, {
      headers: { 'user-agent': 'aurivox-engine-wizard', ...authHeaders(url, auth) },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve({ ok: false, files: [], status: res.statusCode, error: `API returned HTTP ${res.statusCode}` })
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
              // 递归清单里有目录项（Type: tree），只要文件
              if (f.Type && f.Type !== 'blob') continue
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
async function checkFileStatus (file, expectedSize, root, id, expectedSha, subdir = '') {
  const finalPath = destPath(root, id, subdir, file)
  const tmpPath = finalPath + '.tmp'
  // 同名文件已经存在又没有 .tmp 续传标记时，它可能来自另一个仓库。
  //   只在清单里说清楚，不替使用者判断哪一份才对，也不自动覆盖。
  const otherSource = fs.existsSync(finalPath) && !fs.existsSync(tmpPath)
  const keptEn = ' An existing file with this name was kept; it may belong to another repository. Delete it first to replace it.'
  const keptZh = ' 已存在同名文件且没有续传标记，可能是另一个仓库下载的；平台保留未覆盖，需要替换时先删除。'

  if (fs.existsSync(finalPath)) {
    const stat = fs.statSync(finalPath)
    // 远端没给大小，无从比对，不能当作已下载完成
    if (!expectedSize) {
      return {
        status: 'partial',
        size: stat.size,
        sha256: await sha256File(finalPath),
        note: 'The remote file list gives no size for this file — completeness cannot be confirmed.' + (otherSource ? keptEn : ''),
        noteZh: '远端文件列表没有给出这个文件的大小，无法确认完整性。' + (otherSource ? keptZh : ''),
      }
    }
    if (stat.size !== expectedSize) {
      return {
        status: 'partial',
        size: stat.size,
        sha256: await sha256File(finalPath),
        note: 'The file on disk does not match the size the remote file list reports.' + (otherSource ? keptEn : ''),
        noteZh: '磁盘上的文件和远端文件列表给出的大小不一致。' + (otherSource ? keptZh : ''),
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
        note: 'The file size matches but its SHA-256 differs from the value the remote reports.' + (otherSource ? keptEn : ''),
        noteZh: '文件大小一致，但 SHA-256 与远端给出的不一致，内容已损坏。' + (otherSource ? keptZh : ''),
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
async function enrichManifestFiles (files, repo, tool, root, id, subdir = '') {
  const results = []
  for (const f of (files || [])) {
    const st = await checkFileStatus(f.name, f.size, root, id, f.sha256 || null, subdir)
    results.push({
      name: f.name, size: f.size, sha256: st.sha256 || f.sha256 || null, status: st.status,
      shaVerified: st.shaVerified === true,
      repo, tool, subdir,
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
// 连接被重置、超时一类的瞬时故障：已经写入的字节仍然有效，可以从 .tmp 续传。
//   写盘错误、HTTP 错误、主动取消不属于这一类，不重试。
const TRANSIENT_NET_RE = /ECONNRESET|ETIMEDOUT|EPIPE|ECONNABORTED|EAI_AGAIN|socket hang up|timed out/i
const MAX_RESUME_RETRIES = 6

function isTransientNetworkError (e) {
  return TRANSIENT_NET_RE.test(`${(e && e.code) || ''} ${(e && e.message) || ''}`)
}

function downloadFileFromUrl (url, file, repo, root, id, onLine, onProgress, resumeFrom = 0, skipTmpDetect = false, signal = null, auth = null, attempt = 0) {
  return new Promise((resolve) => {
    const finalPath = destPath(root, id, (file && file.subdir) || '', file.name)
    const tmpPath = finalPath + '.tmp'
    let out = null
    // 网络中断时已写入的字节仍然有效。保留 .tmp，从当前大小续传，
    //   不把数 GB 的进度丢掉；没有可续传的字节或次数用完才如实报失败。
    const resumeAfterNetworkError = () => {
      if (attempt >= MAX_RESUME_RETRIES || (signal && signal.aborted)) return false
      let off = 0
      try { off = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0 } catch (e) { return false }
      if (off <= 0) return false
      try { if (out) out.destroy() } catch (e) { /* 已关闭 */ }
      if (typeof onLine === 'function') {
        try { onLine(`连接中断，从 ${off} 字节继续（第 ${attempt + 1} 次续传）。`, false) } catch (e) { /* 忽略 */ }
      }
      downloadFileFromUrl(url, file, repo, root, id, onLine, onProgress,
        off, true, signal, auth, attempt + 1).then((r) => {
        resolve({ ...r, resumeRetries: (Number(r.resumeRetries) || 0) + 1 })
      })
      return true
    }

    const expectedSize = Number(file && file.size ? file.size : 0)

    // 取消：信号在请求发出前就被触发 ⇒ 什么都不做，直接报取消。
    //   不留下未完成的文件，也不把未完成的文件当成续传起点。
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

    // auth 为 { token, origin }：只对 origin 同源的地址带 Authorization（见 authHeaders）。
    const headers = { 'user-agent': 'aurivox-engine-wizard', ...authHeaders(url, auth) }
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
        downloadFileFromUrl(redirectUrl, file, repo, root, id, onLine, onProgress, resumeFrom, skipTmpDetect, signal, auth, attempt).then(resolve)
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
        res.resume()
        // 续传请求拿到 200 说明服务端不认 Range。首次探测到 .tmp 时可以回到 0
        //   允许按原路径重新下载；重试走到这里说明续传不成立，删掉未完成的临时文件。
        if (attempt > 0) {
          try { fs.rmSync(tmpPath, { force: true }) } catch (e) { /* 删不掉就算了 */ }
          resolve({
            ok: false, code: 'SIZE_MISMATCH', status, size: resumeFrom,
            error: `Size mismatch for ${file.name}: the server did not honour the byte range.`,
            errorZh: `${file.name} 大小不符：服务端不支持按字节续传。`
          })
          return
        }
        req.destroy()
        downloadFileFromUrl(url, file, repo, root, id, onLine, onProgress, 0, true, signal, auth, attempt).then(resolve)
        return
      }

      const contentLength = Number(res.headers['content-length'] || 0)
      const startOffset = resumeFrom

      const flags = resumeFrom > 0 ? 'a' : 'w'
      out = fs.createWriteStream(tmpPath, { flags })
      let downloaded = resumeFrom

      const fail = (code, msg, keepTmp = false) => {
        try { if (out) out.destroy() } catch (e) { /* 已关闭 */ }
        if (!keepTmp) { try { fs.rmSync(tmpPath, { force: true }) } catch (e) { /* 删不掉就算了 */ } }
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
      res.on('error', (e) => {
        if (isTransientNetworkError(e) && resumeAfterNetworkError()) return
        fail('DOWNLOAD_ERROR', e.message)
      })
      out.on('error', (e) => { req.destroy(); fail('WRITE_ERROR', e.message) })
    })
    req.on('error', (e) => {
      if (isTransientNetworkError(e) && resumeAfterNetworkError()) return
      resolve({ ok: false, code: 'REQUEST_ERROR', status: null, error: e.message })
    })
    req.setTimeout(2 * 60 * 60 * 1000, () => {
      req.destroy()
      if (resumeAfterNetworkError()) return
      resolve({ ok: false, code: 'TIMEOUT', status: null, error: 'Download timed out' })
    })

    // 取消：中断 HTTP 请求，删掉未完成的文件，报 CANCELLED。
    //   删掉未完成的文件而不是保留：保留的文件会被下一次下载当成续传起点，
    //   而使用者按下取消的意思是「这个文件别下了」，不是「下到一半保留」。
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
      //   只挂 req：res 是 client.get 回调里的参数，在这一层拿不到。
      req.on('close', () => {
        try { signal.removeEventListener('abort', onAbort) } catch (e) { /* 忽略 */ }
      })
    }
  })
}

// 把文件路径的每一段分别编码，保留 / 作路径分隔符。
function encodeFilePath (filePath) {
  if (!filePath) return ''
  return filePath.split('/').map(encodeURIComponent).join('/')
}

// 依次尝试给定的分支：当前分支返回 404 才换下一个分支，其它结果原样返回。
function tryDownloadWithBranches (file, repo, root, id, onLine, onProgress, branches, signal = null, auth = null) {
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
  let url
  try { url = fileUrl(file, repo, currentBranch, encodedName) } catch (e) {
    return Promise.resolve(e.result || { ok: false, code: 'BAD_URL', status: null, error: e.message })
  }
  return downloadFileFromUrl(url, file, repo, root, id, onLine, onProgress, 0, false, signal, auth).then((result) => {
    if (result.ok || !result.status || result.status !== 404) {
      return result
    }
    return tryDownloadWithBranches(file, repo, root, id, onLine, onProgress, rest, signal, auth)
  })
}

// 单个文件的下载地址。file.tool 是清单那一步带下来的来源（enrichManifestFiles 写的）。
//   来源认不出、仓库为空都直接抛错（错误对象带 result，供调用方原样回给前端），
//   不拼一个 HF 地址碰运气：仓库为空时拼出的 huggingface.co//resolve/... 只会 404，
//   来源错了则是去另一个站点下同名仓库。
function fileUrl (file, repo, branch, encodedName) {
  const source = normalizeSource(file && file.tool)
  if (!source) {
    const r = unknownSourceResult(file && file.tool)
    const e = new Error(r.error)
    e.code = r.code
    e.result = r
    throw e
  }
  if (!repo) {
    const r = missingRepoResult()
    const e = new Error(r.error)
    e.code = r.code
    e.result = r
    throw e
  }
  if (source === 'modelscope') {
    return `${ENDPOINTS.modelscope}/models/${repo}/resolve/${branch}/${encodedName}`
  }
  return `${ENDPOINTS.hf}/${repo}/resolve/${branch}/${encodedName}`
}

/**
 * 下载单个文件：拼好 URL 后交给 downloadFileFromUrl。
 * 分支优先用传入的 branch，否则 HF 依次尝试 main 与 master，ModelScope 用 master。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.token] HF 令牌。只用于 HF 来源，且只发给 HF 站点本身。
 * @returns {Promise<object>} 与 downloadFileFromUrl 同形；HF 回 401 / 403 时改报 GATED（见 gatedResult）。
 */
function downloadFile (file, repo, root, id, onLine, onProgress, branch, signal = null, opts = {}) {
  const source = normalizeSource(file && file.tool)
  if (!source) return Promise.resolve(unknownSourceResult(file && file.tool))
  if (!repo) return Promise.resolve(missingRepoResult())
  // 多仓库下载时同名文件不许互相顶掉：README 常把权重拆在几个仓库里，
  //   其中一份是主权重、另一份只是补充文件。先下的那份是这份引擎的基准，
  //   后下的仓库里同名的大文件可能是另一套模型，静默覆盖会把装好的引擎换掉。
  //   判据只看盘：正式文件在、且没有同名的 .tmp ⇒ 认为已完成，只保留不覆盖；
  //   有 .tmp 说明是没下完的续传，照旧走下载。
  const finalPath = file && file.name ? destPath(root, id, file.subdir || '', file.name) : null
  const tmpPath = finalPath ? finalPath + '.tmp' : null
  if (finalPath && fs.existsSync(finalPath) && !fs.existsSync(tmpPath)) {
    const kept = {
      ok: true, code: 'KEPT_EXISTING', status: null, skipped: true,
      size: fs.statSync(finalPath).size,
      note: 'An existing file with this name was kept. It may have come from another repository; delete it first if this one is required.',
      noteZh: '已存在同名文件，保留未覆盖（可能来自另一个仓库）。确实要换成这一份时，请先删除该文件再下载。',
    }
    if (typeof onLine === 'function') onLine(kept.noteZh, false)
    return Promise.resolve(kept)
  }
  const token = source === 'hf' ? (opts.token || null) : null
  const auth = token ? { token, origin: new URL(ENDPOINTS.hf).origin } : null
  const branches = branch ? [branch]
    : (source === 'modelscope' ? ['master'] : ['main', 'master'])
  return tryDownloadWithBranches({ ...file, tool: source }, repo, root, id, onLine, onProgress, branches, signal, auth)
    .then((r) => {
      if (source === 'hf' && r && !r.ok && (r.status === 401 || r.status === 403)) {
        return gatedResult(r.status, repo, !!token, file.name)
      }
      return r
    })
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
  for (const f of (files || [])) {
    const name = f && typeof f === 'object' ? f.name : f
    const subdir = f && typeof f === 'object' ? (f.subdir || '') : ''
    const size = f && typeof f === 'object' ? (f.size || null) : null
    const sha = f && typeof f === 'object' ? (f.sha256 || null) : null
    const finalPath = destPath(root, id, subdir, name)
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

module.exports = { fileUrl, normalizeSource, gatedResult, hfRepoPage, ENDPOINTS, runDownload, readProgress, writeProgress, resetProgress, fetchRemoteManifest, checkFileStatus, enrichManifestFiles, removePartialFiles, downloadFile, downloadFileFromUrl, isTransientNetworkError, destPath, subdirIsSafe, parseDownloadProgress, parseSize }
