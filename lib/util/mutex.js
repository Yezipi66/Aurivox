// ===========================
//  ASYNC MUTEX
// ===========================
// A minimal promise-chain mutex — behaviourally identical to the ad-hoc
// `let _lock = Promise.resolve(); async function withLock(fn){...}` pattern that
// previously lived as two module-level `let`s in server.js (Stage-2 refactor).
// Serialises async callbacks: each waits for the previous to settle, the result
// of `fn` is returned, and the lock is released even if `fn` throws.

class Mutex {
  // opts.maxPending: max callers allowed to WAIT in the queue (excludes the one
  // currently running). 0 / omitted = unbounded (original behaviour). When the
  // queue is full, runExclusive() throws SYNCHRONOUSLY with code
  // "GENERATION_QUEUE_FULL" so the caller can map it to HTTP 503 + Retry-After
  // instead of piling unbounded work behind a single-GPU engine (A-2).
  constructor(opts = {}) {
    this._tail = Promise.resolve();
    const mp = opts && Number.isInteger(opts.maxPending) ? opts.maxPending : 0;
    this._maxPending = mp > 0 ? mp : 0; // 0 = unbounded
    this._pending = 0;                  // callers waiting for the lock (not the runner)
  }

  // Callers currently queued waiting for the lock (excludes the running holder).
  get pending() { return this._pending; }

  async runExclusive(fn) {
    if (this._maxPending && this._pending >= this._maxPending) {
      const err = new Error(`generation queue full (${this._pending}/${this._maxPending})`);
      err.code = "GENERATION_QUEUE_FULL";
      err.pending = this._pending;
      err.maxPending = this._maxPending;
      throw err;
    }
    const prev = this._tail;
    let release;
    this._tail = new Promise((r) => { release = r; });
    this._pending++;
    try {
      await prev;
    } finally {
      this._pending--; // we are now the running holder, no longer queued
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

module.exports = { Mutex };
