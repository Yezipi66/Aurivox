'use strict';

// ---------------------------------------------------------------------------
//  刀 A2 的另一半验收：训练管线的身份只许有**一处**声明
// ---------------------------------------------------------------------------
//
// A2 取证后把 15 处写死的 `"gpt-sovits"` 分成两类：
//   · 合成路径 ⇒ 从名片读（`lib/assets/slotPicks.js` + 它的测试）
//   · 训练管线 ⇒ 收进 `pipelineIdentity.js` 这**一处**声明，其余全是引用
//
// 下面守的是第二类：⛔ 不许再长出第二个来源。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { TRAINING_ENGINE_ID, TRAINING_SLOTS } = require('./pipelineIdentity');

const REPO = path.join(__dirname, '..', '..');

test('⭐⭐⭐ 管线声明的引擎 id 必须真有一张名片认领', () => {
  const manifest = path.join(REPO, 'engines', TRAINING_ENGINE_ID, 'manifest.json');
  assert.ok(fs.existsSync(manifest),
    `训练产物会落进 assets/<角色>/models/${TRAINING_ENGINE_ID}/，`
    + '但没有任何一台引擎叫这个名字 ⇒ 界面上"有模型"、合成时"找不到"');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
  assert.strictEqual(m.id, TRAINING_ENGINE_ID);
});

test('⭐⭐ 管线的两个权重位必须都在那张名片的 weights 里声明过', () => {
  const m = JSON.parse(fs.readFileSync(
    path.join(REPO, 'engines', TRAINING_ENGINE_ID, 'manifest.json'), 'utf-8'));
  // ⚠ 名片里 `weights` 是**数组**（每项一个位），⛔ 不是对象。
  //   写这条测试时我先按对象取键，拿到的是 ["0","1"] —— 一条只在
  //   "恰好长度对得上"时才会绿的假守卫。取证：manifest.json:110-113。
  assert.ok(Array.isArray(m.weights), '名片的 weights 必须是数组');
  const declared = m.weights.map(w => w && w.name);
  assert.ok(declared.length > 0, '名片一个权重位都没写');
  for (const s of Object.values(TRAINING_SLOTS)) {
    assert.ok(declared.includes(s.name),
      `管线会往 ${s.name}/ 里放东西，但名片没声明这个位 ⇒ `
      + 'slotResolve 只认名片声明的位，训出来的东西扫得到、归不了位');
  }
});

test('两个位的后缀就是训练产物的后缀（S1=.ckpt / S2=.pth）', () => {
  assert.strictEqual(TRAINING_SLOTS.gpt.ext, '.ckpt');
  assert.strictEqual(TRAINING_SLOTS.sovits.ext, '.pth');
});

test('⛔ 常量是冻结的 —— 不许运行期被改（那会让"唯一声明"变成谎话）', () => {
  assert.throws(() => { TRAINING_SLOTS.gpt.name = 'x'; }, /read.only|Cannot assign/i);
});

// ---------------------------------------------------------------------------
//  ⭐⭐⭐ A2 的总归零判据
// ---------------------------------------------------------------------------

/** 递归收集 lib/ 下的 .js（跳过测试与 node_modules），外加 server.js。 */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
    }
  };
  walk(path.join(REPO, 'lib'));
  out.push(path.join(REPO, 'server.js'));
  return out;
}

/**
 * ⭐ 白名单 —— 每一条都必须写清"它回答的是哪个问题"。
 * ⛔ 往这张表里加一行之前，先回答：这一处在回答「用户想用哪台」吗？
 *    是 ⇒ 那是 bug，去改代码，⛔ 不是加白名单。
 */
const ALLOWED = new Map([
  // 唯一的主张点。A2 的全部收敛都指向这里。
  ['lib/training/pipelineIdentity.js', '训练管线身份的唯一声明'],
  // 下面这些回答的是「GSV 这台引擎的源码/底模装在哪」，不是「模型位叫什么」。
  // ⇒ 归刀 A4（infer_server.py 迁出 lib/），⛔ 不是 A2 的地盘。见 §12.10 台账。
  ['lib/paths.js', 'GSV 私有安装路径（GSV_DIR / GSV_PRETRAINED_DIR）⇒ 归 A4'],
  ['server.js', 'registerBaseModelSource：GSV 底模目录形状怪，登记一条 ⇒ 归 A4'],
]);

test('⭐⭐⭐ A2 归零判据：lib/ + server.js 里写死的引擎名只剩白名单那几处', () => {
  const stray = [];
  for (const f of sources()) {
    const rel = path.relative(REPO, f).replace(/\\/g, '/');
    if (ALLOWED.has(rel)) continue;
    const lines = fs.readFileSync(f, 'utf-8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;                 // 整行注释放行
      if (/["']gpt-sovits["']|["']gpt_sovits["']/.test(l)) {
        stray.push(`${rel}:${i + 1}  ${l.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(stray, [],
    '这些地方还在自己主张"默认引擎是 gpt-sovits"：\n' + stray.join('\n'));
});

test('⭐ 白名单里的每一条都必须真的还存在（⛔ 不许养僵尸豁免）', () => {
  for (const rel of ALLOWED.keys()) {
    assert.ok(fs.existsSync(path.join(REPO, rel)), `白名单指向一个不存在的文件：${rel}`);
    const src = fs.readFileSync(path.join(REPO, rel), 'utf-8');
    assert.ok(/["']gpt-sovits["']/.test(src),
      `${rel} 已经不写引擎名了 ⇒ 把它从白名单删掉，别让豁免继续挂着`);
  }
});
