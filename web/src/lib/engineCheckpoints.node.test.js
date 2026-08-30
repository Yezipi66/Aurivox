// ============================================================
//  底模徽章 —— checkpointBadge()（2026-08-29）
// ============================================================
//
// 来历是 Owner 的一句话：「你都读不到底模在哪里」。
// 在这之前，「底模」在界面上是**完全不存在**的一个概念：放对了没有、放在哪，
// 界面一个字都不说，只能靠引擎起不起得来事后倒推。
//
// ⛔ 这个函数不做任何判断 —— 判断在服务端 lib/engines/checkpoints.js 里做完了。
//   它只负责把 /api/engines 回来的 checkpoints 那一段翻成「徽章上写什么、
//   悬停显示什么」。两边各判一次，迟早会对同一台引擎说出两种话。
//   ⇒ 下面每一条用例都是「给什么状态，说什么话」，没有一条在验算法。
//
// 单独一个文件而不是并进 engines.node.test.js：那个文件测的是「面板按名片长」
// （契约 §11 判据 9/11），这一件事跟参数面板没有关系。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { checkpointBadge } from './engines.js'

test('列表还没回来 / 没有 checkpoints 段 —— 不显示徽章，也不显示空徽章', () => {
  assert.equal(checkpointBadge(null), null)
  assert.equal(checkpointBadge({ id: 'x' }), null)
})

test('底模齐 = 绿，且标题里必须给绝对路径', () => {
  // ⭐「在哪」比「齐不齐」更重要：Owner 问的原话就是「读不到底模在哪里」。
  const b = checkpointBadge({
    checkpoints: { declared: true, ready: true, abs_path: '/r/models/x', path_source: 'manifest', missing: [] },
  })
  assert.equal(b.tone, 'ok')
  assert.ok(b.title.includes('/r/models/x'))
})

test('底模缺 = 红，徽章上写缺几个，标题里写缺哪几个', () => {
  const b = checkpointBadge({
    checkpoints: {
      declared: true, ready: false, abs_path: '/r/models/x', path_source: 'manifest',
      missing: ['gpt.pth', 's2mel.pth'],
      reason: '底模目录在，但少了 2 个文件：gpt.pth / s2mel.pth',
    },
  })
  assert.equal(b.tone, 'bad')
  assert.match(b.label, /2/)
  assert.ok(b.title.includes('gpt.pth'))
})

test('⛔ 「说不出来」画成灰的，不是红的', () => {
  // 名片没点名必需文件 ≠ 底模没放。画成红的，会让一台其实好好的引擎永远挂着
  // 红灯；那种红灯看久了就没人看了，真红的那天也没人信。
  const b = checkpointBadge({
    checkpoints: {
      declared: true, ready: null, abs_path: '/r/models/x', path_source: 'manifest',
      reason: '目录在（16 项），但没点名任何文件',
    },
  })
  assert.equal(b.tone, 'unknown')
})

test('名片压根没写底模路径 —— 也是灰的，并且把原因说出来', () => {
  const b = checkpointBadge({
    checkpoints: { declared: false, ready: null, abs_path: null, reason: '名片没写 runtime.checkpoints' },
  })
  assert.equal(b.tone, 'unknown')
  assert.match(b.title, /runtime\.checkpoints/)
})

test('⭐ 缺的时候，标题里要给出名片写的那条取回命令（照抄就能用）', () => {
  // 只说一句"缺"等于没说。徽章要回答的是「我该去哪儿、放什么、怎么拿」。
  const b = checkpointBadge({
    checkpoints: {
      declared: true, ready: false, abs_path: '/r/models/x', path_source: 'manifest',
      missing: ['a'], hint: '自己下',
      source: {
        url: 'https://example.invalid/m', license_gate: true,
        command: ['some-downloader', 'get', '--out', '/r/models/x'], cwd: '/r/engines/fake',
      },
    },
  })
  assert.ok(b.title.includes('some-downloader get --out /r/models/x'))
  assert.ok(b.title.includes('/r/engines/fake'))          // 在哪儿执行
  assert.ok(b.title.includes('https://example.invalid/m'))
  assert.ok(b.title.includes('自己下'))
  // 「要先点同意」这件事必须说出来：它的失败长得像网络故障（401/403），
  // 而真正的解法是去开一次浏览器 —— 猜不出来的。
  assert.match(b.title, /401|403|同意/)
})

test('齐了就不再劝人去下载（标题里不出现取回命令）', () => {
  const b = checkpointBadge({
    checkpoints: {
      declared: true, ready: true, abs_path: '/r/models/x', path_source: 'manifest', missing: [],
      hint: '自己下',
      source: { url: 'https://example.invalid/m', license_gate: false, command: ['dl', '/r/models/x'], cwd: '/r' },
    },
  })
  assert.ok(!b.title.includes('example.invalid'))
})

test('路径被环境变量顶掉时，标题要说是谁顶的', () => {
  // 不说的话，界面显示的路径和名片写的不一样，人只会以为界面读错了。
  const b = checkpointBadge({
    checkpoints: { declared: true, ready: true, abs_path: '/somewhere/else', path_source: 'env:DEMO_CKPT_DIR', missing: [] },
  })
  assert.ok(b.title.includes('DEMO_CKPT_DIR'))
  assert.ok(b.title.includes('/somewhere/else'))
})

test('英文界面下徽章说英文', () => {
  const b = checkpointBadge({
    checkpoints: { declared: true, ready: true, abs_path: '/r/x', path_source: 'manifest', missing: [] },
  }, 'en')
  assert.ok(!/[\u4e00-\u9fa5]/.test(b.label), `英文界面的徽章不该有中文：${b.label}`)
})

test('三态的标题一句都不许是空的（悬停上去什么都没有，比不显示更糟）', () => {
  const base = { declared: true, abs_path: '/r/x', path_source: 'manifest', missing: [] }
  for (const ready of [true, false, null]) {
    const b = checkpointBadge({ checkpoints: { ...base, ready } })
    assert.ok(b.label.trim(), `ready=${ready} 的徽章没有字`)
    assert.ok(b.title.trim(), `ready=${ready} 的徽章没有标题`)
  }
})

test('⛔ 守卫：engines.js 里不许出现任何引擎名或下载器名', () => {
  // 界面按名片长，不按某一台引擎长。命令是名片写的，界面不认识下载器。
  const src = readFileSync(new URL('./engines.js', import.meta.url), 'utf8')
  const code = src.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')
  for (const name of ['gpt-sovits', 'sovits', 'indextts', 'modelscope', 'huggingface']) {
    assert.ok(!code.toLowerCase().includes(name),
      `engines.js 的代码里出现了 ${name}`)
  }
})
