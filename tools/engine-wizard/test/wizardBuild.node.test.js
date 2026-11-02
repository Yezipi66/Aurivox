'use strict'
// 向导前端整个模块图必须能真的构建出来。
//
// 这一层补的是逐文件编译检查补不上的洞：
//   逐文件编译（styleguard 里的「每个 JSX 都必须真能编译」）只看语法，
//   看不出两个文件互相 import 形成的环，看不出某个 import 的路径打错。
//   第 4 步三栏改造把参数池从 DragBind 里搬出来时，就差点撞上环：
//   ParamDropZone 要渲染 ParamRow，ParamRow 又要回 ManifestForm 取规格。
//   拆成独立文件才断开，但「拆开就没事」是猜的，这里让它变成测出来的。
//
// 走 Vite 的 build API 而不是 CLI：`vite build` 会被当成常驻进程，
// API 方式没这个问题，而且能拿到真实的模块图。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const EDITOR = path.join(ROOT, 'tools', 'engine-wizard', 'editor')
const WEB = path.join(ROOT, 'web')

/**
 * 拿到 Vite 的 build API。
 *
 * require.resolve('vite') 在 web/ 里解析到 index.cjs（Vite 的 CJS 入口），
 * 它带 deprecation 警告；而 ESM 入口是 dist/node/index.js。
 * 两条路都试：ESM 的命名空间里 build 可能挂在 default 上（转译的 CJS 就是这样），
 * 所以两处都要看。
 */
async function loadVite () {
  const pkg = require(path.join(WEB, 'node_modules', 'vite', 'package.json'))
  const esm = path.join(WEB, 'node_modules', 'vite', pkg.exports['.'].import.default)
  const mod = await import(pathToFileURL(esm).href)
  if (typeof mod.build === 'function') return mod
  if (mod.default && typeof mod.default.build === 'function') return mod.default
  throw new Error('拿不到 Vite 的 build API')
}

test('向导前端整个模块图必须能构建出来（抓路径写错与缺失导入）', async () => {
  const vite = await loadVite()

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-build-'))
  let failed = null
  try {
    await vite.build({
      configFile: path.join(WEB, 'wizard.vite.config.mjs'),
      root: EDITOR,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
      },
    })
  } catch (e) {
    failed = e
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }

  if (failed) {
    const msg = String(failed.message || failed)
    assert.fail(
      `向导前端构建失败（页面会白屏）：\n${msg}\n`
      + '常见原因：某个 import 路径写错，或依赖的文件不存在。\n'
      + '（循环依赖构建器是容忍的，抓环由 wizardDeps.node.test.js 负责。）')
  }
})

test('向导构建产物里必须有页面入口（构建成功不等于产出可用页面）', async () => {
  const vite = await loadVite()

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-build-'))
  try {
    await vite.build({
      configFile: path.join(WEB, 'wizard.vite.config.mjs'),
      root: EDITOR,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true, minify: false },
    })

    const indexHtml = path.join(outDir, 'index.html')
    assert.ok(fs.existsSync(indexHtml), '构建出来了但没有 index.html')

    const assets = path.join(outDir, 'assets')
    assert.ok(fs.existsSync(assets), '构建出来了但没有 assets 目录')
    const files = fs.readdirSync(assets)
    assert.ok(files.some((f) => f.endsWith('.js')), '没有产出 JS 产物')
    assert.ok(files.some((f) => f.endsWith('.css')), '没有产出 CSS 产物')
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})
