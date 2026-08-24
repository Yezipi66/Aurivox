'use strict';

// 「先查缓存，没有才推理」这几行的行为守卫。
//
// 为什么单独立一份：这段代码错了**不会报错**，只会让用户听到上一次的音频
// ——「静默返回错音频」是本仓最难被发现的一类缺陷。它的天然位置在 server.js，
// 而 server.js 进不了测试进程（一 require 就 listen），所以策略被提到
// lib/cache/cachedInference.js，这份测试直接调它的真实现，不抄第二份。

const test = require('node:test');
const assert = require('node:assert');

const { inferWithCache, SWEEP_EVERY_MISSES } = require('./cachedInference');

// --- 一个只认「指纹字符串 -> 字节」的假缓存，行为与真缓存同形 ---------------
function fakeCache (opts = {}) {
  const store = new Map();
  const calls = { fingerprint: [], get: [], put: [], sweep: 0 };
  return {
    store,
    calls,
    // 指纹默认就是 payload 的 JSON —— 让测试能精确控制「同/不同」
    fingerprint (arg) {
      calls.fingerprint.push(arg);
      return (opts.fingerprint || ((a) => JSON.stringify(a.payload)))(arg);
    },
    get (k) { calls.get.push(k); return store.get(k) || null; },
    put (k, v) { calls.put.push({ k, v }); store.set(k, v); },
    sweep () { calls.sweep++; },
  };
}

const PROFILE = { id: 'gpt-sovits', base_url: 'http://127.0.0.1:9880' };

function inferring (bytes, log) {
  return async () => { if (log) log.push(bytes.toString()); return bytes; };
}

test('未命中时会真的推理，并把结果存进缓存', async () => {
  const cache = fakeCache();
  const out = {};
  const ran = [];
  const bytes = Buffer.from('AUDIO-1');

  const got = await inferWithCache(
    cache, { profile: PROFILE, payload: { text: 'hello' }, cfg: {} },
    inferring(bytes, ran), out, { logger: quiet(), counters: { hits: 0, misses: 0 } },
  );

  assert.deepEqual(got, bytes);
  assert.deepEqual(ran, ['AUDIO-1'], '未命中就必须真的推理');
  assert.equal(out.cached, false);
  assert.equal(cache.calls.put.length, 1, '推理完必须存进缓存');
  assert.deepEqual(cache.calls.put[0].v, bytes);
});

test('⭐ 第二次同样的输入 ⇒ 命中，一次推理都不发生', async () => {
  const cache = fakeCache();
  const ran = [];
  const args = { profile: PROFILE, payload: { text: 'hello' }, cfg: {} };
  const deps = { logger: quiet(), counters: { hits: 0, misses: 0 } };

  await inferWithCache(cache, args, inferring(Buffer.from('A'), ran), {}, deps);
  const out2 = {};
  const got = await inferWithCache(cache, args, inferring(Buffer.from('B'), ran), out2, deps);

  assert.deepEqual(ran, ['A'], '第二次不该再推理');
  assert.equal(got.toString(), 'A', '命中要交出第一次的字节');
  assert.equal(out2.cached, true, '出参必须如实说这次是复用的');
});

test('⭐⭐ 输入变了 ⇒ 绝不能命中（这条错了 = 用户听到上一句话）', async () => {
  const cache = fakeCache();
  const ran = [];
  const deps = { logger: quiet(), counters: { hits: 0, misses: 0 } };

  await inferWithCache(cache, { profile: PROFILE, payload: { text: '第一句' }, cfg: {} },
    inferring(Buffer.from('A'), ran), {}, deps);
  const got = await inferWithCache(cache, { profile: PROFILE, payload: { text: '第二句' }, cfg: {} },
    inferring(Buffer.from('B'), ran), {}, deps);

  assert.deepEqual(ran, ['A', 'B'], '输入不同必须重新推理');
  assert.equal(got.toString(), 'B');
});

