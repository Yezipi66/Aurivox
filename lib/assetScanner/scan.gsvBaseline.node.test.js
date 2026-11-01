'use strict'

// GSV 扫描结果的基线：整份 meta 逐字段锁死。
//
// 期望值固化在 scan.gsvBaseline.fixture.json 里，就是改动前的扫描器在同一批文件上扫出来的那份。
// 「零回归」说的是界面上那几行小字一个字都没变：
// 语种、轮数、版本、大小、条目顺序，连没贴标签的目录条目都算，所以整份比而不挑几个字段。
// normalize 只抹掉 created_at（每次扫描都新建）和临时根目录（每台机器不同）。
// fixture 的键是文件名、值是文件开头的字面字节：版本头按字节读，所以 "00" 就是 ASCII 的 00。
// 名单各条覆盖：a0..a6 = 版本头 00/01/02/03/04/05/06，hd_v2ProPlus = 版本头优先于文件名，
// mk_* = 版本头认不出时看文件名标记（全小写那条覆盖规则里的 i 标志），plain_ = 名字里也没标记时按大小兜底，
// a_model_dir = 权重位里的目录条目不贴版本但仍是候选，role_ja-e10.ckpt = 轮数只从 -eNN.ckpt 读。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { scanVoiceDir, deriveLanguageFromModels } = require('./scan')

const fixture = require('./scan.gsvBaseline.fixture.json')
const VOICE_ID = 'baselinevoice'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsv-baseline-'))
const voiceDir = path.join(root, VOICE_ID)

function buildFixture(dir, files, dirs = []) {
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, Buffer.from(content, 'latin1'))
  }
  for (const rel of dirs) fs.mkdirSync(path.join(dir, rel), { recursive: true })
}

buildFixture(voiceDir, fixture.files, fixture.dirs)

function normalize(meta) {
  delete meta.created_at
  return JSON.parse(JSON.stringify(meta).split(root.replace(/\\/g, '/')).join('<ROOT>'))
}

test('⭐ GSV 基线：整份 meta 与 fixture 逐字段相同', () => {
  assert.deepStrictEqual(normalize(scanVoiceDir(VOICE_ID, voiceDir)), fixture.meta)
})

test('⭐ GSV 基线：语种 token 是三字母的也认', () => {
  const dir = path.join(root, 'yue')
  buildFixture(dir, { 'models/gpt-sovits/gpt/role_yue-e3.ckpt': '00' }, [])
  assert.equal(deriveLanguageFromModels(dir), 'yue')
})

test('⭐ GSV 基线：语种 token 大写也恢复得出来，落库转小写', () => {
  const dir = path.join(root, 'case')
  buildFixture(dir, { 'models/gpt-sovits/gpt/role_EN-e7.ckpt': '00' }, [])
  assert.equal(deriveLanguageFromModels(dir), 'en')
})

test('⭐ GSV 基线：只有 .pth 那套命名单独摆出来时也恢复得出语种', () => {
  const dir = path.join(root, 'onlypth')
  buildFixture(dir, { 'models/gpt-sovits/sovits/x_de_e1_s2.pth': '00' }, [])
  assert.equal(deriveLanguageFromModels(dir), 'de')
})
