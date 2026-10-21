// Parse a .list transcript file into editable rows.
// Extracted from server.js (P0 refactor).

const fs = require("fs");

function readTranscriptListRows(listPath) {
  const rows = [];
  let content = "";
  try { content = fs.readFileSync(listPath, "utf-8"); } catch { return rows; }
  content.split("\n").forEach((line, i) => {
    const t = line.replace(/\r$/, "");
    if (!t.trim()) return;
    const parts = t.split("|");
    if (parts.length < 4) return;
    rows.push({
      index: i,
      audio_path: parts[0] || "",
      audio_filename: String(parts[0] || "").replace(/\\/g, "/").split("/").pop(),
      speaker: parts[1] || "",
      lang: parts[2] || "",
      text: parts.slice(3).join("|"),
    });
  });
  return rows;
}

module.exports = { readTranscriptListRows };
