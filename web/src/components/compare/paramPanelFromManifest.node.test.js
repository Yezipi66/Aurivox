// ============================================================
//  对比页（ReferenceCompareTab）必须按 manifest.json 长
//  —— 读源码的守卫，同 generate/paramPanelFromManifest.node.test.js
// ============================================================
//
// ⚠ 为什么是读源码而不是渲染：
//    JSX 在这个仓库里跑不了单元测试（测试是 `node --test` 直接跑的，不经过
//    vite，也没有 jsdom）。真正的闸仍然是 `npm run build` 加真机点一遍。
//    这里守的是三件只有源码里才看得见的事：
//      1. 那 13 个写死的格子没有偷偷长回来
//      2. 面板确实在按 param_schema 循环（不是换了个写法继续写死）
//      3. ⭐ 接线是**真的接上了** —— engine 这个 prop 一路传到了画格子的地方
//
//  背景（2026-10-01）：这一页过去**一个引擎库函数都没 import**，超参是
// 手抄进前端的 GPT-SoVITS 键名 ⇒ 换一台引擎，格子照常显示、填了发出去
// 上游不认、**不报错**。那是平台第 2 条纪律「不静默忽略」的直接违反。
//
// ⚠ web/ 是 ESM（web/package.json 的 "type": "module"），所以这里用 import
//   而不是 require —— lib/ 下那些 .node.test.js 是 CommonJS，两边不一样。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, 'ReferenceCompareTab.jsx'), 'utf-8')

// 注释里可以提这些名字（守卫本身就在提），守的是代码。
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')   // JSX 注释
  .replace(/\/\*[\s\S]*?\*\//g, '')       // 块注释
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// 这台引擎的参数表，曾经被逐条手抄进这个文件。
//
// ⚠ 2026-10-01 订正：这一份最初漏了 `top_p` 本身（只写了驼峰的 `topP`），
//   变异测试立刻抓到 —— 把请求体改回 `top_p: 1.0` 守卫却没红。
//   教训：snake_case 和 camelCase **两种写法都要列**，少一种守卫就漏一半。
//
// 这一页有一处用户可见的 tooltip 文案里**提到**了 `batch_size`
//   （"…in parallel (batch_size)"）—— 那是给人看的解释，不是在发这个键。
//   所以守的是**键出现的位置**：`键名:`（对象字面量）、`[键名]`（下标）、
//   `setXxx` / `[x, setX]`（本地 state），而不是「这个词出现在文件里」。
const HARDCODED = [
  // snake_case（manifest.json 里就是这个名字）
  'temperature', 'top_k', 'top_p', 'repetition_penalty',
  'text_split_method', 'speed_factor', 'batch_size',
  'batch_threshold', 'split_bucket',
  'fragment_interval', 'parallel_infer', 'sample_steps', 'if_sr',
  // camelCase（旧代码里的本地 state 名）
  'topK', 'topP', 'repPenalty', 'splitMethod', 'speedFactor',
  'batchSize', 'batchThreshold', 'splitBucket',
  'fragmentInterval', 'parallelInfer', 'sampleSteps',
]

// 键「被用上」的两种位置。两种都要守：少一种，那一处就能偷偷长回来。
//
// ⛔ 刻意**不**写「`\btop_p\b\s*[,)\]]`」这种宽泛形态：它会命中用户可见的
//   tooltip 文案里对某个参数的**提及**（"…in parallel (batch_size)."），
//   那是给人看的解释，不是在发这个键 —— 守卫会一直红，而且红得没有道理。
//   本地 state 的形态由下面那条单独的测试守（setXxx / [x, setX]）。
const USED_AS = [
  n => new RegExp(`\\b${n}\\s*:`),                    // top_p: 1.0     对象字面量
  n => new RegExp(`\\[\\s*['"\`]${n}['"\`]\\s*\\]`),   // row['top_p']   下标
]

test('⛔ 对比页里不许出现任何写死的引擎参数名', () => {
  const found = HARDCODED.filter(name => USED_AS.some(rx => rx(name).test(CODE)))
  assert.deepEqual(found, [],
    '这些参数名又回到对比页的代码里了（作为对象的键或下标）。' +
    '它们属于某一台引擎的 manifest.json，写在这里意味着换一台引擎时界面还在发这些键、' +
    '而该长的格子长不出来。（注意：只作为**文案**提到某个名字不算。）')
})

test('⛔ 也不许用本地 state 把某个引擎参数名再抄一遍', () => {
  // 过去的形状：`const [topK, setTopK] = useState(...)` + `onUpdate(row.id,'top_k',topK)`。
  // 键名已经在上一条守住了，这条守的是**本地 state 那一层**也不许复活。
  const found = HARDCODED.filter(name =>
    new RegExp(`\\b(set${name[0].toUpperCase()}${name.slice(1)}|${name}\\s*,\\s*set)`).test(CODE))
  assert.deepEqual(found, [],
    '这些参数名又作为本地 state 出现了。参数值应该整体住在 paramValues 这一个袋子里。')
})

test('⛔ cut0…cut5 这些选项值也不许写死 —— 它们是某台引擎的切分档位', () => {
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
  // ⭐ 这条是 E1 判据：`npm run build` 绿**不**证明接线对。
  //   只传 engineId 的话这一页能编译、能过 build，但格子拿不到形状，
  //   会退化成「什么都没画」—— 而 build 一点话都不说。
  assert.ok(/function CompareRow\(\{[^}]*\bengine\b\s*[,}]/.test(SRC),
    'CompareRow 的 props 里没有 engine —— 它拿不到 param_schema，画不出格子')
  assert.ok(/<CompareRow[\s\S]{0,600}?\bengine=\{engine\}/.test(SRC),
    'CompareRow 的调用点没有把 engine 传下去 —— 整页能编译但格子是空的')
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
    '方法下拉没有按 methods.length > 0 判断 —— 单方法引擎也会被画一个只有一个选项的下拉')
})

