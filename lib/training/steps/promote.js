/**
 * Step 7: 发布入库 (Promote)
 *
 * 将 finalize 产出的 _publish/ 目录原子发布到 assets/{voiceId}/。
 * 若目标已存在，先备份为 {voiceId}.bak.{ts}，发布成功后再删备份。
 * 发布失败时回滚备份。
 * 发布成功后注册到 voices.json。
 */
const path = require('path');
const fs = require('fs');
const assetScanner = require('../../assetScanner');

// voices.json 注册路径：steps → training → lib → 项目根（与 server.js 的 <根>/voices.json 对齐，三级上港）
const VOICES_JSON = path.resolve(__dirname, '..', '..', '..', 'voices.json');

function loadVoices() {
  try { return JSON.parse(fs.readFileSync(VOICES_JSON, 'utf-8')); }
  catch (e) { return {}; }
}

function saveVoices(data) {
  const tmp = VOICES_JSON + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, VOICES_JSON);
}

// Synchronous sleep (no busy-loop) — used only for the short lock-retry backoff.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable — skip the wait */ }
}

// Windows file locks (model loaded in the inference server, file watcher, AV,
// indexer) make directory rename fail with these transient codes. Retry a few
// times with exponential backoff before giving up.
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

function renameWithRetry(src, dst, log, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(src, dst); return; }
    catch (e) {
      lastErr = e;
      if (e.code === 'EXDEV') throw e;              // cross-device — caller handles
      if (!LOCK_CODES.has(e.code)) throw e;         // not a lock — fail fast
      const wait = 200 * Math.pow(2, i);            // 200/400/800/1600/3200ms
      if (log) log(`  Directory busy (${e.code}); retrying in ${wait}ms (${i + 1}/${attempts})…`);
      sleepSync(wait);
    }
  }
  throw lastErr;
}