test('⭐ 指纹的原料是 payload 本身，不是被挑出来的几个字段', async () => {
  const cache = fakeCache();
  const payload = { text: 'x', top_k: 15, 某个下游引擎的私有键: 1 };
  await inferWithCache(cache, { profile: PROFILE, payload, cfg: {} },
    inferring(Buffer.from('A')), {}, { logger: quiet(), counters: { hits: 0, misses: 0 } });

  // 交给 fingerprint 的必须是那个 payload 对象本人 —— 中间不许有人复制、
  // 挑拣或改写，否则「漏一个键」就又可能了（C11 的账就是这么欠下的）。
  assert.strictEqual(cache.calls.fingerprint[0].payload, payload);
  assert.strictEqual(cache.calls.fingerprint[0].profile, PROFILE);
});

test('⭐⭐ force_resynth 跳过读', async () => {
  const cache = fakeCache();
  const ran = [];
  const deps = { logger: quiet(), counters: { hits: 0, misses: 0 } };
  const payload = { text: 'hello' };

  await inferWithCache(cache, { profile: PROFILE, payload, cfg: {} },
    inferring(Buffer.from('OLD'), ran), {}, deps);

  const out = {};
  const got = await inferWithCache(cache, { profile: PROFILE, payload, cfg: { force_resynth: true } },
    inferring(Buffer.from('NEW'), ran), out, deps);

  assert.deepEqual(ran, ['OLD', 'NEW'], '勾了强制重推就必须真的重推');
  assert.equal(got.toString(), 'NEW');
  assert.equal(out.cached, false);
});

test('⭐⭐ force_resynth 只跳过读，**不**跳过写', async () => {
  // 这条钉的是一个很容易写反的地方：把 put 也塞进 if (!force_resynth) 里，
  // 会让「强制重推一次」变成「从此永不命中」——因为这个开关是持久化的，
  // 用户很可能长期勾着，那样缓存就等于永远不生效，整刀白做。
  const cache = fakeCache();
  const ran = [];
  const deps = { logger: quiet(), counters: { hits: 0, misses: 0 } };
  const payload = { text: 'hello' };

  await inferWithCache(cache, { profile: PROFILE, payload, cfg: { force_resynth: true } },
    inferring(Buffer.from('NEW'), ran), {}, deps);

  assert.equal(cache.calls.put.length, 1, '强制重推的结果也必须写进缓存');

  // 取消勾选后立刻就该能复用刚才那一版
  const out = {};
  const got = await inferWithCache(cache, { profile: PROFILE, payload, cfg: {} },
    inferring(Buffer.from('X'), ran), out, deps);
  assert.equal(out.cached, true);
  assert.equal(got.toString(), 'NEW');
  assert.deepEqual(ran, ['NEW'], '取消勾选后不该再推理');
});

test('⛔ 推理失败 ⇒ 什么都不许存（否则失败会被一直命中下去）', async () => {
  const cache = fakeCache();
  const deps = { logger: quiet(), counters: { hits: 0, misses: 0 } };

  await assert.rejects(
    () => inferWithCache(cache, { profile: PROFILE, payload: { text: 'x' }, cfg: {} },
      async () => { throw new Error('引擎炸了'); }, {}, deps),
    /引擎炸了/,
  );
  assert.equal(cache.calls.put.length, 0, '失败时一个条目都不许写');
  assert.equal(cache.store.size, 0);

  // 而且错误必须原样抛出去 —— 缓存层不许把引擎的报错吞成自己的
  await assert.rejects(
    () => inferWithCache(cache, { profile: PROFILE, payload: { text: 'x' }, cfg: {} },
      async () => { const e = new Error('boom'); e.transport = true; e.engineId = 'gpt-sovits'; throw e; },
      {}, deps),
    (e) => e.transport === true && e.engineId === 'gpt-sovits',
  );
});

test('出参带回指纹，且命中与否都带', async () => {
  const cache = fakeCache();
  const deps = { logger: quiet(), counters: { hits: 0, misses: 0 } };
  const payload = { text: 'hello' };
  const a = {}; const b = {};

  await inferWithCache(cache, { profile: PROFILE, payload, cfg: {} }, inferring(Buffer.from('A')), a, deps);
  await inferWithCache(cache, { profile: PROFILE, payload, cfg: {} }, inferring(Buffer.from('A')), b, deps);

  assert.ok(a.key, '未命中也要带回指纹（meta.json 要留痕）');
  assert.equal(a.key, b.key, '同一份输入两次的指纹必须一样');
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
});

