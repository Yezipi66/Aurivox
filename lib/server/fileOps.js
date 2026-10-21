'use strict'
//  文件操作工具。
//  职责：目录校验、检查点挑选、健壮目录重命名、断电恢复扫描。
//  从 server.js 逐字搬来，不改逻辑。

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// 从 checkpoint 列表里挑"训练量最大"的那个（避免字母序选到 e5/e4 这种最弱模型）
function pickBestCkpt(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const score = (item) => {
    if (typeof item.steps === 'number') return item.steps;           // GPT: assetScanner 已解析
    const name = item.name || item.path || '';
    const s = name.match(/_s(\d+)/);   if (s) return parseInt(s[1], 10);  // SoVITS: _s288
    const e = name.match(/[-_]e(\d+)/); if (e) return parseInt(e[1], 10);  // 退而用 epoch
    return 0;
  };
  return list.slice().sort((a, b) => score(a) - score(b)).pop();
}

// Recursively verify that every file under `src` exists under `dst` with an
// identical byte size (integrity check for the copy→verify→delete move flow).
async function firstMismatch(src, dst, rel = "") {
  let sStat;
  try { sStat = await fsp.lstat(src); } catch (e) { return rel || src; }
  let dStat;
  try { dStat = await fsp.lstat(dst); } catch (e) { return rel || path.basename(src); }
  if (sStat.isDirectory()) {
    if (!dStat.isDirectory()) return rel || path.basename(src);
    const entries = await fsp.readdir(src);
    for (const name of entries) {
      const bad = await firstMismatch(path.join(src, name), path.join(dst, name), rel ? `${rel}/${name}` : name);
      if (bad) return bad;
    }
    return null;
  }
  // regular file (or symlink): sizes must match
  if (sStat.size !== dStat.size) return rel || path.basename(src);
  return null;
}

// Windows file locks make a directory rename fail with these transient codes.
const RENAME_LOCK_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);
function sleepSyncMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}
function renameDirWithRetry(src, dst, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(src, dst); return; }
    catch (e) {
      lastErr = e;
      if (!RENAME_LOCK_CODES.has(e.code)) throw e; // EXDEV / ENOENT / etc — fail fast
      sleepSyncMs(200 * Math.pow(2, i));           // 200/400/800/1600/3200ms
    }
  }
  throw lastErr;
}

// Robust voice-folder rename. Fast path is an atomic whole-directory rename.
// If that is blocked by a lock on the CONTAINER directory, fall back to creating
// the new folder and MOVING each entry individually.
function renameVoiceFolder(oldDir, newDir) {
  try {
    renameDirWithRetry(oldDir, newDir);
    return { mode: "atomic", locked: [] };
  } catch (e) {
    if (e.code === "EXDEV") throw e;                 // caller handles cross-device
    if (!RENAME_LOCK_CODES.has(e.code)) throw e;     // genuine error — propagate
  }
  // --- per-file fallback ---
  fs.mkdirSync(newDir, { recursive: true });
  const locked = [];
  const moveEntry = (name) => {
    const from = path.join(oldDir, name);
    const to = path.join(newDir, name);
    for (let i = 0; i < 4; i++) {
      try { fs.renameSync(from, to); return true; }
      catch (err) {
        if (!RENAME_LOCK_CODES.has(err.code)) throw err;
        sleepSyncMs(150 * Math.pow(2, i));
      }
    }
    // Last resort: copy then best-effort delete (leaves original if still locked).
    try {
      fs.cpSync(from, to, { recursive: true, force: true });
      try { fs.rmSync(from, { recursive: true, force: true }); } catch (_) {}
      return true;
    } catch (_) { locked.push(name); return false; }
  };
  for (const entry of fs.readdirSync(oldDir)) moveEntry(entry);
  // Try to remove the now-(hopefully)-empty old container.
  try { fs.rmdirSync(oldDir); } catch (_) { /* left behind if still locked/nonempty */ }
  return { mode: "per-file", locked };
}

// ---- 断电恢复：扫描暂存目录中的未完成任务 ----
function scanStagingTasks({ STAGING_ROOT, console }) {
  if (!fs.existsSync(STAGING_ROOT)) return;
  try {
    const entries = fs.readdirSync(STAGING_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskJson = path.join(STAGING_ROOT, entry.name, 'task.json');
      if (!fs.existsSync(taskJson)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(taskJson, 'utf-8'));
        if (data.status === 'running' || data.status === 'pending') {
          data.status = 'interrupted';
          data.finishedAt = new Date().toISOString();
          fs.writeFileSync(taskJson, JSON.stringify(data, null, 2), 'utf-8');
          console.log(`[RECOVERY] task ${data.id} (${data.voiceId}) marked as interrupted`);
        }
      } catch (e) {
        // ignore corrupt task.json
      }
    }
  } catch (e) {
    console.error('[RECOVERY] failed to scan staging directory:', e.message);
  }
}

module.exports = {
  pickBestCkpt,
  firstMismatch,
  RENAME_LOCK_CODES,
  sleepSyncMs,
  renameDirWithRetry,
  renameVoiceFolder,
  scanStagingTasks,
};
