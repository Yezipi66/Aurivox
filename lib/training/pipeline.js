/**
 * Training Pipeline 编排器
 *
 * 状态机：pending → running → completed / failed
 * 每个步骤独立执行，支持取消
 * 实时日志输出（轮询）
 *
 * 使用方式：
 *   const pipeline = createPipeline({ voiceId: 'xxx', language: 'ja', steps: {...} });
 *   pipeline.start();
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadTrainingConfig } = require('./config');
const { ASSETS_ROOT, STAGING_ROOT, APP_DIR } = require('../paths');

// Reproducibility: mirror pron_correction.py's lexicon dir resolution
// (env PRON_LEXICON_DIR > <project>/data/pron_lexicon) so the snapshot we
// capture matches exactly what 1-get-text.py reads during preprocess.
const PRON_LEXICON_DIR = process.env.PRON_LEXICON_DIR || path.join(APP_DIR, 'data', 'pron_lexicon');
// Inline the full lexicon content below this size; above it, keep only
// hash + entryCount (mark truncated). Real lexicons are tiny; this only
// guards against a pathologically large file bloating task.json.
const PRON_LEXICON_INLINE_MAX = 256 * 1024;

// 把一个 GPT-SoVITS .list（每行 path|speaker|LANG|text）解析成 segments.json 的
// segments 数组结构。用于「未跑 ASR 但用户自备 .list」时，在 preprocess 前接管。
// 只取 path 的 basename 作为 audio_filename（preprocess 按 basename 对齐音频）。
function parseListToSegments(listContent) {
  const segments = [];
  const lines = String(listContent || '').split('\n');
  let idx = 0;
  for (const raw of lines) {
    const t = raw.replace(/\r$/, '').trim();
    if (!t) continue;
    const parts = t.split('|');
    if (parts.length < 4) continue;
    const p = parts[0].replace(/\\/g, '/');
    const base = p.split('/').pop() || p;
    const lang = (parts[2] || '').trim().toLowerCase();
    const text = parts.slice(3).join('|');
    segments.push({
      index: idx++,
      scene: base.replace(/\.[^.]+$/, ''),
      audio_filename: base,
      audio_path: p,
      text,
      lang: lang || undefined,
      matched: true,
      duration: 0,
      confidence: null,
    });
  }
  return segments;
}

// Snapshot every data/pron_lexicon/{lang}.json into a self-contained record so a
// later full re-run is deterministic: changing the (global, mutable) lexicon and
// re-running would silently produce a different model, but the old task.json would
// not record which lexicon version was used. We capture content + SHA-256 (content
// = true reproduction, hash = cheap comparison). Never throws — a missing dir or a
// bad file degrades to an empty/partial snapshot rather than failing the run.
function snapshotPronLexicon(language) {
  const snap = {
    capturedAt: new Date().toISOString(),
    dir: PRON_LEXICON_DIR,
    language: language || null,   // training language, for reference
    files: {},
  };
  let names = [];
  try { names = fs.readdirSync(PRON_LEXICON_DIR).filter(n => n.endsWith('.json')); }
  catch (_) { return snap; }  // dir absent = no overrides in effect
  for (const name of names) {
    const lang = name.replace(/\.json$/, '');
    const full = path.join(PRON_LEXICON_DIR, name);
    try {
      const raw = fs.readFileSync(full);
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
      let entries = null, entryCount = 0, truncated = false;
      try {
        const parsed = JSON.parse(raw.toString('utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entryCount = Object.keys(parsed).length;
          if (raw.length <= PRON_LEXICON_INLINE_MAX) entries = parsed;
          else truncated = true;
        }
      } catch (_) { /* unparseable — keep bytes/hash only */ }
      snap.files[lang] = { path: full, sha256, entryCount, ...(entries ? { entries } : {}), ...(truncated ? { truncated: true } : {}) };
    } catch (_) { /* unreadable file — skip */ }
  }
  return snap;
}

// 全局训练任务存储
const tasks = new Map();
const MAX_TASKS_IN_MEMORY = 50;

function cleanupOldTasks() {
  if (tasks.size <= MAX_TASKS_IN_MEMORY) return;
  
  // Sort tasks by finishedAt (if exists) or startedAt
  const sorted = Array.from(tasks.entries()).sort((a, b) => {
    const timeA = a[1].getStatus().finishedAt || a[1].getStatus().startedAt || '';
    const timeB = b[1].getStatus().finishedAt || b[1].getStatus().startedAt || '';
    return timeA.localeCompare(timeB);
  });

  const toRemove = sorted.slice(0, tasks.size - MAX_TASKS_IN_MEMORY);
  for (const [id] of toRemove) {
    tasks.delete(id);
  }
}

/**
 * 把 customParams 深合并进 base config（覆盖默认）
 * 结构: { training: {...}, steps: { slice: { params: {...} }, ... } }
 */
function mergeCustomParams(base, custom) {
  if (!custom || typeof custom !== 'object') return base;
  const cfg = JSON.parse(JSON.stringify(base));
  if (custom.training) Object.assign(cfg.training, custom.training);
  if (custom.steps) {
    for (const [k, v] of Object.entries(custom.steps)) {
      if (!cfg.steps[k]) cfg.steps[k] = { params: {} };
      if (!cfg.steps[k].params) cfg.steps[k].params = {};
      if (v.params) Object.assign(cfg.steps[k].params, v.params);
    }
  }
  return cfg;
}

// ── Resume / 断点恢复支持 ──────────────────────────────────────────────────
// 步骤顺序（与 stepDefs 一致，用于级联清理与"从第 X 步往下"计算）。
const STEP_ORDER = ['denoise', 'slice', 'asr', 'preprocess', 'train_s1', 'train_s2', 'finalize', 'promote'];

