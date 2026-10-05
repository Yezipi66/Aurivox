'use strict'
// steps（六步的顺序与状态）—— ⭐ 核心判据是**顺序**本身
//
// ⚠ 这份测试守的是 docs/ENGINE_WIZARD_PLAN_v2.md §二 那条硬约束：
//   「第 2 步克隆时目录必须是空的」。
// ⇒ 如果有人把 clone 和 manifest 的顺序调换，测试必须红。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// ⚠ editor/ 是 .jsx/.js 混编的目录，node --test 直接跑不了 ESM+JSX。
//   ⇒ 这里 require 一个**纯 JS** 的等价物，避免为了测试去装 babel。
//   ⛔ 但那会变成两份实现 —— 所以这里改成：只测**不依赖 JSX** 的部分，
//      并且用「真跑一遍 steps.js」的方式（见下面的加载器）。
const STEPS_PATH = path.join(__dirname, '..', 'editor', 'steps.js')

// steps.js 是 ESM export，用 node 的 ESM 加载器读；这里用动态 import 包装成 CJS
let mod
test('⏳ 加载 steps.js', async () => {
  mod = await import('file:///' + STEPS_PATH.replace(/\\/g, '/'))
  assert.ok(mod.STEPS, '⛔ 导不出 STEPS')
})

// ---------------------------------------------------------------------------
// ⭐ 顺序 —— 这份测试存在的第一理由
// ---------------------------------------------------------------------------
test('⭐ prepare 必须在 manifest **之前**（目录空的硬约束，Owner 2026-10-04 合并 1/2/3）', () => {
  const { STEPS } = mod
  const prep = STEPS.find((s) => s.key === 'prepare')
  const manifest = STEPS.find((s) => s.key === 'manifest')
  assert.ok(prep && manifest, '⛔ prepare / manifest 步骤不见了')
  assert.ok(prep.n < manifest.n,
    `⛔ prepare(n=${prep.n}) 必须排在 manifest(n=${manifest.n}) 之前 —— `
    + '不然克隆时目录已经非空了')
})

test('⭐ ⭐ prepare 那一步内部仍然声明 requiresEmptyDir（合并不许丢硬约束）', () => {
  const prep = mod.STEPS.find((s) => s.key === 'prepare')
  assert.strictEqual(prep.requiresEmptyDir, true,
    '⛔ prepare 丢了 requiresEmptyDir —— Owner 把 1/2/3 合成一步，'
    + '但「目录必须是空的」这条硬约束不能跟着合并掉')
  // ⚠ 并且要记下内部三小步 —— 界面上要能分开显示
  assert.deepStrictEqual(prep.phases, ['resolve', 'probe', 'clone'],
    '⛔ prepare 没声明 phases —— 探测（只读）与克隆（写盘）必须能分开显示')
})

test('⭐ prepare 内部顺序：探测必须在克隆**之前**（只读优先）', () => {
  const prep = mod.STEPS.find((s) => s.key === 'prepare')
  const i = prep.phases.indexOf('probe')
  const c = prep.phases.indexOf('clone')
  assert.ok(i >= 0 && c >= 0 && i < c,
    '⛔ 探测必须在克隆之前 —— 探测只读，克隆会把目录写非空')
})

test('⭐ 五步：1/2/3 合成一步，第 6 步已删', () => {
  // ⚠ 2026-10-05 Owner 两条裁决：
  //   ① 1/2/3 合成一步「准备」（2026-10-04 定的，没变）
  //   ② ⛔ 删掉第 6 步 —— 它整步就是一段说明文案，一行代码都不做
  //      （README:133「不需要跑任何脚本」），留着只是让流程条多一格
  assert.deepStrictEqual(mod.STEPS.map((s) => s.key),
    ['prepare', 'env', 'models', 'manifest', 'verify'])
  // ⛔ 删干净了：⛔ 任何地方都不许再引用 ready 这一步
  assert.ok(!mod.STEPS.some((s) => s.key === 'ready'))
})

