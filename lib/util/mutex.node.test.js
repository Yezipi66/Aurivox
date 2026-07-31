// Unit tests for the async Mutex (lib/util/mutex.js) using the built-in runner:
//     node --test "lib/**/*.node.test.js"
//
// The Mutex is the serialization primitive the whole system leans on — voices.json
// writes go through it, and Point 4's ModelSwitcher is only correct BECAUSE
// synthesis runs serially under a generation mutex. So its guarantees deserve
// their own tests: strict FIFO ordering, mutual exclusion, value pass-through,
// and lock-release-on-throw.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Mutex } = require("./mutex");

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

test("runExclusive returns the callback's resolved value", async () => {
  const m = new Mutex();
  const v = await m.runExclusive(async () => 42);
  assert.equal(v, 42);
});

test("critical sections never overlap (mutual exclusion)", async () => {
  const m = new Mutex();
  let active = 0, maxActive = 0;
  const job = () => m.runExclusive(async () => {
    active++; maxActive = Math.max(maxActive, active);
    await tick(5);          // hold the lock across an await
    active--;
  });
  await Promise.all([job(), job(), job(), job()]);
  assert.equal(maxActive, 1); // at most one holder at any instant
});

test("callbacks run in strict FIFO submission order", async () => {
  const m = new Mutex();
  const order = [];
  // Submit with descending internal delays; ordering must follow SUBMISSION,
  // not completion speed, because each waits for the previous to settle.
  const p1 = m.runExclusive(async () => { await tick(15); order.push(1); });
  const p2 = m.runExclusive(async () => { await tick(1);  order.push(2); });
  const p3 = m.runExclusive(async () => { await tick(1);  order.push(3); });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("a throwing critical section still releases the lock for the next waiter", async () => {
  const m = new Mutex();
  await assert.rejects(m.runExclusive(async () => { throw new Error("boom"); }), /boom/);
  // If the lock leaked, this second acquisition would hang forever.
  const v = await m.runExclusive(async () => "recovered");
  assert.equal(v, "recovered");
});

test("a rejected section does not corrupt ordering of subsequent sections", async () => {
  const m = new Mutex();
  const seen = [];
  const bad = m.runExclusive(async () => { seen.push("a"); throw new Error("x"); }).catch(() => {});
  const good = m.runExclusive(async () => { seen.push("b"); });
  await Promise.all([bad, good]);
  assert.deepEqual(seen, ["a", "b"]);
});

test("synchronous return values (non-async fn) are supported too", async () => {
  const m = new Mutex();
  const v = await m.runExclusive(() => "sync");
  assert.equal(v, "sync");
});
