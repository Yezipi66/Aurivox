const { ASSETS_ROOT } = require("../paths");

const ASSETS_DIR = ASSETS_ROOT;

// 角色语言未知时的默认值：没有 meta.json 可继承、也解析不出模型文件名时用。
const DEFAULT_LANGUAGE = "auto";

const GSV_BASE = process.env.GSV_BASE || "";
const NO_SLICE_DIR = process.env.NO_SLICE_DIR || "";

module.exports = { ASSETS_DIR, DEFAULT_LANGUAGE, GSV_BASE, NO_SLICE_DIR };
