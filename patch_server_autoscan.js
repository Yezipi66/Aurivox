/**
 * patch_server_autoscan.js
 * 修复:首次启动侧边栏 GPT/SoVITS 红叉 + "voice not found"(需手动 scan all)。
 * 根因:meta.json / segments.json 只有 fullScan 才生成;无元数据 -> 校验失败。
 * 做法:
 *   1) 抽出共享函数 runFullAssetScan()(fullScan + 同步 voices.json)。
 *   2) POST /api/assets/scan 复用该函数(去重)。
 *   3) 服务启动时 assetsNeedScan() 检测缺失 -> 自动 runFullAssetScan()。
 * 幂等:重复运行不会重复插入。保留 CRLF 行尾。
 *
 * 用法:  node patch_server_autoscan.js
 */
const fs = require("fs");
const path = require("path");

const SERVER = path.resolve(__dirname, "server.js");
if (!fs.existsSync(SERVER)) {
  console.error("[FAIL] 找不到 server.js,请把本脚本放到项目根目录(server.js 同级)再运行。");
  process.exit(1);
}

const raw = fs.readFileSync(SERVER, "utf8");
const hadCRLF = raw.includes("\r\n");
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("function runFullAssetScan(")) {
  console.log("[skip] 已包含 runFullAssetScan(),server.js 似乎已打过补丁。");
  process.exit(0);
}

// ---- 1) 在 scan 路由前插入共享函数 ----
const HELPERS = `// ---- 共享:全量资产扫描 + 同步 voices.json ----
async function runFullAssetScan() {
  const results = assetScanner.fullScan();
  await withVoicesLock(async () => {
    const voices = loadVoices();
    const scannedIds = new Set(Object.keys(results));
    for (const oldId of Object.keys(voices)) {
      if (!scannedIds.has(oldId)) delete voices[oldId];
    }
    for (const [id, meta] of Object.entries(results)) {
      voices[id] = {
        display_name: meta?.display_name || id,
        language: meta?.language || "ja",
        prompt_lang: meta?.prompt_lang || meta?.language || "ja",
        text_lang: meta?.text_lang || meta?.language || "ja",
      };
    }
    saveVoices(voices);
  });
  return results;
}

// 是否存在任何声音目录缺少 meta.json / segments.json(需要扫描)
function assetsNeedScan() {
  try {
    if (!fs.existsSync(ASSETS_DIR)) return false;
    const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = path.join(ASSETS_DIR, e.name, "meta.json");
      const segPath = path.join(ASSETS_DIR, e.name, "segments.json");
      if (!fs.existsSync(metaPath) || !fs.existsSync(segPath)) return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

`;

const SCAN_ANCHOR = "// POST /api/assets/scan — trigger full directory scan";
if (!src.includes(SCAN_ANCHOR)) {
  console.error("[FAIL] 未找到 scan 路由锚点,server.js 版本与预期不符,放弃修改。");
  process.exit(1);
}
src = src.replace(SCAN_ANCHOR, HELPERS + SCAN_ANCHOR);

// ---- 2) POST 处理器复用共享函数 ----
const OLD_HANDLER = `  try {
    const results = assetScanner.fullScan();
    await withVoicesLock(async () => {
      const voices = loadVoices();
      const scannedIds = new Set(Object.keys(results));
      for (const oldId of Object.keys(voices)) {
        if (!scannedIds.has(oldId)) delete voices[oldId];
      }
      for (const [id, meta] of Object.entries(results)) {
        voices[id] = {
          display_name: meta?.display_name || id,
          language: meta?.language || "ja",
          prompt_lang: meta?.prompt_lang || meta?.language || "ja",
          text_lang: meta?.text_lang || meta?.language || "ja",
        };
      }
      saveVoices(voices);
    });
    res.json({ ok: true, scanned: Object.keys(results).length, assets: results });`;
const NEW_HANDLER = `  try {
    const results = await runFullAssetScan();
    res.json({ ok: true, scanned: Object.keys(results).length, assets: results });`;
if (!src.includes(OLD_HANDLER)) {
  console.error("[FAIL] 未找到原 scan 处理器主体,放弃修改。");
  process.exit(1);
}
src = src.replace(OLD_HANDLER, NEW_HANDLER);

// ---- 3) 启动时自动扫描 ----
const OLD_START = `  // 扫描暂存目录中的未完成任务（断电恢复）
  scanStagingTasks();
});`;
const NEW_START = `  // 扫描暂存目录中的未完成任务（断电恢复）
  scanStagingTasks();

  // 自动扫描资产:首次启动/缺少 meta.json 时生成元数据,
  // 避免侧边栏 GPT/SoVITS 红叉与 "voice not found"(无需手动 scan all)。
  (async () => {
    try {
      if (assetsNeedScan()) {
        console.log("[ASSETS] 检测到声音缺少 meta.json/segments.json,启动时自动扫描...");
        const results = await runFullAssetScan();
        console.log(\`[ASSETS] 自动扫描完成:\${Object.keys(results).length} 个声音已就绪\`);
      } else {
        console.log("[ASSETS] 资产元数据已就绪,跳过自动扫描");
      }
    } catch (e) {
      console.error("[ASSETS] 启动自动扫描失败:", e.message);
    }
  })();
});`;
if (!src.includes(OLD_START)) {
  console.error("[FAIL] 未找到 listen 启动回调锚点,放弃修改。");
  process.exit(1);
}
src = src.replace(OLD_START, NEW_START);

const out = hadCRLF ? src.replace(/\n/g, "\r\n") : src;
fs.writeFileSync(SERVER, out, "utf8");
console.log("[ok] 已为 server.js 注入启动自动扫描 + 共享 runFullAssetScan()。");
console.log("[next] 重启后端(start.bat 或 node server.js),首次启动会自动扫描,声音直接可用。");
