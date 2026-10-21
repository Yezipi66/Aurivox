// Promise 链式的互斥锁：把异步回调排成一列，每个都等前一个结束，返回 fn 的
// 结果，fn 抛错时锁也会释放。

class Mutex {
  // opts.maxPending：允许排队的调用方上限（不含已进入的那一个），0 或不填 = 不限。
  // 队列满时 runExclusive() 同步抛错，错误码是 "GENERATION_QUEUE_FULL"，
  // 调用方据此回 HTTP 503 + Retry-After，而不是把无界的活堆在一台引擎后面。
  constructor(opts = {}) {
    this._tail = Promise.resolve();
    const mp = opts && Number.isInteger(opts.maxPending) ? opts.maxPending : 0;
    this._maxPending = mp > 0 ? mp : 0; // 0 = 不限
    this._pending = 0;                  // 等锁的调用方数（不含已进入的那个）
  }

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
      this._pending--; // 现在是持锁者，不再排队
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

module.exports = { Mutex };
