// 资产目录与 GPT-SoVITS 目录约定的常量。
// ASSETS_DIR 指向唯一那处声明（lib/paths.js 的 ASSETS_ROOT）。
const path = require("path");
const { ASSETS_ROOT } = require("../paths");

const ASSETS_DIR = ASSETS_ROOT;

// Default language used only when a voice has no existing meta.json to inherit
// from AND no language token can be parsed from a published model filename.
// Real per-voice language is written by the training pipeline (promote) and
// must be preserved across rescans (see scanVoiceDir). "auto" is the honest
// default: an asset with no known language is treated as multilingual rather
// than silently forced to Japanese (which mis-reads shared Han characters).
const DEFAULT_LANGUAGE = "auto";

// Known GPT-SoVITS directory patterns
// base = GPT-SoVITS root (e.g. D:\AI\GPT-SoVITS-v2pro-20250604)
const GSV_BASE = process.env.GSV_BASE || "";
const GSV_PATHS = {
 // Training outputs
 slicerOpt: (base) => path.join(base, "output", "slicer_opt"),
 asrOpt: (base) => path.join(base, "output", "asr_opt"),
 // Models
 gptWeights: (base) => path.join(base, "GPT_weights_v2Pro"),
 sovitsWeights: (base) => path.join(base, "SoVITS_weights_v2Pro"),
 // Training logs (contains name2text)
 logs: (base, voiceName) => path.join(base, "logs", voiceName),
 // Raw audio
 noSlice: process.env.NO_SLICE_DIR || "",
};

module.exports = { ASSETS_DIR, DEFAULT_LANGUAGE, GSV_BASE, GSV_PATHS };