test('不传出参也不能炸（老调用方不写 out）', async () => {
  const cache = fakeCache();
  const deps = { logger: quiet(), counters: { hits: 0, misses: 0 } };
  const got = await inferWithCache(cache, { profile: PROFILE, payload: { text: 'x' }, cfg: {} },
    inferring(Buffer.from('A')), undefined, deps);
  assert.equal(got.toString(), 'A');
});

test('攒够一批未命中才扫盘淘汰，不是每段都扫', async () => {
  const cache = fakeCache();
  const counters = { hits: 0, misses: 0 };
  const deps = { logger: quiet(), counters };

  for (let i = 0; i < SWEEP_EVERY_MISSES - 1; i++) {
    await inferWithCache(cache, { profile: PROFILE, payload: { text: `t${i}` }, cfg: {} },
      inferring(Buffer.from('A')), {}, deps);
  }
  assert.equal(cache.calls.sweep, 0, `不到 ${SWEEP_EVERY_MISSES} 段不该扫盘`);

  await inferWithCache(cache, { profile: PROFILE, payload: { text: 'last' }, cfg: {} },
    inferring(Buffer.from('A')), {}, deps);
  assert.equal(cache.calls.sweep, 1);
});

test('命中时不扫盘（命中不产生新条目，没什么可淘汰的）', async () => {
  const cache = fakeCache();
  const counters = { hits: 0, misses: 0 };
  const deps = { logger: quiet(), counters };
  const payload = { text: 'same' };

  for (let i = 0; i < SWEEP_EVERY_MISSES * 2; i++) {
    await inferWithCache(cache, { profile: PROFILE, payload, cfg: {} },
      inferring(Buffer.from('A')), {}, deps);
  }
  assert.equal(counters.misses, 1);
  assert.equal(counters.hits, SWEEP_EVERY_MISSES * 2 - 1);
  assert.equal(cache.calls.sweep, 0);
});

