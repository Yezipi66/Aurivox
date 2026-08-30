'use strict'

// lib/engines/checkpoints.js 的测试。
//
// ⭐ 这里造的 profile 是**手搓的对象**，不是从 engines/ 里读出来的名片。
//   理由和 parseParamSchema 的测试一样：造一台假引擎要往 engines/ 里写目录，
//   而那一层有目录清点守卫盯着（root_layout / realManifests）。手搓对象能把
//   三态的每一支都精确摆出来，真名片做不到（真名片的底模在不在取决于跑测试
//   的这台机器上有没有下过模型 —— 那种测试今天绿明天红）。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  checkpointStatus, describeCheckpointStatus, resolveCheckpointsDir,
} = require('./checkpoints')

function tmpdir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `aurivox-ckpt-${name}-`))
  test.after?.(() => { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} })
  return d
}

function profileOf(over = {}) {
  return {
    id: 'fake-engine',
    dir: '/nowhere/engines/fake-engine',
    runtime: null,
    models: null,
    ...over,
  }
}

// ---------------------------------------------------------------------------
//  三态。⛔ 三条都得在 —— 把 null 糊成 false/true 正是这个文件要防的那个 bug。
// ---------------------------------------------------------------------------

test('ready === true：名片点名的文件一个不少', () => {
  const root = tmpdir('ok')
  fs.mkdirSync(path.join(root, 'models/x'), { recursive: true })
  fs.writeFileSync(path.join(root, 'models/x/config.yaml'), 'a')
  fs.mkdirSync(path.join(root, 'models/x/sub'))

  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    // 目录也算「在」—— 上游的底模清单里确实有整个目录算一项的情况。
    models: { checkpoints_env: null, required: ['config.yaml', 'sub'], hint: null, source: null },
  }), { env: {}, appDir: root })

  assert.strictEqual(st.ready, true)
  assert.deepStrictEqual(st.missing, [])
  assert.strictEqual(st.exists, true)
  assert.strictEqual(st.is_dir, true)
  assert.strictEqual(st.reason, null)
})

test('ready === false：目录在但点名的文件缺了，且 reason 要点名说缺哪个', () => {
  const root = tmpdir('missing')
  fs.mkdirSync(path.join(root, 'models/x'), { recursive: true })
  fs.writeFileSync(path.join(root, 'models/x/config.yaml'), 'a')

  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    models: { checkpoints_env: null, required: ['config.yaml', 'gpt.pth'], hint: null, source: null },
  }), { env: {}, appDir: root })

  assert.strictEqual(st.ready, false)
  assert.deepStrictEqual(st.missing, ['gpt.pth'])
  // ⛔ 「底模不齐」这四个字不够 —— 缺哪个必须写出来，否则人得自己一个个对。
  assert.match(st.reason, /gpt\.pth/)
})

test('ready === false：目录根本不存在，reason 里要有绝对路径', () => {
  const root = tmpdir('nodir')
  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/nope' },
    models: { checkpoints_env: null, required: ['a'], hint: null, source: null },
  }), { env: {}, appDir: root })

  assert.strictEqual(st.ready, false)
  assert.strictEqual(st.exists, false)
  // 人要去放文件，就必须知道放到哪。相对路径在这里是没用的。
  assert.ok(st.reason.includes(st.abs_path))
  assert.ok(path.isAbsolute(st.abs_path))
})

test('ready === false：路径存在但是个文件不是目录', () => {
  const root = tmpdir('file')
  fs.mkdirSync(path.join(root, 'models'), { recursive: true })
  fs.writeFileSync(path.join(root, 'models/x'), 'not a dir')

  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    models: { checkpoints_env: null, required: ['a'], hint: null, source: null },
  }), { env: {}, appDir: root })

  assert.strictEqual(st.ready, false)
  assert.strictEqual(st.exists, true)
  assert.strictEqual(st.is_dir, false)
})

test('ready === null：名片没写 runtime.checkpoints —— 说不出来，不是"缺"', () => {
  const st = checkpointStatus(profileOf({ runtime: { python: 'x' } }),
    { env: {}, appDir: tmpdir('undeclared') })

  assert.strictEqual(st.ready, null)
  assert.strictEqual(st.declared, false)
  assert.strictEqual(st.abs_path, null)
  assert.match(st.reason, /runtime\.checkpoints/)
})

