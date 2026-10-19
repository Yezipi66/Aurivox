// 工作区：清理步骤产物、复制暂存目录、修剪损坏的 checkpoint。
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

module.exports = { _rmPath, clearStepOutputs, clearFromStep, copyWorkDir, copyWorkDirUpstream, pruneCorruptCheckpoints };
