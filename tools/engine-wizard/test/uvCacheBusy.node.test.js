const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// uv 写 wheel 缓存条目的方式：先把新指针写到同目录的 .tmpXXXX/link，
// 再用 rename 覆盖最终名。Windows 上覆盖已存在文件时，目标被别的句柄以
// 不共享删除的方式打开、或目标带只读属性，MoveFileEx 都返回
// ERROR_ACCESS_DENIED(5)。两种情况的错误码相同，无法据此区分。
//
// 缓存路径与结构本身正常：uv 0.12.1 写的就是 wheels-v6，指针指向的
// archive-v0 目录也在，因此不属于「位置写错」。按访问防护在文件刚写入时
// 短暂持有句柄，才是这个错误时有时无的原因。
//
// 这一组守卫盯住两件事：识别条件不能只认错误码，重试要能换缓存目录。

const ROOT = path.resolve(__dirname, '..', '..', '..')
const envInstall = require(path.join(ROOT, 'tools', 'engine-wizard', 'core', 'envInstall.js'))

const REAL_FAILURE = [
  'error: Failed to prepare distributions',
  '  Caused by: failed to link `pyarrow`',
  '  Caused by: failed to rename',
  '      D://Project//tts_broker_openai_compat//cache//uv//wheels-v6//pypi//pyarrow//.tmpCPH1pL//link',
  '      to',
  '      D://Project//tts_broker_openai_compat//cache//uv//wheels-v6//pypi//pyarrow//18.1.0-cp311-cp311-win_amd64:',
  '      拒绝访问。 (os error 5)',
].join('\n')

test('真实的缓存指针覆盖失败会被识别', () => {
  assert.strictEqual(envInstall.isUvCacheBusy({ stderr: REAL_FAILURE, stdout: '' }), true)
})

test('英文系统提示同样能识别', () => {
  const en = 'error: failed to rename\n'
    + '  C://x//cache//uv//archive-v0//abc//link to '
    + 'C://x//cache//uv//archive-v0//abc: Access is denied. (os error 5)'
  assert.strictEqual(envInstall.isUvCacheBusy({ stderr: en }), true)
})

test('只有拒绝访问、没有 uv 缓存路径时不重试', () => {
  const other = 'error: PermissionError: [WinError 5] 拒绝访问。: D://Project//engines//a//model.bin'
  assert.strictEqual(envInstall.isUvCacheBusy({ stderr: other }), false)
})

test('普通依赖冲突不触发缓存重试', () => {
  const resolve = 'No solution found when resolving dependencies: onnxruntime==1.18.0'
  assert.strictEqual(envInstall.isUvCacheBusy({ stderr: resolve }), false)
})

test('缺 stdout 与 stderr 的失败对象不会抛错', () => {
  assert.strictEqual(envInstall.isUvCacheBusy({}), false)
})

test('缓存冲突的第二档重试落在独立缓存目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-uv-busy-'))
  try {
    const dir = envInstall.uvRetryCacheDir(root)
    assert.strictEqual(dir, path.join(root, 'cache', 'uv-retry'))
    assert.ok(path.isAbsolute(dir), '缓存目录应为绝对路径')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('envOverride 可以覆盖 UV_CACHE_DIR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-uv-env-'))
  try {
    const wanted = path.join(root, 'cache', 'uv-retry')
    const env = envInstall.childEnvFor(root, { UV_CACHE_DIR: wanted })
    assert.strictEqual(env.UV_CACHE_DIR, wanted,
      'envOverride 必须能改掉默认缓存目录，否则换目录重试会落空')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runEnv 在按提示重试之后还留着缓存冲突重试', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'tools', 'engine-wizard', 'core', 'envInstall.js'), 'utf8')
  const hintAt = src.indexOf('for (const st of strategies)')
  const busyAt = src.indexOf('if (!r.ok && isUvCacheBusy(r))')
  assert.ok(hintAt > 0, '按 uv 提示重试的分支不见了')
  assert.ok(busyAt > hintAt, '缓存冲突重试应当排在按提示重试之后')
  assert.ok(src.includes('UV_CACHE_DIR: uvRetryCacheDir(root)'),
    '换独立缓存目录的那一档不见了')
})

// 解 sdist 时的失败：setuptools 往 wheel 目录里写 egg-info，撞上已存在的半成品
// 与按访问防护的句柄，报的同样是拒绝访问，路径在 uv 的 builds-v0/.tmp* 里。
// 判据漏掉这一类时，界面只会显示一条构建失败，而重试一次通常就能过。
const SDIST_BUILD_FAILURE = [
  '× Failed to build `txtsplit==1.0.0`',
  '  ├─▶ The build backend returned an error',
  '  ╰─▶ Call to `setuptools.build_meta:__legacy__.build_wheel` failed (exit code: 1)',
  '      D://Project//tts_broker_openai_compat//cache//uv//builds-v0//.tmpY5B1Bm//Lib//site-packages//setuptools//dist.py:765',
  '      error: [WinError 5] 拒绝访问。: \'build\\bdist.win-amd64\\wheel\\.\\txtsplit-1.0.0-py3.11.egg-info\\dependency_links.txt\'',
].join('\n')

test('sdist 构建目录里的拒绝访问也算缓存被占用', () => {
  assert.strictEqual(envInstall.isUvCacheBusy({ stderr: SDIST_BUILD_FAILURE }), true,
    'builds-v0 里的 .tmp* 是 uv 缓存内部路径，漏掉它这一档就只报失败、不重试')
})

test('每档重试前都要清掉上一次留下的构建目录', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'tools', 'engine-wizard', 'core', 'envInstall.js'), 'utf8')
  const loopAt = src.indexOf('for (const attempt of attempts)')
  const cleanAt = src.indexOf('cleanStaleUvBuilds(root)', loopAt)
  const runAt = src.indexOf('await runStep(', loopAt)
  assert.ok(loopAt > 0 && cleanAt > loopAt,
    '缓存冲突的重试循环里没清构建目录：同一个 builds-v0 会再撞一次同样的错')
  assert.ok(cleanAt < runAt, '清理要排在重跑之前')
})