test('ready === null：目录在但 required 空 —— 平台不猜哪些文件算齐', () => {
  const root = tmpdir('norequired')
  fs.mkdirSync(path.join(root, 'models/x'), { recursive: true })
  fs.writeFileSync(path.join(root, 'models/x/whatever.bin'), 'a')

  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    models: { checkpoints_env: null, required: [], hint: null, source: null },
  }), { env: {}, appDir: root })

  // ⛔ 这里返回 true 等于替名片作者担保他没说过的事；返回 false 等于让一台
  //   其实好好的引擎永远挂红灯。只能是"说不出来"。
  assert.strictEqual(st.ready, null)
  assert.strictEqual(st.exists, true)
  assert.strictEqual(st.entries, 1)
})

test('models 段整个没写，也只能是"说不出来"，且不许抛', () => {
  const root = tmpdir('nomodels')
  fs.mkdirSync(path.join(root, 'models/x'), { recursive: true })
  const st = checkpointStatus(profileOf({ runtime: { checkpoints: 'models/x' }, models: null }),
    { env: {}, appDir: root })
  assert.strictEqual(st.ready, null)
  assert.deepStrictEqual(st.required, [])
  assert.strictEqual(st.hint, null)
  assert.strictEqual(st.source, null)
})

// ---------------------------------------------------------------------------
//  环境变量覆盖：名片说听谁，平台才去读谁
// ---------------------------------------------------------------------------

test('checkpoints_env 顶掉名片路径，并且 path_source 要说清是谁顶的', () => {
  const root = tmpdir('env')
  const elsewhere = tmpdir('env-target')
  fs.writeFileSync(path.join(elsewhere, 'config.yaml'), 'a')

  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    models: { checkpoints_env: 'FAKE_CKPT_DIR', required: ['config.yaml'], hint: null, source: null },
  }), { env: { FAKE_CKPT_DIR: elsewhere }, appDir: root })

  assert.strictEqual(st.ready, true)
  assert.strictEqual(st.abs_path, path.resolve(elsewhere))
  // 路径和名片写的不一样时，人第一个问题一定是"为什么"。
  assert.strictEqual(st.path_source, 'env:FAKE_CKPT_DIR')
  assert.strictEqual(st.declared, true)
})

test('环境变量存在但名片没说听它 —— 平台不认识任何变量名，一律不理', () => {
  const root = tmpdir('env-ignored')
  const elsewhere = tmpdir('env-ignored-target')

  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    models: { checkpoints_env: null, required: ['a'], hint: null, source: null },
  }), { env: { FAKE_CKPT_DIR: elsewhere, GSV_PRETRAINED_DIR: elsewhere }, appDir: root })

  assert.strictEqual(st.path_source, 'manifest')
  assert.strictEqual(st.abs_path, path.resolve(root, 'models/x'))
})

// ⚠ 上面那条给的是绝对路径，path.resolve 在那种情况下是恒等的 —— 它证不了
//   我们真的解析了。环境变量里塞相对路径是常事（`set X=models\y`），必须单测。
test('checkpoints_env 给的是相对路径 —— 也要按项目根解析成绝对路径', () => {
  const root = tmpdir('env-rel')
  const inside = path.join(root, 'models', 'from-env')
  fs.mkdirSync(inside, { recursive: true })
  fs.writeFileSync(path.join(inside, 'config.yaml'), 'a')

  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    models: { checkpoints_env: 'FAKE_CKPT_DIR', required: ['config.yaml'], hint: null, source: null },
  }), { env: { FAKE_CKPT_DIR: 'models/from-env' }, appDir: root })

  assert.strictEqual(st.path, 'models/from-env')
  assert.strictEqual(st.abs_path, inside)
  assert.strictEqual(path.isAbsolute(st.abs_path), true)
  // 解析对了才找得到文件；abs_path 若原样是相对的，这里必然翻车。
  assert.strictEqual(st.ready, true)
})

test('checkpoints_env 指着一个空字符串，等于没设，落回名片', () => {
  const root = tmpdir('env-empty')
  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    models: { checkpoints_env: 'FAKE_CKPT_DIR', required: ['a'], hint: null, source: null },
  }), { env: { FAKE_CKPT_DIR: '' }, appDir: root })
  assert.strictEqual(st.path_source, 'manifest')
})

test('resolveCheckpointsDir 单独也能用（它是这里唯一的路径真相）', () => {
  const loc = resolveCheckpointsDir(
    profileOf({ runtime: { checkpoints: 'models/x' } }), {}, path.sep + 'root')
  assert.strictEqual(loc.declared, 'models/x')
  assert.strictEqual(loc.path_source, 'manifest')
  assert.ok(path.isAbsolute(loc.abs_path))
})

// ---------------------------------------------------------------------------
//  取回办法：平台只填占位符，不生成命令
// ---------------------------------------------------------------------------

