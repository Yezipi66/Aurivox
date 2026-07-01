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
const { loadTrainingConfig } = require('./config');
const { ASSETS_ROOT, STAGING_ROOT } = require('../paths');

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

/**
 * 创建 Pipeline 实例
 */
function createPipeline(options) {
  const { voiceId, language, inputDir, stepOptions = {}, customParams = {} } = options;

  const taskId = `train_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const workDir = path.join(STAGING_ROOT, taskId);          // ← 临时工作区
  const publishDir = path.join(ASSETS_ROOT, voiceId);       // ← 最终发布目标
  const baseConfig = loadTrainingConfig();
  const config = mergeCustomParams(baseConfig, customParams);

  // 内部状态
  const state = {
    id: taskId,
    voiceId,
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
  };

  // 步骤定义
  // 所有步骤的 enabled 均可通过 stepOptions 覆盖；未指定时回退到默认值（保持
  // 原有"全量训练"行为向后兼容）。这让"重建资产"可以只跑缺失环节（例如已有
  // 切片+ASR 的音色，只跑 preprocess→train→finalize→promote，跳过 slice/asr）。
  const stepDefs = [
    { key: 'denoise',    label: '去人声',   enabled: stepOptions.denoise ?? false },
    { key: 'slice',      label: '语音切片', enabled: stepOptions.slice ?? true },
    { key: 'asr',        label: '语音识别', enabled: stepOptions.asr ?? true },
    { key: 'preprocess', label: '预处理',   enabled: stepOptions.preprocess ?? true },
    { key: 'train',      label: '训练',     enabled: stepOptions.train ?? true },
    { key: 'finalize',   label: '收尾整理', enabled: stepOptions.finalize ?? true },
    { key: 'promote',    label: '发布入库', enabled: stepOptions.promote ?? true },
  ];

  for (const def of stepDefs) {
    state.steps[def.key] = {
      label: def.label,
      enabled: def.enabled,
      status: 'pending',
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

      _addLog('info', `开始训练 ${voiceId}，语言: ${language}`);
      _addLog('info', `工作区: ${workDir}`);

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

        _addLog('info', `开始: ${stepDef.label}`);

        try {
          await _runStep(stepDef.key);
          state.steps[stepDef.key].status = 'completed';
          state.steps[stepDef.key].finishedAt = new Date().toISOString();
          _addLog('success', `完成: ${stepDef.label}`);
        } catch (err) {
          state.steps[stepDef.key].status = 'failed';
          state.steps[stepDef.key].finishedAt = new Date().toISOString();
          state.steps[stepDef.key].error = err.message;
          state.status = 'failed';
          state.finishedAt = new Date().toISOString();
          _addLog('error', `失败: ${stepDef.label} — ${err.message}`);
          // 失败时【保留】暂存目录，便于排查；assets/ 仍未被写入，不受污染
          _addLog('warn', `已保留暂存目录用于排查: ${workDir}`);
          _writeJournal();   // 让 task.json 落盘记录 failed 状态
          return;
        }
      }

      if (!state.cancelRequested) {
        state.status = 'completed';
        state.finishedAt = new Date().toISOString();
        _addLog('success', '训练完成');
        cleanupOldTasks(); // 内存回收
      } else {
        state.status = 'cancelled';
        state.finishedAt = new Date().toISOString();
        _addLog('warn', '训练已取消');
        _cleanupStaging();
      }
    },

    cancel() {
      state.cancelRequested = true;
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
      _addLog('warn', '正在取消训练...');
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
        language: state.language,
        status: state.status,
        currentStep: state.currentStep,
        steps: state.steps,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
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
        _addLog('info', `已清理暂存目录: ${workDir}`);
      }
    } catch (e) {
      _addLog('warn', `清理暂存目录失败(忽略): ${e.message}`);
    }
  }

  async function _runStep(stepKey) {
    const stepFile = path.join(__dirname, 'steps', `${stepKey}.js`);
    if (!fs.existsSync(stepFile)) {
      throw new Error(`步骤文件不存在: ${stepFile}`);
    }
    const step = require(stepFile);
    // setChild 让 step 登记当前子进程，cancel() 时只杀自己这个
    const setChild = (child) => { state.currentChild = child; };
    await step.run(
      { voiceId, language, inputDir, workDir, publishDir, config, customParams, stepOptions, setChild,
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
  };
}

// 按 id 取日志（内存优先，磁盘兜底）
function getLogsById(taskId) {
  const t = tasks.get(taskId);
  if (t) return t.getLogs();
  const j = readTaskJournal(taskId);
  return j ? (j.logs || []) : null;
}

module.exports = { createPipeline, getTask, getAllTasks, getStatusById, getLogsById, STAGING_ROOT, readTaskJournal };
