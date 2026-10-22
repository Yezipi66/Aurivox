'use strict'
// 文件与目录的底层操作：检查点挑选、目录重命名、复制完整性核对、暂存目录恢复扫描。
// 纯 Node API 调用，不含业务判断；调用方（server.js 的 ctx）注入路径与控制台。

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// 从 checkpoint 列表里挑训练量最大的那个。排序键按优先级取：steps 字段、文件名里的
// _s<数字>（步数）、文件名里的 [-_]e<数字>（epoch）。
// 不按字母序选：e5 排在 e10 前面会挑到最弱的那一份。
function pickBestCkpt(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const score = (item) => {
    if (typeof item.steps === 'number') return item.steps;           // assetScanner 已解析
    const name = item.name || item.path || '';
    const s = name.match(/_s(\d+)/);   if (s) return parseInt(s[1], 10);  // 文件名里的 _s<数字>，如 _s288
    const e = name.match(/[-_]e(\d+)/); if (e) return parseInt(e[1], 10);  // 退而用 epoch
    return 0;
  };
  return list.slice().sort((a, b) => score(a) - score(b)).pop();
}

// 递归核对 src 下的每个文件在 dst 下都存在且字节数相同。
// 供「先复制、再核对、最后删除」的迁移流程用：返回第一个不一致的相对路径，
// 全部一致时返回 null。
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
  // 普通文件（或符号链接）：字节数必须一致
  if (sStat.size !== dStat.size) return rel || path.basename(src);
  return null;
}

// Windows 上文件被占用时目录改名会失败，这几个错误码是可重试的。
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
      if (!RENAME_LOCK_CODES.has(e.code)) throw e; // 跨设备、路径不存在等错误：立即失败，不重试
      sleepSyncMs(200 * Math.pow(2, i));           // 200/400/800/1600/3200ms
    }
  }
  throw lastErr;
}

// 改音色目录名。先试整目录改名（一次操作，原子）；
// 容器目录被占用而改不动时，退回逐个搬里面的条目。
function renameVoiceFolder(oldDir, newDir) {
  try {
    renameDirWithRetry(oldDir, newDir);
    return { mode: "atomic", locked: [] };
  } catch (e) {
    if (e.code === "EXDEV") throw e;                 // 调用方自己处理跨设备
    if (!RENAME_LOCK_CODES.has(e.code)) throw e;     // 真实错误，往上抛
  }
  // 逐个文件搬
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
    // 最后手段：先复制再尽力删除（仍被占用时原件留在原地）。
    try {
      fs.cpSync(from, to, { recursive: true, force: true });
      try { fs.rmSync(from, { recursive: true, force: true }); } catch (_) {}
      return true;
    } catch (_) { locked.push(name); return false; }
  };
  for (const entry of fs.readdirSync(oldDir)) moveEntry(entry);
  // 试着删掉现在应该已空的旧容器目录。
  try { fs.rmdirSync(oldDir); } catch (_) { /* 仍被占用或非空时留着 */ }
  return { mode: "per-file", locked };
}

// 断电恢复：把暂存目录里状态仍是 running 或 pending 的任务标记为 interrupted。
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
        // task.json 坏了就跳过这一条，不影响其它任务。
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