// 每步在 workDir 里的产物（相对路径），用于改参重跑时精准清理该步及下游产物，
// 让被跳过的上游产物原样复用、被重跑的步用新参数从头产出。绝不列上游产物。
const STEP_OUTPUTS = {
  denoise:    ['denoise', 'raw_b4_extraction'],
  slice:      ['slicer_opt'],
  asr:        ['asr_output', 'segments.json'],
  preprocess: ['2-name2text.txt', '2-name2text-0.txt', '2-name2text-1.txt',
               '3-bert', '4-cnhubert', '5-wav32k',
               '6-name2semantic-0.tsv', '6-name2semantic-1.tsv', '7-sv_cn'],
  train_s1:   ['logs_s1'],
  train_s2:   ['logs_s2'],   // 多版本 logs_s2_<version> 由下方 glob 兜底
  finalize:   ['_publish'],
  promote:    [],
};

function _rmPath(p) {
  try {
    if (!fs.existsSync(p)) return false;
    if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
    return true;
  } catch { return false; }
}

// 清掉某一步的产物（含 train_s2 的多版本 logs_s2_* 目录）。
function clearStepOutputs(workDir, stepKey, log) {
  const outs = STEP_OUTPUTS[stepKey] || [];
  for (const name of outs) {
    if (_rmPath(path.join(workDir, name)) && typeof log === 'function') log(`  Cleared ${stepKey} output: ${name}`);
  }
  if (stepKey === 'train_s2') {
    try {
      for (const e of fs.readdirSync(workDir)) {
        if (/^logs_s2_/.test(e)) {
          if (_rmPath(path.join(workDir, e)) && typeof log === 'function') log(`  Cleared train_s2 output: ${e}`);
        }
      }
    } catch { /* ignore */ }
  }
}

// 从 startKey 起，把它与所有下游步骤的产物清掉（改参分叉时用）。
function clearFromStep(workDir, startKey, log) {
  const start = STEP_ORDER.indexOf(startKey);
  if (start < 0) return;
  for (let i = start; i < STEP_ORDER.length; i++) clearStepOutputs(workDir, STEP_ORDER[i], log);
}

// 整目录复制暂存区（改参分叉复用上游产物，"最稳"方案；调用方负责空间提示）。
function copyWorkDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

// 分叉时"精准复制"：只复制 rerunStart 之前（上游）步骤的产物 + 共享脚手架，
// 跳过 rerunStart 及其下游的产物（它们本来就要用新参重跑，复制过来只会被删）。
// 这样磁盘只占上游那部分，避免把 S1/S2 的 checkpoint 复制一遍又删掉。
// 实现方式：整目录复制，但用 cpSync 的 filter 排除下游产物（含 train_s2 多版本
// logs_s2_* 目录）与源任务的 task.json。startKey 为空时回退为全量复制（最稳）。
function copyWorkDirUpstream(src, dst, startKey) {
  const start = startKey ? STEP_ORDER.indexOf(startKey) : -1;
  if (start < 0) { copyWorkDir(src, dst); return; }
  const excluded = new Set(['task.json']);
  let excludeS2Glob = false;
  for (let i = start; i < STEP_ORDER.length; i++) {
    for (const name of (STEP_OUTPUTS[STEP_ORDER[i]] || [])) excluded.add(name);
    if (STEP_ORDER[i] === 'train_s2') excludeS2Glob = true;
  }
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(src, s);
      if (!rel) return true; // 根目录本身
      const top = rel.split(path.sep)[0];
      if (excluded.has(top)) return false;
      if (excludeS2Glob && /^logs_s2_/.test(top)) return false;
      return true;
    },
  });
}

// 把失败错误信息归类成人类可读的英文恢复建议（3.B）。
function classifyFailure(message) {
  const m = String(message || '');
  if (/out of memory|outofmemory|cuda error: out of memory|exit code 137|\bSIGKILL\b/i.test(m)) {
    return {
      reasonCode: 'oom',
      reason: 'Out of memory (GPU). Close other GPU-heavy programs (games, browsers, other training) and resume.',
      recoverable: true,
    };
  }
  if (/\b(EBUSY|EPERM|EACCES|ENOTEMPTY)\b|being used by another process|resource busy|permission denied/i.test(m)) {
    return {
      reasonCode: 'file_locked',
      reason: 'A file is locked by another program. Close Explorer windows, audio players, or antivirus holding the dataset, then resume.',
      recoverable: true,
    };
  }
  return { reasonCode: 'error', reason: (m.slice(0, 300) || 'Unknown error'), recoverable: true };
}

