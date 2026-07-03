/**
 * Single source of truth for SoVITS version normalization + filename-token
 * recovery. Extracted per CR P1-2.2 to remove the copy-pasted duplicates that
 * previously lived in train.js / preprocess.js / finalize.js. Adding a new
 * version (e.g. a future v3) now only touches this one file.
 */
'use strict';

// Normalize any config / filename version string to a canonical tag.
// Accepts 'v2 pro plus', 'V2ProPlus', 'v2_pro', ... -> 'v2ProPlus' | 'v2Pro' | 'v2'.
function normalizeVersion(raw) {
  const s = String(raw || '').toLowerCase().replace(/[\s_-]/g, '');
  if (s === 'v2proplus') return 'v2ProPlus';
  if (s === 'v2pro') return 'v2Pro';
  return 'v2';
}

// Recover a version from a filename token like '_v2ProPlus_' / '_v2Pro_' / '_v2_'.
// Returns '' when no token is present (caller decides the fallback).
function versionFromName(s) {
  const m = String(s || '').match(/_v2ProPlus_|_v2Pro_|_v2_/i);
  return m ? normalizeVersion(m[0]) : '';
}

module.exports = { normalizeVersion, versionFromName };
