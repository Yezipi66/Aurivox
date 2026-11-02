'use strict'

// 重录 GSV 基线夹具（lib/services/__fixtures__/gsv-baseline.json）里的例外组。
//
// 用法：node tools/tests/capture-gsv-baseline.cjs <组名>[,<组名>...]
// 例：  node tools/tests/capture-gsv-baseline.cjs emptySpeed,nullTopK,emptyNull
//
// parity 组不许用这个脚本动：那一组的存在意义就是「与升级前逐字相同」，改了它等于把回归改成通过。
// 例外组记的是本批有意改变的行为，所以改了装配口径之后要重新录一次；`base` 那一侧永远停在 f37ec61a。

const path = require('node:path')
const fs = require('node:fs')

const createSynthesisService = require('../../lib/services/synthesisService')
const { createSegmentCache } = require('../../lib/cache/segmentCache')
const { resolveEngineProfile } = require('../../lib/engines/profile')
const { createSynthesisHarness } = require('../../lib/testSynthesis')

const FIXTURE = path.join(__dirname, '../../lib/services/__fixtures__/gsv-baseline.json')

function normalize (value, refPath) {
  return JSON.parse(JSON.stringify(value, (k, v) => (typeof v === 'string' ? v.split(refPath).join('<REF>') : v)))
}

function fingerprintsOf (calls, root) {
  const fakeFs = {
    statSync: () => ({ size: 123, mtimeMs: 456 }),
    readFileSync: () => Buffer.from('ref-bytes'),
  }
  const cache = createSegmentCache({ dir: path.join(root, 'cache'), fsImpl: fakeFs })
  return calls.engines.map((engine, i) => cache.fingerprint({
    profile: { id: engine.id, base_url: '<BASE_URL>', maps: engine.maps },
    payload: calls.payloads[i],
    cfg: calls.cfgs[i],
  }))
}

async function replay (request) {
  const { ctx, calls, root, refPath } = createSynthesisHarness({
    prefix: 'aurivox-capture-', withRef: true, engines: {}, ctx: { resolveEngineProfile },
  })
  const { generateService } = createSynthesisService(ctx)
  await generateService({ body: { ...request, ref_audio: refPath } })
  return {
    payloads: calls.payloads.map((payload) => normalize(payload, refPath)),
    fingerprints: fingerprintsOf(calls, root),
    metas: normalize(calls.metas, refPath).map((meta) => { delete meta.createdAt; return meta }),
  }
}

async function main () {
  const groups = String(process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!groups.length) throw new Error('要给组名：node tools/tests/capture-gsv-baseline.cjs emptySpeed,nullTopK,emptyNull')
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'))
  for (const name of groups) {
    const g = fixture.exceptions[name]
    if (!g) throw new Error(`夹具里没有例外组 ${name}`)
    const actual = await replay(g.request)
    const faces = []
    if (JSON.stringify(g.base.payloads) !== JSON.stringify(actual.payloads)) faces.push('payload')
    if (JSON.stringify(g.base.fingerprints) !== JSON.stringify(actual.fingerprints)) faces.push('指纹')
    if (JSON.stringify(g.base.meta) !== JSON.stringify(actual.metas)) faces.push('meta')
    if (!faces.length) throw new Error(`${name} 重录后与 base 逐字相同：它不再是例外，不该留在 exceptions 里`)
    g.payloads = actual.payloads
    g.fingerprints = actual.fingerprints
    g.meta = actual.metas
    g.changed = faces
    console.log(`${name}: changed = ${faces.join('、')}`)
  }
  fs.writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n', 'utf-8')
  console.log('已写回', FIXTURE)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
