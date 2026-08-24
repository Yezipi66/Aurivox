#!/usr/bin/env node
'use strict'
// 「合成结果复用缓存」这一刀的突变验证：逐处把改动改坏，确认有测试变红。
//
// GREEN = 那处改动没有任何测试盯着（或者突变本身写坏了 —— 先怀疑这个：
//         上一刀 3 个 GREEN 里有 2 个是突变脚本自己的锅）。
//
// ⚠ 这一刀比上一刀更需要突变验证：缓存算错了**不会报错**，只会让用户听到
//   上一次的音频。没有任何一条真机日志会提示这件事。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 突变要往盘上写，而某些环境（比如助手的沙箱）源码目录是只读的。
// 一律先复制一份到临时目录里改 —— 顺带保证真正的工作区永远不会被留下脏文件。
const SRC = path.resolve(__dirname, '..', '..')
const root = process.env.MUTATE_IN_PLACE === '1'
  ? SRC
  : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mutate-cache-'))
if (root !== SRC) {
  fs.cpSync(SRC, root, { recursive: true, dereference: false })
  console.log(`工作副本: ${root}\n`)
}

const F = {
  ci: path.join(root, 'lib/cache/cachedInference.js'),
  sc: path.join(root, 'lib/cache/segmentCache.js'),
  svc: path.join(root, 'lib/services/synthesisService.js'),
  pt: path.join(root, 'lib/engines/paramTable.js'),
  srv: path.join(root, 'server.js'),
}
const TESTS = [
  'lib/cache/cachedInference.node.test.js',
  'lib/cache/segmentCache.node.test.js',
  'lib/services/synthesisService.nails.node.test.js',
]

