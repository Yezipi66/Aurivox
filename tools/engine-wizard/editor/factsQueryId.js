// 问完成状态时该用哪个引擎 id。
//
// 背景：wz.id 的 setState 是异步的，克隆刚完成那一刻读闭包里的 wz.id
// 拿到的是上一个渲染的旧值（刚进向导时是空）⇒ 请求带空 id ⇒ 流程条一个勾都不亮。
// 所以 onDone 把刚克隆的 id 传出来，reloadFacts 优先用它。
//
// 为什么单独一个文件：这个函数原先放在 App.jsx 里并从那儿导出。
// App.jsx 是组件模块，而 vite 的 react 插件要求组件模块只导出组件
// （导出别的函数 ⇒ Fast Refresh 失效，改这个文件会整页 reload，
// 日志里报 Could not Fast Refresh ("..." export is incompatible)）。
// 纯函数放自己的文件，组件模块就干净了。
//
// 这个项目里纯函数都是这么放的：manifestAutoFill.js / scanAutofill.js / paramType.js。
//
// 只有具名导出，没有 default：default 导出在 react-refresh 眼里是「组件出口」，
// 这个文件会被当成组件模块 ⇒ 里面的具名导出又要被查一遍。

/**
 * 该用哪个引擎 id 去问完成状态。
 *
 * @param {string} idArg 调用方传的 id（刚克隆完时传它）
 * @param {string} stateId 当前 state 里的 id
 * @returns {string|null} 要用的 id；两个都没有则 null
 */
export function factsQueryId (idArg, stateId) {
  return idArg || stateId || null
}
