// ============================================================
//  装一台假引擎，走完整条链路（契约 §11 判据 9 的后端那一半）
// ============================================================
//
// 判据 9 要的是「界面能长出它的参数面板」。界面那半在
// web/src/lib/engines.node.test.js（纯函数，喂的是写好的 JSON）。
// 这一份补的是**前面那一截**：一张真的躺在盘上的 manifest.json，
// 经过 registry → profile → 对外形状，最后长成界面吃的那个 JSON。
//
// ⭐ 两半缺一不可，而且分开写是有理由的：
//    界面那半喂的是我手写的 JSON —— 它证明不了「平台真能把一张陌生的
//    manifest.json 读成这个形状」。这一份才证明那件事。
//
// ⛔ 假引擎**不落进真的 `engines/`**：
//    契约 §11 判据 2 是「`engines/` 下目录数 == 支持的引擎数」，
//    往那儿塞一个测试用的目录，跟判据 2 直接打架（而且测试崩了会留垃圾）。
//    改为把 ENGINES_DIR 指到临时目录（lib/paths.js:222 本来就支持 env 覆盖）。
//    ⚠ 因为 paths.js 在 require 时就把值定死了，只能起子进程来换。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')

// ------------------------------------------------------------
//  这台假引擎：不出声，而且处处不像盘上那两台。
//
//  ⭐ 「不出声」不是图省事，是这个测法成立的唯一原因：
//     真引擎会出声，出声就说明不了问题 —— 面板长对了，可能是读了这张
//     manifest.json，也可能是平台还按老引擎那套写死的知识在长、而这台
//     引擎恰好长得像。两种情况读数一模一样。
//     假引擎的参数名、档位、能力全都对不上，平台但凡还有一处写死，
//     它当场就长歪。**这是一个有可能失败的实验。**
// ------------------------------------------------------------
const FAKE_ID = 'silent-fake'

const FAKE_MANIFEST = {
  // ⭐ 刀 B1 抓到：原本写的是 `manifest_version`，契约里没这个键。
  contract_version: 2,
  id: FAKE_ID,
  label: 'Silent Fake',
  // 不由平台启动：没有 runtime 段。契约认这是合法的（「这台你自己起」）。
  default_base_url: 'http://127.0.0.1:59999',
  timeout_ms: 1000,
  timeout_ms_source: 'estimated',
  max_chars: 7,
  max_chars_source: 'estimated',
  // ⭐ 刀 B1 抓到：原本写了 hard_max_chars: 13 —— 不是名片键，是算出来的（7×2=14）。
  //   ⚠ 注意 13 ≠ 14：**写错的值也一样没有任何症状**，因为压根没人读它。

  capabilities: {
    requires_reference_audio: false,
    reference_clip_seconds: null,
    // ⛔ 这里原本有 hot_swap_models —— 2026-08-30 退休，新名片不用再写。
    streaming: false,
    output_sample_rate: 8000,
    // 判据 11 的那一格。
    supports_finetune: false,
  },
  maps: {},
  payload_keys: ['wobble', 'flavour', 'goose_count', 'upside_down'],
  // ⭐ `sends_always` **不是名片里的字段**，是从「默认值写在哪一边」推导出来的
  //   （profile.js:501-508，契约 C11「参数表只有一份」）：
  //     写在 defaults 里          ⇒ 平台每次都替它填  ⇒ sends_always: true
  //     写在 params.schema.default ⇒ 只是界面初值      ⇒ sends_always: false
  //   两边都写会报错，因为两份默认值会各自漂移而且漂移不报错。
  //   ⚠ 我第一版把这四个默认值全写进 schema.default、另外手写了一个
  //     `sends_always: true` 字段 —— 那个字段会被静默忽略，测试当场红。
  //     记在这里，免得下一个照抄这张假名片的人重踩。
  defaults: {
    wobble: 0.5,
    flavour: 'salty',
  },
  params: {
    schema: {
      wobble: {
        type: 'number',
        min: 0, max: 1, step: 0.1, tier: 'common',
        label: { en: 'Wobble', zh: '抖动' },
        help: { en: 'How much wobble.', zh: '抖多少。' },
      },
      flavour: {
        type: 'enum', tier: 'common',
        choices: [
          { value: 'salty', label: { en: 'Salty', zh: '咸' } },
          { value: 'sweet', label: { en: 'Sweet', zh: '甜' } },
        ],
        label: { en: 'Flavour', zh: '口味' },
      },
      goose_count: {
        type: 'integer', default: 3,
        min: 1, max: 9, step: 1, tier: 'advanced',
        label: { en: 'Goose Count', zh: '鹅数' },
      },
      upside_down: {
        type: 'boolean', default: false, tier: 'advanced',
        label: { en: 'Upside Down', zh: '倒过来' },
      },
    },
  },
}

/**
 * 建一个只有假引擎的临时 engines 目录，在子进程里问平台「你看见了什么」。
 *
 * 子进程而不是同进程：paths.js 在 require 的那一刻就把 ENGINES_DIR 定死了。
 */
