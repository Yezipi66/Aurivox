'use strict'

// ===========================================================================
//  合成结果复用缓存
// ===========================================================================
//
// 这个文件的重点只有一件事：**证明指纹不会漏**。
//
// 缓存算错的后果不是慢，是返回一段错的音频而且不报错 —— 用户换了个语速、
// 换了个参考音频、换了个模型，听到的还是上一次那段。所以下面第一组用例是
// 「名片驱动的全覆盖」：从真实名片上把参数键一个个拿出来，逐个改值，
// 逐个断言指纹必须变。名片上加了新键而指纹没跟上，这里就红。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createSegmentCache, stableStringify, referencePayloadKeys } = require('./segmentCache')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-cache-'))
const cacheDir = path.join(tmp, 'segments')

const REF = path.join(tmp, 'ref.wav')
const GPT = path.join(tmp, 'model.ckpt')
const SOVITS = path.join(tmp, 'model.pth')
fs.writeFileSync(REF, Buffer.from('reference audio bytes'))
fs.writeFileSync(GPT, Buffer.from('gpt weights'))
fs.writeFileSync(SOVITS, Buffer.from('sovits weights'))

// 形状照着 gpt-sovits 名片来（maps 里参考音频叫 ref_audio_path）。
const PROFILE = {
  id: 'gpt-sovits',
  label: 'GPT-SoVITS',
  base_url: 'http://127.0.0.1:9880',
  maps: {
    text: 'text',
    reference_audio: 'ref_audio_path',
    aux_reference_audio: 'aux_ref_audio_paths',
    speed: 'speed_factor',
    seed: 'seed',
  },
}

const basePayload = () => ({
  text: '今日はいい天気ですね',
  text_lang: 'ja',
  ref_audio_path: REF,
  prompt_text: '参考文本',
  prompt_lang: 'ja',
  speed_factor: 1.0,
  seed: 12345,
  top_k: 15,
  top_p: 1,
  temperature: 1,
  batch_size: 4,
  repetition_penalty: 1.35,
  sample_steps: 32,
  if_sr: false,
  media_type: 'wav',
})

const baseCfg = () => ({ gpt_model: GPT, sovits_model: SOVITS })

const mk = (over = {}) => createSegmentCache(Object.assign({ dir: cacheDir }, over))

const fpOf = (cache, payloadOver = {}, cfgOver = {}, profile = PROFILE) =>
  cache.fingerprint({
    profile,
    payload: Object.assign(basePayload(), payloadOver),
    cfg: Object.assign(baseCfg(), cfgOver),
  })

// ===========================================================================
//  ⭐⭐ 指纹覆盖：payload 上的每一个键都必须影响指纹
// ===========================================================================

test('⭐⭐ payload 上任何一个键改了值，指纹都必须变（逐键遍历，不是抽查）', () => {
  const cache = mk()
  const base = fpOf(cache)
  const payload = basePayload()
  const missed = []
  for (const k of Object.keys(payload)) {
    const v = payload[k]
    // 造一个"肯定不一样"的值，按原类型来（换类型也算变，但那不能证明
    // 它是按值比的 —— 有些实现只看 typeof）。
    let other
    if (typeof v === 'number') other = v + 7
    else if (typeof v === 'boolean') other = !v
    else if (k === 'ref_audio_path') continue // 参考音频单独测（它比的是内容不是路径）
    else other = `${v}-changed`
    if (fpOf(cache, { [k]: other }) === base) missed.push(k)
  }
  assert.deepEqual(missed, [],
    `这些键改了值指纹却没变 —— 用户拧了它们会听到上一次的音频：${missed.join(', ')}`)
})

test('⭐ payload 上多出一个从没见过的键，指纹也要变（下游引擎的私有参数）', () => {
  // 这条是上一条的推论，但值得单独钉：指纹如果是"按一张已知键名清单取值"，
  // 上面那条会全绿，这条会红。下游作者加的引擎参数正是"没在清单上"的那种。
  const cache = mk()
  assert.notEqual(fpOf(cache, { emo_alpha: 0.7 }), fpOf(cache),
    '指纹在按一张写死的键名清单取值 —— 那就是契约 C11 禁止的第二份参数表')
})

test('payload 的键序不影响指纹（它是好几处代码分别盖出来的）', () => {
  const cache = mk()
  const a = basePayload()
  const b = {}
  for (const k of Object.keys(a).reverse()) b[k] = a[k]
  assert.equal(
    cache.fingerprint({ profile: PROFILE, payload: a, cfg: baseCfg() }),
    cache.fingerprint({ profile: PROFILE, payload: b, cfg: baseCfg() }),
    '键序变了指纹就变 ⇒ 缓存永远不命中，这一刀等于白做')
})