test('source.command 的占位符被填成绝对路径，且原样搬运不改写', () => {
  const root = tmpdir('source')
  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    models: {
      checkpoints_env: null,
      required: ['a'],
      hint: '自己下',
      source: {
        url: 'https://example.invalid/m',
        license_gate: true,
        command: ['some-downloader', 'get', '--out', '{checkpoints}', '--from', '{root}'],
        cwd: 'root',
      },
    },
  }), { env: {}, appDir: root })

  assert.deepStrictEqual(st.source.command,
    ['some-downloader', 'get', '--out', path.resolve(root, 'models/x'), '--from', root])
  assert.strictEqual(st.source.cwd, root)
  assert.strictEqual(st.source.license_gate, true)
  assert.strictEqual(st.hint, '自己下')
})

test('cwd 默认 engine_dir，填的是引擎目录不是项目根', () => {
  const root = tmpdir('cwd')
  const st = checkpointStatus(profileOf({
    dir: path.join(root, 'engines', 'fake-engine'),
    runtime: { checkpoints: 'models/x' },
    models: {
      checkpoints_env: null,
      required: ['a'],
      hint: null,
      source: {
        url: null,
        license_gate: false,
        command: ['d', '{engine_dir}', '{checkpoints}'],
        cwd: 'engine_dir',
      },
    },
  }), { env: {}, appDir: root })

  assert.strictEqual(st.source.cwd, path.join(root, 'engines', 'fake-engine'))
  assert.strictEqual(st.source.command[1], path.join(root, 'engines', 'fake-engine'))
})

test('名片只写了 url 没写 command —— command 是 null，不许平台自己编一条', () => {
  const root = tmpdir('nocmd')
  const st = checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x' },
    models: {
      checkpoints_env: null,
      required: ['a'],
      hint: '手动放',
      source: { url: 'https://example.invalid/m', license_gate: false, command: null, cwd: 'engine_dir' },
    },
  }), { env: {}, appDir: root })

  assert.strictEqual(st.source.command, null)
  assert.strictEqual(st.source.url, 'https://example.invalid/m')
})

// ---------------------------------------------------------------------------
//  只验不建
// ---------------------------------------------------------------------------

test('查一遍不会把目录建出来 —— 这里只验不建', () => {
  const root = tmpdir('readonly')
  checkpointStatus(profileOf({
    runtime: { checkpoints: 'models/x/y/z' },
    models: { checkpoints_env: null, required: ['a'], hint: null, source: null },
  }), { env: {}, appDir: root })
  assert.strictEqual(fs.existsSync(path.join(root, 'models')), false)
})

// ---------------------------------------------------------------------------
//  一句人话：两个消费者共用一处
// ---------------------------------------------------------------------------

test('describeCheckpointStatus 三态各说各的话，且都不是空字符串', () => {
  const a = describeCheckpointStatus({ ready: true, abs_path: '/x', reason: null })
  const b = describeCheckpointStatus({ ready: false, abs_path: '/x', reason: '少了 1 个文件：gpt.pth' })
  const c = describeCheckpointStatus({ ready: null, abs_path: null, reason: null })
  for (const s of [a, b, c]) assert.ok(typeof s === 'string' && s.trim())
  assert.notStrictEqual(a, b)
  assert.notStrictEqual(b, c)
  assert.notStrictEqual(a, c)
  assert.match(b, /gpt\.pth/)
})

// ---------------------------------------------------------------------------
//  ⛔ 守卫：这个文件里不许出现任何引擎名、任何下载器名
// ---------------------------------------------------------------------------
// 这条不是洁癖。一旦某个具体引擎或某个具体下载器的名字进了 lib/，
// 「接引擎不用碰 lib/」就破了 —— 而破的那一刻没有任何测试会红，
// 除了这一条。同类守卫在 profile.js / paramTable.js 上都有。

test('lib/engines/checkpoints.js 里不许写死引擎名或下载器名', () => {
  const src = fs.readFileSync(path.join(__dirname, 'checkpoints.js'), 'utf8')
  // 先剥注释：注释里讲历史（比如"以前只有 GPT-SoVITS 有底模"）是允许的，
  // 真正要禁的是代码里出现这些名字。剥注释再 grep 的手法同 verify_ac.py。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')

  const banned = [
    'gpt-sovits', 'gpt_sovits', 'sovits', 'indextts', 'index-tts',
    'modelscope', 'huggingface', 'hf_hub', 'git-lfs', 'gsv_pretrained',
  ]
  for (const name of banned) {
    assert.ok(!code.toLowerCase().includes(name),
      `checkpoints.js 的代码里出现了 ${name} —— 底模这件事必须由名片说，` +
      '平台一旦认识某个具体引擎或某个具体下载器，接下一台就得改 lib/。')
  }
})
