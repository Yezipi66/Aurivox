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

  // 若目标已存在，先备份
  let backupDir = null;
  if (fs.existsSync(publishDir)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupDir = `${publishDir}.bak.${ts}`;
    log(`  备份旧目录 → ${path.basename(backupDir)}`);
    fs.renameSync(publishDir, backupDir);
  }

  try {
    // 原子发布：同盘 renameSync 是原子操作；跨盘 EXDEV 兜底
    try {
      fs.renameSync(srcDir, publishDir);
    } catch (e) {
      if (e.code === 'EXDEV') {
        // 跨盘兜底（理论上 ASSETS_ROOT 同盘后不会走到）
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

    // 注册到 voices.json（仅 4 个字段，对齐 DECOUPLING_TASKS Step 2）
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
    // 发布失败 → 回滚备份
    if (backupDir && fs.existsSync(backupDir)) {
      try {
        fs.renameSync(backupDir, publishDir);
        log(`  回滚成功: 恢复旧目录`);
      } catch (rbErr) {
        log(`  回滚失败(严重): ${rbErr.message} — 备份位于 ${backupDir}`);
      }
    }
    throw new Error(`发布失败: ${err.message}`);
  }
}

module.exports = { run };