test('嵌套对象的键序同样不影响指纹', () => {
  const cache = mk()
  const x = fpOf(cache, { engine_params: { a: 1, b: { c: 2, d: 3 } } })
  const y = fpOf(cache, { engine_params: { b: { d: 3, c: 2 }, a: 1 } })
  assert.equal(x, y, 'stableStringify 只排了最外层')
})

// ===========================================================================
//  payload 装不下的三样输入
// ===========================================================================

test('⭐ 参考音频比的是内容，不是路径（同一个路径换了 wav 必须变）', () => {
  const cache = mk()
  const before = fpOf(cache)
  fs.writeFileSync(REF, Buffer.from('a completely different voice'))
  const after = fpOf(cache)
  fs.writeFileSync(REF, Buffer.from('reference audio bytes')) // 还原
  assert.notEqual(before, after,
    '路径没变、内容变了却命中旧音频 —— 用户换了参考音频，听到的还是上一个人的声音')
})

test('⭐ 换了模型权重指纹必须变（权重不走 payload，走 /set_*_weights）', () => {
  const cache = mk()
  const other = path.join(tmp, 'other.ckpt')
  fs.writeFileSync(other, Buffer.from('another gpt weights'))
  assert.notEqual(fpOf(cache, {}, { gpt_model: other }), fpOf(cache),
    'GPT 权重不进指纹 = 换了音色还命中旧音频')
  const otherS = path.join(tmp, 'other.pth')
  fs.writeFileSync(otherS, Buffer.from('another sovits weights'))
  assert.notEqual(fpOf(cache, {}, { sovits_model: otherS }), fpOf(cache),
    'SoVITS 权重不进指纹')
})

test('权重文件在原地被覆盖（路径不变、mtime/大小变）也要变', () => {
  const cache = mk()
  const before = fpOf(cache)
  fs.writeFileSync(GPT, Buffer.from('gpt weights RETRAINED, longer content'))
  const after = fpOf(cache)
  fs.writeFileSync(GPT, Buffer.from('gpt weights'))
  assert.notEqual(before, after, '用户重新训练后覆盖了同名权重，缓存却认不出来')
})

test('⭐ 换了引擎、或同一份名片指到另一个地址，指纹必须变', () => {
  const cache = mk()
  const base = fpOf(cache)
  assert.notEqual(fpOf(cache, {}, {}, { ...PROFILE, id: 'indextts2' }), base,
    '两台引擎吃同样的 payload 会命中同一段音频')
  assert.notEqual(fpOf(cache, {}, {}, { ...PROFILE, base_url: 'http://10.0.0.9:9880' }), base,
    '指到另一台机器上的引擎（可能是另一个版本、另一套模型）却命中本机旧音频')
})

test('⛔ 参考音频读不出来时，指纹每次都不同（宁可白推，不可返回错音频）', () => {
  const cache = mk()
  const gone = path.join(tmp, 'no-such-ref.wav')
  const a = fpOf(cache, { ref_audio_path: gone })
  const b = fpOf(cache, { ref_audio_path: gone })
  assert.notEqual(a, b, '读不到的文件被当成"不存在"⇒ 两个不同的参考会撞成同一个指纹')
})

test('参考音频的键名从名片 maps 来，不是写死的', () => {
  assert.deepEqual(referencePayloadKeys(PROFILE), ['ref_audio_path', 'aux_ref_audio_paths'])
  // 换一台引擎，键名就该换。写死 'ref_audio_path' 的话这条会红。
  assert.deepEqual(
    referencePayloadKeys({ maps: { reference_audio: 'speaker_wav' } }),
    ['speaker_wav'])
  assert.deepEqual(referencePayloadKeys(null), [], '名片解析不出来时不能崩')
})

test('辅助参考音频是数组，逐个按内容算', () => {
  const cache = mk()
  const aux = path.join(tmp, 'aux.wav')
  fs.writeFileSync(aux, Buffer.from('aux one'))
  const before = fpOf(cache, { aux_ref_audio_paths: [aux] })
  fs.writeFileSync(aux, Buffer.from('aux two, different'))
  const after = fpOf(cache, { aux_ref_audio_paths: [aux] })
  assert.notEqual(before, after)
})

// ===========================================================================
//  存取
// ===========================================================================

test('存了就能取回，字节一模一样', () => {
  const cache = mk()
  const key = fpOf(cache)
  assert.equal(cache.get(key), null, '还没存就命中了？')
  const bytes = Buffer.from('RIFF....fake wav payload')
  assert.equal(cache.put(key, bytes), true)
  assert.deepEqual(cache.get(key), bytes)
})

