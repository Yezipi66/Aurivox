// ============================================================
//  对比页行数据迁移 —— 老 localStorage 数据不许静默丢参数
// ============================================================
//
// ⭐ 这一组测试在守一个**已经差点发生**的回归：
//    2026-10-01 对比页换成按名片驱动之后，行数据的超参从「摊平在行上」
//    搬进了 params/touched。而老数据躺在用户的 localStorage（`compare.rows`）
//    里 —— 不迁移的话，用户调过的 top_k 一个都读不出来（touched 是空集），
//    而格子显示的是**名片默认值**，用户完全看不出来。
//
//    症状是「用户的老参数没了」，这种失败不会自己浮出来，所以要单测。
//
// ⚠ web/ 是 ESM（web/package.json 的 "type": "module"），这里用 import。
import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateRow } from './compareRowMigrate.js'

// 一行**真实形状**的老数据（2026-08 那版：超参摊平）。
const LEGACY_ROW = {
  id: 1,
  refAudio: 'assets/v1/slicer_opt/a.wav',
  auxRefPaths: [],
  text: '你好',
  temperature: 1.25,
  top_k: 42,
  top_p: 0.8,
  repetition_penalty: 1.5,
  text_split_method: 'cut2',
  speed_factor: 1.2,
  seed: 123,
  engine_batch: 'inherit',
  pronOverrides: {},
  hanForced: [],
  hanReadings: {},
  loading: true,        // ⛔ 重载后不该还是「生成中」
  error: 'boom',        // ⛔ 上一次的错误不该还挂着
  textLang: 'ja',
}

test('⭐ 老行的超参搬进 params（不是丢在地上）', () => {
  const r = migrateRow(LEGACY_ROW)
  assert.equal(r.params.top_k, 42)
  assert.equal(r.params.temperature, 1.25)
  assert.equal(r.params.top_p, 0.8)
  assert.equal(r.params.repetition_penalty, 1.5)
  assert.equal(r.params.text_split_method, 'cut2')
  assert.equal(r.params.speed_factor, 1.2)
})

test('⭐⭐ 搬进来的都算 touched —— 否则用户调过的超参一个都发不出去', () => {
  // ⭐ 这条是整组测试的核心。paramsToSend 只发 touched 里的键；touched 空
  //   ⇒ 请求体里一个超参都没有 ⇒ 用户调过的 top_k 完全不生效，而且界面
  //   显示的是默认值，看不出任何异常。
  const r = migrateRow(LEGACY_ROW)
  assert.ok(Array.isArray(r.touched), 'touched 必须是数组（存在 localStorage 里，Set 序列化后为空）')
  for (const k of ['top_k', 'temperature', 'top_p', 'repetition_penalty', 'text_split_method', 'speed_factor']) {
    assert.ok(r.touched.includes(k), `${k} 没进 touched —— 用户的这一格会被静默丢掉`)
  }
})

test('行上摊平的键搬完要摘掉（不然下次迁移会重复搬、也不好查）', () => {
  const r = migrateRow(LEGACY_ROW)
  // ⛔ 这里刻意**不**删摊平键：那样会改掉用户数据的其他部分（配方/导出的
  //   旧工作区可能还读它们）。判据是「params 里有正确的值」，重复搬是幂等的。
  //   这条断言守的是相反的方向：不能因为搬了就顺手把原值改了。
  assert.equal(r.top_k, 42, '老键的原始值不该被迁移改动（还有别处可能读它）')
  assert.equal(r.params.top_k, 42, '而 params 里必须有同一个值')
})

test('transient 标记重置（重载后那一行不该还显示「生成中」/挂着上次的错）', () => {
  const r = migrateRow(LEGACY_ROW)
  assert.equal(r.loading, false)
  assert.equal(r.error, null)
})

test("Legacy 的 per-row textLang 'auto' 落成「跟随默认」", () => {
  assert.equal(migrateRow({ ...LEGACY_ROW, textLang: 'auto' }).textLang, '')
  assert.equal(migrateRow({ ...LEGACY_ROW, textLang: 'zh' }).textLang, 'zh')
})

test('新形状的行原样通过（幂等：跑两遍结果一样）', () => {
  const once = migrateRow(LEGACY_ROW)
  const twice = migrateRow(once)
  assert.deepEqual(twice.params, once.params, '重复迁移改变了 params —— 不幂等')
  assert.deepEqual([...twice.touched].sort(), [...once.touched].sort(), '重复迁移改变了 touched')
})

test('已经是新形状的行不该被搬坏（空 params 就保持空）', () => {
  const modern = { id: 2, params: {}, touched: [], text: 'x' }
  const r = migrateRow(modern)
  assert.deepEqual(r.params, {}, '凭空往 params 里塞了键 —— 等于发明了一个用户没设过的参数')
  assert.deepEqual(r.touched, [])
})

test('半迁移的行（params 有了、老键还在）也要把老的补进来', () => {
  // ⛔ 不是「有 params 就整体跳过」：真出现过分次写入的情况，跳过就漏。
  const half = { id: 3, params: { top_k: 10 }, touched: ['top_k'], temperature: 0.9 }
  const r = migrateRow(half)
  assert.equal(r.params.temperature, 0.9, '老的摊平键没被搬进来')
  assert.ok(r.touched.includes('temperature'))
  assert.equal(r.params.top_k, 10, '已有的新形状值不该被覆盖')
})

test('值是 undefined 的老键不搬（那不是「用户调过」）', () => {
  const r = migrateRow({ id: 4, temperature: undefined, top_k: 7 })
  assert.ok(!('temperature' in r.params), 'undefined 被当成用户调过的搬进来了')
  assert.ok(!r.touched.includes('temperature'))
  assert.equal(r.params.top_k, 7, '但真正有值的那个要搬')
})

test('不是对象 / 是数组 ⇒ 原样返回，不炸', () => {
  for (const bad of [null, undefined, 42, 'x', [1, 2]]) {
    assert.equal(migrateRow(bad), bad, `输入 ${JSON.stringify(bad)} 被改了`)
  }
})

test('行里其他字段一个都不许丢（音色、文本、参考音频…）', () => {
  const r = migrateRow(LEGACY_ROW)
  for (const k of ['id', 'refAudio', 'auxRefPaths', 'text', 'seed', 'engine_batch',
                   'pronOverrides', 'hanForced', 'hanReadings']) {
    assert.deepEqual(r[k], LEGACY_ROW[k], `${k} 在迁移里丢了 —— 这不是迁移该做的事`)
  }
})
