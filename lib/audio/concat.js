// ===========================
//  AUDIO CONCATENATION
// ===========================
// Extracted verbatim from server.js (Stage-0 refactor). Concatenates segment
// WAVs with optional inter-segment silence, preferring ffmpeg (stream copy) and
// transparently falling back to the pure-Node WAV concatenator. Behaviour is
// unchanged; OUTPUT_DIR is resolved the same way server.js did (APP_DIR/outputs).

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { ffmpegCmd, checkFfmpeg } = require("./ffmpeg");
const { generateSilenceWav, concatWavPureNode } = require("./wav");

const APP_DIR = path.resolve(__dirname, "..", "..");
const OUTPUT_DIR = path.join(APP_DIR, "outputs");

function concatWavFiles(inputPaths, outputPath, silenceMs = 300) {
  return new Promise((resolve, reject) => {
    const ffmpegOk = checkFfmpeg();

    if (ffmpegOk && silenceMs >= 0) {
      // ffmpeg concat with silence insertion
      concatWithFfmpeg(inputPaths, outputPath, silenceMs).then(resolve).catch(reject);
    } else {
      // Pure Node.js WAV concatenation (no silence insertion)
      concatWavPureNode(inputPaths, outputPath).then(resolve).catch(reject);
    }
  });
}

function concatWithFfmpeg(inputPaths, outputPath, silenceMs) {
  return new Promise((resolve, reject) => {
    // Create a temp silence file
    const silencePath = path.join(OUTPUT_DIR, `_silence_${Date.now()}.wav`);
    generateSilenceWav(silenceMs, 22050, silencePath);

    // Build ffmpeg concat list
    const concatList = path.join(OUTPUT_DIR, `_concat_${Date.now()}.txt`);
    const files = [];
    for (let i = 0; i < inputPaths.length; i++) {
      const escaped = inputPaths[i].replace(/'/g, "'\\''");
      files.push(`file '${escaped}'`);
      if (silenceMs > 0 && i < inputPaths.length - 1) {
        const silenceEscaped = silencePath.replace(/'/g, "'\\''");
        files.push(`file '${silenceEscaped}'`);
      }
    }
    fs.writeFileSync(concatList, files.join("\n"));

    const child = spawn(ffmpegCmd(), ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", outputPath], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });

    const cleanup = () => {
      try { fs.unlinkSync(silencePath); } catch {}
      try { fs.unlinkSync(concatList); } catch {}
    };

    child.on("close", code => {
      cleanup();
      if (code !== 0) {
        console.error("[WARN] ffmpeg concat failed, falling back to pure Node:", stderr);
        concatWavPureNode(inputPaths, outputPath).then(r => resolve({ ...r, method: "node-fallback" })).catch(reject);
      } else {
        resolve({ method: "ffmpeg" });
      }
    });
    child.on("error", err => {
      cleanup();
      console.error("[WARN] ffmpeg concat error, falling back to pure Node:", err.message);
      concatWavPureNode(inputPaths, outputPath).then(r => resolve({ ...r, method: "node-fallback" })).catch(reject);
    });
  });
}

module.exports = { concatWavFiles, concatWithFfmpeg };