function askPlatform(manifest, id = FAKE_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-engine-'))
  try {
    const engineDir = path.join(dir, id)
    fs.mkdirSync(engineDir)
    fs.writeFileSync(path.join(engineDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    const script = `
      const { listEngineIds } = require(${JSON.stringify(path.join(ROOT, 'lib/engines/registry'))});
      const { resolveEngineProfile } = require(${JSON.stringify(path.join(ROOT, 'lib/engines/profile'))});
      const ids = listEngineIds();
      const out = { ids, profiles: {} };
      for (const i of ids) {
        try { out.profiles[i] = resolveEngineProfile(i); }
        catch (e) { out.profiles[i] = { __error: e.message, __code: e.code || null }; }
      }
      process.stdout.write(JSON.stringify(out));
    `
    const stdout = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, ENGINES_DIR: dir },
      encoding: 'utf-8',
    })
    return JSON.parse(stdout)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ============================================================

test('判据9：一台谁都没见过的引擎，平台看得见它', () => {
  const seen = askPlatform(FAKE_MANIFEST)
  assert.deepEqual(seen.ids, [FAKE_ID],
    '把 ENGINES_DIR 指到只有假引擎的目录，平台应该只看见它一台')
})

test('判据9：假引擎的参数表，是从它自己的 manifest.json 读出来的', () => {
  const p = askPlatform(FAKE_MANIFEST).profiles[FAKE_ID]
  assert.ok(!p.__error, `解析失败了：${p.__error}`)

  const names = p.param_schema.map(f => f.name)
  assert.deepEqual([...names].sort(), ['flavour', 'goose_count', 'upside_down', 'wobble'])

  // ⭐ 反面：平台不许往里掺任何这张 manifest.json 没写的东西。
  //   ⛔ 不是在点名某台引擎 —— 是在证明参数表不是按谁长的。
  for (const leaked of ['temperature', 'top_k', 'top_p', 'text_split_method', 'batch_size']) {
    assert.ok(!names.includes(leaked),
      `假引擎的参数表里冒出了 ${leaked} —— 平台还在按别的引擎长`)
  }
})

test('判据9：格子的形状（档位、范围、要不要每次发）逐字来自 manifest.json', () => {
  const p = askPlatform(FAKE_MANIFEST).profiles[FAKE_ID]
  const by = Object.fromEntries(p.param_schema.map(f => [f.name, f]))

  assert.equal(by.wobble.tier, 'common')
  assert.equal(by.wobble.min, 0)
  assert.equal(by.wobble.max, 1)
  assert.equal(by.wobble.sends_always, true)

  assert.equal(by.goose_count.tier, 'advanced')
  assert.equal(by.goose_count.sends_always, false)

  assert.deepEqual(by.flavour.choices.map(c => c.value), ['salty', 'sweet'])
  assert.equal(by.wobble.label.zh, '抖动')
})

test('判据11：假引擎的 supports_finetune 一路传到界面吃的那个形状', () => {
  const p = askPlatform(FAKE_MANIFEST).profiles[FAKE_ID]
  assert.equal(p.supports_finetune, false,
    '这个字段在 §9 里记了很久「解析出来了、全仓零消费者」—— 训练页显隐就是它的消费者')
})

test('假引擎的其他能力也照 manifest.json 走，没有一处回落到别的引擎', () => {
  const p = askPlatform(FAKE_MANIFEST).profiles[FAKE_ID]
  assert.equal(p.max_chars, 7)
  assert.equal(p.output_sample_rate, 8000)
  assert.equal(p.requires_reference_audio, false)
  assert.equal(p.base_url, 'http://127.0.0.1:59999')
  // 没写 runtime 段 = 不由平台启动。⛔ 不是「解析失败」。
  assert.equal(p.runtime, null)
})

test('契约 §63：名片没写 supports_finetune ⇒ 当 false，⛔ 不是当支持', () => {
  // ⚠ 这一条我一开始写反了：断言「漏写要报错」，理由是「不能替名片作者猜」。
  //   契约 §63 明写「名片里的 `capabilities.supports_finetune` **默认 `false`**」——
  //   那就不是猜，是契约定好的默认值，报错才是错的。
  //   留着这条，是因为默认成 false 和默认成 true 是两个方向相反的错误：
  //   默认 false 顶多让一台真能微调的引擎少一个页签（看得见、能改名片补上）；
  //   默认 true 会给一台根本不能微调的引擎开出训练页，用户填完一整张表才发现。
  const broken = JSON.parse(JSON.stringify(FAKE_MANIFEST))
  delete broken.capabilities.supports_finetune
  const p = askPlatform(broken).profiles[FAKE_ID]
  assert.ok(!p.__error, `不该报错：${p.__error}`)
  assert.equal(p.supports_finetune, false)
})

test('⛔ 写成字符串 "true" / 数字 1 都不算支持 —— 只认布尔真值', () => {
  for (const sloppy of ['true', 1, 'yes']) {
    const m = JSON.parse(JSON.stringify(FAKE_MANIFEST))
    m.capabilities.supports_finetune = sloppy
    const p = askPlatform(m).profiles[FAKE_ID]
    // 要么报错说清写法，要么当 false。⛔ 唯独不能当 true。
    if (!p.__error) {
      assert.equal(p.supports_finetune, false,
        `capabilities.supports_finetune 写成 ${JSON.stringify(sloppy)} 被当成了支持`)
    }
  }
})
