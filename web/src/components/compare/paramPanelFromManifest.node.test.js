// 对比页（ReferenceCompareTab）的参数面板必须按 manifest.json 长。读源码的守卫，与
// generate/paramPanelFromManifest.node.test.js 同款：JSX 在这个仓库里没法通过单元测试
// （node --test 不经 vite，也没有 jsdom），所以这里守三件只有源码里才看得见的事：写死的
// 格子没长回来、面板确实在按 param_schema 循环、engine prop 一路传到了画格子的地方。
// 这一页的代码里不出现任何引擎的参数名；web/ 是 ESM，这里用 import 而不是 require。
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

// 这一页不出现任何引擎参数名，snake_case（manifest.json 里的名字）与 camelCase
// （旧代码里的本地 state 名）两种写法都要列。守的是键出现的位置：对象字面量里的
// `键名:`、下标里的 `[键名]`、成员赋值 `.键名 =`。用户可见的 tooltip 文案里提到某个名字不算。
const HARDCODED = [
  'temperature', 'top_k', 'top_p', 'repetition_penalty',
  'text_split_method', 'speed_factor', 'batch_size',
  'batch_threshold', 'split_bucket',
  'fragment_interval', 'parallel_infer', 'sample_steps', 'if_sr',
  'topK', 'topP', 'repPenalty', 'splitMethod', 'speedFactor',
  'batchSize', 'batchThreshold', 'splitBucket',
  'fragmentInterval', 'parallelInfer', 'sampleSteps',
  'gpt_model', 'sovits_model', 'gptCheckpoint', 'sovitsModel',
]

// 键「被使用」的三种位置。三种都要覆盖：少一种，那一处就可能重新出现。
const USED_AS = [
  n => new RegExp(`\\b${n}\\s*:`),                    // 对象字面量里的键，如 top_p: 1.0
  n => new RegExp(`\\[\\s*['"\`]${n}['"\`]\\s*\\]`),   // 下标里的键，如 row['top_p']
  n => new RegExp(`\\.\\s*${n}\\s*(=|\\+=)`),          // 成员赋值，如 body.top_p = 1.0
]

