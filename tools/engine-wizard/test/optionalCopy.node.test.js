const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const editor = path.join(__dirname, '..', 'editor')
async function loadKeys () {
  return import(pathToFileURL(path.join(editor, 'optionalKeys.js')).href)
}

test('参考音频新建时预填「是」并真写进文件，已有值不覆盖', async () => {
  const { prefillReferenceAudio } = await loadKeys()
  const blank = prefillReferenceAudio({ id: 'x' })
  assert.strictEqual(blank.capabilities.requires_reference_audio, true, '空名片要写 true')
  const no = prefillReferenceAudio({ id: 'x', capabilities: { requires_reference_audio: false } })
  assert.strictEqual(no.capabilities.requires_reference_audio, false, '已写 false 不能被覆盖')
  const yes = prefillReferenceAudio({ id: 'x', capabilities: { requires_reference_audio: true } })
  assert.strictEqual(yes.capabilities.requires_reference_audio, true)

  const src = fs.readFileSync(path.join(editor, 'OptionalConfig.jsx'), 'utf8')
  assert.ok(src.includes('prefillReferenceAudio(cur)'), '组件要把预填真写进文件')
  assert.ok(!/referenceAudioState|当前算作|按名片推导/.test(src), '旧说法不能与新规则并存')
})

test('界面里的常量默认与平台 DEFAULTS 一致，不各写一份', async () => {
  const { PLATFORM_DEFAULTS } = await loadKeys()
  const { DEFAULTS } = require(path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'profile.js'))
  for (const key of Object.keys(PLATFORM_DEFAULTS)) {
    assert.ok(key in DEFAULTS, `平台没有这个默认值：${key}`)
    assert.strictEqual(PLATFORM_DEFAULTS[key], DEFAULTS[key], `默认值对不上：${key}`)
  }
})
