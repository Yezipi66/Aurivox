'use strict'

// 一次安装里若有多个只有源码包的依赖，uv 并行构建会在 Windows 上触发
//   egg-info 临时目录的拒绝访问错误（ERROR_ACCESS_DENIED）。把源码包构建
//   并发限制为一即可，依赖声明与安装命令都不变。
//   同一进程可能同时安装多台引擎，用引用计数恢复调用前的取值。

const KEY = 'UV_CONCURRENT_BUILDS'
let users = 0
let saved = null

function beginSerialBuilds () {
  if (users === 0) {
    saved = process.env[KEY]
    process.env[KEY] = '1'
  }
  users += 1
}

function endSerialBuilds () {
  users = Math.max(0, users - 1)
  if (users > 0) return
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
  saved = null
}

function serialBuildsActive () {
  return users > 0
}

module.exports = { beginSerialBuilds, endSerialBuilds, serialBuildsActive }