test('⛔ CMP_ENGINE 这个常量不许回来', () => {
  // 它是「这一页写死一台引擎」的全部证据。位名现在来自 weight_slots。
  assert.ok(!/\bCMP_ENGINE\b/.test(CODE), 'CMP_ENGINE 又回来了')
  assert.ok(CODE.includes('weight_slots'), '权重位名没有从名片读')
})

test('换引擎必须重建权重下拉（依赖数组里少了 engine.id 就是安静地错）', () => {
  // buildModels 现在按**当前引擎**的位名取权重。少了依赖这一项 ⇒ 换引擎后
  // 下拉还是上一台引擎的权重，而界面上没有任何一处会提示它没跟着换。
  assert.ok(/setAvailableModels\(models\)[\s\S]{0,200}?\}, \[engine\?\.id\]\)/.test(CODE),
    '拉权重的 useEffect 依赖里没有 engine.id —— 换引擎后下拉不会跟着换')
})

test('⭐ seed 是平台自己的开关，不属于任何一台引擎，要留在原地', () => {
  // ⚠ 这条是防「收得太狠」：把面板改成名片驱动时很容易顺手把 seed 一起
  //   收走，而它换哪台引擎含义都不变（GenerateTab:201 同一条纪律）。
  assert.ok(/\bconst \[seed, setSeed\] = useState/.test(CODE), 'seed state 在改造中被误删了')
  assert.ok(/Seed \(-1 = random\)/.test(CODE), 'seed 那一格不见了')
})

test('touched 必须跟着 params 一起存回 row（generateRow 在 tab 级读的是 row）', () => {
  // 只存 params 是不够的：touched 决定了「哪些键是用户真动过的」。
  // 它必须能还原（存数组），否则回放/重新渲染后 paramsToSend 会把所有键都丢掉。
  assert.ok(/onUpdate\(row\.id, 'params'/.test(CODE), 'params 没有存回 row')
  assert.ok(/onUpdate\(row\.id, 'touched'/.test(CODE), 'touched 没有存回 row')
  assert.ok(/Array\.from\(touched\)/.test(CODE), 'touched 存的是不可还原的形状（Set 序列化后为空）')
})