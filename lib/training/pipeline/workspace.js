// 训练工作区的目录操作：按步骤清理产物、按分叉点复制上游产物、修剪损坏的权重文件。
// 每一步的产物名单在 steps.js 里，本文件只按那份名单办事，不自己认定哪些是产物。
const fs = require('fs');
const path = require('path');
const { STEP_ORDER, STEP_OUTPUTS } = require('./steps');

function _rmPath(p) {
  try {
    if (!fs.existsSync(p)) return false;
    if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
    return true;
  } catch { return false; }
}

// 清掉某一步的产物。train_s2 的多版本目录 logs_s2_* 不在产物名单里，单独按前缀清。
// workDir 是本次任务的工作区，stepKey 取自 steps.js 的 STEP_ORDER，log 是可选的日志回调。
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
    } catch { /* 目录读不到：没有这一步的产物可清 */ }
  }
}

// 从 startKey 起，把它与所有下游步骤的产物清掉。startKey 不在 STEP_ORDER 里则什么都不做。
function clearFromStep(workDir, startKey, log) {
  const start = STEP_ORDER.indexOf(startKey);
  if (start < 0) return;
  for (let i = start; i < STEP_ORDER.length; i++) clearStepOutputs(workDir, STEP_ORDER[i], log);
}

// 整目录复制工作区。调用方负责磁盘空间提示。
function copyWorkDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

// 分叉时的上游复制：只复制 startKey 之前（上游）步骤的产物，跳过 startKey 及其下游的产物。
// 下游产物本来就要用新参数重跑，复制过来只会被删掉，省下的是几个 GB 的权重文件。
// 实现是整目录复制，用 cpSync 的 filter 排除下游产物（含 train_s2 的多版本 logs_s2_*
// 目录）与源任务的 task.json。startKey 为空或不在 STEP_ORDER 里时回退为全量复制。
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
      if (!rel) return true; // 源目录本身
      const top = rel.split(path.sep)[0];
      if (excluded.has(top)) return false;
      if (excludeS2Glob && /^logs_s2_/.test(top)) return false;
      return true;
    },
  });
}

// 删掉 0 字节的权重文件：训练进程写到一半被中断时会留下这种空文件，
// 续跑时加载它会直接失败。剪掉之后训练回退到上一个可用的权重或底模。
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
          catch { /* 取不到大小：这个文件留着，交给训练步骤自己判断 */ }
        }
      }
    } catch { /* 目录读不到：没有权重文件可剪 */ }
  };
  scan(path.join(workDir, 'logs_s1'));
  try {
    for (const e of fs.readdirSync(workDir)) {
      if (/^logs_s2/.test(e)) scan(path.join(workDir, e));
    }
  } catch { /* 工作区读不到：没有权重文件可剪 */ }
}

module.exports = { _rmPath, clearStepOutputs, clearFromStep, copyWorkDir, copyWorkDirUpstream, pruneCorruptCheckpoints };
