const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// uv 的包缓存归谁管：归项目，不归当前登录的用户。
//
// uv 默认写 %LOCALAPPDATA%\uv\cache。那是当前用户才能看到的地方：换台机器部署，
// 那边会在用户的家目录里长出几十 GB；搬走项目目录，缓存也不会跟着走。
// 缓存放进项目的 cache/uv/ 之后，它与各个虚拟环境同盘，uv 能用硬链接把文件
// 链进环境，省掉每台引擎一份完整拷贝，也不再打印「Failed to hardlink」警告。
//
// 这条守卫盯住四处调用点：少改一处，那一处就还在往用户目录里写。

const ROOT = path.resolve(__dirname, '..', '..', '..')

// 读一个源码文件里的某个片段，看它有没有把 uv 缓存指向项目内。
function readSrc (...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
}

// lib/paths/cache.js 是缓存路径的权威：uv 的缓存根由它算出来。
test('uv 缓存的权威路径在项目里，不在用户目录', () => {
  const cache = require(path.join(ROOT, 'lib', 'paths', 'cache.js'))
  assert.ok(path.isAbsolute(cache.UV_CACHE_DIR), 'UV_CACHE_DIR 应为绝对路径')
  assert.strictEqual(
    path.dirname(cache.UV_CACHE_DIR),
    path.resolve(cache.CACHE_DIR),
    'uv 缓存应当就在 cache/ 之下',
  )
  assert.ok(
    cache.UV_CACHE_DIR.startsWith(path.resolve(ROOT) + path.sep),
    `uv 缓存跑到项目外去了：${cache.UV_CACHE_DIR}`,
  )
})

// 向导按它自己操作的项目根定位缓存：向导能对着别的项目根干活，
// 那时缓存要跟着那个项目根走，而不是跟着脚本所在位置走。
test('向导的缓存跟着它操作的项目根走', () => {
  const cache = require(path.join(ROOT, 'lib', 'paths', 'cache.js'))
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-other-root-'))
  try {
    assert.strictEqual(
      cache.uvCacheDirFor(other),
      path.join(other, 'cache', 'uv'),
      '向导对着别的项目根干活时，缓存没有跟着那个根走',
    )
  } finally {
    fs.rmSync(other, { recursive: true, force: true })
  }
})

// 四个调用点：部署、向导装依赖、装 torch、路径权威。
//
// 只看文件里有没有出现「UV_CACHE_DIR」这几个字是不够的：require 那行就写着它，
// 把真正赋值的那行删掉，这个字样照样在，守卫会一直是绿的。所以这里查的是
// 「值有没有真的被送到子进程」这件事的形状：部署是写进 process.env 再继承，
// 装 torch 是放进传给 spawn 的那个 env 对象。
test('每一处调用 uv 的地方都把缓存指向项目内', () => {
  const cases = [
    // 部署：写进 process.env，之后的子进程都继承它
    {
      rel: 'tools/deploy/bootstrap.js',
      check: (src) => /process\.env\.UV_CACHE_DIR\s*=\s*UV_CACHE_DIR/.test(src),
      why: '部署没有把 uv 的缓存指向项目内的 cache/uv/',
    },
    // 装 torch：放进传给 spawn 的那个 env 对象
    {
      rel: 'tools/cli/install-torch.js',
      check: (src) => /const\s+env\s*=\s*Object\.assign\([^)]*\{[\s\S]*?UV_CACHE_DIR[\s\S]*?\}\)/.test(src),
      why: '装 torch 没有把 uv 的缓存指向项目内的 cache/uv/',
    },
    // 向导：拼环境变量时带上
    {
      rel: 'tools/engine-wizard/core/envInstall.js',
      check: (src) => /env:\s*\{[^}]*UV_CACHE_DIR/.test(src),
      why: '向导装依赖没有把 uv 的缓存指向项目内的 cache/uv/',
    },
  ]
  for (const c of cases) {
    const src = readSrc(...c.rel.split('/'))
    assert.ok(c.check(src), c.why)
  }
})

// 真正跑一步安装，看子进程拿到的环境变量是什么。
// 只看源码不够：环境变量可能在拼装环境的地方被覆盖掉。
test('向导装依赖时，子进程拿到的 uv 缓存路径在项目里', async () => {
  const envInstall = require(
    path.join(ROOT, 'tools', 'engine-wizard', 'core', 'envInstall.js'))

  let seen = null
  const fakeSpawn = (argv, args, opts) => {
    seen = opts.env
    // 返回一个能立刻结束、状态为 0 的假进程
    const { EventEmitter } = require('node:events')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 12345
    child.kill = () => {}
    setImmediate(() => {
      child.stdout.emit('data', '')
      child.emit('close', 0)
    })
    return child
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-wizard-uv-'))
  try {
    await envInstall.runOne(
      { argv: ['uv', 'sync'], cwd: root, absCwd: root },
      root,
      5000,
      null,
      () => {},
      null,
      { spawn: fakeSpawn, killProcessTree: () => {} },
    )
    assert.ok(seen, '没有抓到子进程的环境变量')
    assert.strictEqual(
      seen.UV_CACHE_DIR,
      path.join(root, 'cache', 'uv'),
      '向导装依赖时 uv 的缓存没有落在被操作项目的 cache/uv/ 下',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// 缓存目录不进版本库：cache/ 整个是 gitignore 的，uv 缓存是它的一部分。
test('uv 缓存目录不会被 git 收进去', () => {
  const out = require('node:child_process').execFileSync(
    'git', ['check-ignore', '-q', 'cache/uv/probe.txt'],
    { cwd: ROOT, stdio: 'ignore' },
  )
})
