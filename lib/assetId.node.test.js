// Unit tests for canonical voice-ID logic (lib/assetId.js) via the built-in
// runner. Covers the PURE, fs-free surface: slugify (Unicode/CJK folding),
// isValidId, deterministic preview ids, and collision-avoiding allocation.
// (reserve/release/prune touch a persisted registry under STAGING_ROOT and are
// intentionally left to the black-box/integration layer.)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const aid = require("./assetId");

// ---- slugify ----

test("slugify folds CJK / non-ASCII away and yields an empty stem for pure-CJK", () => {
  // 日本語 -> all non-ASCII collapse to a trimmed '' (caller substitutes 'voice').
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

// ---- isValidId ----

test("isValidId accepts [a-zA-Z0-9_-]+ and rejects everything else", () => {
  assert.equal(aid.isValidId("voice_ab12-CD"), true);
  assert.equal(aid.isValidId(""), false);
  assert.equal(aid.isValidId("has space"), false);
  assert.equal(aid.isValidId("has/slash"), false);
  assert.equal(aid.isValidId("日本語"), false);
  assert.equal(aid.isValidId(123), false);
  assert.equal(aid.isValidId(null), false);
});

// ---- proposeVoiceId (deterministic preview) ----

test("proposeVoiceId is deterministic per display name and well-formed", () => {
  const a = aid.proposeVoiceId("Hello World");
  const b = aid.proposeVoiceId("Hello World");
  assert.deepEqual(a, b);                              // stable
  assert.equal(a.base, "hello_world");
  assert.match(a.proposed, /^hello_world_[0-9a-f]{6}$/); // stem + 6-hex suffix
  assert.equal(aid.isValidId(a.proposed), true);
});

test("proposeVoiceId falls back to 'voice' stem for a language-less name", () => {
  const p = aid.proposeVoiceId("日本語");
  assert.equal(p.base, "voice");
  assert.match(p.proposed, /^voice_[0-9a-f]{6}$/);
});

// ---- allocateVoiceId (unique, collision-avoiding) ----

test("allocateVoiceId returns a valid id with the expected stem + suffix shape", () => {
  const id = aid.allocateVoiceId("My Voice", new Set());
  assert.match(id, /^my_voice_[0-9a-f]{6}$/);
  assert.equal(aid.isValidId(id), true);
});

test("allocateVoiceId never returns an id already in the taken set", () => {
  // Pre-seed the taken set with many plausible ids; the allocator must dodge them.
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

// ---- shortHash ----

test("shortHash is stable and honors the requested length", () => {
  assert.equal(aid.shortHash("seed"), aid.shortHash("seed"));
  assert.equal(aid.shortHash("seed", 6).length, 6);
  assert.equal(aid.shortHash("seed", 10).length, 10);
  assert.match(aid.shortHash("seed"), /^[0-9a-f]+$/);
});