async function run(ctx, log) {
  const { workDir, publishDir, voiceId, language } = ctx;
  const srcDir = path.join(workDir, '_publish');

  log(`Publishing: ${voiceId}`);

  if (!fs.existsSync(srcDir)) {
    throw new Error(`_publish/ dir not found: ${srcDir} (finalize may have failed)`);
  }

  // 检查源目录是否为空（至少要有 meta.json）
  const srcFiles = fs.readdirSync(srcDir);
  if (srcFiles.length === 0) {
    throw new Error(`_publish/ dir is empty; refusing to publish`);
  }

  // 读取 _publish/meta.json 获取 display_name 等信息
  let meta = {};
  const metaPath = path.join(srcDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
  }

  // 确保父目录存在（修首次训练 ENOENT）
  fs.mkdirSync(path.dirname(publishDir), { recursive: true });

  // 若目标已存在，先备份（renameWithRetry 处理 Windows 瞬时锁）。
  // 若旧目录始终被占用（模型已加载/监视/杀软）无法移动，退回“就地覆盖”发布：
  // 不移动被锁目录，直接把 finalize 产出的完整内容覆盖进去（force overwrite，
  // 保留旧目录中未被覆盖的文件），从而彻底规避整目录 rename 的 EPERM。
  let backupDir = null;
  let copyInPlace = false;
  if (fs.existsSync(publishDir)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupDir = `${publishDir}.bak.${ts}`;
    try {
      log(`  Backing up old dir → ${path.basename(backupDir)}`);
      renameWithRetry(publishDir, backupDir, log);
    } catch (e) {
      backupDir = null;
      copyInPlace = true;
      log(`  Old dir cannot be moved (${e.code}); using in-place overwrite publish (not moving the locked dir)`);
    }
  }

  try {
    if (copyInPlace) {
      // finalize 的 _publish 已结转全部产物（模型/参考/切片等），就地覆盖即得到
      // 相同的最终状态，无需移动被锁定的目录。
      fs.cpSync(srcDir, publishDir, { recursive: true, force: true });
      try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      log(`  Published in place → ${publishDir}`);
    } else {
      // 原子发布：同盘 rename 是原子操作；瞬时锁重试，跨盘 EXDEV 兜底。
      try {
        renameWithRetry(srcDir, publishDir, log);
      } catch (e) {
        if (e.code === 'EXDEV') {
          fs.cpSync(srcDir, publishDir, { recursive: true });
          fs.rmSync(srcDir, { recursive: true, force: true });
        } else throw e;
      }
      log(`  Published → ${publishDir}`);

      // 发布成功 → 删除备份
      if (backupDir && fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
        log(`  Cleaned up backup`);
      }
    }

    // 注册到 voices.json（仅 4 个字段，对齐 DECOUPLING_TASKS Step 2）
    // 修正 meta.json 里的 checkpoint 路径：finalize 在 .staging/_publish 上扫描,
    // 路径钉在临时目录; 移到 assets/{voiceId}/ 后重扫一次, 只替换 assets 字段。
    try {
      const fresh = assetScanner.scanVoiceDir(voiceId, publishDir);
      const metaFinalPath = path.join(publishDir, 'meta.json');
      let mergedMeta = fresh;
      if (fs.existsSync(metaFinalPath)) {
        const old = JSON.parse(fs.readFileSync(metaFinalPath, 'utf-8'));
        mergedMeta = { ...old, assets: (fresh && fresh.assets) ? fresh.assets : (old.assets || {}) };
      }
      fs.writeFileSync(metaFinalPath, JSON.stringify(mergedMeta, null, 2));
      log(`  Rewrote meta.json checkpoint paths → assets/${voiceId}/`);
    } catch (rescanErr) {
      log(`  Failed to rescan meta.json (ignored): ${rescanErr.message}`);
    }

    // task3.2: 发布后立即重建 segments.json（等同单资产 Scan）。finalize 拷进来的
    // segments.json 路径还钉在 staging 旧目录，不重建的话 /api/assets/:id/segments
    // 按 slicer_opt/<file> 校验会全部 miss → 前端显示 No segments，逗用户手动 Scan All。
    try {
      const segResult = assetScanner.generateSegments(voiceId);
      if (segResult && segResult.ok === false) {
        log(`  Warning: cannot rebuild segments (${segResult.error})`);
      } else if (segResult && typeof segResult.matched === 'number') {
        log(`  Rebuilt segments.json: ${segResult.matched}/${segResult.total} matched`);
      } else {
        log(`  No transcript list found; skipping segments rebuild`);
      }
    } catch (segErr) {
      log(`  Failed to rebuild segments.json (ignored): ${segErr.message}`);
    }

    try {
      const voices = loadVoices();
      const lang = language || meta.language || 'ja';
      voices[voiceId] = {
        display_name: meta.display_name || voiceId,
        language: lang,
        prompt_lang: lang,
        text_lang: lang,
      };
      saveVoices(voices);
      log(`  Registered to voices.json`);
    } catch (regErr) {
      log(`  Failed to register voices.json (ignored): ${regErr.message}`);
    }

    // 清理整个暂存目录（包括中间件）
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
        log(`  Cleaned up staging dir`);
      }
    } catch (e) {
      log(`  Failed to clean up staging dir (ignored): ${e.message}`);
    }

    log(`Publish complete: ${voiceId}`);
    return { published: true, path: publishDir };

  } catch (err) {
    // 发布失败 → 回滚备份（仅当备份存在且目标未被新内容占据时）
    if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(publishDir)) {
      try {
        renameWithRetry(backupDir, publishDir, log);
        log(`  Rollback succeeded: old dir restored`);
      } catch (rbErr) {
        log(`  Rollback FAILED (critical): ${rbErr.message} — backup at ${backupDir}`);
      }
    }
    throw new Error(`Publish failed: ${err.message}`);
  }
}

module.exports = { run };