test('⭐ 五个步骤名：中文位是中文、英文位是英文（Owner 2026-10-05）', () => {
  // ⛔ 之前这条断言要求 label[0] === label[1]（中英相同）——
  //   那正是「切到英文界面时步骤名不会变」的病根：t() 在英文界面取
  //   label[0]，两半都写中文 ⇒ 英文界面显示的还是中文。
  // ✅ 现在的规则：**中文位是中文，英文位是英文**，各说各话。
  for (const s of mod.STEPS) {
    assert.ok(/[\u4e00-\u9fa5]/.test(s.label[1]),
      `${s.key} 的中文标签不是中文：${s.label[1]}`)
    assert.ok(/[A-Za-z]/.test(s.label[0]),
      `${s.key} 的英文标签没有英文（切英文界面会显示中文）：${s.label[0]}`)
    // ⛔ 中文位不许夹半截英文（那正是「Weights 权重」式拼接）
    assert.ok(!/[A-Za-z]{3,}/.test(s.label[1]),
      `${s.key} 的中文标签夹了英文单词：${s.label[1]}`)
  }
  // ⛔ 半截英文（Label 里带中文又有长英文单词）也不许
  for (const s of mod.STEPS) {
    assert.ok(!/[A-Za-z]{3,}/.test(s.label[1]),
      `${s.key} 的中文标签里混了英文：${s.label[1]}`)
  }
})

test('⭐ 名字说「要做什么」而不是只给名词', () => {
  // ⚠ Owner：「我没听懂这几步需要干什么」⇒ 光有名词不够。
  for (const s of mod.STEPS) {
    assert.ok(s.does && s.does[0] && s.does[1],
      `${s.key} 缺 does（界面要说清这一步做什么）`)
  }
  // ⭐⭐ 第 3 步：名字叫「下载模型」⇒ 必须说清**平台不统一下载**。
  //   Owner 2026-10-05：「从现在开始，模型不再需要统一管理」
  //   ⇒ 平台只摆出**上游自己**的下载方式（自带脚本 / README 里的命令）。
  //   ⛔ 不加这句 ⇒ 用户以为平台会替他下一份统一管理的权重。
  const models = mod.STEPS.find((s) => s.key === 'models')
  // ⚠ 2026-10-05 Owner 亲自改成了「由使用者手动执行」——
  //   ⭐ 那句比我的好：说的是**谁来做**，不是「平台不做什么」。
  //   ⇒ 断言改钉实质：**必须说清由人执行**，⛔ 不许断言某几个字。
  assert.ok(/手动|自己|自行|manually|by yourself/i.test(models.does[1]),
    `第 3 步的说明必须说清「由使用者手动执行」：${models.does[1]}`)
})

test('⭐ models 与 manifest 必须是并发的那一对', () => {
  const models = mod.STEPS.find((s) => s.key === 'models')
  const manifest = mod.STEPS.find((s) => s.key === 'manifest')
  assert.strictEqual(models.parallelWith, 'manifest')
  assert.strictEqual(manifest.parallelWith, 'models')
})

test('⛔ 除 models↔manifest 外，其余不许声明并发', () => {
  for (const s of mod.STEPS) {
    if (s.key === 'models' || s.key === 'manifest') continue
    assert.ok(!s.parallelWith,
      `⛔ ${s.key} 声明了并发 —— Owner 只定了 models/manifest 那一对`)
  }
})

// ---------------------------------------------------------------------------
// env 那一步：名片必须自己说怎么装
// ---------------------------------------------------------------------------
test('⭐ env 步骤声明了它依赖哪个名片字段', () => {
  const env = mod.STEPS.find((s) => s.key === 'env')
  assert.strictEqual(env.requiresManifestField, 'install.env_command',
    '⛔ env 步骤没声明依赖 install.env_command —— 「平台不猜装法」就没人守了')
})