test('⛔ 半截文件不许被当成命中（写到一半被 stop.bat 杀掉）', () => {
  // put 必须先写临时文件再 rename。这里直接检查：写入过程中目标文件不该出现。
  const dir2 = path.join(tmp, 'atomic')
  const seen = []
  const spy = Object.create(fs)
  spy.writeFileSync = (p, b) => { seen.push(p); return fs.writeFileSync(p, b) }
  const cache = createSegmentCache({ dir: dir2, fsImpl: spy })
  const key = fpOf(cache)
  cache.put(key, Buffer.from('abc'))
  assert.ok(seen.length === 1 && path.basename(seen[0]).startsWith('.tmp-'),
    `put 直接往目标文件上写了（${seen.map((p) => path.basename(p)).join(', ')}）—— ` +
    '进程被杀会在盘上留下一个"文件名是正确指纹、内容是半截音频"的条目，' +
    '下次它会被当成命中，而且没有任何东西会报错')
  assert.deepEqual(cache.get(key), Buffer.from('abc'), 'rename 之后应该能取回')
})

test('零字节的条目不存，也不算命中', () => {
  const cache = mk()
  const key = fpOf(cache, { text: '空音频用例' })
  assert.equal(cache.put(key, Buffer.alloc(0)), false)
  assert.equal(cache.get(key), null)
})

test('⭐ 缓存写不进去时，绝不能让这次合成失败', () => {
  const broken = Object.create(fs)
  broken.mkdirSync = () => { throw new Error('EACCES: read-only file system') }
  broken.writeFileSync = () => { throw new Error('EACCES') }
  const warned = []
  const cache = createSegmentCache({
    dir: path.join(tmp, 'readonly'), fsImpl: broken,
    logger: { warn: (m) => warned.push(m), log: () => {} },
  })
  assert.equal(cache.put('deadbeef', Buffer.from('x')), false, '把异常抛出去了 —— 合成会白白失败')
  assert.equal(warned.length, 1, '静默吞掉也不行，至少得说一声')
})

test('⭐⭐ 缓存目录在进程活着的时候被删掉，后面还要能写进去（走真磁盘）', () => {
  // 真机上目录是会消失的：stop.bat 清理、用户手删 cache\、杀软隔离、外置盘掉线。
  // 老代码的 ensured 闩锁只在启动后建一次目录，目录一没就余生每段 ENOENT，
  // 而"写不进去不影响合成"又保证了没人会发现 —— 这一刀会静默变成 0% 命中。
  const dir2 = path.join(tmp, 'vanishing')
  const cache = createSegmentCache({ dir: dir2 })
  const k1 = fpOf(cache, { text: '删目录之前' })
  assert.equal(cache.put(k1, Buffer.from('before')), true)

  fs.rmSync(dir2, { recursive: true, force: true })
  assert.equal(fs.existsSync(dir2), false, '前置条件：目录真的被删掉了')

  const k2 = fpOf(cache, { text: '删目录之后' })
  assert.equal(cache.put(k2, Buffer.from('after')), true,
    '目录被删之后就再也写不进去了 —— 缓存静默退化成空操作，命中率永远 0%')
  assert.deepEqual(cache.get(k2), Buffer.from('after'), '自愈之后应该能正常取回')
})

test('⛔ 目录真的建不出来时只重试一次，且要在日志里点名是哪个目录', () => {
  // 自愈不能变成"每段空转两遍 + 刷屏两遍"。盘符不存在、无权限、路径非法
  // 都属于这一类：重试解决不了，必须一次说清楚。
  const dir2 = path.join(tmp, 'nowhere')
  let mkdirs = 0
  const broken = Object.create(fs)
  broken.mkdirSync = () => { mkdirs++ }          // 假装建成功了
  broken.writeFileSync = () => {
    // ⛔ 故意不把 dir 写进 message：真实的 fs 错误自带路径，那会让
    //   "我们有没有自己点名目录"这条断言被 e.message 白送 —— 守卫就成了摆设。
    const e = new Error('ENOENT: no such file or directory, open <tmpfile>')
    e.code = 'ENOENT'
    throw e
  }
  const warned = []
  const cache = createSegmentCache({
    dir: dir2, fsImpl: broken,
    logger: { warn: (m) => warned.push(m), log: () => {} },
  })
  assert.equal(cache.put('deadbeef', Buffer.from('x')), false)
  assert.equal(mkdirs, 2, `重建目录应当恰好试 2 次（实际 ${mkdirs} 次）—— ` +
    '1 次说明根本没自愈，3 次以上说明重试没有上界')
  const said = warned.filter((m) => m.includes('写入失败'))
  assert.equal(said.length, 1, `"写入失败"应当恰好说一次（实际 ${said.length} 次）—— ` +
    '0 次 = 一直在重试、从来不认输，用户永远看不到根因；2 次以上 = 每段刷屏')
  assert.ok(warned.some((m) => m.includes(dir2)),
    '重建之后仍然 ENOENT，日志必须点名是哪个目录 —— ' +
    '它挂在 CACHE_DIR 环境变量下，不打出来没人查得到')
})

