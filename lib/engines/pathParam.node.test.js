// 「这个参数的值是一个文件」—— manifest.json 能不能说出这句话。
//
// 在 2026-08-29 之前说不出来：params.schema 的 type 只有
// number / integer / boolean / enum 四种，没有路径。
//
// 后果不是「少一种控件」，是**平台被迫认识「权重」这个概念**：
// GPT-SoVITS 的两个权重当年只能在参数表之外另开一套（抬成 recipe 的顶层
// 字段 gpt_ckpt / sovits_pth，再由前端各画一遍「GPT 槽 + SoVITS 槽」），
// 于是平台知道了什么是权重、该有几个、怎么配对 —— 而 IndexTTS2 根本没有
// 这个概念，别家引擎的个数也不会正好是 2。
//
// 加上 'path' 之后：权重只是袋子里一个值是路径的参数。有几个、叫什么，
// 引擎自己说；一个都不写，界面上一格都不长。

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')

// 一台假引擎：两个路径参数（名字跟 gpt_ckpt / sovits_pth 处处不同），
// 外加一台**一个路径参数都没有**的引擎，用来验「不长格子」那一半。
function manifest(id, extra) {
  return Object.assign({
    contract_version: 2,
    id,
    label: id,
    upstream: { url: 'https://example.invalid/x', commit: null, license: 'MIT',
      commit_unknown_reason: '这是测试用的假引擎，本来就没有上游历史可记。' },
    param_keys: ['text', 'brain_file', 'voice_file', 'wobble'],
    maps: { text: 'text' },
    payload_keys: ['text', 'brain_file', 'voice_file', 'wobble'],
    defaults: {},
    params: { schema: {} },
    default_base_url: 'http://127.0.0.1:9999',
    timeout_ms: 1000,
    timeout_ms_source: 'estimated',
    max_chars: 20,
    max_chars_source: 'estimated',
    runtime: { python: 'python', entry: 'x.py', ready_endpoint: '/', ready_timeout_ms: 1000,
      ready_timeout_ms_source: 'estimated' },
    // ⚠ 这几个不是本测试关心的，但契约要求「漏写」和「不限制」必须区分开，
    //   所以一个都不能省 —— 省了会在别的地方报错，掩盖掉本测试真正要看的东西。
    capabilities: {
      hot_swap_models: false,
      requires_reference_audio: false,
      reference_clip_seconds: null,
      streaming: false,
      output_sample_rate: 22050,
    },
  }, extra)
}

function ask(dir, id) {
  // registry 在 require 时就把 ENGINES_DIR 解构下来了，所以必须起子进程，
  // 不能在本进程里改环境变量。
  const code = `
    const { resolveEngineProfile } = require(${JSON.stringify(path.join(ROOT, 'lib', 'engines', 'profile.js'))});
    const p = resolveEngineProfile(${JSON.stringify(id)});
    process.stdout.write(JSON.stringify(p.param_schema));
  `
  const out = execFileSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, { ENGINES_DIR: dir }),
    encoding: 'utf8',
  })
  return JSON.parse(out)
}

function withEngines (engines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathparam-'))
  try {
    for (const m of engines) {
      const d = path.join(dir, m.id)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m, null, 2))
    }
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('一台引擎可以说「我有两个参数，值是文件」', () => {
  const m = manifest('two-files', {
    params: { schema: {
      brain_file: { type: 'path', default: '', tier: 'common',
        label: { en: 'Brain file', zh: '脑子文件' } },
      voice_file: { type: 'path', default: '', tier: 'common',
        label: { en: 'Voice file', zh: '嗓子文件' } },
    } },
  })
  const schema = withEngines([m], d => ask(d, 'two-files'))
  const paths = schema.filter(f => f.type === 'file').map(f => f.name)
  assert.deepEqual(paths, ['brain_file', 'voice_file'])
  assert.equal(schema.find(f => f.name === 'brain_file').label.zh, '脑子文件')
})

test('⭐ 一个文件都不要的引擎，一个路径参数都没有 —— 这是完全正常的一台引擎', () => {
  const m = manifest('no-files', {
    params: { schema: { wobble: { type: 'number', default: 0.5, tier: 'common' } } },
  })
  const schema = withEngines([m], d => ask(d, 'no-files'))
  assert.deepEqual(schema.filter(f => f.type === 'file'), [])
})

test('路径参数个数不必是 2 —— 平台不许对个数有任何期待', () => {
  const m = manifest('one-file', {
    params: { schema: { brain_file: { type: 'path', default: '', tier: 'common' } } },
  })
  const schema = withEngines([m], d => ask(d, 'one-file'))
  assert.equal(schema.filter(f => f.type === 'file').length, 1)
})

test('路径参数照样受 C11 管：默认值必须有且只有一处', () => {
  // 两处都不写 —— 界面不知道这一格开局显示什么。
  const m = manifest('no-default', {
    params: { schema: { brain_file: { type: 'path', tier: 'common' } } },
  })
  assert.throws(() => withEngines([m], d => ask(d, 'no-default')), /没人给它默认值|ENGINE_MANIFEST_INCOMPLETE/)
})

test('路径参数也必须先在 param_keys 里声明过', () => {
  const m = manifest('stray', {
    params: { schema: { not_declared: { type: 'path', default: '', tier: 'common' } } },
  })
  assert.throws(() => withEngines([m], d => ask(d, 'stray')), /param_keys|ENGINE_MANIFEST_INVALID_VALUE/)
})

