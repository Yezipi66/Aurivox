import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// 校验桥：把 Node 侧的校验层暴露给浏览器。
//   不走平台的 server.js，向导是独立工具；平台的 /api/* 仍然 proxy 到 9886。
const require = createRequire(import.meta.url)

// ============================================================================
//  名片面板预览的独立 dev server 配置。
//
//  为什么这个文件放在 web/ 里，而不是项目根或 tools/ 下：
//    Vite 用 Node 的 ESM 加载器读配置，bare specifier 按配置文件所在目录解析。
//    放在根目录时 `from 'vite'` 会报 ERR_MODULE_NOT_FOUND；
//    放在 web/ 里才解析得到 web/node_modules。
//
//  为什么叫 .mjs：
//    web/package.json 有 "type": "module"，web/ 下的 .js 本来就是 ESM；
//    用 .mjs 是为了在根目录被引用时也不被当 CommonJS。
//
//  代价是 web/ 目录多一个文件，但 web/src 未改动，
//    `npm run build` 的产物与以前一致。换来的是预览复用平台真组件，
//    而不是另画一遍必然与真实现漂移的版本。
//
//  用法（cd web）：
//   npx vite --config wizard.vite.config.mjs
//   浏览器开 http://127.0.0.1:5199/
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 预览页要 import 平台的真组件（../../../web/src/...）。
//   自己不重写 ParamField 就是第二份实现，必然与真实现漂移，而漂移的预览
//   会给出错误结论。所以 root 指向 editor 目录。
const EDITOR = path.join(HERE, '..', 'tools', 'engine-wizard', 'editor')
const WEB_MODULES = path.join(HERE, 'node_modules')
const CORE = path.join(HERE, '..', 'tools', 'engine-wizard', 'core')

// 校验中间件：POST /wizard/validate { manifest } 回 { diagnostics, summary }
//   页面每次改 JSON 都调它，红框就是这么来的。
function validatePlugin () {
  const { handleValidate } = require(path.join(CORE, 'bridge.js'))
  const { handleSpec } = require(path.join(CORE, 'specbridge.js'))
  const { handleInstalled, handleSave, handleRead } = require(path.join(CORE, 'savebridge.js'))
  // wizardbridge 整体引用，不逐个解构：解构在模块加载时求值，
  //   若引擎侧刚加了新导出（如 handleCliArgs），vite 的模块图可能缓存旧导出表
  //   ⇒ 解构出来的 handleCliArgs 是 undefined。整体引用 + 运行时 .handleX 动态取，
  //   每次请求都读到最新的导出。
  const wb = require(path.join(CORE, 'wizardbridge.js'))
  // 顺序纪律，两层缺一不可：
  //   一、长前缀在前。manifest/<id> 是动态的，必须排在 installed 之前，
  //      否则 /wizard/manifest/xxx 会被别的 handler 先吃掉。同理短端点要
  //      显式排除自己的 cancel 子端点，单靠顺序挡不住前缀包含关系。
  //   二、同步 handler 必须全部排在异步 handler 之前。中间件调用到第一个
  //      返回 Promise 的 handler 就 break + next()，它后面的无论 URL 是否
  //      匹配都轮不到。所以 handleValidate 要排在 handleParams 之前，
  //      否则 /wizard/validate 被挡在后面，整条校验环 404。
  //   handleParams 认的是 /wizard/params 这个整串，与本表其它前缀无一互为
  //   前缀，与 handleValidate 互换位置不影响 params 路由。
  const HANDLERS = [
    handleSpec, handleRead,
    wb.handleState, wb.handleResolve, wb.handleProbe, wb.handleDeps, wb.handleHardware,
    wb.handleClone, wb.handleCloneCancel, wb.handleEnvCancel, wb.handleEnv, wb.handleModels,
    wb.handleVerifyChecks, wb.handleVerify, wb.handleProfile, handleValidate, wb.handleCliArgs,
    wb.handleDiscover,
    // install-state 报这一台装到哪了，reset-progress 是重装本步的逃生口。
    // 两者都同步返回 true/false，改成 async 会让中间件见到 Promise 就 break
    // （见文件头）。认的都是整串前缀、tail 只能跟 ?，与本表其它前缀
    // 无一互为前缀，所以在表里的位置不影响路由。
    wb.handleInstallState, wb.handleResetProgress,
    handleInstalled, handleSave,
    wb.handleDownloadFile, wb.handleDownloadFiles, wb.handleDownloadProgress,
    // handleDownload 认的是 /wizard/download 这个前缀，会把 download/file、
    //   download/files、download/manifest、download/progress 全部吃掉，
    //   所以它必须排在所有 download 子端点之后（具体优先于前缀）。
    wb.handleDownload,
    // 这两个曾经是 async handler 排在队尾。
    //   现在全部 handler 都同步返回 true/false（async 的 bug 已修，见
    //   core/wizardbridge.js 里 handleDownloadManifest / handleParams 的头注）。
    //   async function 无论 URL 匹不匹配都返回 Promise，本循环一见到 Promise
    //   就 break，排在它后面的 handler 无论匹不匹配都轮不到，请求穿透到 vite
    //   的 HTML fallback，前端报「响应格式错误」。
    //   排序纪律本身仍然有效，不要因为现在都是同步的就重排：
    //     中间件的同步 return 判据没变，将来任何 handler 改回 async 都会
    //     让它后面的全部 handler 静默失效（静默失效，不是报错）。
    wb.handleParams, wb.handleDownloadManifest,
  ]
  return {
    name: 'aurivox-wizard-validate',
    configureServer (server) {
      server.middlewares.use((req, res, next) => {
        // handler 返回 boolean（同步）或 Promise<boolean>（异步）。
        //   async handler 即使返回 false，返回的也是 Promise<false>，
        //   Promise 是 truthy，会被误判为已处理，next() 不被调用，请求卡死。
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
    // 必须显式绑定 127.0.0.1。vite 5 默认只绑 IPv6 回环（[::1]），
    //   而浏览器访问 127.0.0.1:5199 走 IPv4，连不上。症状是页面打不开，
    //   而 vite 日志一切正常。日志里显示 localhost 不代表 IPv4 通，
    //   localhost 两个协议都能解析。判据是 netstat 里应出现
    //   127.0.0.1:5199，而不只是 [::1]:5199。
    host: '127.0.0.1',
    // 后端没起也能用：/api/engines 拿不到时，前端退回「粘贴 JSON」模式。
    proxy: {
      '/api': 'http://127.0.0.1:9886',
    },
  },
  resolve: {
    alias: {
      // react 必须锁到同一份，否则出现两个 React 实例，hooks 直接报错。
      //   预览页与平台组件都要 react，alias 让它们指向同一个目录。
      react: path.join(WEB_MODULES, 'react'),
      'react-dom': path.join(WEB_MODULES, 'react-dom'),
    },
  },
})