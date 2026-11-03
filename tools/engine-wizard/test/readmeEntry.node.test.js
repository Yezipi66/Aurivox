'use strict'
// 从 README 找入口的守卫。
// 守住三条：只认明确的 python 调用写法；认不出就是认不出（不猜）；README 点名时压过参数打分。

const { test } = require('node:test')
const assert = require('node:assert')

const { entriesFromReadme, moduleToFiles } = require('../core/readmeEntry.js')
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

test('模块名翻成两种可能的源文件', () => {
  assert.deepStrictEqual(moduleToFiles('a.b.c'), ['a/b/c.py', 'a/b/c/__main__.py'])
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