test('⛔ 拼错的类型仍然当场拦下，且报错里要列出 file 这一种', () => {
  // ⚠ 这条测试原本拿 'file' 当「拼错的类型」—— 2026-08-29 收口之后 'file'
  //   正是那一种的正名了，所以换成一个真拼错的词。
  const m = manifest('typo', {
    params: { schema: { brain_file: { type: 'filepath', default: '', tier: 'common' } } },
  })
  assert.throws(
    () => withEngines([m], d => ask(d, 'typo')),
    (e) => /file/.test(String(e.stderr || e.message)),
    '报错文案没有告诉作者有 file 这一种可用',
  )
})

test('⭐ 老名片一个字不改也照样装得上 —— path / enum / integer / string 全收', () => {
  // 判据：第三方名片不该因为我们换了个词就装不上。别名只在读入的那一刻折叠。
  const m = manifest('legacy-words', {
    param_keys: ['text', 'a_path', 'a_enum', 'a_int', 'a_str'],
    payload_keys: ['text', 'a_path', 'a_enum', 'a_int', 'a_str'],
    params: { schema: {
      a_path: { type: 'path', default: '', tier: 'common' },
      a_enum: { type: 'enum', default: 'x', tier: 'common', choices: [{ value: 'x' }] },
      a_int: { type: 'integer', default: 3, tier: 'common' },
      a_str: { type: 'string', default: '', tier: 'common' },
    } },
  })
  const schema = withEngines([m], d => ask(d, 'legacy-words'))
  const t = Object.fromEntries(schema.map(f => [f.name, f.type]))
  assert.deepEqual(t, { a_path: 'file', a_enum: 'select', a_int: 'number', a_str: 'text' })
  // 出口只有五种：⛔ 老词不许漏到界面上，否则前端又要认两套。
  assert.deepEqual(
    schema.map(f => f.type).filter(x => !['text', 'number', 'select', 'boolean', 'file'].includes(x)),
    [])
})

// ───────────────────────────────────────────────────────────────────────
// ⛔ 上面这些验的全是**声明侧**：名片说得出「我有个参数值是文件」。
//    洞就是从这条缝里漏的 —— 没有一条验**收取侧**：用户真填了值，平台收不收。
//
//    实际情况是：coerceIncoming 有 integer / number / boolean / enum 四个
//    分支，唯独没有 path，于是落到函数末尾的 return undefined。
//    ⇒ 名片声明了、界面画得出格子、用户填了，值在进请求体前**被无声丢掉**。
//    ⇒ 症状是「我明明选了权重，它却没换」，而且不报错。
//
//    这几条就是拿来钉住那个分支的：把 path 分支删掉，它们必须变红。
// ───────────────────────────────────────────────────────────────────────

const { coerceIncoming } = require('./paramTable')

const PATH_ENTRY = { name: 'brain_file', type: 'path' }

test('⭐ 用户填的路径（裸字符串）收得进来 —— 删掉 path 分支这条必须变红', () => {
  assert.equal(
    coerceIncoming(PATH_ENTRY, 'assets/foo/brain.ckpt'),
    'assets/foo/brain.ckpt',
    '裸路径被丢掉了：用户选了文件却等于没选，而且不报错',
  )
})

test('⭐ 平台托管路径的可移植写法 { base, path } 也收得进来', () => {
  const v = { base: 'asset', path: 'foo/brain.ckpt' }
  assert.deepEqual(
    coerceIncoming(PATH_ENTRY, v), v,
    '{base,path} 形状被丢掉了 —— 配方里存的就是这个形状，等于配方读不回来',
  )
})

test('没填就是没填：空串 / 空对象 / 缺 path 字段，一律当作没填', () => {
  assert.equal(coerceIncoming(PATH_ENTRY, ''), undefined)
  assert.equal(coerceIncoming(PATH_ENTRY, {}), undefined)
  assert.equal(coerceIncoming(PATH_ENTRY, { base: 'asset' }), undefined)
  assert.equal(coerceIncoming(PATH_ENTRY, { base: 'asset', path: '' }), undefined)
})

test('⛔ 只判形状，不猜：数字不是路径', () => {
  assert.equal(coerceIncoming(PATH_ENTRY, 123), undefined)
  assert.equal(coerceIncoming(PATH_ENTRY, true), undefined)
})

test('⛔ 平台不查这个文件在不在 —— 它不认识这个文件是什么', () => {
  // 一个铁定不存在的路径，照收不误。查不查得着是引擎的事，
  // 平台一插手就等于替引擎规定它的文件该放在哪。
  const ghost = 'D:/nowhere/does-not-exist-' + Date.now() + '.ckpt'
  assert.equal(coerceIncoming(PATH_ENTRY, ghost), ghost)
})

test('补 path 分支没有碰坏另外四种', () => {
  assert.equal(coerceIncoming({ type: 'integer' }, '7'), 7)
  assert.equal(coerceIncoming({ type: 'number' }, '1.5'), 1.5)
  assert.equal(coerceIncoming({ type: 'boolean' }, 'false'), false)
  assert.equal(
    coerceIncoming({ type: 'enum', choices: [{ value: 'a' }] }, 'a'), 'a')
  assert.equal(
    coerceIncoming({ type: 'enum', choices: [{ value: 'a' }] }, 'zzz'), undefined)
})
