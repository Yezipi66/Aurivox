// downloadState.js — 第 3 步下载状态的**门面**（内部走 useInstallSession）
//
// 2026-10-12 Owner 裁决「统一重构持久化」：这里原来自己抄了一份
//    localStorage 读写（键 wizard:download:<id>）。现在三处收敛到同一个
//    editor/useInstallSession.js，本文件只保留导出名（StepsExtra.jsx 在用），
//    内部改走会话段。
//
// 判据（防串号）：键里含 id **与 url**。原来只按 id 分键 ⇒ 换 URL 后
//    仍显示旧仓库的下载清单（真机踩过）。所以本门面的签名多了 url：
//      loadDownloadState(id, url) / saveDownloadState(id, url, state)
//    url 省不掉：省了就没有防串号那一层。
//
// 落在 sessionStorage 而不是 localStorage：这些是**探测结果**，
//    按裁决 ② 不持久化到 localStorage，但退出网页 / 下一次扫描前要在。

import { loadSession, saveSession, clearSession } from './useInstallSession.js'

/** 从会话段读下载状态（manifest / probeError / dedup 三项） */
export function loadDownloadState (id, url) {
  if (!id) return null
  const s = loadSession(id, url)
  if (!s) return null
  // 三项都没有 ⇒ 等于没存过（读 null 让调用方走「新开一页」那条路）
  if (s.manifest == null && s.probeError == null && s.dedup === true) return null
  return { manifest: s.manifest, probeError: s.probeError, dedup: s.dedup }
}

/** 存下载状态到会话段 */
export function saveDownloadState (id, url, state) {
  if (!id || !state) return
  saveSession(id, url, {
    manifest: state.manifest === undefined ? undefined : state.manifest,
    probeError: state.probeError === undefined ? undefined : state.probeError,
    dedup: state.dedup === undefined ? undefined : state.dedup,
  })
}

/** 清掉这一段会话（换引擎 / 换 URL 时主动丢） */
export function clearDownloadState (id, url) {
  if (!id) return
  clearSession(id, url)
}
