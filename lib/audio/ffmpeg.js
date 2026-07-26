// ===========================
//  FFMPEG DETECTION + TRANSCODE
// ===========================
// Extracted verbatim from server.js (Stage-0 refactor). Encapsulates the
// module-level ffmpeg detection cache (previously three top-level `let`s in
// server.js) plus the OpenAI-format transcode table. Behaviour unchanged.
//
// APP_DIR is the project root (where server.js lives). This file sits at
// <root>/lib/audio/ffmpeg.js, so the root is two levels up.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const APP_DIR = path.resolve(__dirname, "..", "..");

let _ffmpegChecked = false;
let _ffmpegAvailable = false;
let _ffmpegPath = "ffmpeg";

// Resolve the ffmpeg executable, preferring a project-local static build
// provisioned by download_ffmpeg.py (vendor/ffmpeg/<platform>/ffmpeg[.exe]).
// This keeps ffmpeg self-contained per project — no PATH / global install
// required. Falls back to a system ffmpeg on PATH when no vendored copy exists.
function vendoredFfmpegPath() {
  const isWin = process.platform === "win32";
  const arch = process.arch; // "x64" | "arm64" | ...
  const bin = isWin ? "ffmpeg.exe" : "ffmpeg";
  const keys = [];
  if (isWin) {
    keys.push("windows-x86_64");
  } else if (process.platform === "linux") {
    keys.push(arch === "arm64" ? "linux-aarch64" : "linux-x86_64");
  } else if (process.platform === "darwin") {
    keys.push(arch === "arm64" ? "darwin-arm64" : "darwin-x86_64");
  }
  for (const k of keys) {
    const p = path.join(APP_DIR, "vendor", "ffmpeg", k, bin);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The absolute (or PATH) command used to invoke ffmpeg. Callers should use this
// instead of a hardcoded "ffmpeg" so the vendored binary is honored.
function ffmpegCmd() {
  checkFfmpeg();
  return _ffmpegPath;
}

function checkFfmpeg() {
  if (_ffmpegChecked) return _ffmpegAvailable;
  _ffmpegChecked = true;
  const vendored = vendoredFfmpegPath();
  const candidate = vendored || "ffmpeg";
  try {
    execFileSync(candidate, ["-version"], { stdio: "ignore", timeout: 5000 });
    _ffmpegAvailable = true;
    _ffmpegPath = candidate;
    if (vendored) console.log(`[ffmpeg] using project-local build: ${vendored}`);
  } catch {
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

// PH: OpenAI /v1/audio/speech response formats. WAV is the lossless default and
// needs no ffmpeg (the engine already emits WAV). The others are produced by
// transcoding the engine's WAV bytes through the system ffmpeg; when ffmpeg is
// absent the broker strictly rejects non-WAV requests (see /v1/audio/speech)
// rather than silently shipping WAV under a mismatched Content-Type.
const AUDIO_FORMATS = {
  wav:  { ext: "wav",  mime: "audio/wav",  ffmpeg: null },
  mp3:  { ext: "mp3",  mime: "audio/mpeg", ffmpeg: ["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"] },
  opus: { ext: "opus", mime: "audio/opus", ffmpeg: ["-c:a", "libopus", "-b:a", "64k", "-f", "opus"] },
  aac:  { ext: "aac",  mime: "audio/aac",  ffmpeg: ["-c:a", "aac", "-b:a", "192k", "-f", "adts"] },
  flac: { ext: "flac", mime: "audio/flac", ffmpeg: ["-c:a", "flac", "-f", "flac"] },
};

// Transcode WAV bytes to a target format via system ffmpeg. Returns the encoded
// Buffer. Uses a temp working directory (some ffmpeg muxers can't stream to a
// pipe). Throws on failure so callers can decide how to degrade.
function transcodeAudio(wavBuffer, targetFmt) {
  const spec = AUDIO_FORMATS[targetFmt];
  if (!spec || !spec.ffmpeg) return wavBuffer; // wav or unknown → passthrough
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-xcode-"));
  const inPath = path.join(tmpDir, "in.wav");
  const outPath = path.join(tmpDir, `out.${spec.ext}`);
  try {
    fs.writeFileSync(inPath, wavBuffer);
    execFileSync(ffmpegCmd(), ["-hide_banner", "-loglevel", "error", "-y", "-i", inPath, ...spec.ffmpeg, outPath], { timeout: 30000 });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

module.exports = {
  vendoredFfmpegPath,
  ffmpegCmd,
  checkFfmpeg,
  AUDIO_FORMATS,
  transcodeAudio,
};