test('⭐ 没有 env_command ⇒ env 步骤不能开始', () => {
  const { stepStatus, canStart } = mod
  const s = { id: 'x', url: 'https://github.com/a/b', cloneUrl: 'u', manifest: {} }
  const st = stepStatus(s).find((x) => x.step === 'env')
  assert.strictEqual(st.ok, false, '⛔ 没写 env_command 也放行')
  const c = canStart('env', s)
  assert.strictEqual(c.ok, false)
  assert.ok(c.reason, '⛔ 不能开始时要说清为什么')
})

test('⭐ 写了 env_command ⇒ env 步骤能开始', () => {
  const { canStart } = mod
  const s = {
    id: 'x', url: 'https://github.com/a/b', cloneUrl: 'u',
    manifest: { install: { env_command: ['uv', 'sync'] } },
  }
  assert.strictEqual(canStart('env', s).ok, true)
})

// ---------------------------------------------------------------------------
// 下一步
// ---------------------------------------------------------------------------
test('⭐ currentStep 看的是「做完没」，不是「有值没」', () => {
  const { currentStep } = mod
  assert.strictEqual(currentStep({}), 'prepare')
  // ⛔ prepare 要**真克隆了**才算做完
  assert.strictEqual(currentStep({ prepare: true }), 'env')
  assert.strictEqual(currentStep({ prepare: true, env: true }), 'models')
})

test('⭐ ⭐ stepDone：prepare 解析成功但没克隆 ⇒ 不算做完', () => {
  const { stepDone } = mod
  assert.strictEqual(stepDone('prepare', {}), false)
  assert.strictEqual(stepDone('prepare', { id: 'x', probed: true }), false,
    '⛔ 只解析+探测就当克隆做完了 —— 那个目录还是空的')
  assert.strictEqual(stepDone('prepare', { cloned: true }), true)
})

test('⭐ stepDone：weights 的 ready:null（说不出来）⇒ 不算做完', () => {
  const { stepDone } = mod
  assert.strictEqual(stepDone('models', {}), false)
  assert.strictEqual(stepDone('models', { weightsReady: null }), false,
    '⛔ ready=null 意味着「说不出来」⇒ 那是要人补名片的信号')
  assert.strictEqual(stepDone('models', { weightsReady: true }), true)
  assert.strictEqual(stepDone('models', { weightsReady: false }), true,
    '⛔ false（确实缺了）也算查过了 —— 那是一条结论')
})

test('⭐ 全做完 ⇒ currentStep 返回 null（**没有下一步**）', () => {
  const { currentStep } = mod
  // ⚠ 2026-10-05 Owner 删掉第 6 步 ⇒ 全部做完时**没有下一步**。
  //   ⛔ 之前这里返回 'ready' —— 一个已经不存在的步骤名，
  //     流程条会去找一个空节点。⇒ 现在必须是 null。
  assert.strictEqual(currentStep({ prepare: true, env: true, models: true,
    manifest: true, verify: true }), null)
})

// ---------------------------------------------------------------------------
// lanes —— 并发只发生在该并发的地方
// ---------------------------------------------------------------------------
test('⭐ 起点只有一条线（models/manifest 在同一格里，并发）', () => {
  const l = mod.lanes({})
  assert.strictEqual(l.length, 1, '⛔ 起点只该有一条线')
  assert.ok(l[0].includes('models+manifest'),
    `⛔ 并发的那一对没在同一格：${JSON.stringify(l[0])}`)
})

test('⭐ prepare 在那条线**之前**（目录空是克隆的前提）', () => {
  const l = mod.lanes({})
  assert.ok(l[0].indexOf('prepare') < l[0].indexOf('models+manifest'),
    '⛔ prepare 必须排在 models/manifest 前面 —— 名片没写时目录才是空的')
})

test('models 完成之后 ⇒ 剩下的是各自一条线', () => {
  const l = mod.lanes({ models: true })
  assert.ok(!JSON.stringify(l).includes('models+manifest'),
    '⛔ models 做完了还合成一条线')
  assert.ok(l[0].includes('manifest'), 'manifest 还该在')
})

// ---------------------------------------------------------------------------
// ⛔ 纪律
// ---------------------------------------------------------------------------
test('⛔ steps.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(STEPS_PATH, 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})