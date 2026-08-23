'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAdvancedParamsStore } = require('./advancedParams');

// ============================================================
//  advanced_params.json 是「界面记忆」，不是「默认值表」
// ============================================================
//
// ⛔⛔ 这一整个文件是拿一个**真 bug** 换来的。
//
// 2026-08-23 把 save 从合并改成替换 —— 一个货真价实的行为变更 —— 全量 661 条
// 测试**一条没红**。原因是这三个函数当时住在 server.js 里，而 server.js 一被
// require 就 listen，根本进不了测试进程。于是盘上这份文件的行为**从来没有人守**。
//
// 那条没人守的合并语义干了什么：因为 save 是 { ...load(), ...params }，而 load
// 是 { ...名片默认值, ...盘上文件 }，所以**每存一次就把当时的名片默认值全量
// 拓印到盘上**；下次 load 时盘上那份又赢过名片。真机上的结果是 C11 刚裁定的
// batch_size=4 被一个用户从没碰过的、拓印上去的 1 永久压住。
//
// ⇒ 下面每一条都必须在把 save 改回合并、或把 load 的优先级倒过来时变红。

function withStore(run, { onDisk = null, engineDefaults } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advparams-'));
  // ⭐ 刻意不用盘上那个真名：路径权威只在 lib/paths.js（paths.node.test.js 守着），
  //   而这个 store 本来就接受任意路径 —— 它不认识自己存在哪个文件里。
  const file = path.join(dir, 'ui-memory-fixture.json');
  if (onDisk) fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf-8');
  const store = createAdvancedParamsStore({
    file,
    engineDefaults: engineDefaults || (() => ({ knob_a: 4, knob_b: 15, knob_c: 'cut5' })),
    launchDefaults: { launch_x: 'v2Pro' },
    logger: { error() {} },
  });
  try {
    return run({ store, file, read: () => JSON.parse(fs.readFileSync(file, 'utf-8')) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('没有盘上文件时，每一个值都来自名片', () => {
  withStore(({ store }) => {
    const got = store.load();
    assert.strictEqual(got.knob_a, 4);
    assert.strictEqual(got.knob_b, 15);
    assert.strictEqual(got.knob_c, 'cut5');
  });
});

test('用户在界面上拧过的值，赢过名片默认值', () => {
  // 「记忆」这个功能本身不能被这一刀弄坏 —— 收窄的是**存什么**，不是**谁赢**。
  withStore(({ store }) => {
    assert.strictEqual(store.load().knob_b, 20);
    assert.strictEqual(store.load().knob_a, 4, '没拧过的键仍然来自名片');
  }, { onDisk: { knob_b: 20 } });
});

test('保存只留下本次提交的键 —— 不把名片默认值拓印到盘上', () => {
  // ⭐ 这是本刀的核心。改回 { ...load(), ...params } 会让盘上多出 knob_a /
  //   knob_c / launch_x，这一条立刻红。
  withStore(({ store, read }) => {
    store.save({ knob_b: 20 });
    const onDisk = read();
    assert.deepStrictEqual(
      Object.keys(onDisk).sort(),
      ['knob_b', 'updated_at'],
      '盘上应当只有用户真的拧过的键，外加一个时间戳',
    );
  });
});

test('保存会清掉盘上那些只写不读的陈年键（自愈）', () => {
  // 真机上那份文件写了 18 个键、前端只读得回 7 个。剩下 11 个是纯粹的历史沉积，
  // 而它们正是盖住名片默认值的那些。第一次保存后就该消失。
  withStore(({ store, read }) => {
    store.save({ knob_b: 20 });
    const onDisk = read();
    assert.ok(!('knob_a' in onDisk), '陈年的 knob_a 应当已被清掉');
    assert.ok(!('launch_x' in onDisk), '启动期设置不该沉积在界面记忆文件里');
  }, { onDisk: { knob_a: 1, knob_b: 20, knob_c: 'cut0', launch_x: 'v2', stale_key: true } });
});

test('清掉之后，那个键当场退回名片的值 —— batch_size=4 那件事', () => {
  // ⭐⭐ 收益证明，端到端走一遍：
  //   盘上有一个用户从没碰过、被合并语义拓印上去的 knob_a=1（真机上就是
  //   batch_size），它压住了名片的 4。用户在界面上拧了别的键并保存之后，
  //   knob_a 从盘上消失 ⇒ 下一次 load 拿到的是名片的 4。
  withStore(({ store }) => {
    assert.strictEqual(store.load().knob_a, 1, '改之前：陈年快照压住名片');
    store.save({ knob_b: 20 });
    assert.strictEqual(store.load().knob_a, 4, '改之后：退回名片，C11 的默认值真正生效');
  }, { onDisk: { knob_a: 1, knob_b: 20 } });
});

test('名片默认值是运行时事实，不是进程启动那一瞬间的快照', () => {
  // ⛔ engineDefaults 必须是函数并且每次调用 —— 装了哪些引擎、环境变量拧到几，
  //   都可能在进程活着的时候变。缓存成常量就是又制造一份会漂的副本。
  let n = 0;
  withStore(({ store }) => {
    assert.strictEqual(store.load().knob_a, 1);
    assert.strictEqual(store.load().knob_a, 2, '第二次读取应当看到新的运行时事实');
  }, { engineDefaults: () => ({ knob_a: ++n }) });
});

test('坏掉的盘上文件不会拖垮合成，只是退回名片', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advparams-'));
  const file = path.join(dir, 'ui-memory-fixture.json');
  fs.writeFileSync(file, '{ this is not json', 'utf-8');
  const errors = [];
  const store = createAdvancedParamsStore({
    file,
    engineDefaults: () => ({ knob_a: 4 }),
    logger: { error: (...a) => errors.push(a.join(' ')) },
  });
  assert.strictEqual(store.load().knob_a, 4);
  assert.strictEqual(errors.length, 1, '坏文件要留下一条日志，不能静默');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('保存盖时间戳，并把它一起交回给调用方', () => {
  withStore(({ store, read }) => {
    const before = new Date().toISOString();
    const returned = store.save({ knob_b: 20 });
    assert.strictEqual(returned.knob_b, 20);
    assert.ok(returned.updated_at >= before);
    assert.deepStrictEqual(read(), returned, '交回的和写到盘上的必须是同一份');
  });
});

test('这个模块不认识任何一个引擎参数的名字（契约 C11）', () => {
  // ⛔ 它只搬运键值对。哪天有人在这里写一张「允许持久化的键名清单」，
  //   那就又是一份会漂的参数表 —— 正是 C11 要禁的东西。
  const src = fs.readFileSync(path.join(__dirname, 'advancedParams.js'), 'utf-8');
  const code = src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');
  for (const forbidden of ['batch_size', 'temperature', 'top_k', 'top_p', 'text_split_method', 'streaming_mode']) {
    assert.ok(!code.includes(forbidden), `代码里不该出现引擎参数名：${forbidden}`);
  }
});
