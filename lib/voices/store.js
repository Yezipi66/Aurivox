//  VOICES STORE
// Encapsulates voices.json read/write, the write mutex, and rotating backups.
// `load()`/`save()` are bare file I/O; all writes must be bracketed by
// `withLock()` so concurrent callers cannot interleave a read-modify-write.
// `backup()` acquires the lock itself; `_backupUnlocked()` assumes it is held.

const fs = require("fs");
const path = require("path");
const { Mutex } = require("../util/mutex");

class VoicesStore {
  constructor({ voicesJson, backupDir, maxBackups = 20 }) {
    this.voicesJson = voicesJson;
    this.backupDir = backupDir;
    this.maxBackups = maxBackups;
    this._mutex = new Mutex();
  }

  load() {
    try { return JSON.parse(fs.readFileSync(this.voicesJson, "utf-8")); }
    catch (e) { return {}; }
  }

  save(data) {
    fs.writeFileSync(this.voicesJson, JSON.stringify(data, null, 2), "utf-8");
  }

  // Serialise writers.
  withLock(fn) {
    return this._mutex.runExclusive(fn);
  }

  // Backup logic. ASSUMPTION: caller already holds withLock.
  async _backupUnlocked() {
    if (!fs.existsSync(this.voicesJson)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const name = `voices.${ts}.json`;
    const dest = path.join(this.backupDir, name);
    fs.copyFileSync(this.voicesJson, dest);
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.match(/^voices\.\d{15}\.json$/))
        .sort();
      while (files.length > this.maxBackups) {
        const old = files.shift();
        fs.unlinkSync(path.join(this.backupDir, old));
      }
    } catch {}
    return name;
  }

  backup() {
    return this.withLock(async () => this._backupUnlocked());
  }
}

module.exports = { VoicesStore };
