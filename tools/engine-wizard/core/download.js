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

module.exports = { runDownload, unifyDest, readProgress }