// File logging setup.
// Tee console.log/info/warn/error to a daily-rotating file under logs/.

const fs = require("fs");
const path = require("path");

function setupFileLogging(console, process) {
  if (process.env.AURIVOX_LOG_FILE === "0") return;
  try {
    const logDir = process.env.AURIVOX_LOG_DIR || path.join(__dirname, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    let day = ""; let stream = null;
    const openFor = (d) => {
      if (stream && day === d) return stream;
      if (stream) { try { stream.end(); } catch (_) {} }
      day = d;
      stream = fs.createWriteStream(path.join(logDir, `aurivox-${d}.log`), { flags: "a" });
      stream.on("error", () => {});
      return stream;
    };
    const fmt = (a) => (typeof a === "string" ? a
      : (a instanceof Error ? (a.stack || a.message)
      : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })()));
    const write = (level, args) => {
      try {
        const now = new Date();
        const line = `[${now.toISOString()}] [${level}] ` + args.map(fmt).join(" ") + "\n";
        openFor(now.toISOString().slice(0, 10)).write(line);
      } catch (_) {}
    };
    for (const level of ["log", "info", "warn", "error"]) {
      const orig = console[level].bind(console);
      console[level] = (...args) => { orig(...args); write(level.toUpperCase(), args); };
    }
    console.log(`[LOG] file logging -> ${logDir} (disable with AURIVOX_LOG_FILE=0)`);
  } catch (e) {
    try { console.error("[LOG] file logging disabled:", e.message); } catch (_) {}
  }
}

module.exports = { setupFileLogging };
