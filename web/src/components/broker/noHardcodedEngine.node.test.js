// Broker 页不许写死一台引擎：读源码的守卫。
// JSX 在这个仓库里跑不了单测（node --test 不经 vite，也没有 jsdom），所以只守源码里看得见的事：
// 引擎身份与模型位名问后端要、参数摘要走 paramsSummaryOf、文件过滤不写死扩展名。
// 守的是代码不是注释：这些名字写在注释里不算违规。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDirSources, stripComments } from '../../__testsupport__/readDirSources.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 读本目录下全部源码：组件拆成多个文件后，只读 BrokerTab.jsx 会看不见拆出去的部分，守卫静默失效。
const SRC = readDirSources(import.meta.url, '.')

// 注释里可以提这些名字，守卫只查代码。
const CODE = stripComments(SRC)

test('⛔ REBIND_ENGINE 这个常量不许回来', () => {
  assert.ok(!/\bREBIND_ENGINE\b/.test(CODE),
    'REBIND_ENGINE 又回来了，这正是「这一页写死一台引擎」的证据。' +
    '引擎身份应该由 /api/recipes-models/:role 的 engines 字段给出。')
})

test('⭐ 引擎身份问后端要，不在代码里写死', () => {
  // 后端 /api/recipes-models/:role 已经返回 engines 与 models[<engineId>][<slot>]，前端不用猜。
  assert.ok(CODE.includes('r.data.engines') || CODE.includes('data && r.data.engines'),
    '没有读后端返回的 engines 列表')
  assert.ok(/api\/recipes-models\//.test(CODE), '没有走 /api/recipes-models/:role')
  assert.ok(CODE.includes('enginesInMeta') === false,
    '前端不该复制一份 enginesInMeta，那是后端的事实')
})

test('⭐ 模型位的名字来自后端的 models[<engineId>][<slot>]，不写死 gpt/sovits', () => {
  assert.ok(/Object\.keys\([^)]*slots/.test(CODE) || CODE.includes('slotNamesOf'),
    '位名没有从后端返回的对象里取')
  assert.ok(CODE.includes('slotNames'), '位名没有进 state')
  // gpt/sovits 仍可作为局部变量名（配方那两个字段就叫这个），但不许再当位名去后端查。
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
  // 判据同对比页的方法下拉：后端没给的，界面不许替它编一个。
  assert.ok(/slotNames\.length > 1/.test(CODE),
    '第二个模型位没有按 slotNames.length > 1 渲染，一台只有一个位的引擎' +
    '会被画出一个标题写着「模型」、候选永远为空的下拉。')
})

test('文件选择器的扩展名不写死成 GPT-SoVITS 的形状', () => {
  // 除 .ckpt/.pth 外至少要能选到 safetensors / onnx / bin，否则「浏览」看不到文件。
  assert.ok(/exts=\{\[?'\.safetensors'/.test(CODE) || CODE.includes('WEIGHT_EXTS'),
    '文件过滤还是写死的一两个扩展名')
  const hardExt = CODE.match(/exts=\{\[([^\]]*)\]\}/g) || []
  for (const h of hardExt) {
    assert.ok(!/\.ckpt['"]\s*,\s*'\.pt/.test(h) || h.includes('.safetensors'),
      `文件过滤又退回 .ckpt/.pt 两项了：${h}`)
  }
})

test('配方没有 engine_id 这件事被显式说明了，不是被忽略了', () => {
  // 配方顶层还没有引擎身份这件事必须留在代码或注释里：下一个读的人会以为引擎身份是现成的。
  assert.ok(/engine_id/.test(SRC) || /没有 engine_id/.test(SRC),
    '配方没有 engine_id 这个事实没有被任何注释或代码记录下来，' +
    '下一个读这段代码的人会以为引擎身份是现成的。')
})