// --- server.js 接线的弱守卫 -------------------------------------------------
// server.js 一被 require 就 app.listen，进不了测试进程 ⇒ 只能读它的文本。
// ⛔ 必须排除 require 行：突变把调用点删掉时 import 行还留着符号名，
//    不排除的话守卫会被 import 行喂饱而照绿（这一刀里已经踩过一次）。
test('接线守卫: server.js 真的调了 inferWithCache，而不只是 require 了它', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const lines = src.split('\n').filter((l) => !l.includes('require('));
  const body = lines.join('\n');

  assert.ok(/inferWithCache\s*\(/.test(body), 'server.js 必须真的调用 inferWithCache');
  assert.ok(/segmentCache/.test(body), 'server.js 必须把缓存实例交进去');

  // 指纹的原料必须是拼好的 payload —— 不许换成 cfg 或 segmentText
  assert.ok(
    /inferWithCache\([^;]*payload/.test(body),
    'inferWithCache 的实参里必须有 payload（指纹原料不许换成别的）',
  );

  // ⭐⭐ 真推理只许有**一个**入口，就是交给 inferWithCache 的那个回调。
  //   多出任何一处直接调用，就等于开了一条绕过缓存的旁路 —— 而旁路不会
  //   报错，只会让缓存悄悄不生效（或者更糟：两条路的 payload 不一致）。
  //   数出现次数：1 次函数定义 + 1 次回调里调用 = 2。
  const inferCalls = (body.match(/_inferOneSegment/g) || []).length;
  assert.equal(inferCalls, 2,
    `_inferOneSegment 出现 ${inferCalls} 次（应为 2：定义 + 回调各一次）—— ` +
    '多出来的那次很可能是一条绕过缓存的旁路');

  // ⭐ 取值点必须在 applyEngineKnobs 之后：早一步 payload 还没拼完，
  //   名片补的旋钮不会进指纹 ⇒ 改了旋钮却命中旧音频。
  // ⛔ 先断言它还在：不断言的话 indexOf 返回 -1，而 -1 < 任何下标都成立，
  //   把 applyEngineKnobs 整行删掉反而能让守卫照绿（这一刀里踩过一次）。
  assert.ok(/applyEngineKnobs\s*\(/.test(body),
    'server.js 必须仍然调用 applyEngineKnobs（旋钮要在指纹之前补齐）');
  assert.ok(
    body.indexOf('applyEngineKnobs(') < body.indexOf('inferWithCache('),
    '缓存取值点必须在 applyEngineKnobs 之后，否则旋钮不进指纹',
  );
});

test('⭐⭐ 一次请求里若有几段文本完全相同，后面那几段命中是**正确行为**', async () => {
  // 这条钉的是一次真机验收里的误判：验收脚本把同一句话重复 N 遍当长文，
  // 切完之后 N 段文本一模一样 ⇒ N 段同指纹 ⇒ 第 1 段真推、后 N-1 段命中。
  // 当时这被当成「缓存把错音频发出去了」上报成 P0，其实是**测试数据退化**。
  //
  // ⛔ 由此得出的纪律写在这里，免得下次再争一轮：
  //   ① 缓存的验收数据**每段必须不同**，否则「复用」和「本来就该一样」分不开；
  //   ② 判断有没有真复用要**比字节**，不能拿另一段的音频去比 —— 段不同，
  //      音频当然不同，那不构成任何证据。
  const cache = fakeCache();
  const ran = [];
  const deps = { logger: quiet(), counters: { hits: 0, misses: 0 } };
  const N = 5;
  const flags = [];
  for (let i = 0; i < N; i++) {
    const out = {};
    await inferWithCache(
      cache, { profile: PROFILE, payload: { text: '同じ文です。' }, cfg: {} },
      inferring(Buffer.from(`AUDIO-${i}`), ran), out, deps,
    );
    flags.push(out.cached);
  }
  assert.deepEqual(ran, ['AUDIO-0'], `只该推理 1 次（实际 ${ran.length} 次）`);
  assert.deepEqual(flags, [false, true, true, true, true],
    '第 1 段真推、其余全部复用 —— 这就是正确答案，不是缺陷');
  assert.equal(deps.counters.hits, N - 1, '复用计数必须与真实命中数一致，不能虚高');
});

test('⛔ 复用计数不许虚高：字节从缓存来的次数 == 出参说 cached 的次数', async () => {
  // CR 报过「meta 说复用了 6 段，但字节证明是新推的」。计数是从这里传上去的，
  // 所以在这里钉死：out.cached 为 true 的那几次，交出的字节必须真的是旧字节。
  const cache = fakeCache();
  const ran = [];
  const deps = { logger: quiet(), counters: { hits: 0, misses: 0 } };
  const texts = ['一つ目。', '二つ目。', '一つ目。', '三つ目。', '二つ目。'];
  const seen = new Map();
  let claimed = 0;
  for (let i = 0; i < texts.length; i++) {
    const out = {};
    const got = await inferWithCache(
      cache, { profile: PROFILE, payload: { text: texts[i] }, cfg: {} },
      inferring(Buffer.from(`AUDIO-${i}`), ran), out, deps,
    );
    if (out.cached) {
      claimed++;
      assert.equal(got.toString(), seen.get(texts[i]),
        `第 ${i} 段自称复用，交出的字节却不是当初存下的那份 —— 这才是"静默错音频"`);
    } else {
      assert.equal(got.toString(), `AUDIO-${i}`, '自称真推，就得交出这次推出来的字节');
      seen.set(texts[i], got.toString());
    }
  }
  assert.equal(claimed, 2, `重复的两段该复用（实际自称复用 ${claimed} 段）`);
  assert.equal(ran.length, 3, `只有 3 段不同的文本，就只该推 3 次（实际 ${ran.length} 次）`);
  assert.equal(deps.counters.hits, claimed, '计数与出参必须一致');
});

function quiet () { return { log () {}, warn () {}, error () {} }; }
