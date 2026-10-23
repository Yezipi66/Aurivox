'use strict'

// 接受「升级 torch 到本机后端上可用版本」这条建议时的装法。
//
// 判据：主安装步跳过 torch 系（上游钉的版本装不上，硬装必然失败），
//   追加一步从本机后端的官方 index 装建议版本的 torch 整族（版本必须配对）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { applyInstallChoices } = require('../core/installChoices.js')

/** 造一个引擎目录，带一份 requirements.txt */
function mkdtempEngine (id, requirements) {
  const mkdtempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-upg-'))
  const mkdtempEngineDir = path.join(mkdtempRoot, 'engines', id)
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  fs.writeFileSync(path.join(mkdtempRoot, 'server.js'), '// anchor\n')
  fs.writeFileSync(path.join(mkdtempEngineDir, 'requirements.txt'), requirements)
  return { root: mkdtempRoot, engineDir: mkdtempEngineDir }
}

/** 一份照 suggestEnvCommand 形状的 guess */
const guessOf = (from) => ({
  argv: ['uv', 'pip', 'install', '-r', from || 'requirements.txt'],
  from: from || 'requirements.txt',
  cwd: '.',
  why: 'why', whyZh: 'why',
})

const SUGGESTION = {
  backend: 'ipex',
  pythonVersion: '3.11',
  declared: '2.5.1',
  declaredSource: 'requirements.txt',
  suggested: '2.6.0',
  available: ['2.6.0', '2.7.0'],
  reason: 'version-not-on-this-backend',
}

test('接受升级 ⇒ 主安装步跳过 torch 系，追加一步装建议版本', () => {
  const { engineDir } = mkdtempEngine('u1',
    'einops==0.8.1\ntorch==2.5.1\ntorchaudio==2.5.1\n')
  const r = applyInstallChoices(engineDir, guessOf(), {
    backend: 'ipex', upgradeTorch: true, torchSuggestion: SUGGESTION,
  })
  assert.ok(r.guess, JSON.stringify(r))
  // 主安装步：跳过 torch 与 torchaudio（整族）
  const main = r.guess.argv
  assert.ok(main.includes('--excludes'), `主步必须带排除清单：${main.join(' ')}`)
  assert.ok(!main.some((a) => /torch/.test(a)),
    `主步不许再装 torch（上游钉的版本装不上）：${main.join(' ')}`)
  // 追加步：从本机后端的官方 index 装建议版本
  const alt = r.guess.alternative
  assert.ok(alt, '应当有追加的那一步')
  assert.ok(alt.then.includes('torch==2.6.0'),
    `追加步必须装建议版本：${alt.then.join(' ')}`)
  assert.ok(alt.then.includes('torchaudio==2.6.0'),
    `torchaudio 必须一起升（版本要配对）：${alt.then.join(' ')}`)
  const idx = alt.then.indexOf('--index-url')
  assert.ok(idx > 0 && /download\.pytorch\.org\/whl\/xpu/.test(alt.then[idx + 1]),
    `必须从本机后端（XPU）的官方 index 装：${alt.then.join(' ')}`)
})

test('接受升级 ⇒ 排除清单文件里含 torch 整族（执行期才写盘）', () => {
  const { engineDir } = mkdtempEngine('u2',
    'einops==0.8.1\ntorch==2.5.1\ntorchaudio==2.5.1\n')
  const r = applyInstallChoices(engineDir, guessOf(), {
    backend: 'ipex', upgradeTorch: true, torchSuggestion: SUGGESTION,
    execute: true,
  })
  assert.ok(r.guess, JSON.stringify(r))
  const f = path.join(engineDir, '.wizard-excludes.txt')
  assert.ok(fs.existsSync(f), '执行期应当写排除清单')
  const text = fs.readFileSync(f, 'utf8')
  assert.ok(/^torch$/m.test(text), `排除清单要含 torch：${text}`)
  assert.ok(/^torchaudio$/m.test(text), `排除清单要含 torchaudio：${text}`)
})

test('不接受升级 ⇒ 装法原样返回（不闷头改版本）', () => {
  const { engineDir } = mkdtempEngine('u3',
    'einops==0.8.1\ntorch==2.5.1\ntorchaudio==2.5.1\n')
  const g = guessOf()
  const r = applyInstallChoices(engineDir, g, {
    backend: 'ipex', upgradeTorch: false, torchSuggestion: SUGGESTION,
  })
  assert.deepStrictEqual(r.guess, g, '装法必须原样返回')
  assert.strictEqual(r.choices.applied, false)
})

test('接受升级但没有建议 ⇒ 如实报错，不闷头改版本', () => {
  const { engineDir } = mkdtempEngine('u4', 'torch==2.5.1\n')
  const r = applyInstallChoices(engineDir, guessOf(), {
    backend: 'ipex', upgradeTorch: true, torchSuggestion: null,
  })
  assert.ok(!r.guess, '应当报错')
  assert.strictEqual(r.code, 'NO_TORCH_SUGGESTION')
  assert.ok(r.error && r.errorZh, '错误文案要双语成对')
})

test('接受升级但后端没有官方 index ⇒ 如实报错', () => {
  const { engineDir } = mkdtempEngine('u5', 'torch==2.5.1\n')
  const r = applyInstallChoices(engineDir, guessOf(), {
    backend: 'directml', upgradeTorch: true, torchSuggestion: SUGGESTION,
  })
  assert.ok(!r.guess, '应当报错')
  assert.strictEqual(r.code, 'BACKEND_NO_INDEX')
})

test('上游没声明 torch 系 ⇒ 升级只装 torch 一个（不凭空加兄弟包）', () => {
  const { engineDir } = mkdtempEngine('u6', 'einops==0.8.1\nnumpy==2.2.3\n')
  const r = applyInstallChoices(engineDir, guessOf(), {
    backend: 'ipex', upgradeTorch: true, torchSuggestion: SUGGESTION,
  })
  assert.ok(r.guess, JSON.stringify(r))
  const alt = r.guess.alternative
  assert.ok(alt.then.includes('torch==2.6.0'))
  assert.ok(!alt.then.some((a) => /torchaudio|torchvision/.test(a)),
    `上游没声明的兄弟包不许凭空加：${alt.then.join(' ')}`)
})

test('锁文件那条路：接受升级 ⇒ sync 跳过 torch 系', () => {
  const { engineDir } = mkdtempEngine('u7', '')
  fs.writeFileSync(path.join(engineDir, 'uv.lock'),
    'version = 1\n\n[[package]]\nname = "torch"\nversion = "2.5.1"\n')
  const g = { argv: ['uv', 'sync'], from: 'uv.lock', cwd: '.', why: 'w', whyZh: 'w' }
  const r = applyInstallChoices(engineDir, g, {
    backend: 'ipex', upgradeTorch: true, torchSuggestion: SUGGESTION,
  })
  assert.ok(r.guess, JSON.stringify(r))
  const argv = r.guess.argv
  assert.ok(argv.includes('--no-install-package'), argv.join(' '))
  assert.ok(argv.includes('torch'), `sync 必须跳过 torch：${argv.join(' ')}`)
  assert.ok(r.guess.alternative.then.includes('torch==2.6.0'))
})
