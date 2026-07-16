// Canonical voice-ID generation + reservation (Option A: display/id decoupling).
//
// Rules (locked 2026-07-16):
//   * display_name may be any Unicode (中文 etc.); the canonical id is an
//     immutable ASCII slug `[a-zA-Z0-9_-]+`.
//   * Every NEWLY created id carries a stable `_<6hex>` suffix so a slug
//     collision can NEVER silently become an overwrite. Two identical display
//     names therefore always get distinct ids.
//   * The final id is allocated ONCE, atomically, at task/voice creation. The
//     preview endpoint returns a PROPOSED (non-reserved) id that may differ from
//     the final one — callers must label it "proposed".
//   * Collision set = asset folders ∪ voices.json ∪ retained tasks ∪ reservations.
//   * A reservation is held for a resumable task's full lifetime; it is released
//     only when the task is explicitly deleted / loses recovery eligibility, or
//     when publishing creates the asset folder that then owns the id.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { STAGING_ROOT } = require("./paths");

const RESERVATIONS_FILE = path.join(STAGING_ROOT, "id-reservations.json");
const ID_RE = /^[a-zA-Z0-9_-]+$/;

function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

// NFKD-fold, strip diacritics, keep ASCII [a-z0-9_-], collapse, lowercase, cap.
function slugify(displayName) {
  let s = String(displayName == null ? "" : displayName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");           // drop combining marks
  s = s.replace(/[^a-zA-Z0-9_-]+/g, "_")          // non-ASCII (incl. CJK) -> _
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return s.toLowerCase().slice(0, 32);
}

function shortHash(seed, n = 6) {
  return crypto.createHash("sha1").update(String(seed)).digest("hex").slice(0, n);
}

// PREVIEW ONLY — deterministic per display name, explicitly non-reserved. The
// final id is allocated separately at reserve time and may differ.
function proposeVoiceId(displayName) {
  const stem = slugify(displayName) || "voice";
  return { base: stem, proposed: `${stem}_${shortHash(String(displayName) + "|preview", 6)}` };
}

// Allocate a unique id NOT present in `taken`. Deterministic stem + random
// suffix; retried until unique. Caller supplies the full taken set (collected
// under the same critical section) and persists the reservation.
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

// ── Reservation registry (persisted; survives restart) ───────────────────────
function readReservations() {
  try {
    const j = JSON.parse(fs.readFileSync(RESERVATIONS_FILE, "utf-8"));
    return new Set(Array.isArray(j.ids) ? j.ids : []);
  } catch (_) { return new Set(); }
}

function writeReservations(set) {
  try { fs.mkdirSync(STAGING_ROOT, { recursive: true }); } catch (_) {}
  const tmp = RESERVATIONS_FILE + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify({ ids: [...set].sort() }, null, 2), "utf-8");
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

// Drop reservations that are now backed by a real folder or a retained task
// (they no longer need a placeholder). `backedIds` is a Set of ids owned by
// folders/tasks. Keeps the registry from growing unbounded.
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
