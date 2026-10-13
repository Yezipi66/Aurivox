// ============================================================================
//  目录名的唯一来源
//
//  ⛔⛔ 2026-10-13 Owner 真机抓到：同一屏上**两个 id** ——
//    「本操作会将 speech-kit 项目克隆到本地的 engines/speech-kit」（文案用输入框里的新值）
//    「engines/last-installed/ already has 25 item(s)」（克隆请求用 localStorage 里的旧值）
//  根因：克隆请求体写的是 `id: idInput || state.id`，输入框一空就退化到
//    state.id，而它是**上一次安装**留下的（wz 持久化在 localStorage）。
//
//  ⇒ 目录名只有两个合法来源，⛔ 没有第三个：
//      ① 用户在输入框里敲的（typed）
//      ② 链接解析出来的仓库名（suggested）—— 留空就用它
//  ⭐ 持久段里的旧 id **不是来源**：那是上一次的结果，拿它顶进来
//    就等于拿另一个引擎的目录名去克隆。
//     判据：改目录名时，命令 / 目标路径 / 克隆请求必须一起变。
// ============================================================================

/**
 * 目录名最终用哪个 —— 输入框优先，留空则用仓库名。
 *
 * ⛔ 签名里**没有**「旧持久值」这一位。不是忘了加：加一个就会再漂一次。
 *    持久段（localStorage）里的 id 只在**解析成功 / 克隆成功**时由响应写回，
 *    ⛔ 不作为任何计算的输入。
 *
 * @param {{typed?:string, suggested?:string}} src
 * @returns {string} 两端都可能为空 ⇒ 返回空串（调用方不许拿空串发请求）
 */
export function folderName ({ typed, suggested } = {}) {
  const a = String(typed == null ? '' : typed).trim()
  if (a) return a
  return String(suggested == null ? '' : suggested).trim()
}
