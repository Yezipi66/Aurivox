'use strict'
// 从 README 找入口的守卫。
// 守住三条：只认明确的 python 调用写法；认不出就是认不出（不猜）；README 点名时压过参数打分。

const { test } = require('node:test')
const assert = require('node:assert')

const {
  entriesFromReadme, entriesFromPyproject, entriesFromSetupPy, mergeEntries, moduleToFiles,
} = require('../core/readmeEntry.js')
const { pickEntry } = require('../core/entryPick.js')

test('认 python -m 与 python 脚本两种写法', () => {
  const text = [
    '```bash',
    'python -m cli.inference --text "hi" --prompt_speech_path ref.wav',
    'python3 webui.py',
    '```',
  ].join('\n')
  const got = entriesFromReadme(text)
  assert.deepStrictEqual(got.modules, ['cli.inference'])
  assert.deepStrictEqual(got.files, ['webui.py'])
})

test('README 里同时写着好几个启动方式时，全部列出来', () => {
  const got = entriesFromReadme('python -m a.b\nthen python -m a.c\nand python tools/prepare.py')
  assert.deepStrictEqual(got.modules, ['a.b', 'a.c'])
  assert.deepStrictEqual(got.files, ['tools/prepare.py'])
})

test('认不出就返回空，不猜', () => {
  assert.deepStrictEqual(entriesFromReadme('bash run.sh'), { modules: [], files: [] })
  assert.deepStrictEqual(entriesFromReadme(''), { modules: [], files: [] })
  assert.deepStrictEqual(entriesFromReadme(null), { modules: [], files: [] })
})

test('python -m 的模块名不会被当成 .py 路径重复收一遍', () => {
  const got = entriesFromReadme('python -m cli.inference')
  assert.deepStrictEqual(got.files, [])
})

test('模块名翻成源文件：扁平布局与 src 布局两组都试', () => {
  assert.deepStrictEqual(moduleToFiles('a.b.c'), [
    'a/b/c.py', 'a/b/c/__main__.py',
    'src/a/b/c.py', 'src/a/b/c/__main__.py',
  ])
})

test('python 带版本号也认：python3.10 / python3.12', () => {
  const got = entriesFromReadme('python3.10 cli/inference.py --text hi')
  assert.deepStrictEqual(got.files, ['cli/inference.py'])
  assert.deepStrictEqual(entriesFromReadme('python3.12 -m a.b.c').modules, ['a.b.c'])
})

test('作者站在子目录里写用法：cd 前缀算进路径', () => {
  const got = entriesFromReadme('cd cli && python inference.py --text hi')
  assert.deepStrictEqual(got.files, ['cli/inference.py'])
})

test('打包声明里的入口：三种常见段落都读', () => {
  const text = [
    '[project]',
    'name = "x"',
    '',
    '[project.scripts]',
    'x-infer = "a.b.c:main"',
    '',
    '[project.entry-points.console_scripts]',
    'x-old = "a.b.legacy:run"',
    '',
    '[tool.poetry.scripts]',
    'x-poetry = "a.b.poetry:go"',
  ].join('\n')
  const got = entriesFromPyproject(text)
  assert.deepStrictEqual(got.modules, ['a.b.c', 'a.b.legacy', 'a.b.poetry'])
})

test('键名加了引号也能解析：命令名里带连字符时生成器常加引号', () => {
  // 命令名里带连字符很常见，有的生成器会给键名加引号。TOML 两种写法都合法，这里都认。
  const text = [
    '[project]',
    'name = "x"',
    '',
    '[project.scripts]',
    '"x-infer-cli" = "a.b.c:main"',
    '"x-infer-gradio" = "a.c.d:main"',
  ].join('\n')
  const got = entriesFromPyproject(text)
  assert.deepStrictEqual(got.modules, ['a.b.c', 'a.c.d'])
  assert.deepStrictEqual(got.commands, ['x-infer-cli', 'x-infer-gradio'])
})

test('段名带引号也认：entry-points 这类带点的段名在 TOML 里必须加引号', () => {
  const text = [
    '[project.entry-points."console_scripts"]',
    'x-infer = "a.b.c:main"',
  ].join('\n')
  assert.deepStrictEqual(entriesFromPyproject(text).modules, ['a.b.c'])
})

test('值后面跟着行尾注释也能取到模块名', () => {
  const text = [
    '[project.scripts]',
    'x-infer = "a.b.c:main"   # 推理入口',
    'x-old = a.b.legacy:main  # 不带引号的写法',
  ].join('\n')
  assert.deepStrictEqual(entriesFromPyproject(text).modules, ['a.b.c', 'a.b.legacy'])
})

test('别的段落里的同名写法不算入口', () => {
  const text = ['[tool.black]', 'line-length = "a.b.c:main"'].join('\n')
  assert.deepStrictEqual(entriesFromPyproject(text).modules, [])
})

test('setup.py 的 console_scripts 也能认', () => {
  const text = "setup(name='x', entry_points={'console_scripts': ['x-infer=a.b.c:main']})"
  assert.deepStrictEqual(entriesFromSetupPy(text).modules, ['a.b.c'])
})

