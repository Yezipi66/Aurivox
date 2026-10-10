import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// ⭐ 校验桥 —— 把 Node 侧的校验层暴露给浏览器。
//   ⛔ 不走平台的 server.js：向导是独立工具，不往产品里塞代码。
//   平台的 /api/* 仍然 proxy 到 9886，两条路各管各的。
const require = createRequire(import.meta.url)

// ============================================================================
//  名片面板预览 —— 独立 dev server 的配置
//
// ⛔ 为什么这个文件放在 web/ 目录里，而不是项目根或 tools/ 下
//    Vite 用 Node 的 ESM 加载器读配置，**bare specifier 按配置文件所在目录解析**
//    （实测：ERR_MODULE_NOT_FOUND: Cannot find package 'vite'）。
//    ⇒ 只有放在 web/ 里，`from 'vite'` 才解析得到 web/node_modules。
//
//  ⛔ 为什么叫 .mjs
//    web/package.json 有 `"type": "module"`，所以 web/ 下的 .js 本来就是 ESM；
//    用 .mjs 是为了在**根目录**被引用时也不被当 CommonJS。
//    ⚠️ 曾经把它放在项目根 ⇒ 根 package.json 没有 type:module
//    ⇒ import 语法直接报错（2026-10-03 实测）。
//
//  ⛔ web/ 目录因此多了一个文件 —— 但 web/src 一个字没动，
//    `npm run build` 的产物与以前完全一致。这是可接受的代价：
//    换来的是预览**复用平台真组件**，而不是另画一遍必然漂移的实现。
//
//  用法（cd web）：
//   npx vite --config wizard.vite.config.mjs
//   浏览器开 http://127.0.0.1:5199/
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ⭐ 预览页要 import 平台的真组件（../../../web/src/...），
//    自己不重写一遍 ParamField —— 那会是第二份实现，必然漂移，
//    而漂移的预览会**骗人**。所以 root 指向 editor 目录。
const EDITOR = path.join(HERE, '..', 'tools', 'engine-wizard', 'editor')
const WEB_MODULES = path.join(HERE, 'node_modules')
const CORE = path.join(HERE, '..', 'tools', 'engine-wizard', 'core')

// ⭐ 校验中间件 —— POST /wizard/validate { manifest } → { diagnostics, summary }
//   页面每次改 JSON 都调它，红框就是这么来的。
function validatePlugin () {
  const { handleValidate } = require(path.join(CORE, 'bridge.js'))
  const { handleSpec } = require(path.join(CORE, 'specbridge.js'))
  const { handleInstalled, handleSave, handleRead } = require(path.join(CORE, 'savebridge.js'))
  // ⭐ wizardbridge 整体引用（⛔ 不逐个解构）—— 解构在模块加载时求值，
  //   若引擎侧刚加了新导出（如 handleCliArgs），vite 的模块图可能缓存旧导出表
  //   ⇒ 解构出来的 handleCliArgs 是 undefined。整体引用 + 运行时 .handleX 动态取，
  //   每次请求都读到最新的导出。
  const wb = require(path.join(CORE, 'wizardbridge.js'))
  // ⛔ 顺序纪律（两层，缺一不可）：
  //   ① 长前缀在前。manifest/<id> 是动态的，必须排在 installed 之前，
  //      否则 /wizard/manifest/xxx 会被别的 handler 先吃掉。
  //   ② 同步 handler 必须全部排在异步 handler 之前。中间件调用到**第一个**
  //      async handler（返回 Promise）就 break + next()，它后面的 handler
  //      无论 URL 是否匹配都轮不到。⇒ handleValidate 必须排在 handleParams
  //      之前；否则 /wizard/validate 被挡在 handleParams 后面，整条校验环
  //      404（卡点1：UI 满屏 REPLACE_ME 草稿却一条红框不报，Save 恒 disabled）。
  // ⚠ handleParams 认的是 /wizard/params 这个**整串**，与本表中其它前缀
  //    无一互为前缀 ⇒ 与 handleValidate 互换位置不影响 params 路由。
  const HANDLERS = [
    handleSpec, handleRead,
    wb.handleState, wb.handleResolve, wb.handleProbe, wb.handleDeps, wb.handleHardware,
    wb.handleClone, wb.handleEnv, wb.handleModels,
    wb.handleVerifyChecks, wb.handleVerify, wb.handleProfile, handleValidate, wb.handleCliArgs,
    handleInstalled, handleSave,
    wb.handleDownloadFile, wb.handleDownloadFiles, wb.handleDownloadProgress,
    // ⛔ handleDownload 认的是 /wizard/download 这个**前缀**，会把上面的
    //   download/file、download/files、download/manifest、download/progress
    //   全部吃掉 ⇒ 它必须排在所有 download 子端点之后（具体优先于前缀）。
    //   （子 Agent deleg_1f88218b 查证：前端 StepsExtra.jsx:329 调它执行下载 SSE，
    //   它一直没进 HANDLERS ⇒ 点下载 404 —— 这是「第三步下载坏了」的真身之一。）
    wb.handleDownload,
    // ⛔ 唯二的 async handler 沉底：中间件一调用到返回 Promise 的 handler
    //   就 break + next()，其后的 handler 无论 URL 是否匹配都轮不到。
    //   ⇒ async 只能放队尾，sync 全部排它们前面。
    wb.handleParams, wb.handleDownloadManifest,
  ]
  return {
    name: 'aurivox-wizard-validate',
    configureServer (server) {
      server.middlewares.use((req, res, next) => {
        // ⛔ handler 返回 boolean（同步）或 Promise<boolean>（异步）。
        //   async handler 即使返回 false，返回的也是 Promise<false>，
        //   Promise 是 truthy ⇒ 会被误判为已处理 ⇒ next() 不调用 ⇒ 卡死。
        //   ⇒ 对 Promise，不能同步判定，要等它 resolve。
        let handled = false
        try {
          for (const h of HANDLERS) {
            if (typeof h !== 'function') continue
            const r = h(req, res)
            if (r === true) { handled = true; break }
            if (r && typeof r.then === 'function') {
              r.then((ok) => {
                if (ok) { /* 已处理 */ }
                else { next() }
              }).catch(() => { next() })
              handled = true; break
            }
          }
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String((err && err.message) || err) }))
          return
        }
        if (!handled) next()
      })
    },
  }
}

export default defineConfig({
  root: EDITOR,
  plugins: [react(), validatePlugin()],
  server: {
    port: 5199,
    strictPort: true,
    // ⛔ 必须显式绑定 127.0.0.1。vite 5 默认只绑 IPv6 回环（[::1]），
    //   ⛔ 而浏览器访问 127.0.0.1:5199 走 IPv4 ⇒ 连不上。
    //   症状：页面打不开，而 vite 日志一切正常。
    //   ⛔ 日志里显示 localhost 不代表 IPv4 通 —— localhost 两个协议都能解析。
    //   判据：改完 netstat 里应出现 127.0.0.1:5199，而不只是 [::1]:5199。
    host: '127.0.0.1',
    // ⛔ 后端没起也能用：/api/engines 拿不到时，前端退回「粘贴 JSON」模式。
    proxy: {
      '/api': 'http://127.0.0.1:9886',
    },
  },
  resolve: {
    alias: {
      // ⭐ react 必须锁到同一份，否则出现两个 React 实例 ⇒ hooks 直接报错。
      //   预览页与平台组件都要 react，而 alias 让它们指向同一个目录。
      react: path.join(WEB_MODULES, 'react'),
      'react-dom': path.join(WEB_MODULES, 'react-dom'),
    },
  },
})