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
    // 向导：拼环境变量时带上。env 已经收进 childEnvFor()，形状变了，
    // 守卫跟着改：runOne 把 childEnvFor 的结果喂给 spawn，且该助手确实把
    // 缓存指进项目。只看「UV_CACHE_DIR 字样」不够，那行 require 也写着它。
    {
      rel: 'tools/engine-wizard/core/envInstall.js',
      check: (src) => /env:\s*childEnvFor\(/.test(src)
        && /UV_CACHE_DIR:\s*uvCacheDirFor\(root\)/.test(src),
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
  // 宿主环境里这两样会污染 uv 的构建子进程，装依赖时必须剥掉：
  //   ① PYTHONPATH：装着 WorkBuddy 沙箱的 sitecustomize.py（它劫持 shutil.rmtree
  //     改走回收站 SHFileOperationW）。uv 构建隔离子进程加载它后，setuptools
  //     构建 wheel 清临时目录就 SHFileOperationW 失败(0x2) ⇒ 构建失败。
  //   ② VIRTUAL_ENV：指向平台根 venv，会与引擎自己的 .venv 冲突（mismatch 警告）。
  const prevPP = process.env.PYTHONPATH
  const prevVE = process.env.VIRTUAL_ENV
  process.env.PYTHONPATH = 'C:/host/shim'
  process.env.VIRTUAL_ENV = 'D:/project/venv'
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
    assert.strictEqual(
      seen.PYTHONPATH, undefined,
      'PYTHONPATH 泄漏进了 uv 子进程：sitecustomize 劫持 rmtree 会让 setuptools 构建失败',
    )
    assert.strictEqual(
      seen.VIRTUAL_ENV, undefined,
      'VIRTUAL_ENV 泄漏进了 uv 子进程：会与引擎自己的 .venv 冲突',
    )
  } finally {
    if (prevPP === undefined) delete process.env.PYTHONPATH
    else process.env.PYTHONPATH = prevPP
    if (prevVE === undefined) delete process.env.VIRTUAL_ENV
    else process.env.VIRTUAL_ENV = prevVE
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

// 被中断的 uv 构建会在 builds-v0/.tmp* 留下半成品。下次重跑复用这些残留
// 时，setuptools 重写 egg-info 可能撞上残留的只读/锁定状态，报
// [WinError 5] 拒绝访问。cleanStaleUvBuilds 只清被中断的 .tmp* 临时目录，
// 正常完成的构建缓存（wheel/sdist）不动。
test('cleanStaleUvBuilds 清掉被中断的 .tmp* 构建，保留正常缓存', () => {
  const { cleanStaleUvBuilds } = require(
    path.join(ROOT, 'tools', 'engine-wizard', 'core', 'envInstall.js'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-uv-builds-'))
  try {
    const builds = path.join(root, 'cache', 'uv', 'builds-v0')
    const sdists = path.join(root, 'cache', 'uv', 'sdists-v9', 'pypi', 'pkg')
    fs.mkdirSync(path.join(builds, '.tmppartial1'), { recursive: true })
    fs.mkdirSync(path.join(builds, '.tmppartial2'), { recursive: true })
    fs.mkdirSync(path.join(builds, 'otherdir'), { recursive: true })
    fs.mkdirSync(path.join(sdists, 'pkg-4.9.3'), { recursive: true })
    cleanStaleUvBuilds(root)
    assert.ok(!fs.existsSync(path.join(builds, '.tmppartial1')),
      '.tmp* 残留没被清：下次复用会撞 WinError 5')
    assert.ok(!fs.existsSync(path.join(builds, '.tmppartial2')),
      '.tmp* 残留没被清：下次复用会撞 WinError 5')
    assert.ok(fs.existsSync(path.join(builds, 'otherdir')),
      '正常目录也被清了：只该动 .tmp* 临时目录')
    assert.ok(fs.existsSync(path.join(sdists, 'pkg-4.9.3')),
      '正常 sdist 缓存被清了：已下载的 wheel 不该重下')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// 缓存目录不存在时（全新机器、还没装过依赖）cleanStaleUvBuilds 要安静返回，
// 不抛错：没缓存就没什么可清的。
test('cleanStaleUvBuilds 在缓存目录不存在时不抛错', () => {
  const { cleanStaleUvBuilds } = require(
    path.join(ROOT, 'tools', 'engine-wizard', 'core', 'envInstall.js'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-uv-nocache-'))
  try {
    assert.doesNotThrow(() => cleanStaleUvBuilds(root),
      '缓存目录不存在时抛错：全新机器首次装依赖会挂')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// 守卫：runEnv 执行前必须清 .tmp*（只在真正执行时清，出计划不碰缓存）。
test('runEnv 执行前调用 cleanStaleUvBuilds（不清残留会撞 WinError 5）', () => {
  const src = readSrc('tools', 'engine-wizard', 'core', 'envInstall.js')
  assert.ok(/cleanStaleUvBuilds\(root\)/.test(src),
    'runEnv 没在执行前清 .tmp*：被中断构建的残留会让下次 uv 构建报 WinError 5')
  assert.ok(src.includes('if (input.execute !== true) return')
    && src.indexOf('cleanStaleUvBuilds(root)') > src.indexOf("if (input.execute !== true) return"),
    'cleanStaleUvBuilds 的位置在 execute 早退之前：只出计划时不该动缓存')
})