// 删掉 0 字节 / 明显截断的最新 checkpoint（crash 恰好写到一半时），
// 让 GSV 退回到上一个可用 ckpt 或底模，避免续跑时加载损坏权重直接再挂。
function pruneCorruptCheckpoints(workDir, log) {
  const dirs = [path.join(workDir, 'logs_s1', '**')];
  const scan = (dir) => {
    try {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { scan(fp); continue; }
        if (/\.(ckpt|pth)$/i.test(e.name)) {
          try { if (fs.statSync(fp).size === 0) { _rmPath(fp); if (typeof log === 'function') log(`  Pruned empty checkpoint: ${e.name}`); } }
          catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  };
  scan(path.join(workDir, 'logs_s1'));
  try {
    for (const e of fs.readdirSync(workDir)) {
      if (/^logs_s2/.test(e)) scan(path.join(workDir, e));
    }
  } catch { /* ignore */ }
}

/**
 * 创建 Pipeline 实例
 */
function createPipeline(options) {
  const { voiceId, displayName, language, inputDir, stepOptions = {}, customParams = {} } = options;

  // Resume/断点恢复入参：
  //   resumeTaskId    —— 续跑：原地改，复用同 taskId + 同 workDir（失败步接着跑，
  //                       train 步默认保留 checkpoint 让 GSV 自动断点续训）。
  //   forkFromTaskId  —— 改参重跑：分叉出新 taskId + 新 workDir，整目录复制源暂存区
  //                       复用上游产物，从改动步往下清+重跑；源失败缓存绝不动。
  //   restartFailedStep —— 续跑时若改了失败步自身的参数，清掉它的旧产物从头跑
  //                       （而非从 checkpoint 续），保证新参生效。
  const resumeTaskId = options.resumeTaskId || null;
  const forkFromTaskId = options.forkFromTaskId || null;
  const restartFailedStep = !!options.restartFailedStep;
  const isResume = !!resumeTaskId;
  const isFork = !!forkFromTaskId;

  const taskId = isResume ? resumeTaskId : `train_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const workDir = path.join(STAGING_ROOT, taskId);          // ← 临时工作区
  const srcWorkDir = isFork ? path.join(STAGING_ROOT, forkFromTaskId) : null; // 分叉的复制来源
  const publishDir = path.join(ASSETS_ROOT, voiceId);       // ← 最终发布目标
  const baseConfig = loadTrainingConfig();
  const config = mergeCustomParams(baseConfig, customParams);

  // 内部状态
  const state = {
    id: taskId,
    voiceId,
    // Option A: the human-facing display name (Unicode allowed). Immutable id
    // above is the canonical key; this rides along so publish writes it into the
    // asset meta.json. Preserved across resume/fork via the journal.
    displayName: displayName || null,
    language,
    inputDir,
    workDir,          // 训练写入的临时目录
    publishDir,       // 最终 assets/{voiceId} 目标路径
    status: 'pending',
    currentStep: null,
    steps: {},
    logs: [],
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    currentChild: null,  // 当前正在运行的子进程（用于 cancel）
    // P6 人工校对：ASR 完成后暂停，等待用户校对文本/读音再继续。
    pauseAfterAsr: !!(stepOptions.pauseAfterAsr ?? options.pauseAfterAsr ?? false),
    // GIGO 门 1：人声提取完成后暂停，让用户试听分离结果，满意则继续、不满意则取消
    // 整条管线。与 pauseAfterAsr 同构，但默认【开启】（分离质量是决定成败的第一道门）。
    pauseAfterDenoise: !!(stepOptions.pauseAfterDenoise ?? options.pauseAfterDenoise ?? false),
    // 当前挂起的校对属于哪一道门：'denoise'（试听）| 'asr'（文本校对）| null。
    reviewStage: null,
    // 门控 G2/G3：训练开启但本次未跑 ASR 时，preprocess 前的宽限期（秒），
    // 让用户把自备的 .list / segments.json 复制进暂存目录。0 = 不等待。默认 30，钳制 0–600。
    asrGraceSec: (() => {
      const v = Number(stepOptions.asrGraceSec ?? options.asrGraceSec);
      return Number.isFinite(v) && v >= 0 && v <= 600 ? Math.round(v) : 30;
    })(),
    reviewResolve: null,     // 挂起的 resume Promise 解析器
    reviewListName: null,    // 当前可校对的 .list 文件名
    reviewStartedAt: null,   // 进入 awaiting_review 的时间
    failedAt: null,          // 3.A/3.B：{step,index,reasonCode,reason,recoverable}
    // 恢复现场元数据（写入 journal，供缓存列表 & 恢复面板回填参数）。
    stepOptions,
    customParams,
    resumeOf: resumeTaskId || forkFromTaskId || null,
    resumeMode: isFork ? 'fork' : (isResume ? 'resume' : null),
    // Reproducibility: pronunciation lexicon snapshot, filled the moment preprocess
    // actually runs (see step loop). null when preprocess is reused/skipped, in which
    // case the pronunciations are already baked into the copied 2-name2text artifacts.
    pronLexicon: null,
    // Patch #12: refinement lineage/params (S2 acoustic refinement etc.). When set,
    // this run continues training from a parent asset's checkpoints and publishes a
    // NEW derived voice. Carried into every step's ctx and written to meta by finalize.
    refinement: options.refinement || null,
  };

  // Reproducibility: on resume/fork the preprocess step is usually reused (skipped),
  // so we won't re-snapshot — carry the prior lexicon snapshot forward from the
  // upstream journal so it isn't overwritten with null. Resume reads its own workDir
  // journal; fork reads the source workDir (its task.json is excluded from the copy).
  if (isResume || isFork) {
    const priorJournal = path.join(isFork ? srcWorkDir : workDir, 'task.json');
    try {
      const prior = JSON.parse(fs.readFileSync(priorJournal, 'utf-8'));
      if (prior && prior.pronLexicon) state.pronLexicon = prior.pronLexicon;
      // Patch #12: carry the refinement lineage/warm-start block forward so a
      // resumed/forked refinement keeps continuing from the parent checkpoints and
      // preserves lineage (the caller's options.refinement is empty on recovery).
      if (prior && prior.refinement && !state.refinement) state.refinement = prior.refinement;
      // Preserve the human-facing display name across resume/fork if the caller
      // didn't supply one (id itself is already carried by the server).
      if (prior && prior.displayName && !state.displayName) state.displayName = prior.displayName;
    } catch (_) { /* no prior snapshot — will re-capture if preprocess runs */ }
  }

  // 步骤定义
  // 所有步骤的 enabled 均可通过 stepOptions 覆盖；未指定时回退到默认值（保持
  // 原有"全量训练"行为向后兼容）。这让"重建资产"可以只跑缺失环节（例如已有
  // 切片+ASR 的音色，只跑 preprocess→train→finalize→promote，跳过 slice/asr）。
  const stepDefs = [
    { key: 'denoise',    label: 'Vocal extraction', enabled: stepOptions.denoise ?? false },
    { key: 'slice',      label: 'Audio slicing',    enabled: stepOptions.slice ?? true },
    { key: 'asr',        label: 'ASR',              enabled: stepOptions.asr ?? true },
    { key: 'preprocess', label: 'Preprocess',       enabled: stepOptions.preprocess ?? true },
    { key: 'train_s1',   label: 'S1 training (GPT)',    enabled: stepOptions.train_s1 ?? stepOptions.train ?? true },
    { key: 'train_s2',   label: 'S2 training (SoVITS)', enabled: stepOptions.train_s2 ?? stepOptions.train ?? true },
    { key: 'finalize',   label: 'Finalize', enabled: stepOptions.finalize ?? true },
    { key: 'promote',    label: 'Publish',  enabled: stepOptions.promote ?? true },
  ];

  // 重跑起点 = 第一个 enabled 的步骤（其上游均被前端设为 enabled=false 复用）。
  const rerunStart = (stepDefs.find(s => s.enabled) || {}).key || null;

  for (const def of stepDefs) {
    // Resume/Fork：被跳过（enabled=false）的上游步骤已在 workDir 里有产物，
    // 标成 completed 让 UI 正确显示"已复用"，而非误报 pending。
    const skippedButDone = (isResume || isFork) && !def.enabled;
    state.steps[def.key] = {
      label: def.label,
      enabled: def.enabled,
      status: skippedButDone ? 'completed' : 'pending',
      startedAt: null,
      finishedAt: null,
      error: null,
    };
  }

  // Pipeline 实例
  const pipeline = {
    id: taskId,

    async start() {
      if (state.status !== 'pending') return;
      state.status = 'running';
      state.startedAt = new Date().toISOString();

      _addLog('info', `Starting training ${voiceId}, language: ${language}`);
      _addLog('info', `Workspace: ${workDir}`);

      // Resume/Fork：准备工作区（复制上游产物 / 清理待重跑步骤 / 修剪损坏 ckpt）。
      try {
        _prepareWorkspace();
      } catch (err) {
        state.status = 'failed';
        state.finishedAt = new Date().toISOString();
        state.failedAt = { step: rerunStart, index: STEP_ORDER.indexOf(rerunStart), ...classifyFailure(err.message) };
        _addLog('error', `Recovery preparation failed: ${err.message}`);
        _writeJournal();
        return;
      }

      // 确保暂存目录存在
      fs.mkdirSync(workDir, { recursive: true });

      const enabledSteps = stepDefs.filter(s => s.enabled);

      for (const stepDef of enabledSteps) {
        if (state.cancelRequested) {
          state.steps[stepDef.key].status = 'skipped';
          continue;
        }

        state.currentStep = stepDef.key;
        state.steps[stepDef.key].status = 'running';
        state.steps[stepDef.key].startedAt = new Date().toISOString();

        // Reproducibility: capture the effective pronunciation lexicon at the exact
        // moment preprocess is about to consume it (1-get-text.py reads the global
        // data/pron_lexicon/{lang}.json). Persisted with the next _addLog flush.
        if (stepDef.key === 'preprocess') {
          // 门控 G2/G3：本次未跑 ASR，但要 preprocess（即将训练）。给用户一段宽限期，
          // 把自备的 .list 或 segments.json 复制进暂存目录；随后按 list 优先 → segments 接管。
          const asrRanThisSession = (stepDefs.find(s => s.key === 'asr') || {}).enabled;
          const segPath = path.join(workDir, 'segments.json');
          // Refine "reuse" mode seeds the parent's frozen dataset (segments.json) into
          // the derived asset dir (inputDir/publishDir), NOT the fresh staging workDir.
          // preprocess reads segments.json from inputDir too, so a transcript IS present —
          // don't fall into the missing-transcript grace/wait (which stalls asrGraceSec
          // and prints a misleading "will raise missing-transcript error"). Only wait when
          // NEITHER location has one (a genuine no-transcript run awaiting a user drop-in).
          const inputSegPath = inputDir ? path.join(inputDir, 'segments.json') : null;
          const haveTranscript = fs.existsSync(segPath)
            || (inputSegPath && fs.existsSync(inputSegPath));
          if (!asrRanThisSession && !haveTranscript) {
            await _graceIngestTranscript(segPath);
          }
          try {
            state.pronLexicon = snapshotPronLexicon(state.language);
            const langs = Object.keys(state.pronLexicon.files);
            _addLog('info', langs.length
              ? `Pronunciation lexicon snapshot captured: ${langs.map(l => `${l}(${state.pronLexicon.files[l].entryCount})`).join(', ')}`
              : 'Pronunciation lexicon snapshot: no custom entries');
          } catch (e) {
            _addLog('warn', `Pronunciation lexicon snapshot failed (ignored): ${e.message}`);
          }
        }

        _addLog('info', `Starting: ${stepDef.label}`);

        try {
          await _runStep(stepDef.key);
          state.steps[stepDef.key].status = 'completed';
          state.steps[stepDef.key].finishedAt = new Date().toISOString();
          _addLog('success', `Done: ${stepDef.label}`);

          // GIGO 门 1：人声提取完成后，若勾选了试听校对，则在此暂停，直到 resume()。
          if (stepDef.key === 'denoise' && state.pauseAfterDenoise && !state.cancelRequested) {
            await _pauseForReview('denoise');
            if (state.cancelRequested) {
              // 用户试听后不满意，取消整条管线
              continue;
            }
          }

          // P6：ASR 完成后，若勾选了人工校对，则在此暂停，直到 resume() 被调用。
          if (stepDef.key === 'asr' && state.pauseAfterAsr && !state.cancelRequested) {
            await _pauseForReview('asr');
            if (state.cancelRequested) {
              // 用户在校对期间取消
              continue;
            }
          }
        } catch (err) {
          state.steps[stepDef.key].status = 'failed';
          state.steps[stepDef.key].finishedAt = new Date().toISOString();
          state.steps[stepDef.key].error = err.message;
          state.status = 'failed';
          state.finishedAt = new Date().toISOString();
          // 3.A/3.B：记录"挂在哪一步 + 人类可读的英文原因"，供缓存列表与恢复面板读取。
          state.failedAt = {
            step: stepDef.key,
            index: STEP_ORDER.indexOf(stepDef.key),
            ...classifyFailure(err.message),
          };
          _addLog('error', `Failed: ${stepDef.label} — ${err.message}`);
          _addLog('warn', `Reason: ${state.failedAt.reason}`);
          // 失败时【保留】暂存目录，便于排查与恢复；assets/ 仍未被写入，不受污染
          _addLog('warn', `Staging folder kept for diagnosis/recovery: ${workDir}`);
          _writeJournal();   // 让 task.json 落盘记录 failed 状态
          return;
        }
      }

      if (!state.cancelRequested) {
        state.status = 'completed';
        state.finishedAt = new Date().toISOString();
        _addLog('success', 'Training complete');
        cleanupOldTasks(); // 内存回收
      } else {
        state.status = 'cancelled';
        state.finishedAt = new Date().toISOString();
        _addLog('warn', 'Training cancelled');
        _cleanupStaging();
      }
    },

    // P6：恢复被 ASR 校对暂停的管线。返回 true 表示确有挂起的校对被放行。
    resume() {
      if (state.status !== 'awaiting_review' || typeof state.reviewResolve !== 'function') {
        return false;
      }
      _addLog('info', 'Manual review complete; resuming pipeline');
      const fn = state.reviewResolve;
      state.reviewResolve = null;
      state.reviewStage = null;
      state.status = 'running';
      fn();
      return true;
    },

    // GIGO 门 1：人声提取（UVR5）产物试听清单，供 /api/train/preview/:id/denoise
    // 路由无条件列出（不依赖当前是否处于 awaiting_review）。返回 { files:[{name, path}] }。
    getDenoisePreview() {
      return { files: _denoisePreview() };
    },

    // P6：读取当前可校对的 .list（ASR 产物），解析成 { rows: [{path, lang, text}], ... }。
    // GIGO 门 1：若当前挂起的是人声提取试听门，返回分离产物音频清单（供试听），
    // 结构 { stage:'denoise', files:[{name, path}] }，前端据 stage 分派到试听面板。
    getReviewList() {
      if (state.reviewStage === 'denoise') {
        return { status: state.status, stage: 'denoise', files: _denoisePreview() };
      }
      const info = _resolveReviewListPath();
      if (!info) return null;
      const { listPath, listName } = info;
      let content = '';
      try { content = fs.readFileSync(listPath, 'utf-8'); } catch { return null; }
      // Patch #23：置信度旁车 <listName-without-ext>.conf.json（键为片段文件名）。
      let confMap = {};
      try {
        const confPath = listPath.replace(/\.list$/i, '.conf.json');
        if (fs.existsSync(confPath)) {
          const parsed = JSON.parse(fs.readFileSync(confPath, 'utf-8'));
          if (parsed && typeof parsed === 'object') confMap = parsed;
        }
      } catch { /* best-effort：旁车缺失/损坏不影响校对 */ }
      const rows = [];
      content.split('\n').forEach((line, i) => {
        const t = line.replace(/\r$/, '');
        if (!t.trim()) return;
        const parts = t.split('|');
        const audioPath = parts[0] || '';
        const bn = path.basename(String(audioPath).replace(/\\/g, '/'));
        const c = confMap[bn] || null;
        rows.push({
          index: i,
          audio_path: audioPath,
          speaker: parts[1] || state.voiceId,
          lang: parts[2] || '',
          text: parts.slice(3).join('|'),
          confidence: c && typeof c.confidence === 'number' ? c.confidence : null,
          words: c && Array.isArray(c.words) ? c.words : null,
        });
      });
      return { status: state.status, stage: 'asr', listName, rows };
    },

    // P6：保存用户校对后的文本。写回 .list 与 segments.json（preprocess 的真实数据源）。
    saveReviewList(rows) {
      const info = _resolveReviewListPath();
      if (!info) throw new Error('No reviewable .list (ASR has not produced one yet, or the review stage has passed)');
      if (!Array.isArray(rows)) throw new Error('rows must be an array');
      const { listPath } = info;

      // 1) 重写 .list（保持原有列格式：path|speaker|LANG|text）
      const lines = rows.map(r => {
        const p = (r.audio_path || '').trim();
        const sp = (r.speaker || state.voiceId).trim();
        const lang = (r.lang || '').trim();
        const text = (r.text == null ? '' : String(r.text));
        return `${p}|${sp}|${lang}|${text}`;
      });
      const tmp = listPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf-8');
      fs.renameSync(tmp, listPath);

      // 2) 同步 segments.json —— preprocess 真正读取的是它的 segments[*].text，
      //    按 basename 对齐，改写文本。
      const segPath = path.join(workDir, 'segments.json');
      if (fs.existsSync(segPath)) {
        try {
          const seg = JSON.parse(fs.readFileSync(segPath, 'utf-8'));
          const textByName = {};
          for (const r of rows) {
            const bn = path.basename(String(r.audio_path || '').replace(/\\/g, '/'));
            if (bn) textByName[bn] = (r.text == null ? '' : String(r.text));
          }
          for (const s of (seg.segments || [])) {
            const bn = path.basename(String(s.audio_filename || s.audio_path || '').replace(/\\/g, '/'));
            if (bn in textByName) s.text = textByName[bn];
          }
          const segTmp = segPath + '.tmp.' + process.pid;
          fs.writeFileSync(segTmp, JSON.stringify(seg, null, 2), 'utf-8');
          fs.renameSync(segTmp, segPath);
        } catch (e) {
          _addLog('warn', `Failed to sync segments.json (ignored): ${e.message}`);
        }
      }

      // 3) 清掉可能已生成的 2-name2text.txt，强制 preprocess 用最新文本重建。
      try {
        const n2t = path.join(workDir, '2-name2text.txt');
        if (fs.existsSync(n2t)) fs.unlinkSync(n2t);
      } catch { /* best-effort */ }

      _addLog('info', `Saved manual review: ${rows.length} lines`);
      return { saved: rows.length };
    },

    // P6+：把校对行里的 audio_path（资产内相对路径，如 slicer_opt/xxx.wav）解析成
    // 暂存工作区里的绝对路径，供试听预览用。做了三重防护：扩展名白名单、去掉盘符/
    // 前导斜杠防绝对路径逃逸、解析后必须仍在 workDir 内（防 ../ 目录穿越）。
    resolveReviewAudioPath(relPath) {
      if (!relPath || typeof relPath !== 'string') return null;
      const ALLOWED = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg']);
      const cleaned = relPath.replace(/\\/g, '/').replace(/^([a-zA-Z]:)?\/+/, '');
      if (!cleaned || cleaned.split('/').includes('..')) return null;
      if (!ALLOWED.has(path.extname(cleaned).toLowerCase())) return null;
      const root = path.resolve(workDir);
      const abs = path.resolve(root, cleaned);
      if (abs !== root && !abs.startsWith(root + path.sep)) return null;
      try {
        if (!fs.statSync(abs).isFile()) return null;
      } catch { return null; }
      return abs;
    },

    cancel() {
      state.cancelRequested = true;
      // 若正卡在校对暂停，放行让循环走到 cancel 分支收尾
      if (state.status === 'awaiting_review' && typeof state.reviewResolve === 'function') {
        const fn = state.reviewResolve;
        state.reviewResolve = null;
        fn();
      }
      if (state.currentChild && !state.currentChild.killed) {
        if (process.platform === 'win32') {
          // Windows: 杀整棵进程树，防止 DDP worker 残留占显存
          try {
            const pid = state.currentChild.pid;
            if (pid) {
              require('child_process').execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
            }
          } catch { /* ignore */ }
        } else {
          state.currentChild.kill('SIGTERM');
        }
      }
      _addLog('warn', 'Cancelling training...');
    },

    getStatus() {
      return {
        id: state.id,
        voiceId: state.voiceId,
        language: state.language,
        status: state.status,
        currentStep: state.currentStep,
        steps: { ...state.steps },
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        pauseAfterAsr: state.pauseAfterAsr,
        pauseAfterDenoise: state.pauseAfterDenoise,
        awaitingReview: state.status === 'awaiting_review',
        reviewStage: state.reviewStage,
        reviewListName: state.reviewListName,
        reviewStartedAt: state.reviewStartedAt,
        failedAt: state.failedAt,
        inputDir: state.inputDir,
        stepOptions: state.stepOptions,
        customParams: state.customParams,
        resumeOf: state.resumeOf,
        resumeMode: state.resumeMode,
      };
    },

    getLogs() {
      return [...state.logs];
    },
  };

  // 内部方法
  function _addLog(level, message) {
    const log = {
      time: new Date().toISOString(),
      level,
      step: state.currentStep,
      message,
    };
    state.logs.push(log);
    if (state.logs.length > 200) state.logs = state.logs.slice(-200);
    _writeJournal();
  }

  // 轻量任务日志（journal）—— 落盘到 workDir/task.json，用于断电后恢复 UI 现场
  function _writeJournal() {
    try {
      fs.mkdirSync(workDir, { recursive: true });
      const snapshot = {
        id: state.id,
        voiceId: state.voiceId,
        displayName: state.displayName,
        language: state.language,
        status: state.status,
        currentStep: state.currentStep,
        steps: state.steps,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        // 恢复现场：失败定位 + 原始参数，供缓存列表 & 恢复面板回填。
        failedAt: state.failedAt,
        inputDir: state.inputDir,
        stepOptions: state.stepOptions,
        customParams: state.customParams,
        resumeOf: state.resumeOf,
        resumeMode: state.resumeMode,
        pronLexicon: state.pronLexicon,   // 读音词典快照（自包含复现）
        refinement: state.refinement,     // Patch #12: 派生资产血缘 + warm-start 快照

        logs: state.logs.slice(-200),   // 只保留最近 200 条，防止文件膨胀
        updatedAt: new Date().toISOString(),
      };
      const journalPath = path.join(workDir, 'task.json');
      const tmp = journalPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
      fs.renameSync(tmp, journalPath);
    } catch (e) {
      // journal 写入失败不影响主流程
    }
  }

  // 清理暂存目录（训练失败/取消时调用，保证 assets/ 不受污染）
  function _cleanupStaging() {
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
        _addLog('info', `Cleaned staging folder: ${workDir}`);
      }
    } catch (e) {
      _addLog('warn', `Failed to clean staging folder (ignored): ${e.message}`);
    }
  }

  // GIGO 门 1：无条件列出人声提取（UVR5，内部代号 denoise）的产物目录
  // workDir/denoise 作为试听候选。getReviewList 的 denoise 分支与
  // getDenoisePreview() 均复用它，避免逻辑重复。
  function _denoisePreview() {
    const outDir = path.join(workDir, 'denoise');
    let files = [];
    try {
      files = fs.readdirSync(outDir)
        .filter((f) => /\.(wav|flac|mp3|m4a|ogg)$/i.test(f))
        .sort()
        .map((f) => ({ name: f, path: 'denoise/' + f }));
    } catch { /* dir missing → empty list */ }
    return files;
  }

  // P6：定位 ASR 产出的可校对 .list（asr_output/{slicer_opt,raw_opt}.list）。
  function _resolveReviewListPath() {
    const asrDir = path.join(workDir, 'asr_output');
    const candidates = ['slicer_opt.list', 'raw_opt.list'];
    for (const name of candidates) {
      const p = path.join(asrDir, name);
      if (fs.existsSync(p)) return { listPath: p, listName: name };
    }
    return null;
  }

  // P6 / GIGO 门：进入 awaiting_review 状态并挂起，等待 resume() 放行。
  // stage='denoise' → 人声提取试听门；stage='asr' → ASR 文本校对门。
  function _pauseForReview(stage = 'asr') {
    state.reviewStage = stage;
    state.status = 'awaiting_review';
    state.reviewStartedAt = new Date().toISOString();
    if (stage === 'denoise') {
      state.reviewListName = null;
      _addLog('info', 'Paused after vocal extraction, awaiting audition (listen & confirm)');
    } else {
      const info = _resolveReviewListPath();
      state.reviewListName = info ? info.listName : null;
      _addLog('info', `Paused after ASR, awaiting manual review (${state.reviewListName || 'no list'})`);
    }
    return new Promise((resolve) => { state.reviewResolve = resolve; });
  }

  // Resume/Fork：正式跑步骤前准备好工作区。
  function _prepareWorkspace() {
    // 对齐3：从 denoise/slice 起跑却缺 inputDir → 门控直接拦下（英文提示）。
    if ((rerunStart === 'denoise' || rerunStart === 'slice')) {
      if (!inputDir || !fs.existsSync(inputDir)) {
        throw new Error('Input folder is missing. This task resumes from an early step (denoise/slice) that needs the original audio. Please re-select the source folder and try again.');
      }
    }

    if (isFork) {
      // 改参重跑：只精准复制 rerunStart 之前（上游）的产物；rerunStart 及下游本就要
      // 用新参重跑，不复制它们（否则等于白复制几个 GB 的 checkpoint 再删）。
      if (!srcWorkDir || !fs.existsSync(srcWorkDir)) {
        throw new Error('The task to fork from no longer exists in the cache. It may have been cleaned up. Please start a new training run.');
      }
      if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
      if (rerunStart) {
        _addLog('info', `Fork: copying only products before ${rerunStart}; re-running from ${rerunStart} with new params: ${srcWorkDir} → ${workDir}`);
        _addLog('warn', `Fork copies only the products of steps BEFORE "${rerunStart}"; downstream is re-run, not copied. Make sure you have enough disk space for the upstream products.`);
      } else {
        _addLog('info', `Fork: copying staging folder (re-run with new params): ${srcWorkDir} → ${workDir}`);
        _addLog('warn', 'Fork copies the whole cache folder — make sure you have enough disk space.');
      }
      copyWorkDirUpstream(srcWorkDir, workDir, rerunStart);
      // task.json 已被 filter 排除；防御性再删一次（回退全量复制的分支不会排除它）。
      try { fs.unlinkSync(path.join(workDir, 'task.json')); } catch { /* ignore */ }
      // rerunStart 及下游本就没被复制过来；防御性清一次（对已缺失目录是安全的 no-op），
      // 兼容 STEP_OUTPUTS 未覆盖的边角产物。
      if (rerunStart) {
        clearFromStep(workDir, rerunStart, (m) => _addLog('info', m));
      }
    } else if (isResume) {
      // 续跑：原地复用。若用户改了失败步自身的参数(restartFailedStep)，清掉该步旧产物
      // 从头跑（保证新参生效）；否则 train 步保留 checkpoint，让 GSV 自动断点续训。
      if (restartFailedStep && rerunStart) {
        _addLog('info', `Restarting failed step (params changed), clearing its products: ${rerunStart}`);
        clearStepOutputs(workDir, rerunStart, (m) => _addLog('info', m));
      } else {
        _addLog('info', 'Resume: keeping completed products and training checkpoints (GSV will auto-resume from checkpoint)');
      }
      // 无论如何都修剪 0 字节/损坏的最新 ckpt，避免加载半截权重再次崩溃。
      pruneCorruptCheckpoints(workDir, (m) => _addLog('info', m));
    }
  }

  // 门控 G2/G3 宽限期 + 自备转写接管。未跑 ASR 且缺 segments.json 时调用：
  //   1) sleep asrGraceSec（双语高亮打印暂存目录 + 倒计时；期间可取消）
  //   2) 优先检测 .list → 转成 segments.json（覆写）；否则用已放入的 segments.json；
  //      都没有 → 交给 preprocess 抛现有明确错误。
  async function _graceIngestTranscript(segPath) {
    const grace = state.asrGraceSec;
    _addLog('warn',
      `No ASR transcript this run. Waiting ${grace}s — copy your .list or segments.json into the staging folder before it continues.`);
    _addLog('info', `Staging folder: ${workDir}`);
    _addLog('info',
      'Rule: a .list overrides segments.json; or drop segments.json directly. Provide only one.');

    // 倒计时：1s 一跳，检查取消 + 早退（文件已就绪就不必等满）。每 5s 播报一次剩余。
    for (let remaining = grace; remaining > 0; remaining--) {
      if (state.cancelRequested) return;
      const hasList = _findUserList().length > 0;
      if (hasList || fs.existsSync(segPath)) {
        _addLog('info', `Transcript detected, ending wait early.`);
        break;
      }
      if (remaining % 5 === 0 || remaining <= 3) {
        _addLog('info', `Waiting… ${remaining}s left`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (state.cancelRequested) return;

    // 接管：list 优先。
    const lists = _findUserList();
    if (lists.length > 0) {
      try {
        const content = fs.readFileSync(lists[0], 'utf-8');
        const segments = parseListToSegments(content);
        const segData = {
          voice: voiceId, language,
          source_kind: 'user_list', source_file: path.basename(lists[0]),
          generated_at: new Date().toISOString(),
          total: segments.length, matched: segments.length, segments,
        };
        fs.writeFileSync(segPath, JSON.stringify(segData, null, 2));
        _addLog('success',
          `Ingested user .list (${path.basename(lists[0])}, ${segments.length} lines) → segments.json (overwritten).`);
        return;
      } catch (e) {
        _addLog('warn', `Failed to parse .list; falling back to segments.json: ${e.message}`);
      }
    }
    if (fs.existsSync(segPath)) {
      _addLog('success', `Using user-provided segments.json.`);
      return;
    }
    _addLog('warn', `No .list / segments.json found after the grace period — preprocess will raise a missing-transcript error.`);
  }

  // 在暂存目录里查找用户投放的 .list（排除 ASR 自产的 asr_output/ 内产物）。
  function _findUserList() {
    try {
      return fs.readdirSync(workDir)
        .filter(f => /\.list$/i.test(f))
        .map(f => path.join(workDir, f));
    } catch { return []; }
  }

  async function _runStep(stepKey) {
    const stepFile = path.join(__dirname, 'steps', `${stepKey}.js`);
    if (!fs.existsSync(stepFile)) {
      throw new Error(`Step file not found: ${stepFile}`);
    }
    const step = require(stepFile);
    // setChild 让 step 登记当前子进程，cancel() 时只杀自己这个
    const setChild = (child) => { state.currentChild = child; };
    await step.run(
      { voiceId, displayName: state.displayName, language, inputDir, workDir, publishDir, config, customParams, stepOptions, setChild,
        refinement: state.refinement,
        isCancelled: () => state.cancelRequested,
      },
      (msg) => _addLog('info', msg)
    );
  }

  tasks.set(taskId, pipeline);
  return pipeline;
}

function getTask(taskId) {
  return tasks.get(taskId);
}

function getAllTasks() {
  const result = Array.from(tasks.values()).map(t => ({
    id: t.id,
    voiceId: t.getStatus().voiceId,
    status: t.getStatus().status,
    currentStep: t.getStatus().currentStep,
    startedAt: t.getStatus().startedAt,
    finishedAt: t.getStatus().finishedAt,
  }));

  // 补充磁盘上已中断的任务（断电后内存 Map 已清空，但 task.json 还在）
  try {
    if (fs.existsSync(STAGING_ROOT)) {
      const idsInMem = new Set(result.map(t => t.id));
      const entries = fs.readdirSync(STAGING_ROOT, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskJson = path.join(STAGING_ROOT, entry.name, 'task.json');
        if (!fs.existsSync(taskJson)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(taskJson, 'utf-8'));
          if (!idsInMem.has(data.id) && (data.status === 'interrupted' || data.status === 'running' || data.status === 'pending')) {
            result.push({
              id: data.id,
              voiceId: data.voiceId,
              status: 'interrupted',
              currentStep: data.currentStep,
              startedAt: data.startedAt,
              finishedAt: data.finishedAt,
            });
          }
        } catch (e) { /* 忽略损坏的 task.json */ }
      }
    }
  } catch (e) { /* 忽略扫描失败 */ }

  return result;
}

// 从磁盘 journal 读取任务快照（用于断电重启后内存 Map 已空的情况）
function readTaskJournal(taskId) {
  try {
    const journalPath = path.join(STAGING_ROOT, taskId, 'task.json');
    if (!fs.existsSync(journalPath)) return null;
    const data = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    // 重启后仍是 running/pending 的，按中断处理
    if (data.status === 'running' || data.status === 'pending') data.status = 'interrupted';
    return data;
  } catch { return null; }
}

// 按 id 取状态（内存优先，磁盘兜底）
function getStatusById(taskId) {
  const t = tasks.get(taskId);
  if (t) return t.getStatus();
  const j = readTaskJournal(taskId);
  if (!j) return null;
  return {
    id: j.id, voiceId: j.voiceId, language: j.language,
    status: j.status, currentStep: j.currentStep, steps: j.steps,
    startedAt: j.startedAt, finishedAt: j.finishedAt,
    failedAt: j.failedAt || null, inputDir: j.inputDir,
    stepOptions: j.stepOptions, customParams: j.customParams,
    resumeOf: j.resumeOf, resumeMode: j.resumeMode,
  };
}

// 列出缓存里所有"可恢复"的微调任务 —— 只列 failed + interrupted（3 主力场景）。
// success 已被 publish 自清、cancelled 已被 _cleanupStaging 清掉，都不会在这里出现。
// 内存 Map 优先，磁盘 task.json 兜底（断电重启后内存已空）。
function listRecoverable() {
  const out = [];
  const seen = new Set();

  const push = (data, statusOverride) => {
    if (!data || !data.id || seen.has(data.id)) return;
    const status = statusOverride || data.status;
    if (status !== 'failed' && status !== 'interrupted') return;
    seen.add(data.id);
    // 计算可恢复的建议起跑步：失败步（有 failedAt）或当前步；缺则回退首个 enabled。
    let resumeStep = (data.failedAt && data.failedAt.step) || data.currentStep || null;
    if (!resumeStep && data.steps) {
      const firstFailed = STEP_ORDER.find(k => data.steps[k] && data.steps[k].status === 'failed');
      resumeStep = firstFailed || null;
    }
    out.push({
      id: data.id,
      voiceId: data.voiceId,
      language: data.language,
      status,
      currentStep: data.currentStep,
      resumeStep,
      failedAt: data.failedAt || (status === 'interrupted'
        ? { step: resumeStep, index: STEP_ORDER.indexOf(resumeStep),
            reasonCode: 'interrupted',
            reason: 'Training was interrupted (app closed, power loss, or manual stop). You can resume from where it stopped.',
            recoverable: true }
        : null),
      steps: data.steps || {},
      inputDir: data.inputDir || null,
      stepOptions: data.stepOptions || {},
      customParams: data.customParams || {},
      startedAt: data.startedAt,
      finishedAt: data.finishedAt,
      updatedAt: data.updatedAt || data.finishedAt || data.startedAt,
    });
  };

  // 1) 内存中的任务
  for (const t of tasks.values()) {
    const s = t.getStatus();
    push(s);
  }

  // 2) 磁盘兜底
  try {
    if (fs.existsSync(STAGING_ROOT)) {
      for (const entry of fs.readdirSync(STAGING_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        const taskJson = path.join(STAGING_ROOT, entry.name, 'task.json');
        if (!fs.existsSync(taskJson)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(taskJson, 'utf-8'));
          // 断电后仍标 running/pending 的按 interrupted 处理
          const st = (data.status === 'running' || data.status === 'pending') ? 'interrupted' : data.status;
          push(data, st);
        } catch { /* 忽略损坏的 task.json */ }
      }
    }
  } catch { /* 忽略扫描失败 */ }

  // 最近的排前面
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

// 按 id 取日志（内存优先，磁盘兜底）
function getLogsById(taskId) {
  const t = tasks.get(taskId);
  if (t) return t.getLogs();
  const j = readTaskJournal(taskId);
  return j ? (j.logs || []) : null;
}

module.exports = { createPipeline, getTask, getAllTasks, getStatusById, getLogsById, STAGING_ROOT, readTaskJournal, listRecoverable, snapshotPronLexicon };
