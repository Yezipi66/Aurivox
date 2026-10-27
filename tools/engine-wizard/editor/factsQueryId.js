// 问完成状态时该用哪个引擎 id：优先用刚克隆出来的那个。
// 只有具名导出：default 在 react-refresh 眼里是组件出口，这个文件会被当成组件模块。
// 优先传进来的 id 是因为 wz.id 的 setState 异步：克隆刚完成时读闭包拿到旧值，
// 请求就会带空 id，流程条一个勾都不亮。

/** @returns {string|null} 要用的 id；两个都没有则 null */
export function factsQueryId (idArg, stateId) {
  return idArg || stateId || null
}
