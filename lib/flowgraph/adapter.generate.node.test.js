'use strict'

// Flow 引擎节点 → 真实 generateService。
// 适配器把参数平铺一份、按引擎分格一份，两条路径都必须到达引擎：
// 界面上修改了参数而请求发给引擎时不含它，就是本文件要防的回归。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { useFixtureEngines } = require('../testEngines')
// registry 在模块加载时读 AURIVOX_EXTRA_ENGINES_DIR，所以这行必须排在
// require 任何引擎模块之前。
useFixtureEngines()

const { createSynthesizeAdapter } = require('./adapter')
const createSynthesisService = require('../services/synthesisService')
const { createSynthesisHarness } = require('../testSynthesis')

// fixture-beta：不要求参考音频，调用参数是 emo_alpha / interval_silence。
const ENGINE = 'fixture-beta'

// 走真实 buildTtsPayload 与 applyEngineKnobs，只把「发送网络请求」换成记录请求与返回一段静音 WAV。
function makeHarness () {
  return createSynthesisHarness({ prefix: 'aurivox-flow-', genId: 'FLOWGEN', assetSubdir: 'generate' })
}

test('⭐ Flow 引擎节点的参数（平铺 + 分格）都到达非 GSV 引擎', async () => {
  const { root, ctx, calls } = makeHarness()
  const { generateService } = createSynthesisService(ctx)
  const synthesize = createSynthesizeAdapter(generateService, {
    outputRoot: root,
    defaultVoice: 'v1',
  })

  const result = await synthesize({
    text: '你好',
    engine: { engine_id: ENGINE, voice: 'v1' },
    engine_params: { emo_alpha: 0.7, interval_silence: 0.2 },
  })

  assert.equal(calls.payloads.length, 1)
  assert.equal(calls.cfgs[0].emo_alpha, 0.7, '平铺这一条必须写入 cfg')
  assert.deepEqual(calls.cfgs[0].engine_params,
    { emo_alpha: 0.7, interval_silence: 0.2 }, '分格这一条必须写入 cfg.engine_params')
  assert.equal(calls.payloads[0].emo_alpha, 0.7, '参数必须拼进发往引擎的请求体')
  assert.equal(calls.payloads[0].interval_silence, 0.2)

  assert.equal(result.kind, 'audio')
  assert.ok(fs.existsSync(result.path), '适配器返回的路径必须真的存在')
  assert.deepEqual(result.recipe.params, { emo_alpha: 0.7, interval_silence: 0.2 })
})
