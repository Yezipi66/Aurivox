// ===========================
//  ASYNC MUTEX
// ===========================
// A minimal promise-chain mutex — behaviourally identical to the ad-hoc
// `let _lock = Promise.resolve(); async function withLock(fn){...}` pattern that
// previously lived as two module-level `let`s in server.js (Stage-2 refactor).
// Serialises async callbacks: each waits for the previous to settle, the result
// of `fn` is returned, and the lock is released even if `fn` throws.

class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  async runExclusive(fn) {
    const prev = this._tail;
    let release;
    this._tail = new Promise((r) => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

module.exports = { Mutex };
