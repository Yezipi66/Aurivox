// ============================================================
//  参数面板必须按 manifest.json 长 —— 读源码的守卫（契约 §12 第 3 步）
// ============================================================
//
// ⚠ 为什么是读源码而不是渲染：
//    JSX 在这个仓库里跑不了单元测试（测试是 `node --test` 直接跑的，不经过
//    vite，也没有 jsdom）。真正的闸仍然是 `cd web && npm run build` 加真机
//    点一遍。同 advancedParamsMemory.node.test.js 的做法和理由。
//
//    面板「长什么样」的判断已经全部搬进 web/src/lib/engines.js（纯函数，
//    有真行为测试）。这里只守一件 JSX 里才看得见的事：
//    **那 13 个写死的格子没有偷偷长回来。**

// ⚠ web/ 是 ESM（web/package.json 的 "type": "module"），所以这里用 import 而不是
//   require —— lib/ 下那些 .node.test.js 是 CommonJS，两边写法不一样。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, 'GenerateTab.jsx'), 'utf-8')

// 注释里可以提这些名字（上面那段注释本身就在提），守的是代码。
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')   // JSX 注释
  .replace(/\/\*[\s\S]*?\*\//g, '')       // 块注释
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// 这台引擎的参数表，曾经被逐条手抄进这个文件。
const HARDCODED = [
  'temperature', 'top_k', 'topK', 'top_p', 'topP',
  'repetition_penalty', 'repPenalty',
  'text_split_method', 'splitMethod',
  'speed_factor', 'speedFactor',
  'batch_size', 'batchSize',
  'batch_threshold', 'batchThreshold',
  'split_bucket', 'splitBucket',
  'fragment_interval', 'fragmentInterval',
  'parallel_infer', 'parallelInfer',
  'sample_steps', 'sampleSteps',
  'if_sr', 'superSampling',
]

test('⛔ 参数面板里不许出现任何写死的引擎参数名', () => {
  const found = HARDCODED.filter(name => new RegExp(`\\b${name}\\b`).test(CODE))
  assert.deepEqual(found, [],
    '这些参数名又回到 GenerateTab 的代码里了。它们属于某一台引擎的 manifest.json，' +
    '写在这里意味着换一台引擎时界面还在发这些键、而该长的格子长不出来。')
})

test('⛔ cut0…cut5 这些选项值也不许写死 —— 它们是某台引擎的切分档位', () => {
  for (const v of ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5']) {
    assert.ok(!CODE.includes(v), `${v} 还写在面板里。枚举选项要从 manifest.json 的 choices 来。`)
  }
})

test('面板确实在按 param_schema 循环，而不是换了个写法继续写死', () => {
  assert.ok(/fieldsForTier|visibleFields/.test(CODE), '面板没有调用 fieldsForTier')
  assert.ok(CODE.includes('paramsToSend'), '请求体没有走 paramsToSend')
  assert.ok(CODE.includes('initialParamValues'), '初值没有来自名片')
  assert.ok(CODE.includes('schemaGap'), '名片没写 params.schema 时没有任何提示')
})

test('档位按钮从 TIERS 来，不是写死两个', () => {
  assert.ok(CODE.includes('TIERS.map'), '档位标签页还是写死的')
})

test('平台自己的开关留在原地 —— 它们不属于任何引擎，不该被一起收走', () => {
  // ⚠ 这条是防「收得太狠」：把面板改成名片驱动的时候，很容易顺手把这几个
  //   一起删掉，而它们换哪台引擎含义都不变。
  for (const keep of ['forceResynth', 'engineBatch', 'mediaType', 'seed']) {
    assert.ok(new RegExp(`\\b${keep}\\b`).test(CODE), `平台开关 ${keep} 在改造中被误删了`)
  }
})

test('GenerateTab 收 engine 这个 prop —— 否则它无从知道该按谁长', () => {
  assert.ok(/function GenerateTab\(\{\s*engine[,\s}]/.test(SRC))
})
