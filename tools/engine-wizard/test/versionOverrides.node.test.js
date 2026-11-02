'use strict'
// core/versionOverrides.js 的测试：改版本要改清单本身，不能靠排除。
//
// 判据的理由：uv 的排除语义是「这个包连同依赖它的其它包一起不装」，
//   所以改版本若走排除，依赖它的那些包会一起装不上。这里逐条验证改写规则。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const M = require(path.join(__dirname, '..', 'core', 'versionOverrides.js'))

test('精确钉住的版本：换成指定版本', () => {
  assert.strictEqual(M.replaceVersion('einops==0.8.1', '0.7.0'), 'einops==0.7.0')
  assert.strictEqual(M.replaceVersion('torch==2.5.1', '2.6.0'), 'torch==2.6.0')
})

test('区间约束：保留约束形式，只换版本号', () => {
  assert.strictEqual(M.replaceVersion('einops>=0.8.1', '0.7.0'), 'einops>=0.7.0')
  assert.strictEqual(M.replaceVersion('fugashi~=1.2.0', '1.1.0'), 'fugashi~=1.1.0')
  assert.strictEqual(M.replaceVersion('numpy<=2.2.3', '2.1.0'), 'numpy<=2.1.0')
})

test('原本没钉版本的：换成钉住', () => {
  assert.strictEqual(M.replaceVersion('einops', '0.7.0'), 'einops==0.7.0')
})

test('带 extras 的：extras 要留着', () => {
  assert.strictEqual(M.replaceVersion('einops[extra]==0.8.1', '0.7.0'), 'einops[extra]==0.7.0')
})

test('换不了的：如实报 null，不闷头改', () => {
  assert.strictEqual(M.replaceVersion('', '1.0'), null)
  assert.strictEqual(M.replaceVersion('einops==0.8.1', ''), null)
})

test('改写清单：只动指定的那一行', () => {
  const text = ['einops==0.8.1', 'torch==2.5.1', 'numpy==2.2.3'].join('\n')
  const r = M.rewriteManifest(text, { torch: '2.6.0' })
  assert.ok(r.text.includes('torch==2.6.0'), 'torch 要换成 2.6.0')
  assert.ok(r.text.includes('einops==0.8.1'), 'einops 不能动')
  assert.deepStrictEqual(r.changed, ['torch'])
})

test('改写清单：注释行、选项行、链接行都不动', () => {
  const text = [
    '# torch==1.0.0',
    '--extra-index-url https://example.com/simple',
    'git+https://example.com/x.git#egg=x',
    'torch==2.5.1',
  ].join('\n')
  const r = M.rewriteManifest(text, { torch: '2.6.0' })
  assert.ok(r.text.includes('# torch==1.0.0'), '注释行不能动')
  assert.ok(r.text.includes('--extra-index-url'), '选项行不能动')
  assert.ok(r.text.includes('git+https://example.com/x.git#egg=x'), '链接行不能动')
  assert.ok(r.text.includes('torch==2.6.0'), '真正的依赖行要改')
})

test('改写清单：包名归一化（大小写、-_. 视作同一个）', () => {
  const text = 'einops==0.8.1\nsound_file==0.12.1'
  const r = M.rewriteManifest(text, { 'EinOps': '0.7.0', 'sound-file': '0.11.0' })
  assert.ok(r.text.includes('einops==0.7.0'), 'einops 要被改')
  assert.ok(r.text.includes('sound_file==0.11.0'), 'sound_file 要被改')
  assert.deepStrictEqual(r.changed.sort(), ['einops', 'sound-file'])
})

test('改写清单：清单里没有的包，如实报 missing', () => {
  const text = 'einops==0.8.1'
  const r = M.rewriteManifest(text, { torch: '2.6.0' })
  assert.deepStrictEqual(r.changed, [])
  assert.deepStrictEqual(r.missing, ['torch'])
})

test('改写清单：行尾注释要留着', () => {
  const text = 'torch==2.5.1  # pinned by upstream'
  const r = M.rewriteManifest(text, { torch: '2.6.0' })
  assert.ok(r.text.includes('# pinned by upstream'), '行尾注释要留着')
  assert.ok(r.text.includes('torch==2.6.0'), '版本要换')
})

test('写出清单副本：上游文件保持原样，副本里才是新版本', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vo-'))
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'einops==0.8.1\ntorch==2.5.1\n', 'utf8')
  const r = M.writeLocalManifest(dir, 'requirements.txt', { torch: '2.6.0' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.file, M.LOCAL_MANIFEST)
  const upstream = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8')
  assert.ok(upstream.includes('torch==2.5.1'), '上游文件不能被改')
  const local = fs.readFileSync(path.join(dir, M.LOCAL_MANIFEST), 'utf8')
  assert.ok(local.includes('torch==2.6.0'), '副本里要是新版本')
  assert.ok(local.includes('einops==0.8.1'), '没改的包要原样保留')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('写出清单副本：清单读不到时如实报', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vo-'))
  const r = M.writeLocalManifest(dir, 'requirements.txt', { torch: '2.6.0' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'MANIFEST_UNREADABLE')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('写出清单副本：所选版本一项都对不上时如实报', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vo-'))
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'einops==0.8.1\n', 'utf8')
  const r = M.writeLocalManifest(dir, 'requirements.txt', { torch: '2.6.0' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_VERSION_OVERRIDE_APPLIED')
  assert.ok(r.errorZh.includes('torch'), '要说清是哪个包对不上')
  fs.rmSync(dir, { recursive: true, force: true })
})
