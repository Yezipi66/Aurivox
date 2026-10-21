// SoVITS 版本号归一与文件名版本标记的恢复，全仓库只有这一处。
// 归一后只有三种取值：v2ProPlus / v2Pro / v2。
'use strict';

// 'v2 pro plus'、'V2ProPlus'、'v2_pro' 都归到 v2ProPlus；其余归到 v2。
function normalizeVersion(raw) {
  const s = String(raw || '').toLowerCase().replace(/[\s_-]/g, '');
  if (s === 'v2proplus') return 'v2ProPlus';
  if (s === 'v2pro') return 'v2Pro';
  return 'v2';
}

// 从文件名标记 _v2ProPlus_ / _v2Pro_ / _v2_ 恢复版本。没有标记时返回 ''，由调用方决定回落值。
function versionFromName(s) {
  const m = String(s || '').match(/_v2ProPlus_|_v2Pro_|_v2_/i);
  return m ? normalizeVersion(m[0]) : '';
}

module.exports = { normalizeVersion, versionFromName };
