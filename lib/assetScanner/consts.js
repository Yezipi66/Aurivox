const { ASSETS_ROOT } = require("../paths");

const ASSETS_DIR = ASSETS_ROOT;

// 角色语言未知时的默认值（既没有 meta.json 可继承、也从模型文件名解析不出语言时才用）；真实语言由训练流程写入，重扫时必须保留（见 scanVoiceDir）。
const DEFAULT_LANGUAGE = "auto";

const GSV_BASE = process.env.GSV_BASE || "";
const NO_SLICE_DIR = process.env.NO_SLICE_DIR || "";

module.exports = { ASSETS_DIR, DEFAULT_LANGUAGE, GSV_BASE, NO_SLICE_DIR };
