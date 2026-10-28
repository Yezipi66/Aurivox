// 引擎接入向导的独立 dev server 配置：把向导的校验与安装端点挂到 Vite 上，
// 预览页复用平台的真组件。
// 这个文件必须留在 web/ 下：Vite 用 Node 的 ESM 加载器读配置，bare specifier 按
// 配置文件所在目录解析，挪到项目根就解析不到 web/node_modules 里的 vite。
// 扩展名用 .mjs，避免被根目录引用时当成 CommonJS。
// 用法（cd web）：npx vite --config wizard.vite.config.mjs，浏览器开 http://127.0.0.1:5199/
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// 平台的核心层是 CommonJS，配置文件是 ESM：用 createRequire 在运行时加载，
// 于是向导端点与平台的校验层是同一份实现，不重写一遍。
const require = createRequire(import.meta.url)

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 预览页 import 平台的真组件（tools/engine-wizard/editor 与 web/src/...），
// 所以 root 指向 editor 目录：另画一份预览必然与真组件漂移，而漂移的预览会给出错误结论。
const EDITOR = path.join(HERE, '..', 'tools', 'engine-wizard', 'editor')
const WEB_MODULES = path.join(HERE, 'node_modules')
const CORE = path.join(HERE, '..', 'tools', 'engine-wizard', 'core')

// 校验中间件：POST /wizard/validate 收 { manifest }，回 { diagnostics, summary }。
// 页面每次改 JSON 都调它，诊断面板的提示由这份结果渲染。
function validatePlugin () {
  const { handleValidate } = require(path.join(CORE, 'bridge.js'))
  const { handleSpec } = require(path.join(CORE, 'specbridge.js'))
  const { handleInstalled, handleSave, handleRead } = require(path.join(CORE, 'savebridge.js'))
  // 整体引用 wizardbridge，不逐个解构：解构在模块加载时求值，
  // 引擎侧新加的导出不会进入解构出来的函数表。整体引用 + 运行时取 .handleX，
  // 每次请求都读到最新的导出表。
  const wb = require(path.join(CORE, 'wizardbridge.js'))
  // 表的顺序即路由优先级，两条规则都要满足：
  //   一、长前缀在前。manifest/<id> 是动态的，必须排在 installed 之前，
  //      否则 /wizard/manifest/xxx 会被别的 handler 先吃掉；短端点还要显式排除
  //      自己的 cancel 子端点，单靠顺序挡不住前缀包含关系。
  //   二、同步 handler 全部排在异步 handler 之前。中间件一见到 Promise 就 break，
  //      排在它后面的 handler 无论 URL 是否匹配都轮不到。handleValidate 必须排在
  //      handleParams 之前，否则 /wizard/validate 被挡在后面，整条校验环 404。
  //      handleParams 认的是 /wizard/params 这个整串，与本表其它前缀无一互为前缀，
  //      与 handleValidate 互换位置不影响 params 路由。
  const HANDLERS = [
    handleSpec, handleRead,
    wb.handleState, wb.handleResolve, wb.handleProbe, wb.handleDeps, wb.handleHardware,
    wb.handleClone, wb.handleCloneCancel, wb.handleCloneRemove, wb.handleEnvCancel, wb.handleEnv, wb.handleModels,
    wb.handleVerifyChecks, wb.handleVerifyAudio, wb.handleVerifyMeasureProgress, wb.handleVerifyMeasureCancel,
    wb.handleVerifyMeasure, wb.handleVerify, wb.handleProfile,
    handleValidate, wb.handleCliArgs,
    wb.handleDiscover,
    // install-state 报这一台装到哪了，reset-progress 是重装本步的逃生口。
    // 两者都同步返回 true/false，改成 async 会让中间件见到 Promise 就 break。
    // 认的都是整串前缀、tail 只能跟 ?，与本表其它前缀无一互为前缀，
    // 所以在表里的位置不影响路由。
    wb.handleInstallState, wb.handleResetProgress,
    // hf-token 认的是 /wizard/hf-token 整串，后面只能跟 ?，与本表其它前缀无一互为前缀。
    wb.handleHfToken,
    handleInstalled, handleSave,
    wb.handleDownloadFile, wb.handleDownloadFiles, wb.handleDownloadProgress,
    // cancel 必须排在 handleDownload 之前：handleDownload 认的是 /wizard/download 整串前缀，
    // 会把 download/cancel 一起吃掉（它自己也会显式排除，但注册顺序不能依赖那个）。
    wb.handleDownloadCancel,
    // handleDownload 认的是 /wizard/download 这个前缀，会把 download/file、
    // download/files、download/manifest、download/progress 全部吃掉，
    // 所以它必须排在所有 download 子端点之后（具体优先于前缀）。
    wb.handleDownload,
    // 中间件一见到 Promise 就 break 出循环，排在它后面的 handler 全部静默失效，
    // 请求穿透到 vite 的 HTML fallback，前端报「响应格式错误」。
    // 排序纪律本身仍然有效，不要因为现在都是同步的就重排：
    // 中间件的同步 return 判据没变，将来任何 handler 改回 async 都会让它后面的
    // 全部 handler 静默失效（静默失效，不是报错）。
    wb.handleParams, wb.handleDownloadManifest,
  ]
  return {
    name: 'aurivox-wizard-validate',
    configureServer (server) {
      server.middlewares.use((req, res, next) => {
        // handler 返回 boolean（同步）或 Promise<boolean>（异步）。
        // async handler 即使返回 false，返回的也是 Promise<false>，
        // Promise 是 truthy，会被误判为已处理，next() 不被调用，请求卡死。
        // 所以 Promise 不能同步判定，要等它 resolve。
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
    // 而浏览器访问 127.0.0.1:5199 走 IPv4，连不上。症状是页面打不开，
    // 而 vite 日志一切正常。日志里显示 localhost 不代表 IPv4 通，
    // localhost 两个协议都能解析。判据是 netstat 里应出现
    // 127.0.0.1:5199，而不只是 [::1]:5199。
    host: '127.0.0.1',
    // 平台的 /api/* 代理到 9886，向导自己的端点不经过平台后端。
    proxy: {
      '/api': 'http://127.0.0.1:9886',
    },
  },
  resolve: {
    alias: {
      // react 必须锁到同一份，否则出现两个 React 实例，hooks 直接报错。
      // 预览页与平台组件都要 react，alias 让它们指向同一个目录。
      react: path.join(WEB_MODULES, 'react'),
      'react-dom': path.join(WEB_MODULES, 'react-dom'),
    },
  },
})