test('几路候选合并去重，保序', () => {
  const got = mergeEntries(
    { modules: ['a.b'], files: ['x.py'], commands: ['x'] },
    { modules: ['a.b', 'c.d'], files: ['x.py', 'y.py'] })
  assert.deepStrictEqual(got.modules, ['a.b', 'c.d'])
  assert.deepStrictEqual(got.files, ['x.py', 'y.py'])
})

// 造一份并列的扫描结果：两个文件四类齐全、参数数量也相同，打分分不出高下。
function tiedParams () {
  const mk = (file) => [
    { source: 'cli', name: 'text', target: '--text', kind: 'str', style: 'value', required: true, group: 'infer', source_file: file },
    { source: 'cli', name: 'voice', target: '--voice', kind: 'str', style: 'value', required: false, group: 'infer', source_file: file },
    { source: 'cli', name: 'output', target: '--output', kind: 'str', style: 'value', required: false, group: 'infer', source_file: file },
    { source: 'cli', name: 'model-dir', target: '--model-dir', kind: 'str', style: 'value', required: false, group: 'infer', source_file: file },
  ]
  return [...mk('cli/a.py'), ...mk('cli/b.py')]
}

test('打分分不出高下时，README 点名的那个胜出', () => {
  const scoredOnly = pickEntry(tiedParams())
  assert.strictEqual(scoredOnly.ambiguous, true, '前提：这两个文件打分确实并列')

  const withReadme = pickEntry(tiedParams(), { fromReadme: { modules: ['cli.b'], files: [] } })
  assert.strictEqual(withReadme.file, 'cli/b.py')
  assert.strictEqual(withReadme.source, 'readme')
  assert.strictEqual(withReadme.ambiguous, false, 'README 给了答案，就不再算并列')
})

test('README 点了名但扫描没见过这个文件，回到打分，不硬认', () => {
  const got = pickEntry(tiedParams(), { fromReadme: { modules: ['cli.nothere'], files: ['ghost.py'] } })
  assert.strictEqual(got.source, 'score')
})

// ---- src 布局 -------------------------------------------------------------

function fourKinds (file) {
  return [
    { source: 'cli', name: 'text', target: '--text', required: true, group: '(root)', source_file: file },
    { source: 'cli', name: 'ref_audio', target: '--ref-audio', required: false, group: '(root)', source_file: file },
    { source: 'cli', name: 'output_path', target: '--output-path', required: false, group: '(root)', source_file: file },
    { source: 'cli', name: 'model', target: '--model', required: false, group: '(root)', source_file: file },
  ]
}

test('src 布局：声明点过名就用声明的模块名，并把 cwd 起算目录标成 src', () => {
  const got = pickEntry(fourKinds('src/a/b/c.py'), { fromEntryPoints: { modules: ['a.b.c'], files: [] } })
  assert.strictEqual(got.source, 'entry-points')
  assert.strictEqual(got.file, 'src/a/b/c.py')
  assert.strictEqual(got.module, 'a.b.c', '不能用扫描路径反推成 src.a.b.c')
  assert.strictEqual(got.srcRoot, 'src')
})

test('src 布局：没有声明时按路径反推也要剥掉 src，并标出起算目录', () => {
  const got = pickEntry(fourKinds('src/a/b/c.py'))
  assert.strictEqual(got.module, 'a.b.c')
  assert.strictEqual(got.srcRoot, 'src')
})

test('src 本身是包时不剥：src/__init__.py 存在的工程按原路径拼', () => {
  const got = pickEntry(fourKinds('src/a/b/c.py'), { srcIsPackage: true })
  assert.strictEqual(got.module, 'src.a.b.c')
  assert.strictEqual(got.srcRoot, null)
})

// ---- 参数词表与路径基准 ---------------------------------------------------

test('只有文本与 save_wav 也算两类：音频后缀属于输出落点', () => {
  const params = [
    { source: 'cli', name: 'text', target: '--text', required: true, group: '(root)', source_file: 'a.py' },
    { source: 'cli', name: 'save_wav', target: '--save_wav', required: false, group: '(root)', source_file: 'a.py' },
  ]
  const got = pickEntry(params)
  assert.strictEqual(got.file, 'a.py', '两类就该给建议，不该因为词表太窄而返回 null')
  assert.strictEqual(got.score, 2)
})

test('README 只写了文件名（站在子目录里写）：唯一后缀能命中', () => {
  const got = pickEntry(fourKinds('cli/inference.py'),
    { fromReadme: { modules: [], files: ['inference.py'] } })
  assert.strictEqual(got.source, 'readme')
  assert.strictEqual(got.file, 'cli/inference.py')
})

test('同名文件不止一个时，后缀匹配不替使用者挑', () => {
  const params = [...fourKinds('cli/inference.py'), ...fourKinds('web/inference.py')]
  const got = pickEntry(params, { fromReadme: { modules: [], files: ['inference.py'] } })
  assert.strictEqual(got.source, 'score', '两个都叫 inference.py 时只按分数，不按后缀硬认')
})
