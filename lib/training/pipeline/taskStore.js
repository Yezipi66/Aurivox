// 训练任务的存储与查询：内存 Map 里放 Pipeline 实例，磁盘上每个任务目录的 task.json 留档。
// 查询一律内存优先、磁盘兜底，两边按任务 id 合并。边界：只提供任务查询、状态、日志、
// 可恢复清单与内存回收，不负责训练流程本身。
const fs = require('fs');
const path = require('path');
const { STAGING_ROOT } = require('../../paths');
const { STEP_ORDER } = require('./steps');

// 训练任务：id 到 Pipeline 实例。
const tasks = new Map();

// 内存里保留的任务上限，超出后按时间淘汰最旧的。
const MAX_TASKS_IN_MEMORY = 50;

function cleanupOldTasks() {
  if (tasks.size <= MAX_TASKS_IN_MEMORY) return;
  
  // 淘汰顺序：先按完成时间，没有完成时间则按开始时间。
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

  // 磁盘上仍是 interrupted / running / pending 的任务也并进来，
  // 统一按 interrupted 报：进程重启后内存 Map 已空，task.json 是唯一的来源。
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

// 从磁盘上的 task.json 读取任务快照。内存里没有这个任务时用它。
// 文件不存在、读不出或 JSON 坏了时返回 null。
// 返回前把 running / pending 改成 interrupted：进程重启后没人接着跑它。
function readTaskJournal(taskId) {
  try {
    const journalPath = path.join(STAGING_ROOT, taskId, 'task.json');
    if (!fs.existsSync(journalPath)) return null;
    const data = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    if (data.status === 'running' || data.status === 'pending') data.status = 'interrupted';
    return data;
  } catch { return null; }
}

// 按 id 取任务状态。内存里有就返回实例的状态，否则读磁盘快照；
// 两边都没有时返回 null。
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

// 列出可恢复的任务：状态为 failed 或 interrupted 的那些。
// 其余状态（completed、cancelled 等）不满足上面的条件，因此不在其中。
// 内存里的任务与磁盘上的任务合并，按 id 去重。
function listRecoverable() {
  const out = [];
  const seen = new Set();

  const push = (data, statusOverride) => {
    if (!data || !data.id || seen.has(data.id)) return;
    const status = statusOverride || data.status;
    if (status !== 'failed' && status !== 'interrupted') return;
    seen.add(data.id);
    // 建议的恢复起点：失败步，没有就取当前步；两者都没有则取 STEP_ORDER 里
    // 第一个状态为 failed 的步。
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

  // 2) 磁盘上的任务
  try {
    if (fs.existsSync(STAGING_ROOT)) {
      for (const entry of fs.readdirSync(STAGING_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        const taskJson = path.join(STAGING_ROOT, entry.name, 'task.json');
        if (!fs.existsSync(taskJson)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(taskJson, 'utf-8'));
          // 磁盘上仍标 running / pending 的按 interrupted 处理
          const st = (data.status === 'running' || data.status === 'pending') ? 'interrupted' : data.status;
          push(data, st);
        } catch { /* 忽略损坏的 task.json */ }
      }
    }
  } catch { /* 忽略扫描失败 */ }

  // 最近更新的排在前面
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
