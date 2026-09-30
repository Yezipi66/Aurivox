// ============================================================
//  Broker 页面不许写死一台引擎 —— 读源码的守卫
// ============================================================
//
// ⚠ 同 generate/paramPanelFromManifest.node.test.js：JSX 跑不了单测
//   （测试是 `node --test` 直跑，不经过 vite，也没有 jsdom）。这里守三件
//   只有源码里才看得见的事：
//     1. REBIND_ENGINE / 写死的位名没有偷偷长回来
//     2. 参数摘要走的是 paramsSummaryOf，不是手抄键名
//     3. ⭐ 引擎和位名是**问后端要的**（/api/recipes-models 的 engines + models）
//
//  背景（2026-10-01）：BrokerTab.jsx:41 是 `REBIND_ENGINE = 'gpt-sovits'`，
//  位名写死 'gpt'/'sovits'，文件选择器扩展名写死 .ckpt/.pth，配方卡片的参数
//  摘要写死 top_k/temperature/speed。后果：一台 CosyVoice 的资产在 Broker 里
//  **连一个模型位都列不出来**，参数摘要显示成三个 undefined —— 而界面上
//  没有任何一句说「因为这里写死了引擎」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, 'BrokerTab.jsx'), 'utf-8')

// 注释里可以提这些名字（守卫本身就在提），守的是代码。
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')   // JSX 注释
  .replace(/\/\*[\s\S]*?\*\//g, '')       // 块注释
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

test('⛔ REBIND_ENGINE 这个常量不许回来', () => {
  assert.ok(!/\bREBIND_ENGINE\b/.test(CODE),
    'REBIND_ENGINE 又回来了 —— 这正是「这一页写死一台引擎」的证据。' +
    '引擎身份应该由 /api/recipes-models/:role 的 engines 字段给出。')
})

test('⭐ 引擎身份问后端要，不在代码里写死', () => {
  // 后端 /api/recipes-models/:role 已经返回 engines（lib/assets/modelLayout.js
  // 的 enginesInMeta 算的）和 models[<engineId>][<slot>]。前端一个都不用猜。
  assert.ok(CODE.includes('r.data.engines') || CODE.includes('data && r.data.engines'),
    '没有读后端返回的 engines 列表')
  assert.ok(/api\/recipes-models\//.test(CODE), '没有走 /api/recipes-models/:role')
  assert.ok(CODE.includes('enginesInMeta') === false,
    '前端不该复制一份 enginesInMeta —— 那是后端的事实')
})

test('⭐ 模型位的名字来自后端的 models[<engineId>][<slot>]，不写死 gpt/sovits', () => {
  assert.ok(/Object\.keys\([^)]*slots/.test(CODE) || CODE.includes('slotNamesOf'),
    '位名没有从后端返回的对象里取')
  assert.ok(CODE.includes('slotNames'), '位名没有进 state')
  // gpt/sovits 仍然作为**局部变量名**存在（配方那两个字段就叫这个），
  // 但不许再作为**位名**去后端查。
  assert.ok(!/slots\.(gpt|sovits)\b/.test(CODE), '还在用写死的 gpt/sovits 位名')
  assert.ok(!/slots\[['"]gpt['"]\]/.test(CODE), '还在用写死的 gpt 位名')
})

test('⭐ 参数摘要走 paramsSummaryOf，不许手抄键名', () => {
  assert.ok(CODE.includes('paramsSummaryOf'), '参数摘要没有走 paramsSummaryOf')
  const HARDCODED_KEYS = ['top_k', 'temperature', 'speed', 'text_split_method', 'repetition_penalty']
  const found = HARDCODED_KEYS.filter(k => new RegExp(`\\b${k}\\b`).test(CODE))
  assert.deepEqual(found, [],
    '这些参数名又出现在 Broker 页面里了。它们属于某一台引擎的名片，' +
    '写在这里意味着换一台引擎时摘要显示的一串 undefined。')
})

test('⭐ 只有一位的引擎不许画第二个下拉', () => {
  // 判据跟对比页的方法下拉一样：后端没给的，界面不许替它编一个。
  assert.ok(/slotNames\.length > 1/.test(CODE),
    '第二个模型位没有按 slotNames.length > 1 渲染 —— 一台只有一个位的引擎' +
    '会被画出一个标题写着「模型」、候选永远为空的下拉。')
})

test('文件选择器的扩展名不写死成 GPT-SoVITS 的形状', () => {
  // .ckpt/.pth 之外至少要能选到 safetensors / onnx / bin，否则自定义路径
  // 那一栏的「浏览」看不到文件，而界面上没有任何一句话解释为什么。
  assert.ok(/exts=\{\[?'\.safetensors'/.test(CODE) || CODE.includes('WEIGHT_EXTS'),
    '文件过滤还是写死的一两个扩展名')
  const hardExt = CODE.match(/exts=\{\[([^\]]*)\]\}/g) || []
  for (const h of hardExt) {
    assert.ok(!/\.ckpt['"]\s*,\s*'\.pt/.test(h) || h.includes('.safetensors'),
      `文件过滤又退回 .ckpt/.pt 两项了：${h}`)
  }
})

test('配方没有 engine_id 这件事被显式说明了，不是被忽略了', () => {
  // ⚠ 这条守的是一个**已知的格式缺口**（配方顶层还没有引擎身份）。它现在的
  //   解法是「从它钉的权重反查引擎」和「按配方自带的键显示参数」。
  //   如果哪天配方格式升级到带 engine_id，这两条断言要一起改。
  assert.ok(/engine_id/.test(SRC) || /没有 engine_id/.test(SRC),
    '配方没有 engine_id 这个事实没有被任何注释或代码记录下来 —— ' +
    '下一个读这段代码的人会以为引擎身份是现成的。')
})