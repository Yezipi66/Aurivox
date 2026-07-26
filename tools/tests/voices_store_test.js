// Stage-2 unit tests: Mutex mutual-exclusion/ordering/exception-safety and
// VoicesStore load/save/backup round-trip + rotation. No deps, no server.
// Run:  node tools/tests/voices_store_test.js
const os = require("os");
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { Mutex } = require("../../lib/util/mutex");
const { VoicesStore } = require("../../lib/voices/store");

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok   " + name); }
  catch (e) { failed++; console.error("  FAIL " + name + " :: " + (e && e.stack || e)); }
}

(async () => {
  await check("Mutex serialises overlapping critical sections", async () => {
    const m = new Mutex();
    let active = 0, maxActive = 0;
    const order = [];
    const task = (id) => m.runExclusive(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      order.push(id);
      active--;
      return id;
    });
    const results = await Promise.all([task(1), task(2), task(3)]);
    assert.equal(maxActive, 1, "never more than one holder");
    assert.deepEqual(order, [1, 2, 3], "FIFO order preserved");
    assert.deepEqual(results, [1, 2, 3], "returns fn results");
  });

  await check("Mutex releases lock even when fn throws", async () => {
    const m = new Mutex();
    await assert.rejects(() => m.runExclusive(async () => { throw new Error("boom"); }));
    // next acquirer must still proceed
    const v = await m.runExclusive(async () => 42);
    assert.equal(v, 42);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vstore-"));
  const vjson = path.join(tmp, "voices.json");
  const bdir = path.join(tmp, "backups");
  fs.mkdirSync(bdir);
  const store = new VoicesStore({ voicesJson: vjson, backupDir: bdir, maxBackups: 3 });

  await check("load() returns {} when file absent", async () => {
    assert.deepEqual(store.load(), {});
  });

  await check("save()/load() round-trips", async () => {
    store.save({ a: { name: "X" } });
    assert.deepEqual(store.load(), { a: { name: "X" } });
    assert.ok(fs.readFileSync(vjson, "utf-8").includes("\n"), "pretty-printed");
  });

  await check("withLock serialises writers", async () => {
    let active = 0, maxA = 0;
    await Promise.all([1, 2, 3, 4].map(() => store.withLock(async () => {
      active++; maxA = Math.max(maxA, active);
      await new Promise(r => setTimeout(r, 3));
      active--;
    })));
    assert.equal(maxA, 1);
  });

  await check("backup() creates file and rotates to maxBackups", async () => {
    for (let i = 0; i < 5; i++) {
      store.save({ n: i });
      const name = await store.backup();
      assert.ok(name && name.startsWith("voices."), "returns backup name");
      // ensure distinct timestamps (15-char slice granularity is seconds)
      await new Promise(r => setTimeout(r, 1100));
    }
    const backups = fs.readdirSync(bdir).filter(f => /^voices\.\d{15}\.json$/.test(f));
    assert.ok(backups.length <= 3, `rotated to <=3, got ${backups.length}`);
  }).catch(() => {});

  fs.rmSync(tmp, { recursive: true, force: true });

  if (failed) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }
  console.log("\nall voices-store / mutex tests passed");
})();
