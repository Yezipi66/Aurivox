// 任务查询：内存 Map 优先，磁盘 task.json 兜底。
const fs = require('fs');
const path = require('path');
const { STAGING_ROOT } = require('../../paths');
const { STEP_ORDER } = require('./steps');

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

// 列出缓存里所有"可恢复"的微调任务：只列 failed + interrupted（3 主力场景）。
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

module.exports = { tasks, MAX_TASKS_IN_MEMORY, cleanupOldTasks, getTask, getAllTasks, readTaskJournal, getStatusById, listRecoverable, getLogsById };
