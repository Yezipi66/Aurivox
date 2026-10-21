// 对比页（ReferenceCompareTab）的参数面板必须按 manifest.json 长。读源码的守卫，与
// generate/paramPanelFromManifest.node.test.js 同款：JSX 在这个仓库里没法通过单元测试
// （node --test 不经 vite，也没有 jsdom），所以这里守三件只有源码里才看得见的事：写死的
// 格子没长回来、面板确实在按 param_schema 循环、engine prop 一路传到了画格子的地方。
// 这一页的代码里不许出现任何引擎的参数名；web/ 是 ESM，这里用 import 而不是 require。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDirSources, stripComments } from '../../__testsupport__/readDirSources.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 读本目录下全部源码：组件拆成多个文件后，只读单个 .jsx 会看不见拆出去的部分，守卫静默失效。
const SRC = readDirSources(import.meta.url, '.')

// 注释里可以提这些名字，守的是代码。
const CODE = stripComments(SRC)

// 这一页不许再出现任何引擎参数名，snake_case（manifest.json 里的名字）与 camelCase
// （旧代码里的本地 state 名）两种写法都要列。守的是键出现的位置：对象字面量里的
// `键名:`、下标里的 `[键名]`。用户可见的 tooltip 文案里提到某个名字不算。
const HARDCODED = [
  'temperature', 'top_k', 'top_p', 'repetition_penalty',
  'text_split_method', 'speed_factor', 'batch_size',
  'batch_threshold', 'split_bucket',
  'fragment_interval', 'parallel_infer', 'sample_steps', 'if_sr',
  'topK', 'topP', 'repPenalty', 'splitMethod', 'speedFactor',
  'batchSize', 'batchThreshold', 'splitBucket',
  'fragmentInterval', 'parallelInfer', 'sampleSteps',
]

// 键「被用上」的两种位置。两种都要守：少一种，那一处就能偷偷长回来。
const USED_AS = [
  n => new RegExp(`\\b${n}\\s*:`),                    // 对象字面量里的键，如 top_p: 1.0
  n => new RegExp(`\\[\\s*['"\`]${n}['"\`]\\s*\\]`),   // 下标里的键，如 row['top_p']
]

test('⛔ 对比页里不许出现任何写死的引擎参数名', () => {
  const found = HARDCODED.filter(name => USED_AS.some(rx => rx(name).test(CODE)))
  assert.deepEqual(found, [],
    '这些参数名又回到对比页的代码里了（作为对象的键或下标）。' +
    '它们属于某一台引擎的 manifest.json，写在这里意味着换一台引擎时界面还在发这些键、' +
    '而该长的格子长不出来。（注意：只作为**文案**提到某个名字不算。）')
})

test('⛔ 也不许用本地 state 把某个引擎参数名再抄一遍', () => {
  // 本地 state 那一层也不许有引擎参数名（形如 const [topK, setTopK] = useState(...)）。
  const found = HARDCODED.filter(name =>
    new RegExp(`\\b(set${name[0].toUpperCase()}${name.slice(1)}|${name}\\s*,\\s*set)`).test(CODE))
  assert.deepEqual(found, [],
    '这些参数名又作为本地 state 出现了。参数值应该整体住在 paramValues 这一个袋子里。')
})

test('⛔ cut0…cut5 这些选项值也不许写死，它们是某台引擎的切分档位', () => {
  for (const v of ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5']) {
    assert.ok(!CODE.includes(v), `${v} 还写在对比页里。枚举选项要从 manifest.json 的 choices 来。`)
  }
})

test('⭐ 面板确实在按 param_schema 循环，而不是换了个写法继续写死', () => {
  assert.ok(CODE.includes('fieldsForTier'), '格子没有调用 fieldsForTier')
  assert.ok(CODE.includes('paramsToSend'), '请求体没有走 paramsToSend')
  assert.ok(CODE.includes('initialParamValues'), '初值没有来自名片')
  assert.ok(CODE.includes('ParamField'), '格子没有用共享的 <ParamField>（会分叉出第二套控件实现）')
  assert.ok(CODE.includes('isFieldVisible'), '条件字段（only_when）没有过滤')
})