const MUT = [
  // ---- cachedInference.js：读/写的取舍 ----
  ['根本不查缓存（每次都推理）', F.ci,
    '    const hit = cache.get(key)',
    '    const hit = null'],
  ['查了但不用（拿到也丢掉）', F.ci,
    '      counters.hits++;\n      return hit;',
    '      counters.hits++;'],
  ['推理完不存缓存', F.ci,
    '  cache.put(key, bytes)',
    '  // cache.put(key, bytes)'],
  ['⛔ force_resynth 把写也跳过（= 勾一次从此永不命中）', F.ci,
    '  const bytes = await infer()',
    '  const bytes = await infer()\n  if (cfg.force_resynth) return bytes'],
  ['force_resynth 判断反过来', F.ci,
    '  if (!cfg.force_resynth) {',
    '  if (cfg.force_resynth) {'],
  ['force_resynth 干脆不看了', F.ci,
    '  if (!cfg.force_resynth) {',
    '  if (true) {'],
  ['推理失败也把结果写进缓存', F.ci,
    '  const bytes = await infer()',
    '  let bytes\n  try { bytes = await infer() } catch (e) { cache.put(key, Buffer.alloc(0)); throw e }'],
  ['出参不再汇报命中（meta 留痕失真）', F.ci,
    '      out.cached = true',
    '      out.cached = false'],
  ['出参不带指纹', F.ci,
    '  out.key = key',
    '  out.key = undefined'],
  ['每段都扫盘淘汰', F.ci,
    '  if (counters.misses % SWEEP_EVERY_MISSES === 0) cache.sweep()',
    '  cache.sweep()'],
  ['命中也算进未命中计数（淘汰节奏错乱）', F.ci,
    '      counters.hits++',
    '      counters.hits++; counters.misses++'],

  // ---- 指纹原料：错了 = 静默返回错音频 ----
  ['指纹不看 payload，只看引擎', F.ci,
    '  const key = cache.fingerprint({ profile, payload, cfg })',
    '  const key = cache.fingerprint({ profile, payload: {}, cfg })'],
  ['指纹前先把 payload 复制一份（复制时容易漏键）', F.ci,
    '  const key = cache.fingerprint({ profile, payload, cfg })',
    '  const key = cache.fingerprint({ profile, payload: { text: payload.text }, cfg })'],
  ['指纹不看引擎身份（换引擎照样命中旧音频）', F.sc,
    '        id: (profile && profile.id) || null,',
    '        id: null,'],
  ['指纹不看引擎地址（指到另一台机器照样命中）', F.sc,
    '        base_url: (profile && profile.base_url) || null,',
    '        base_url: null,'],
  ['stableStringify 只排最外层，不递归', F.sc,
    '  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`',
    "  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(',')}]`"],
  ['参考音频只比路径，不比内容', F.sc,
    '          : fileIdentity(fsImpl, v, true);',
    '          : v;'],
  ['权重文件只比路径，不比大小/时间', F.sc,
    '        gpt: fileIdentity(fsImpl, cfg.gpt_model, false),',
    '        gpt: cfg.gpt_model,'],
  ['读不到的文件退化成同一个身份（两个不同参考会撞指纹）', F.sc,
    "    return `unreadable:${filePath}:${crypto.randomBytes(8).toString('hex')}`",
    "    return 'unreadable'"],
  ['指纹版本号不再进指纹（换算法后老条目还会命中）', F.sc,
    '      v: version,',
    '      v: null,'],

  // ---- 落盘安全 ----
  ['put 直接写目标文件，不走临时文件+rename', F.sc,
    '        fsImpl.writeFileSync(tmp, bytes);\n        fsImpl.renameSync(tmp, entryPath(key));',
    '        fsImpl.writeFileSync(entryPath(key), bytes);'],

  // ---- 目录自愈（r3：真机上每段写入 ENOENT，缓存静默退化成 0% 命中）----
  ['⛔ 目录被删之后不自愈（闩锁钉死 ⇒ 余生每段都 ENOENT）', F.sc,
    "        if (e && e.code === 'ENOENT' && attempt === 0) {\n          forgetDir();\n          continue;\n        }",
    '        // 不自愈'],
  ['自愈永不认输（一直重试，从不报根因）', F.sc,
    "        if (e && e.code === 'ENOENT' && attempt === 0) {",
    "        if (e && e.code === 'ENOENT') {"],
  ['ENOENT 时不点名是哪个目录（排障时查不到 CACHE_DIR）', F.sc,
    "        if (e && e.code === 'ENOENT') {\n          logger.warn(`[CACHE] 缓存目录建不出来，分段复用已失效: ${dir}`);\n        }",
    '        // 不点名'],

  // ---- 平台词 / 透传 ----
  ['⛔ force_resynth 变成引擎参数（会进 payload ⇒ 进指纹 ⇒ 缓存全废）', F.pt,
    "  'force_resynth',",
    '  '],
  ['force_resynth 不再从请求体读出来', F.svc,
    '  force_resynth: !!(req.body && req.body.force_resynth),',
    '  force_resynth: false,'],
  ['force_resynth 被存进 recipe（Rerun 永远强制重推）', F.svc,
    '  force_resynth: _fr,\n',
    ''],

  // ---- meta 留痕 ----
  ['meta 不再记复用了几段', F.svc,
    '      reused_segments: segResults.filter(s => s.reused).length,',
    '      reused_segments: 0,'],
  ['meta 把每一段都记成复用的', F.svc,
    '          reused: segCache.cached === true });',
    '          reused: true });'],
  ['meta 不再记是否强制重推', F.svc,
    '      forced: !!cfg.force_resynth,',
    '      forced: false,'],
  ['出参根本不传给 generateOneSegment（留痕永远是 false）', F.svc,
    'await generateOneSegment(segText, segmentCfg, engine, segCache)',
    'await generateOneSegment(segText, segmentCfg, engine)'],

  // ---- server.js 接线（弱守卫盯着）----
  // ---- 「自称复用却交出新字节」：CR 报的那类"静默错音频"，专门验它 ----
  ['命中时自称复用，却交出重新推理的字节（静默错音频）', F.ci,
    '      out.cached = true;\n      counters.hits++;\n      return hit;',
    '      out.cached = true;\n      counters.hits++;\n      return await infer();'],
  ['复用计数虚高（命中一次记两次）', F.ci,
    '      counters.hits++;',
    '      counters.hits += 2;'],
  ['命中了却不在出参上说（留痕会漏报复用）', F.ci,
    '      out.cached = true;\n      counters.hits++;',
    '      counters.hits++;'],

  ['server.js 不再走缓存，直接推理', F.srv,
    '  return await inferWithCache(',
    '  return await _inferOneSegment(payload, cfg, engine, _profile) || await inferWithCache('],
  ['server.js 把取值点挪到 applyEngineKnobs 之前（旋钮不进指纹）', F.srv,
    '  const _profile = engine || legacyEngineProfile();\n  applyEngineKnobs(payload, _profile, cfg);',
    '  const _profile = engine || legacyEngineProfile();'],
]

let red = 0; let green = 0; let bad = 0
for (const [name, file, from, to] of MUT) {
  const orig = fs.readFileSync(file, 'utf8')
  if (!orig.includes(from)) {
    console.log(`⚠ 锚点坏  ${name}`)
    bad++
    continue
  }
  fs.writeFileSync(file, orig.replace(from, to))
  const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: root, encoding: 'utf8' })
  fs.writeFileSync(file, orig)
  const failed = r.status !== 0
  console.log(`${failed ? '✔ RED ' : '✖ GREEN'}  ${name}`)
  if (failed) red++; else green++
}
console.log(`\nRED ${red} / GREEN ${green} / 锚点坏 ${bad} / 共 ${MUT.length}`)
process.exit(green + bad === 0 ? 0 : 1)
