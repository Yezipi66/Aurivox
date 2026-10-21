// 创建 Pipeline 实例：状态机、步骤循环、取消、断点恢复。
const path = require('path');
const fs = require('fs');
const { loadTrainingConfig } = require('../config');
const { ASSETS_ROOT, STAGING_ROOT } = require('../../paths');
const { parseListToSegments, mergeCustomParams, classifyFailure } = require('./pure');
const { snapshotPronLexicon } = require('./pronLexicon');
const { STEP_ORDER } = require('./steps');
const { copyWorkDirUpstream, clearFromStep, clearStepOutputs, pruneCorruptCheckpoints } = require('./workspace');
const { tasks, cleanupOldTasks } = require('./taskStore');

/**
 * 创建 Pipeline 实例
 */
function createPipeline(options) {
  const { voiceId, displayName, language, inputDir, stepOptions = {}, customParams = {} } = options;

  // Resume/断点恢复入参：
  //  resumeTaskId：续跑：原地改，复用同 taskId + 同 workDir（失败步接着跑，
  //  train 步默认保留 checkpoint 让 GSV 自动断点续训）。
  //  forkFromTaskId：改参重跑：分叉出新 taskId + 新 workDir，整目录复制源暂存区
  //  复用上游产物，从改动步往下清+重跑；源失败缓存绝不动。
  //  restartFailedStep：续跑时若改了失败步自身的参数，清掉它的旧产物从头跑
  //  （而非从 checkpoint 续），保证新参生效。
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
    // refinement lineage/params (S2 acoustic refinement etc.). When set,
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
      // carry the refinement lineage/warm-start block forward so a
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
      // 置信度旁车 <listName-without-ext>.conf.json（键为片段文件名）。
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

      // 2) 同步 segments.json：preprocess 真正读取的是它的 segments[*].text，
      //  按 basename 对齐，改写文本。
      const segPath = path.join(workDir, 'segments.json');
      if (fs.existsSync(segPath)) {
        try {
          const seg = JSON.parse(fs.readFileSync(segPath, 'utf-8'));
          const textByName = {};
          for (const r of rows) {
            const bn = path.basename(String(r.audio_path || '').replace(/\\/g, '/'));
            if (bn) textByName[bn] = { text: (r.text == null ? '' : String(r.text)), lang: (r.lang || '').trim() };
          }
          for (const s of (seg.segments || [])) {
            const bn = path.basename(String(s.audio_filename || s.audio_path || '').replace(/\\/g, '/'));
            if (bn in textByName) { s.text = textByName[bn].text; s.lang = textByName[bn].lang; }
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

  // 轻量任务日志（journal）：落盘到 workDir/task.json，用于断电后恢复 UI 现场
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
        refinement: state.refinement,     // 派生资产血缘 + warm-start 快照

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
      // 无论如何都修剪 0 字节/损坏的最新 ckpt，避免加载不完整权重再次崩溃。
      pruneCorruptCheckpoints(workDir, (m) => _addLog('info', m));
    }
  }

  // 门控 G2/G3 宽限期 + 自备转写接管。未跑 ASR 且缺 segments.json 时调用：
  //  1) sleep asrGraceSec（双语高亮打印暂存目录 + 倒计时；期间可取消）
  //  2) 优先检测 .list → 转成 segments.json（覆写）；否则用已放入的 segments.json；
  //  都没有 → 交给 preprocess 抛现有明确错误。
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
    const stepFile = path.join(__dirname, '..', 'steps', `${stepKey}.js`);
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

module.exports = { createPipeline };