test('⛔ 对比页里不许出现任何写死的引擎参数名', () => {
  const found = HARDCODED.filter(name => USED_AS.some(rx => rx(name).test(CODE)))
  assert.deepEqual(found, [],
    '这些参数名重新出现在对比页的代码里（作为对象的键、下标或成员赋值）。' +
    '它们属于某一台引擎的 manifest.json，写在这里意味着换一台引擎时界面仍在发这些键、' +
    '按名片声明生成的参数格子则长不出来。（注意：只作为**文案**提到某个名字不算。）' +
    '权重位名与旧界面为它们引入的字段名同样计入：请求体、配方、旧行数据都按位名读取，' +
    '该页代码里再出现一次就是第二份写死。')
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
  assert.ok(!/\bCMP_ENGINE\b/.test(CODE), 'CMP_ENGINE 重新出现：它是「这一页写死一台引擎」的全部证据')
  assert.ok(CODE.includes('slotsOf('), '权重位名未从名片读取（位名应经 slotsOf 从 weight_slots 读取）')
  assert.ok(/compareWeightBody\(/.test(CODE),
    'generateRow 未使用 compareWeightBody 组装权重字段：请求体的权重字段由纯函数按名片组装，该页再组装一次就是第二条装配线')
  assert.ok(/=\s*stalePicks\(/.test(CODE),
    'generateRow 未先逐位检查所选是否仍在候选中。不在候选中的那一位要立即报错、不发送该行：' +
    '静默跳过它，引擎会沿用上一行切换的权重，批量结果取决于行的执行顺序')
  // 只检查「有没有调用 compareWeightBody」拦不住装配线分叉：还要检查它收到的是哪一份候选清单。
  assert.ok(!/compareWeightBody\([^)]*,[^)]*,/.test(CODE),
    'compareWeightBody 收到第三份候选清单：请求体这一层不筛选择，筛了就是一条静默兜底')
})

// 参考侧的四条判据（这一行属于哪个角色、说什么语种、换位后要不要换参考来源、选中的还在不在）
// 只有纯函数那一份实现，界面各点只调用它们。下面三条按文件数调用点：整目录拼在一起时
// 纯函数自己的定义也算一次「出现过」，调用点被删回界面里就看不见。
const codeOf = (name) => {
  const p = path.join(HERE, name)
  return fs.existsSync(p) ? stripComments(fs.readFileSync(p, 'utf8')) : ''
}
const countCalls = (code, name) => (code.match(new RegExp(`${name}\\(`, 'g')) || []).length

test('⭐⭐ 参考侧的角色与语种在每个消费点都调用纯函数，界面不留第二份', () => {
  const row = codeOf('CompareRow.jsx')
  const tab = codeOf('ReferenceCompareTab.jsx')
  assert.ok(row && tab, '按文件名取源码失败：组件改名或拆出去后，这个守卫要跟着改，不能让它静默放行')
  // 这一行的参考角色：画这一行、发这一行的请求、把这一行存成配方，三处都得问同一个问题。
  assert.ok(countCalls(row, 'referenceVoiceOf') >= 1, 'CompareRow 没问参考角色，界面又回到按 selectedVoice 取')
  assert.ok(countCalls(tab, 'referenceVoiceOf') >= 2,
    'ReferenceCompareTab 里的参考角色消费点少了：发请求与另存配方都要按这一行的参考侧取角色')
  assert.ok(countCalls(row, 'rowVoiceLanguage') >= 1 && countCalls(tab, 'rowVoiceLanguage') >= 2,
    '语种没有三处都走 rowVoiceLanguage：查表的顺序就会长出第二份')
  // 第二份实现长回来的样子：在界面里按角色查 language。
  for (const [name, code] of [['CompareRow.jsx', row], ['ReferenceCompareTab.jsx', tab]]) {
    assert.ok(!/\.find\([^)]*\)\s*\?\.language/.test(code), `${name} 里又拼了一份按角色查语种的链`)
  }
})

test('⭐⭐ 换位后要不要换参考来源只在行内判一次，注入的是底模常量', () => {
  const row = codeOf('CompareRow.jsx')
  assert.ok(/shouldSwitchRefToCross\(\{[^}]*baseVoiceId:\s*BASE_VOICE_ID/.test(row),
    '换参考位后的跨角色选择器切换没有走 shouldSwitchRefToCross，或没有把底模常量注入进去：' +
    '判据留在界面里就会跟着组件的措辞漂，用户自己选的来源也可能被界面改掉')
  // 非混搭下不推断归属：推断了就是把这一行悄悄变成混搭。
  assert.ok(/if \(!mix\)/.test(row), 'pickSlot 不再先分辨混搭与否，非混搭下的选择也会写入跨角色归属')
})

test('⭐ 失效判断复用算好的候选集合；被拦下的那一行不进 try…finally，提示要设在检查之后', () => {
  const row = codeOf('CompareRow.jsx')
  const tab = codeOf('ReferenceCompareTab.jsx')
  assert.ok(/useMemo\(\(\) => candidatePathsBySlot\(availableModels\)/.test(row),
    '候选集合没有 useMemo：渲染每一位都重算一遍全表')
  assert.ok(countCalls(row, 'isPathStale') >= 1, '行内失效标记没有复用集合')
  assert.equal(countCalls(row, 'candidatePathsBySlot'), 1,
    '行内除了那一次 useMemo 又算了一遍全表：渲染每一位都重算，是白付的开销')
  const atStale = tab.search(/=\s*stalePicks\(/)
  const atBanner = tab.indexOf("label: 'Generating'")
  assert.ok(atStale >= 0 && atStale < atBanner,
    '「Generating」提示设在逐位检查之前：拦下的那一行不进 try…finally，负责清掉提示的代码不会跑，' +
    '状态栏一直停在「Generating」')
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