test('⭐ 接线判据：engine prop 一路传到了画格子的地方', () => {
  // 只传 engineId 的话这一页能编译、能过 build，但格子拿不到形状。
  assert.ok(/function CompareRow\(\{[^}]*\bengine\b\s*[,}]/.test(SRC),
    'CompareRow 的 props 里没有 engine，它拿不到 param_schema，画不出格子')
  assert.ok(/<CompareRow[\s\S]{0,600}?\bengine=\{engine\}/.test(SRC),
    'CompareRow 的调用点没有把 engine 传下去，整页能编译但格子是空的')
})

test('⭐ 每行的方法下拉来自名片，不是写死一份方法表', () => {
  // 方法名（zero_shot / instruct2 / vc / sft…）属于某台引擎的名片。
  for (const m of ['zero_shot', 'cross_lingual', 'instruct2']) {
    assert.ok(!CODE.includes(m), `${m} 写死在对比页里了。方法列表要从 engine.methods 来。`)
  }
  assert.ok(CODE.includes('engine?.methods') || CODE.includes('engine.methods'),
    '方法下拉没有读 engine.methods')
  assert.ok(CODE.includes('default_method'), '没有读名片给的默认方法')
})

test('⭐ 单方法引擎不许画方法下拉（没有第二个选项的下拉只是噪声）', () => {
  // 判据跟 schemaGap 一样：名片没说的东西，界面不许替它编一个。
  assert.ok(/engine\?\.methods\) && engine\.methods\.length > 0/.test(CODE),
    '方法下拉没有按 methods.length > 0 判断，单方法引擎也会被画一个只有一个选项的下拉')
})

test('⛔ CMP_ENGINE 这个常量不许回来', () => {
  // 它是「这一页写死一台引擎」的全部证据。位名现在来自 weight_slots。
  assert.ok(!/\bCMP_ENGINE\b/.test(CODE), 'CMP_ENGINE 又回来了')
  assert.ok(CODE.includes('weight_slots'), '权重位名没有从名片读')
})

test('换引擎必须重建权重下拉（依赖数组里少了 engine.id 就是安静地错）', () => {
  // buildModels 按当前引擎的位名取权重：少了 engine.id 这项依赖，换引擎后下拉还是上一台的。
  assert.ok(/setAvailableModels\(models\)[\s\S]{0,200}?\}, \[engine\?\.id\]\)/.test(CODE),
    '拉权重的 useEffect 依赖里没有 engine.id，换引擎后下拉不会跟着换')
})

test('⭐ seed 是平台自己的开关，不属于任何一台引擎，要留在原地', () => {
  // seed 是平台自己的开关，换哪台引擎含义都不变，不许顺手收走。
  assert.ok(/\bconst \[seed, setSeed\] = useState/.test(CODE), 'seed state 在改造中被误删了')
  assert.ok(/Seed \(-1 = random\)/.test(CODE), 'seed 那一格不见了')
})

test('touched 必须跟着 params 一起存回 row（generateRow 在 tab 级读的是 row）', () => {
  // touched 必须能还原成数组，否则回放/重新渲染后 paramsToSend 会把所有键都丢掉。
  assert.ok(/onUpdate\(row\.id, 'params'/.test(CODE), 'params 没有存回 row')
  assert.ok(/onUpdate\(row\.id, 'touched'/.test(CODE), 'touched 没有存回 row')
  assert.ok(/Array\.from\(touched\)/.test(CODE), 'touched 存的是不可还原的形状（Set 序列化后为空）')
})

// 档位要两档都取，不能只画 common：有些引擎的 param_schema common 层是空的，只取
// common 会画出零个格子而界面上看不出异常。判据是「档位来自 TIERS 且两档都取」。
test('⭐⭐ 档位来自 TIERS，不许只画 common 一层', () => {
  assert.ok(/TIERS/.test(CODE),
    '对比页没有引用 TIERS，档位名单被复制了一份，或者根本没做两档')
  assert.ok(/fieldsForTier\(engine, tier\)/.test(CODE),
    "fieldsForTier 收的不是变量 tier，而是写死的某一层，" +
    '只画一层会让 common 层为空的引擎（两台 CosyVoice）画出零个格子')
  // 查「它做了什么」而不是「变量名在不在」：`const tiersWithFields = TIERS` 不做过滤，只测名字出现过会把它放过去。
  assert.ok(/tiersWithFields\s*=\s*TIERS\.filter\(/.test(CODE),
    "tiersWithFields 没有过滤掉空档位，空档位按钮点开是空的，比不画更糟")
  assert.ok(/tiersWithFields\.length > 1/.test(CODE),
    '只有一个档有格子时也要画档位按钮（那一个按钮是噪声）')
})
