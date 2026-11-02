'use strict'

// 后端给的「最终要装的那条 spec」必须与真正装进去的那条一致。
//
// 为什么要守这个：界面上 pill 显示的那条 spec 来自后端的 specs 字段。
//   如果后端漏了某个分支没给 specs，界面就会退回上游原文，
//   于是使用者看到的不是真正装进去的那条。
//   （界面自己拼也不对：上游写 >= 的时候，界面拼出来的是 ==，
//     而后端保留上游的约束形式。）

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const IC = require(path.join(__dirname, '..', 'core', 'installChoices.js'))

const MANIFEST = [
  'einops==0.8.1',
  'torch==2.5.1',
  'torchaudio==2.5.1',
  'transformers==4.45.0',
  '',
].join('\n')

function tmpDir (manifest) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-specs-'))
  fs.writeFileSync(path.join(d, 'requirements.txt'), manifest, 'utf8')
  return d
}

const GUESS = {
  from: 'requirements.txt',
  cwd: '.',
  argv: ['uv', 'pip', 'install', '-r', 'requirements.txt'],
  label: 'requirements',
}

test('不装任何东西时，specs 就是上游原文', () => {
  const dir = tmpDir(MANIFEST)
  const r = IC.applyInstallChoices(dir, GUESS, { execute: false })
  assert.ok(!r.ok, '这一步不该报错')
  assert.deepStrictEqual(r.specs, [
    'einops==0.8.1', 'torch==2.5.1', 'torchaudio==2.5.1', 'transformers==4.45.0',
  ], 'specs 要等于上游原文')
})

test('选依赖版本时，specs 里是改后的那条（界面显示 = 装进去的）', () => {
  const dir = tmpDir(MANIFEST)
  const r = IC.applyInstallChoices(dir, GUESS, {
    versionOverrides: { einops: '0.7.0' }, execute: false,
  })
  assert.ok(!r.ok, '这一步不该报错')
  assert.ok(r.specs.includes('einops==0.7.0'), '选的版本要在 specs 里')
  assert.ok(!r.specs.includes('einops==0.8.1'), '不该还留着上游那个版本')
  // 命令读的是清单副本 ⇒ 副本里也必须是改后的那条。
  const copy = path.join(dir, IC.EXCLUDES_FILE.replace('.wizard-excludes.txt', '.wizard-requirements.local.txt'))
  const local = fs.existsSync(copy)
    ? fs.readFileSync(copy, 'utf8')
    : null
  if (local) {
    assert.ok(local.includes('einops==0.7.0'),
      '清单副本里也要是改后的那条：' + local)
  }
})

test('升级 torch 时，specs 里 torch 系是升级后的版本', () => {
  const dir = tmpDir(MANIFEST)
  const r = IC.applyInstallChoices(dir, GUESS, {
    backend: 'ipex', recommendedBackend: 'ipex', upgradeTorch: true, execute: false,
    torchSuggestion: { suggested: '2.6.0', declared: '2.5.1', pythonVersion: '3.11' },
  })
  assert.ok(!r.ok, '这一步不该报错：' + JSON.stringify(r))
  assert.ok(r.specs.includes('torch==2.6.0'), 'torch 要换成升级后的版本')
  assert.ok(r.specs.includes('torchaudio==2.6.0'), 'torchaudio 要一起换')
  assert.ok(!r.specs.includes('torch==2.5.1'), '不该还留着上游那个版本')
  // 其余包照上游原文。
  assert.ok(r.specs.includes('einops==0.8.1'), '其余包照上游原文')
  assert.ok(r.specs.includes('transformers==4.45.0'), '其余包照上游原文')
  // 追加装的那一步与界面显示的版本一致。
  const then = (r.guess.alternative || {}).then || []
  assert.ok(then.includes('torch==2.6.0'),
    '追加装的命令里要装界面显示的那个版本：' + JSON.stringify(then))
  assert.ok(then.includes('torchaudio==2.6.0'),
    '追加装的命令里要装界面显示的那个版本：' + JSON.stringify(then))
})

test('读不到清单时，specs 如实是 null（界面退回上游原文，不编）', () => {
  const dir = tmpDir(MANIFEST)
  fs.unlinkSync(path.join(dir, 'requirements.txt'))
  const r = IC.applyInstallChoices(dir, GUESS, { execute: false })
  assert.ok(!r.ok, '这一步不该报错')
  assert.strictEqual(r.specs, null, '读不到就没有 specs，不许编一个出来')
})

test('清单里的注释、选项行、链接行不算 spec', () => {
  const text = [
    '# 这是注释',
    '-e .',
    '--extra-index-url https://example.invalid/simple',
    'git+https://example.invalid/pkg.git',
    './local/pkg',
    'einops==0.8.1',
    '',
  ].join('\n')
  assert.deepStrictEqual(IC.specsFromManifestText(text), ['einops==0.8.1'])
})
