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

// voices.json 注册路径（相对于项目根）
const VOICES_JSON = path.resolve(__dirname, '..', '..', 'voices.json');

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
      if (log) log(`  目录被占用(${e.code})，${wait}ms 后重试 (${i + 1}/${attempts})…`);
      sleepSync(wait);
    }
  }
  throw lastErr;
}

async function run(ctx, log) {
  const { workDir, publishDir, voiceId, language } = ctx;
  const srcDir = path.join(workDir, '_publish');

  log(`发布入库: ${voiceId}`);

  if (!fs.existsSync(srcDir)) {
    throw new Error(`_publish/ 目录不存在: ${srcDir}（finalize 可能未成功执行）`);
  }

  // 检查源目录是否为空（至少要有 meta.json）
  const srcFiles = fs.readdirSync(srcDir);
  if (srcFiles.length === 0) {
    throw new Error(`_publish/ 目录为空，拒绝发布`);
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
      log(`  备份旧目录 → ${path.basename(backupDir)}`);
      renameWithRetry(publishDir, backupDir, log);
    } catch (e) {
      backupDir = null;
      copyInPlace = true;
      log(`  旧目录无法移动(${e.code})，改用就地覆盖发布（不移动被占用目录）`);
    }
  }

  try {
    if (copyInPlace) {
      // finalize 的 _publish 已结转全部产物（模型/参考/切片等），就地覆盖即得到
      // 相同的最终状态，无需移动被锁定的目录。
      fs.cpSync(srcDir, publishDir, { recursive: true, force: true });
      try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      log(`  已就地覆盖发布 → ${publishDir}`);
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
      log(`  已发布 → ${publishDir}`);

      // 发布成功 → 删除备份
      if (backupDir && fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
        log(`  已清理备份`);
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
      log(`  已重写 meta.json checkpoint 路径 → assets/${voiceId}/`);
    } catch (rescanErr) {
      log(`  重扫 meta.json 失败(忽略): ${rescanErr.message}`);
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
      log(`  已注册到 voices.json`);
    } catch (regErr) {
      log(`  注册 voices.json 失败(忽略): ${regErr.message}`);
    }

    // 清理整个暂存目录（包括中间件）
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
        log(`  已清理暂存目录`);
      }
    } catch (e) {
      log(`  清理暂存目录失败(忽略): ${e.message}`);
    }

    log(`发布完成: ${voiceId}`);
    return { published: true, path: publishDir };

  } catch (err) {
    // 发布失败 → 回滚备份（仅当备份存在且目标未被新内容占据时）
    if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(publishDir)) {
      try {
        renameWithRetry(backupDir, publishDir, log);
        log(`  回滚成功: 恢复旧目录`);
      } catch (rbErr) {
        log(`  回滚失败(严重): ${rbErr.message} — 备份位于 ${backupDir}`);
      }
    }
    throw new Error(`发布失败: ${err.message}`);
  }
}

module.exports = { run };
