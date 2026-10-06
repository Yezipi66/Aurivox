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
const path = require('node:path')

/**
 * 执行一条下载命令（异步流式）。
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
    const child = spawn(argv[0], argv.slice(1), {
      cwd: input.root || process.cwd(),
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

module.exports = { runDownload, unifyDest }