// 音色唯一标识的单元测试（被测模块 lib/assetId.js），跑在 node 内置测试运行器里。
// 覆盖不碰盘的纯函数部分：slugify 的 Unicode 折叠、isValidId 的合法性判定、
// proposeVoiceId 的确定性预览标识、allocateVoiceId 的避让分配。
// reserve / release / prune 会读写 STAGING_ROOT 下的持久化登记表，不在本文件里测。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const aid = require("./assetId");

// slugify：显示名到 ASCII 标识词干

test("slugify folds CJK / non-ASCII away and yields an empty stem for pure-CJK", () => {
  // 日本語 全部是非 ASCII 字符，折叠后词干为空字符串，由调用方替换成 'voice'。
  assert.equal(aid.slugify("日本語"), "");
});

test("slugify keeps ASCII, strips diacritics, collapses separators, lowercases", () => {
  assert.equal(aid.slugify("Crème Brûlée"), "creme_brulee");
  assert.equal(aid.slugify("My   Voice!!"), "my_voice");
  assert.equal(aid.slugify("__leading-and-trailing__"), "leading-and-trailing");
});

test("slugify caps the stem at 32 chars", () => {
  const s = aid.slugify("a".repeat(100));
  assert.equal(s.length, 32);
});

test("slugify handles null/undefined without throwing", () => {
  assert.equal(aid.slugify(null), "");
  assert.equal(aid.slugify(undefined), "");
});

// isValidId：标识的合法性判定

test("isValidId accepts [a-zA-Z0-9_-]+ and rejects everything else", () => {
  assert.equal(aid.isValidId("voice_ab12-CD"), true);
  assert.equal(aid.isValidId(""), false);
  assert.equal(aid.isValidId("has space"), false);
  assert.equal(aid.isValidId("has/slash"), false);
  assert.equal(aid.isValidId("日本語"), false);
  assert.equal(aid.isValidId(123), false);
  assert.equal(aid.isValidId(null), false);
});

// proposeVoiceId：确定性的预览标识（不占用）

test("proposeVoiceId is deterministic per display name and well-formed", () => {
  const a = aid.proposeVoiceId("Hello World");
  const b = aid.proposeVoiceId("Hello World");
  assert.deepEqual(a, b);                              // 同一个显示名两次结果相同
  assert.equal(a.base, "hello_world");
  assert.match(a.proposed, /^hello_world_[0-9a-f]{6}$/); // 词干加 6 位十六进制后缀
  assert.equal(aid.isValidId(a.proposed), true);
});

test("proposeVoiceId falls back to 'voice' stem for a language-less name", () => {
  const p = aid.proposeVoiceId("日本語");
  assert.equal(p.base, "voice");
  assert.match(p.proposed, /^voice_[0-9a-f]{6}$/);
});

// allocateVoiceId：唯一标识的分配（避让已占用的）

test("allocateVoiceId returns a valid id with the expected stem + suffix shape", () => {
  const id = aid.allocateVoiceId("My Voice", new Set());
  assert.match(id, /^my_voice_[0-9a-f]{6}$/);
  assert.equal(aid.isValidId(id), true);
});

test("allocateVoiceId never returns an id already in the taken set", () => {
  // 先用同一个显示名占掉一批标识，分配器必须全部避开。
  const taken = new Set();
  for (let i = 0; i < 50; i++) taken.add(aid.allocateVoiceId("dup", taken));
  const fresh = aid.allocateVoiceId("dup", taken);
  assert.equal(taken.has(fresh), false);
  assert.match(fresh, /^dup_[0-9a-f]{6}$/);
});

test("allocateVoiceId accepts an array (not just a Set) as the taken collection", () => {
  const id = aid.allocateVoiceId("arr", ["arr_000000"]);
  assert.equal(aid.isValidId(id), true);
});

// shortHash：标识后缀用的短哈希

test("shortHash is stable and honors the requested length", () => {
  assert.equal(aid.shortHash("seed"), aid.shortHash("seed"));
  assert.equal(aid.shortHash("seed", 6).length, 6);
  assert.equal(aid.shortHash("seed", 10).length, 10);
  assert.match(aid.shortHash("seed"), /^[0-9a-f]+$/);
});