test('关掉时既不存也不取（缓存本身要能被关掉）', () => {
  const cache = mk({ enabled: false })
  const key = 'whatever'
  assert.equal(cache.put(key, Buffer.from('x')), false)
  assert.equal(cache.get(key), null)
})

test('以盘为准：条目被手删之后就是 miss，不需要维护任何索引', () => {
  const cache = mk()
  const key = fpOf(cache, { text: '手删用例' })
  cache.put(key, Buffer.from('bytes'))
  assert.ok(cache.get(key))
  fs.unlinkSync(path.join(cacheDir, `${key}.wav`))
  assert.equal(cache.get(key), null, '索引说有、盘上没有 —— 正是内容寻址要避免的那种漂移')
})

// ===========================================================================
//  淘汰
// ===========================================================================

test('总量超限时按最后使用时间淘汰，最近用过的留下', () => {
  const dir3 = path.join(tmp, 'sweep')
  const cache = createSegmentCache({ dir: dir3, maxBytes: 1000, logger: { log: () => {}, warn: () => {} } })
  const big = Buffer.alloc(300)
  for (let i = 0; i < 5; i++) {
    cache.put(`key${i}`.padEnd(8, '0'), big)
    // 拉开 mtime，否则同一毫秒内排序没有意义
    const p = path.join(dir3, `${`key${i}`.padEnd(8, '0')}.wav`)
    const t = new Date(Date.now() - (5 - i) * 60000)
    fs.utimesSync(p, t, t)
  }
  assert.equal(cache.stats().bytes, 1500)
  const removed = cache.sweep()
  assert.ok(removed > 0, '超了上限却一个都没删')
  assert.ok(cache.stats().bytes <= 900, `没降到 90% 以下（现在 ${cache.stats().bytes}）`)
  assert.ok(fs.existsSync(path.join(dir3, 'key40000.wav')), '把最近用过的删了')
  assert.ok(!fs.existsSync(path.join(dir3, 'key00000.wav')), '最久没用的应该先走')
})

test('没超限时不删任何东西', () => {
  const cache = mk({ maxBytes: 10 * 1024 * 1024 })
  const before = cache.stats().entries
  assert.equal(cache.sweep(), 0)
  assert.equal(cache.stats().entries, before)
})

test('clear 只删缓存条目，不碰别的文件', () => {
  const dir4 = path.join(tmp, 'clear')
  fs.mkdirSync(dir4, { recursive: true })
  fs.writeFileSync(path.join(dir4, 'README.txt'), 'not mine')
  const cache = createSegmentCache({ dir: dir4 })
  cache.put('aaaaaaaa', Buffer.from('x'))
  assert.equal(cache.clear(), 1)
  assert.ok(fs.existsSync(path.join(dir4, 'README.txt')), '把不属于缓存的文件删了')
})

test('目录还不存在时 stats 不崩，报 0', () => {
  const cache = createSegmentCache({ dir: path.join(tmp, 'never-created') })
  assert.deepEqual(
    { entries: cache.stats().entries, bytes: cache.stats().bytes },
    { entries: 0, bytes: 0 })
})

// ===========================================================================
//  stableStringify
// ===========================================================================

test('stableStringify 区分得开 null / undefined / 缺席', () => {
  assert.notEqual(stableStringify({ a: null }), stableStringify({ a: 0 }))
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: '1' }),
    '数字 1 和字符串 "1" 撞了 —— 引擎那边这是两个不同的值')
  assert.notEqual(stableStringify({ a: false }), stableStringify({ a: 0 }))
})

test('stableStringify 保持数组顺序（辅助参考音频的顺序是有意义的）', () => {
  assert.notEqual(stableStringify({ a: [1, 2] }), stableStringify({ a: [2, 1] }))
})

test('⭐ 指纹算法版本号进指纹：改了取材方式，老条目必须全部失效', () => {
  // 这是缓存最阴的一种翻车方式：将来有人给指纹多算一样东西（比如把某个
  // 之前漏掉的键补进去），盘上却躺着一批按旧规则算出来的条目 —— 它们的
  // 文件名依然"正确"，于是继续被命中，而内容是按旧规则生成的。
  // 版本号进指纹后，加一就等于让整代老条目自然失效，不用去删任何文件。
  const a = mk({ version: 2 })
  const b = mk({ version: 3 })
  const args = { profile: PROFILE, payload: basePayload(), cfg: baseCfg() }
  assert.notEqual(a.fingerprint(args), b.fingerprint(args),
    '版本号变了指纹却没变 ⇒ 说明版本号根本没进指纹')

  // 同版本当然还要稳定（否则上面那条 notEqual 可能只是因为指纹本来就随机）
  assert.equal(a.fingerprint(args), mk({ version: 2 }).fingerprint(args))
})
