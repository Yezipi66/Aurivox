const path = require("path");
const { ASSETS_ROOT } = require("../paths");

const ASSETS_DIR = ASSETS_ROOT;

// 角色语言未知时的默认值：既没有 meta.json 可继承、也从模型文件名解析不出语言时才用。
// 真实语言由训练流程写入，重扫时必须原样保留。"auto" 是诚实的默认。
const DEFAULT_LANGUAGE = "auto";

const GSV_BASE = process.env.GSV_BASE || "";
const GSV_PATHS = {
 slicerOpt: (base) => path.join(base, "output", "slicer_opt"),
 asrOpt: (base) => path.join(base, "output", "asr_opt"),
 gptWeights: (base) => path.join(base, "GPT_weights_v2Pro"),
 sovitsWeights: (base) => path.join(base, "SoVITS_weights_v2Pro"),
 logs: (base, voiceName) => path.join(base, "logs", voiceName),
 noSlice: process.env.NO_SLICE_DIR || "",
};

module.exports = { ASSETS_DIR, DEFAULT_LANGUAGE, GSV_BASE, GSV_PATHS };
