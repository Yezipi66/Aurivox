'use strict'
// 第 3 步下载 HF 上需要授权的仓库时用的访问令牌（HF token）。
//
// 只存本机：<写根>/state/hf-token。state/ 整个被 .gitignore 排除；
//   令牌是使用者个人的凭据，不进名片、不进日志、不出现在任何 HTTP 响应里。
//   界面只需要知道「配置了没有」，所以对外只暴露 hasToken。
// 文件权限 600：同一台电脑上的其他账号读不到。Windows 上 chmod 只能控制只读位，
//   那里靠的是用户目录本身的访问控制。
// 根用写根（wizardRoot.writeRoot）：与本机测得的超时同一处，worktree 里试运行时
//   不会写到主仓库去。根不从请求里取：请求带来的 root 可以是任意路径。

const fs = require('node:fs')
const path = require('node:path')
const { writeRoot } = require('./wizardRoot')

const FILE_NAME = path.join('state', 'hf-token')

// HF 的令牌是 hf_ 开头的一串字母数字；这里只挡明显不对的输入（空、带空白、过长），
//   不按前缀判：前缀规则由 HF 定，以后可能变，判错了会把真令牌拒掉。
const MAX_LEN = 512

function tokenPath (rootDir) {
  const root = rootDir || writeRoot()
  return root ? path.join(root, FILE_NAME) : null
}

/**
 * 校验一个待保存的令牌。返回 null 表示可以保存，否则返回中英文原因。
 * 原因里不带令牌本身：错误信息会显示在界面上，也可能被转写进日志。
 */
function validateToken (token) {
  if (typeof token !== 'string' || !token.trim()) {
    return { code: 'EMPTY_TOKEN', error: 'The token is empty.', errorZh: '令牌为空。' }
  }
  const t = token.trim()
  if (t.length > MAX_LEN || /\s/.test(t)) {
    return { code: 'BAD_TOKEN', error: 'This does not look like an access token.',
      errorZh: '这不像一个访问令牌，请检查是否复制完整。' }
  }
  return null
}

/** 读令牌；没有、读不出、内容为空都返回 null。 */
function readToken (rootDir) {
  const p = tokenPath(rootDir)
  if (!p) return null
  let t
  try { t = fs.readFileSync(p, 'utf8').trim() } catch { return null }
  return t || null
}

function hasToken (rootDir) {
  return readToken(rootDir) !== null
}

/**
 * 保存令牌。先写临时文件再改名，临时文件建出来时就是 600，
 *   不会有一瞬间以默认权限躺在盘上。
 * @returns {{ok:boolean, code?:string, error?:string, errorZh?:string}}
 */
function writeToken (token, rootDir) {
  const bad = validateToken(token)
  if (bad) return { ok: false, ...bad }
  const p = tokenPath(rootDir)
  if (!p) return { ok: false, code: 'NO_ROOT', error: 'Cannot locate the local state folder.',
    errorZh: '找不到本机记录目录。' }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.tmp.${process.pid}`
    fs.writeFileSync(tmp, token.trim() + '\n', { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(tmp, 0o600) } catch { /* Windows 上只认只读位 */ }
    fs.renameSync(tmp, p)
    try { fs.chmodSync(p, 0o600) } catch { /* 同上 */ }
  } catch (e) {
    // e.message 只含路径与系统错误，不含令牌
    return { ok: false, code: 'WRITE_FAILED', error: `Could not save the token: ${e.message}`,
      errorZh: `令牌保存失败：${e.message}` }
  }
  return { ok: true }
}

/** 删掉令牌；本来就没有也算成功。 */
function clearToken (rootDir) {
  const p = tokenPath(rootDir)
  if (!p) return { ok: true }
  try { fs.rmSync(p, { force: true }) } catch (e) {
    return { ok: false, code: 'DELETE_FAILED', error: `Could not remove the token: ${e.message}`,
      errorZh: `令牌删除失败：${e.message}` }
  }
  return { ok: true }
}

module.exports = { FILE_NAME, tokenPath, validateToken, readToken, hasToken, writeToken, clearToken }
