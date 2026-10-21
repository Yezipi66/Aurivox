// ffmpeg 探测与转码。ffmpeg 优先用项目内自带的静态构建（vendor/ffmpeg/<平台>/ffmpeg[.exe]），
// 没有才退回 PATH 上的系统 ffmpeg；调用方一律用 ffmpegCmd() 拿命令，不要写死 "ffmpeg"。
// APP_DIR 是项目根（server.js 所在目录），本文件在 <根>/lib/audio/ffmpeg.js，所以上跳两级。

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const APP_DIR = path.resolve(__dirname, "..", "..");

let _ffmpegChecked = false;
let _ffmpegAvailable = false;
let _ffmpegPath = "ffmpeg";

// 找项目内自带的 ffmpeg 可执行文件；没有就返回 null，交给系统 ffmpeg。
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

// 实际调用 ffmpeg 的命令。探测一次就记住结果。
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

// OpenAI /v1/audio/speech 支持的响应格式。wav 是无损默认格式，引擎本来就出 WAV，不需要 ffmpeg；
// 其余格式要把引擎的 WAV 字节转一遍。ffmpeg 不可用时请求层直接拒绝非 WAV 请求，
// 不能拿 WAV 配一个不相干的 Content-Type 发出去。
const AUDIO_FORMATS = {
  wav:  { ext: "wav",  mime: "audio/wav",  ffmpeg: null },
  mp3:  { ext: "mp3",  mime: "audio/mpeg", ffmpeg: ["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"] },
  opus: { ext: "opus", mime: "audio/opus", ffmpeg: ["-c:a", "libopus", "-b:a", "64k", "-f", "opus"] },
  aac:  { ext: "aac",  mime: "audio/aac",  ffmpeg: ["-c:a", "aac", "-b:a", "192k", "-f", "adts"] },
  flac: { ext: "flac", mime: "audio/flac", ffmpeg: ["-c:a", "flac", "-f", "flac"] },
};

// 把 WAV 字节转成目标格式，返回转码后的 Buffer。走临时目录（有些 ffmpeg 封装器不能写管道）。
// 失败时抛错，由调用方决定怎么降级。
function transcodeAudio(wavBuffer, targetFmt) {
  const spec = AUDIO_FORMATS[targetFmt];
  if (!spec || !spec.ffmpeg) return wavBuffer; // wav 或未知格式：原样返回
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-xcode-"));
  const inPath = path.join(tmpDir, "in.wav");
  const outPath = path.join(tmpDir, `out.${spec.ext}`);
  try {
    fs.writeFileSync(inPath, wavBuffer);
    execFileSync(ffmpegCmd(), ["-hide_banner", "-loglevel", "error", "-y", "-i", inPath, ...spec.ffmpeg, outPath], { timeout: 30000 });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  }
}

module.exports = {
  vendoredFfmpegPath,
  ffmpegCmd,
  checkFfmpeg,
  AUDIO_FORMATS,
  transcodeAudio,
};
