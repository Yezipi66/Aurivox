'use strict'

// GSV 的扫描结果基线（不打桩）。
//
// 这条链路上的每个标签都从 scan.json 来，所以这份基线同时钉住两件事：
// GSV 那份声明没写坏，以及「文件名 → 标签」的读法和扫描约定搬走之前一致。
// 用的是仓库里那张真名片与它目录下的真 scan.json，不改路径、不换引擎。
//
// 覆盖：版本头 00/03/05/06、文件名里的 _v2ProPlus_ 标记、大小兜底、
// 权重位里的目录条目、GPT 位的轮数、从 .pth / .ckpt 恢复语种。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { scanVoiceDir, deriveLanguageFromModels } = require('./scan')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gsv-scan-baseline-'))
const VOICE_ID = 'baselinevoice'
const voiceDir = path.join(ROOT, VOICE_ID)

function put(rel, content) {
  const fp = path.join(voiceDir, rel)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
  return fp
}

put('models/gpt-sovits/gpt/role_ja-e10.ckpt', Buffer.from('00'))
put('models/gpt-sovits/sovits/h_zh_e1_s2.pth', Buffer.from('00'))
put('models/gpt-sovits/sovits/h_en_e1_s2.pth', Buffer.from('03'))
put('models/gpt-sovits/sovits/h_ko_e1_s2.pth', Buffer.from('05'))
put('models/gpt-sovits/sovits/h_fr_e1_s2.pth', Buffer.from('06'))
put('models/gpt-sovits/sovits/mk_v2ProPlus_ja_e1_s2.pth', Buffer.from('PK'))
put('models/gpt-sovits/sovits/plain_nn_e9_s9.pth', Buffer.from('ZZ'))
fs.mkdirSync(path.join(voiceDir, 'models', 'gpt-sovits', 'sovits', 'a_model_dir'), { recursive: true })

const meta = scanVoiceDir(VOICE_ID, voiceDir)

const labelOf = (slot, name) =>
  meta.assets.models['gpt-sovits'][slot].find(x => x.name === name)

test('⭐ GSV 基线：版本头 00/03/05/06 各判成 v1/v3/v2Pro/v2ProPlus', () => {
  assert.equal(labelOf('sovits', 'h_zh_e1_s2.pth').version, 'v1')
  assert.equal(labelOf('sovits', 'h_en_e1_s2.pth').version, 'v3')
  assert.equal(labelOf('sovits', 'h_ko_e1_s2.pth').version, 'v2Pro')
  assert.equal(labelOf('sovits', 'h_fr_e1_s2.pth').version, 'v2ProPlus')
})

test('⭐ GSV 基线：版本头认不出时看文件名标记，再认不出按大小兜底', () => {
  assert.equal(labelOf('sovits', 'mk_v2ProPlus_ja_e1_s2.pth').version, 'v2ProPlus')
  // 名字里没有标记、头也不是官方标记 ⇒ 尺寸规则接手（这个文件只有两个字节，落在最小那档）。
  assert.equal(labelOf('sovits', 'plain_nn_e9_s9.pth').version, 'v1')
})

test('⭐ GSV 基线：轮数只从 -eNN.ckpt 读，版本只贴 version.slot 那一位', () => {
  assert.equal(labelOf('gpt', 'role_ja-e10.ckpt').steps, 10)
  assert.equal(labelOf('gpt', 'role_ja-e10.ckpt').version, undefined,
    'version.slot 是 sovits，GPT 位的文件不贴版本')
  assert.equal(labelOf('sovits', 'h_zh_e1_s2.pth').steps, undefined,
    '.pth 的轮数写法不在 steps_from_name 上')
})

test('⭐ GSV 基线：权重位里的目录条目不贴版本，但照样是候选', () => {
  const d = labelOf('sovits', 'a_model_dir')
  assert.equal(d.is_dir, true)
  assert.equal(d.version, undefined)
})

test('⭐ GSV 基线：约定齐全的角色不在 meta 里留「缺约定」那条诊断', () => {
  assert.equal(meta.assets.scan_conventions_missing, undefined)
})

test('⭐ GSV 基线：语种从 .ckpt 的文件名恢复出来', () => {
  assert.equal(meta.language, 'ja')
  assert.equal(deriveLanguageFromModels(voiceDir), 'ja')
  assert.equal(meta.prompt_lang, 'ja')
  assert.equal(meta.text_lang, 'ja')
})

test('⭐ GSV 基线：.pth 那套命名单独摆出来时也从文件名恢复语种', () => {
  const only = path.join(ROOT, 'onlypth')
  fs.mkdirSync(path.join(only, 'models', 'gpt-sovits', 'sovits'), { recursive: true })
  fs.writeFileSync(path.join(only, 'models', 'gpt-sovits', 'sovits', 'x_de_e1_s2.pth'), Buffer.from('00'))
  assert.equal(deriveLanguageFromModels(only), 'de')
})
