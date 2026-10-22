// 音色 id 的生成与预留：显示名与 id 分离，显示名可以是任意 Unicode。
// id 形如 <slug>_<6 位十六进制>，slug 只留 ASCII 字母、数字、下划线与连字符；
// 新分配的 id 必带后缀，同名显示名也分到不同 id，不会撞成覆盖。
// 占用集合 = 资产目录 ∪ voices.json ∪ 保留中的任务 ∪ 预留记录。
// 真正的 id 在建任务或建音色时一次性分配并占位，占位保留到任务不再可恢复；
// 预览接口给的是不占位的候选 id，两者可能不同，调用方要把它标成候选。

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { STAGING_ROOT } = require("./paths");

const RESERVATIONS_FILE = path.join(STAGING_ROOT, "id-reservations.json");
const ID_RE = /^[a-zA-Z0-9_-]+$/;

function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

// 显示名转 id 词干：结果只含 ASCII 字母、数字、下划线与连字符，最长 32 个字符。
// 显示名里没有可用字符时结果是空串，兜底词干由调用方决定。
function slugify(displayName) {
  let s = String(displayName == null ? "" : displayName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");           // 去掉组合变音符号
  s = s.replace(/[^a-zA-Z0-9_-]+/g, "_")          // 非 ASCII（含中文）换成下划线
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return s.toLowerCase().slice(0, 32);
}

function shortHash(seed, n = 6) {
  return crypto.createHash("sha1").update(String(seed)).digest("hex").slice(0, n);
}

// 预览用：按显示名推出一个候选 id，同一显示名每次结果相同，不占位。
// 真正的 id 另行分配，可能与候选不同。
function proposeVoiceId(displayName) {
  const stem = slugify(displayName) || "voice";
  return { base: stem, proposed: `${stem}_${shortHash(String(displayName) + "|preview", 6)}` };
}

// 分配一个不在 taken 里的 id：词干取自显示名，后缀带随机量，
// 重复尝试直到不撞。taken 由调用方在同一临界区里收集完整并负责占位。
function allocateVoiceId(displayName, taken) {
  const takenSet = taken instanceof Set ? taken : new Set(taken || []);
  const stem = slugify(displayName) || "voice";
  for (let attempt = 0; attempt < 2000; attempt++) {
    const seed = `${displayName}|${Date.now()}|${attempt}|${crypto.randomBytes(4).toString("hex")}`;
    const id = `${stem}_${shortHash(seed, 6)}`;
    if (isValidId(id) && !takenSet.has(id)) return id;
  }
  throw new Error("could not allocate a unique voice id after many attempts");
}

// 预留登记表，落盘保存，重启后仍然有效。
function readReservations() {
  try {
    const j = JSON.parse(fs.readFileSync(RESERVATIONS_FILE, "utf-8"));
    return new Set(Array.isArray(j.ids) ? j.ids : []);
  } catch (_) { return new Set(); }
}

function writeReservations(set) {
  try { fs.mkdirSync(STAGING_ROOT, { recursive: true }); } catch (_) {}
  const tmp = RESERVATIONS_FILE + ".tmp." + process.pid + "." + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ids: [...set].sort() }, null, 2), "utf-8");
  } catch (e) {
    console.warn("[assetId] 写入临时文件失败:", e.message);
    return;
  }
  fs.renameSync(tmp, RESERVATIONS_FILE);
}

function reserve(id) {
  const s = readReservations();
  if (!s.has(id)) { s.add(id); writeReservations(s); }
}

function release(id) {
  const s = readReservations();
  if (s.delete(id)) writeReservations(s);
}

// 清掉已有真实目录或保留任务占着的预留：那些 id 已经有主了，不需要占位。
// backedIds 是被目录或任务占有的 id 集合。清预留是为了不让登记表无限增长。
function prune(backedIds) {
  const backed = backedIds instanceof Set ? backedIds : new Set(backedIds || []);
  const s = readReservations();
  let changed = false;
  for (const id of [...s]) {
    if (backed.has(id)) { s.delete(id); changed = true; }
  }
  if (changed) writeReservations(s);
}

function listReservations() {
  return [...readReservations()];
}

module.exports = {
  ID_RE,
  isValidId,
  slugify,
  shortHash,
  proposeVoiceId,
  allocateVoiceId,
  reserve,
  release,
  prune,
  listReservations,
  RESERVATIONS_FILE,
};
