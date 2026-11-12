// 第 1 步的两个判定，抽成纯函数以便单测（界面只负责渲染）。
//
// 为什么需要这两条判据：
//   完成状态来自后端读盘（GET /wizard/install-state?id=…），而界面上的目录名来自输入框。
//   两者一旦不是同一个 id，就会出现「没克隆也显示已克隆到 engines/<某个目录>/」：
//   持久段里留着上一次的目录名，粘一个新仓库的链接，解析不会覆盖它，
//   而完成状态按旧目录名去问，旧目录确实存在 ⇒ 第 1 步直接亮成已完成。
//
//   撤销克隆同理：按钮要删的是 engines/<目录名> 整棵（含环境与权重）。
//   只要目录名指向一台早就装好的引擎，按钮就不该出现。

/**
 * 第 1 步是否完成。
 *
 * 三个条件缺一不可：后端说准备完成、问的是当前目录名、目录名非空。
 * 只信 facts.prepare 会在目录名与 facts 不同源时把一台旧引擎的状态显示在新仓库上。
 *
 * @param {{facts?:object, factsId?:string|null, curId?:string}} p
 * @returns {boolean}
 */
export function cloneDone ({ facts, factsId, curId } = {}) {
  if (!facts || facts.prepare !== true) return false
  if (!curId) return false
  return factsId === curId
}

/**
 * 能不能显示「撤销克隆」。
 *
 * 只认本次真的克隆出来的那份：cloneRes 里记着克隆用的 id，且不是「复用」。
 * 复用的意思是目录本来就在（使用者自己放进去的，或上一次装的），删它等于删掉
 * 一台已经接入的引擎，与按钮上写的「撤销克隆」不是一件事。
 *
 * @param {object|null} cloneRes 上次克隆的结果
 * @param {string} curId 当前目录名
 * @returns {boolean}
 */
export function canUndoClone (cloneRes, curId) {
  if (!cloneRes || cloneRes.ok !== true) return false
  if (cloneRes.reused === true) return false
  if (!cloneRes.id || !curId) return false
  return cloneRes.id === curId
}
